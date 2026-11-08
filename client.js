/**
 * dsh-tree-task-flow 的客户端：输入框上方的需求条。
 *
 * 这是**手写**的模块包装格式，不经过打包，所以用 `h()` 而不是 JSX。
 *
 * 挂载点是 `conversation.input.dock`——输入框上方的全宽条目区，内置的任务清单
 * （`todo`）与目标（`goal`）就在那里。这是一个 `list` 槽：用自己的 id 注册就会
 * 并列加在它们旁边，不会替换任何一个。
 *
 * 这一条只管三件事（见 `docs/09-需求与任务模型.md` §5）：
 *
 *   1. **看**：需求两个列表（活跃 / 已归档）+ 待确认的草稿，当前进行中的那条就地
 *      展开成任务与步骤；
 *   2. **改**：用户改需求正文（标题 / 简介 / 详情）→ 点「确认变更」→ 落成**暂定版本**，
 *      等 AI 确认。改的时候**不动**正在生效的正文；
 *   3. **开始**：点某条需求的「开始」——这是能叫醒 AI 的三种动作之一（另外两种是
 *      点「继续」与直接发消息）。
 *
 * **归档按钮有一个刻意的延迟**：点了之后这一行**不动**，按钮变成「取消归档」，
 * 反悔点一下就回去了；下次打开面板才按新状态重新分列表。防误点优先于即时一致。
 *
 * 没有需求的会话**一个像素都不占**：读不到就返回 null，免得平白挤掉内置条目。
 *
 * 另外挂在插件管理的**本插件自己的配置页** `plugins.bundle.config`（按 bundle 的
 * 包名 `dsh-tree-task-flow` 作 key）——不是 DSH 设置面板里的一页标签：设置属于
 * 这个插件，就该长在插件自己身上，从「插件」页点进这个 bundle 才看得到。
 */
window.__ModuleLoader__.load({
	id: "dsh-tree-task-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback } = react;

		const name = "dsh-tree-task-flow";
		const inject = ["slots", "locale"];
		const NS = "dsh-tree-task-flow";
		/** 条目 id。用自己的 id，所以只会加在内置条目旁边。 */
		const ENTRY_ID = "dsh-tree-task-flow";
		/**
		 * 本插件作为 bundle 的包名——`plugins.bundle.config` 的 key 用它，
		 * 跟 locale 命名空间 `NS` 是两个不同的字符串（那是文案的命名空间）。
		 */
		const BUNDLE_PACKAGE = "dsh-tree-task-flow";

		let translate = (key) => key;
		const useT = () => translate;

		// ------------------------------------------------------------ 内置基座

		/**
		 * 内置 UI 基座。外壳启动时把这张表播种进模块表，所以这里的 require 正常一定
		 * 成功；仍然兜一层 try——万一这版外壳没有 primitives，条目该降级成文字。
		 */
		let primitives = {};
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives") || {};
		} catch {
			primitives = {};
		}

		function findIcon(base, size) {
			const candidates = [base + size, base + "14", base + "16", base + "Regular", base + "Medium", base];
			for (const candidate of candidates) {
				const component = primitives[candidate];
				if (typeof component === "function") return component;
			}
			return null;
		}

		function icon(base, size) {
			const component = findIcon(base, size);
			if (component === null) return null;
			return h(component, { size });
		}

		function withTooltip(label, node) {
			const Tooltip = primitives.Tooltip;
			if (typeof Tooltip !== "function") return node;
			return h(Tooltip, { label, side: "bottom", delayMs: 500 }, node);
		}

		function IconButton({ iconBase, label, size, disabled, onClick }) {
			const glyph = icon(iconBase, typeof size === "number" ? size : 16);
			return withTooltip(
				label,
				h(
					"button",
					{
						type: "button",
						className: glyph === null ? "dsh-ttf-iconBtn dsh-ttf-iconBtnText" : "dsh-ttf-iconBtn",
						disabled: disabled === true,
						"aria-label": label,
						onClick,
					},
					glyph === null ? h("span", { className: "dsh-ttf-iconText" }, label) : glyph,
				),
			);
		}

		// ---------------------------------------------------------------- 基础

		function urlOf(path) {
			try {
				return new URL(path, window.location.origin).toString();
			} catch {
				return path;
			}
		}

		async function api(path, init) {
			const response = await fetch(
				urlOf(path),
				Object.assign({ cache: "no-store", credentials: "same-origin" }, init || {}),
			);
			const text = await response.text();
			let data = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				throw new Error(response.status + " 返回了非 JSON：" + String(text).slice(0, 120));
			}
			if (!response.ok) {
				const error = new Error((data && data.error) || response.status + " " + response.statusText);
				error.status = response.status;
				throw error;
			}
			return data;
		}

		/** 写操作。host 用 HTTP 200 携带 `{ ok: false, error }` 表示业务拒绝，所以要把 ok 也判一次。 */
		async function post(body) {
			const data = await api("/dsh-tree-task-flow/action", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (data && data.ok === false) throw new Error(data.error || "host 拒绝了这次操作");
			return data;
		}

		// ---------------------------------------------------------------- 数据

		/** 面板要的三组数据；接口缺字段时一律当空，不让界面炸。 */
		function listsOf(data) {
			const lists = (data && data.requirements) || {};
			return {
				active: Array.isArray(lists.active) ? lists.active : [],
				archived: Array.isArray(lists.archived) ? lists.archived : [],
				drafts: Array.isArray(lists.drafts) ? lists.drafts : [],
			};
		}

		/** 一条需求的进度分数：任务与步骤都算，放弃的两边都不算。 */
		function countOf(row) {
			let total = 0;
			let done = 0;
			for (const task of row.tasks || []) {
				if (task.status === "dropped") continue;
				total += 1;
				if (task.status === "done") done += 1;
				for (const step of task.steps || []) {
					if (step.status === "dropped") continue;
					total += 1;
					if (step.status === "done") done += 1;
				}
			}
			return { total, done };
		}

		/** 状态的显示名。 */
		function statusKey(status) {
			if (status === "draft") return "status.draft";
			if (status === "done") return "status.done";
			if (status === "dropped") return "status.dropped";
			return "status.open";
		}

		// ---------------------------------------------------------------- 文案

		const zh = {
			nav: "树形任务流",
			"state.running": "进行中",
			"state.paused": "已暂停",
			"state.idle": "待开始",
			"status.open": "未完成",
			"status.done": "已完成",
			"status.dropped": "已放弃",
			"status.draft": "草稿",
			"label.requirements": "{count} 条需求",
			"label.archived": "已归档",
			"label.drafts": "待确认",
			"label.current": "当前",
			"label.missing": "缺前置",
			"label.pending": "待确认变动",
			"label.detail": "详情",
			"label.tasks": "任务",
			"label.summary": "总结",
			"action.pause": "暂停",
			"action.resume": "继续",
			"action.expand": "展开",
			"action.collapse": "收起",
			"action.start": "开始这条需求",
			"action.archive": "归档",
			"action.unarchive": "取消归档",
			"action.open": "看详情",
			"action.edit": "改需求",
			"action.submitChange": "确认变更",
			"action.newRequirement": "新建需求",
			"action.add": "记下来",
			"action.cancel": "取消",
			"note.paused": "已暂停：正在跑的工具会跑完，之后不再往下走。点「继续」从原处接着跑。",
			"note.archiveDeferred": "点了不会立刻移动：这一行留在原地，下次打开面板才按新状态分开。反悔就再点一下。",
			"note.draft": "草稿还不算真需求。跟 AI 把「要什么」说清楚，它确认之后才会转正。",
			"note.pending": "这条需求有用户提交的改动，等 AI 确认。确认之前仍按旧版本走。",
			"note.edit": "改完点「确认变更」提交成暂定版本，AI 确认之后才生效。",
			"note.noTasks": "还没有任务，让 AI 拆。",
			"placeholder.title": "一句话说清要做什么（不超过 50 字）",
			"placeholder.intro": "简介（不超过 200 字）",
			"placeholder.detail": "详情，可以很长",
			"settings.loading": "正在读设置…",
			"settings.unavailable": "读不到设置：宿主那一半没在跑，或者接口不通。",
			"settings.off": "插件在 profile 配置里被关掉了（enabled: false），这两个开关现在不起作用。",
			"setting.note": "改完立刻生效，也会写进状态目录，重启 dsh web 之后还在。",
			"setting.autoContinue": "任务没做完、模型自己停下时，自动把它叫起来接着跑",
			"setting.autoContinueNote": "会往会话里推一条消息。默认关。",
			"setting.interruptRecovery": "工具出错或网络断了，自动重试把会话拉起来",
			"setting.interruptRecoveryNote": "按 1 / 5 / 10 / 30 分钟各拉一次，一直拉不起来就停手。你按过停止的绝不拉起。",
		};

		const en = {
			nav: "Task tree",
			"state.running": "In progress",
			"state.paused": "Paused",
			"state.idle": "Not started",
			"status.open": "Open",
			"status.done": "Done",
			"status.dropped": "Dropped",
			"status.draft": "Draft",
			"label.requirements": "{count} requirements",
			"label.archived": "Archived",
			"label.drafts": "Waiting for you",
			"label.current": "current",
			"label.missing": "waiting on",
			"label.pending": "pending change",
			"label.detail": "Detail",
			"label.tasks": "Tasks",
			"label.summary": "Summary",
			"action.pause": "Pause",
			"action.resume": "Resume",
			"action.expand": "Expand",
			"action.collapse": "Collapse",
			"action.start": "Start this requirement",
			"action.archive": "Archive",
			"action.unarchive": "Unarchive",
			"action.open": "Show detail",
			"action.edit": "Edit",
			"action.submitChange": "Submit change",
			"action.newRequirement": "New requirement",
			"action.add": "Save",
			"action.cancel": "Cancel",
			"note.paused": "Paused: the running tool finishes, then nothing else happens. Resume picks up exactly where it stopped.",
			"note.archiveDeferred": "Nothing moves right away: the row stays put and the next time you open the panel it shows up in the other list. Click again to undo.",
			"note.draft": "A draft is not a requirement yet. Describe what you want to the model; it becomes real once confirmed.",
			"note.pending": "This requirement has a change submitted by you, waiting for the model to confirm. The old version is still in force.",
			"note.edit": "Submit the change and it becomes a provisional version; it takes effect once the model confirms it.",
			"note.noTasks": "No tasks yet — the model breaks it down.",
			"placeholder.title": "One line: what should be done (<= 50 chars)",
			"placeholder.intro": "Short intro (<= 200 chars)",
			"placeholder.detail": "Detail, may be long",
			"settings.loading": "Reading settings…",
			"settings.unavailable": "Settings are unreachable: the host half is not running, or the endpoint is blocked.",
			"settings.off": "The plugin is switched off in the profile config (enabled: false), so these switches do nothing right now.",
			"setting.note": "Takes effect right away and is written to the state directory, so it survives a restart.",
			"setting.autoContinue": "When the plan is unfinished and the model stops, wake it up to carry on",
			"setting.autoContinueNote": "This pushes a message into the session. Off by default.",
			"setting.interruptRecovery": "After a tool error or a dropped connection, retry to get the session going",
			"setting.interruptRecoveryNote": "Retries at 1 / 5 / 10 / 30 minutes, then gives up. A session you stopped is never revived.",
		};

		/** 插件配置页上的两个开关。 */
		const SETTING_ROWS = [
			{ key: "autoContinue", note: "setting.autoContinueNote" },
			{ key: "interruptRecovery", note: "setting.interruptRecoveryNote" },
		];

		// ---------------------------------------------------------------- 样式

		const CSS = [
			// 外壳与宽度：**必须照抄内置条目的宽度公式**。漏掉它，这一条会按父容器的
			// 宽度铺满整个输入区（实测就是这样占满全屏的）。
			".dsh-ttf-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));margin:0 auto;flex:none;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
			".dsh-ttf-panel{background:var(--dsw-specific-tip);border-radius:12px;position:relative;overflow:hidden}",
			'.dsh-ttf-panel:after{border:.5px solid var(--dsw-alias-border-l1);border-radius:inherit;content:"";pointer-events:none;position:absolute;inset:0}',
			".dsh-ttf-bar{box-sizing:border-box;width:100%;height:36px;display:flex;align-items:center;gap:10px;padding:4px 5px 4px 12px}",
			".dsh-ttf-glyph{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;align-items:center}",
			".dsh-ttf-glyphFallback{font-size:13px;line-height:16px}",
			".dsh-ttf-label{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px;white-space:nowrap}",
			".dsh-ttf-labelHeld{color:var(--dsw-alias-state-warning-primary,#a06800)}",
			".dsh-ttf-title{min-width:0;flex:1;color:var(--dsw-alias-label-primary-dimmed);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-ttf-progress{flex:none;max-width:45%;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-ttf-actions{flex:none;display:flex;align-items:center;gap:2px}",
			".dsh-ttf-iconBtn{width:28px;height:28px;border:none;background:0 0;border-radius:999px;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;font:inherit;flex:none}",
			".dsh-ttf-iconBtn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-ttf-iconBtn:disabled{opacity:.4;cursor:default}",
			".dsh-ttf-iconBtnText{width:auto;min-width:28px;max-width:112px;height:24px;padding:0 8px}",
			".dsh-ttf-iconText{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:16px;white-space:nowrap}",
			".dsh-ttf-body{max-height:264px;overflow-y:auto;padding:2px 8px 8px}",
			".dsh-ttf-note{margin:4px 4px 6px;padding:6px 8px;border-radius:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}",
			".dsh-ttf-section{margin:8px 4px 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-ttf-row{position:relative;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:6px 4px;border-radius:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dsh-ttf-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-ttf-rowHead{display:flex;align-items:center;gap:8px;min-width:0}",
			".dsh-ttf-rowTitle{min-width:0;flex:1;white-space:pre-wrap;word-break:break-word;cursor:pointer}",
			".dsh-ttf-rowIntro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}",
			".dsh-ttf-pill{flex:none;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;padding:0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dsh-ttf-pillDone{border-color:var(--dsw-alias-state-success-primary,#1a7f37);color:var(--dsw-alias-state-success-primary,#1a7f37)}",
			".dsh-ttf-pillDropped{opacity:.6;text-decoration:line-through}",
			".dsh-ttf-pillDraft{color:var(--dsw-alias-state-warning-primary,#a06800);border-color:var(--dsw-alias-state-warning-primary,#a06800)}",
			".dsh-ttf-tag{flex:none;border-radius:999px;padding:0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}",
			".dsh-ttf-tagWarn{color:var(--dsw-alias-state-warning-primary,#a06800);background:var(--dsw-alias-state-warning-bg,#ffcc002e)}",
			".dsh-ttf-detail{display:flex;flex-direction:column;gap:6px;padding:2px 4px 4px}",
			".dsh-ttf-detail>*+*{border-top:.5px solid var(--dsw-alias-border-l1);padding-top:6px}",
			".dsh-ttf-detailText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}",
			".dsh-ttf-list{margin:2px 0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dsh-ttf-btn{box-sizing:border-box;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;flex:none}",
			".dsh-ttf-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-ttf-btn:disabled{opacity:.4;cursor:default}",
			".dsh-ttf-form{display:flex;flex-direction:column;gap:6px;margin:6px 0 2px}",
			".dsh-ttf-input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}",
			".dsh-ttf-textarea{box-sizing:border-box;width:100%;min-height:64px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,monospace;font-size:12px;line-height:18px;resize:vertical;outline:none}",
			".dsh-ttf-input:focus,.dsh-ttf-textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
			".dsh-ttf-input::placeholder,.dsh-ttf-textarea::placeholder{color:var(--dsw-alias-label-caption,#00000066)}",
			".dsh-ttf-formActions{margin-top:2px;display:flex;align-items:center;justify-content:flex-end;gap:6px}",
			".dsh-ttf-settingsPage{display:flex;flex-direction:column;gap:10px;padding:4px 2px;max-width:640px}",
			".dsh-ttf-settings{display:flex;flex-direction:column;gap:12px}",
			".dsh-ttf-setting{display:flex;align-items:flex-start;gap:10px}",
			".dsh-ttf-settingText{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dsh-ttf-settingName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dsh-ttf-settingNote{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-ttf-switch{box-sizing:border-box;flex:none;position:relative;width:32px;height:18px;margin-top:1px;padding:0;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:var(--dsw-alias-bg-module-platform);cursor:pointer}",
			".dsh-ttf-switchOn{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent}",
			".dsh-ttf-switchKnob{position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:999px;background:#fff;transition:left .12s}",
			".dsh-ttf-switchOn .dsh-ttf-switchKnob{left:15px}",
		].join("\n");

		function ensureStyles() {
			const id = "dsh-tree-task-flow:css";
			if (typeof document === "undefined" || document === null) return;
			if (typeof document.createElement !== "function") return;
			try {
				// 自检里的假 document 只有 createElement：取不到已有节点就当作没有。
				if (typeof document.getElementById === "function" && document.getElementById(id) !== null) return;
				const style = document.createElement("style");
				style.id = id;
				style.textContent = CSS;
				if (document.head && typeof document.head.appendChild === "function") {
					document.head.appendChild(style);
				}
			} catch {
				// 样式注入失败不该拖垮条目：没有样式也还能用。
			}
		}

		// ---------------------------------------------------------------- 组件

		/** 状态那枚小药丸。 */
		function StatusPill({ row, t }) {
			const key = statusKey(row.status);
			const extra =
				row.status === "done"
					? " dsh-ttf-pillDone"
					: row.status === "dropped"
						? " dsh-ttf-pillDropped"
						: "";
			return h("span", { className: "dsh-ttf-pill" + extra }, t(key));
		}

		/** 编辑态：标题 / 简介 / 详情 + 「确认变更」。 */
		function EditForm({ row, onSubmit, onCancel, busy, t }) {
			const [title, setTitle] = useState(row.title || "");
			const [intro, setIntro] = useState(row.intro || "");
			const [detail, setDetail] = useState(row.detail || "");
			const [change, setChange] = useState("");
			return h(
				"div",
				{ className: "dsh-ttf-form" },
				h("input", {
					className: "dsh-ttf-input",
					value: title,
					maxLength: 80,
					placeholder: t("placeholder.title"),
					onChange: (event) => setTitle(event.target.value),
				}),
				h("input", {
					className: "dsh-ttf-input",
					value: intro,
					maxLength: 240,
					placeholder: t("placeholder.intro"),
					onChange: (event) => setIntro(event.target.value),
				}),
				h("textarea", {
					className: "dsh-ttf-textarea",
					value: detail,
					placeholder: t("placeholder.detail"),
					onChange: (event) => setDetail(event.target.value),
				}),
				h("input", {
					className: "dsh-ttf-input",
					value: change,
					placeholder: "这次改了什么（会写进版本历史）",
					onChange: (event) => setChange(event.target.value),
				}),
				h("div", { className: "dsh-ttf-note" }, t("note.edit")),
				h(
					"div",
					{ className: "dsh-ttf-formActions" },
					h("button", { type: "button", className: "dsh-ttf-btn", disabled: busy, onClick: onCancel }, t("action.cancel")),
					h(
						"button",
						{
							type: "button",
							className: "dsh-ttf-btn",
							disabled: busy,
							onClick: () =>
								onSubmit({ title, intro, detail, change }),
						},
						t("action.submitChange"),
					),
				),
			);
		}

		/** 一条需求的详情（只读）。 */
		function Detail({ row, t }) {
			const tasks = row.tasks || [];
			return h(
				"div",
				{ className: "dsh-ttf-detail" },
				row.intro ? h("div", { className: "dsh-ttf-detailText" }, row.intro) : null,
				row.detail
					? h("div", null, h("div", { className: "dsh-ttf-section" }, t("label.detail")), h("div", { className: "dsh-ttf-detailText" }, row.detail))
					: null,
				row.missing && row.missing.length > 0
					? h("div", { className: "dsh-ttf-note" }, t("label.missing") + "：" + row.missing.map((each) => each.id).join("、"))
					: null,
				row.pending
					? h("div", { className: "dsh-ttf-note" }, t("label.pending") + "：" + (row.pending.change || "（未说明改了什么）"))
					: null,
				tasks.length > 0
					? h(
							"div",
							null,
							h("div", { className: "dsh-ttf-section" }, t("label.tasks")),
							h(
								"ul",
								{ className: "dsh-ttf-list" },
								tasks.map((task) =>
									h(
										"li",
										{ key: task.id },
										(task.status === "done" ? "✓ " : task.status === "dropped" ? "✗ " : "· ") + task.title,
										(task.steps || []).length > 0
											? h(
													"ul",
													{ className: "dsh-ttf-list" },
													task.steps.map((step) =>
														h(
															"li",
															{ key: step.id },
															(step.status === "done" ? "✓ " : step.status === "dropped" ? "✗ " : "· ") + step.title,
														),
													),
												)
											: null,
									),
								),
							),
						)
					: h("div", { className: "dsh-ttf-note" }, t("note.noTasks")),
				row.result
					? h("div", null, h("div", { className: "dsh-ttf-section" }, t("label.summary")), h("div", { className: "dsh-ttf-detailText" }, row.result))
					: null,
			);
		}

		/** 一条需求。 */
		function RequirementRow({ row, isCurrent, expanded, busy, onToggle, onStart, onArchive, onEdit, t }) {
			const counts = countOf(row);
			return h(
				"div",
				{ className: "dsh-ttf-row" },
				h(
					"div",
					{ className: "dsh-ttf-rowHead" },
					h(StatusPill, { row, t }),
					h("span", { className: "dsh-ttf-tag" }, row.id),
					h(
						"span",
						{ className: "dsh-ttf-rowTitle", onClick: onToggle, title: row.title },
						row.title || "（还没有标题）",
					),
					isCurrent ? h("span", { className: "dsh-ttf-tag dsh-ttf-tagWarn" }, t("label.current")) : null,
					counts.total > 0
						? h("span", { className: "dsh-ttf-progress" }, counts.done + "/" + counts.total)
						: null,
					row.status === "pending" && !row.pending
						? h(IconButton, { iconBase: "IconPlayOutline", label: t("action.start"), disabled: busy, onClick: onStart })
						: null,
					row.pending
						? null
						: h(IconButton, {
								iconBase: row.archived ? "IconUndoOutline" : "IconArchiveOutline",
								label: row.archived ? t("action.unarchive") : t("action.archive"),
								disabled: busy,
								onClick: onArchive,
							}),
					h(IconButton, {
						iconBase: expanded ? "IconChevronUpOutline" : "IconChevronDownOutline",
						label: expanded ? t("action.collapse") : t("action.open"),
						onClick: onToggle,
					}),
				),
				row.intro ? h("div", { className: "dsh-ttf-rowIntro" }, row.intro) : null,
				expanded
					? h(
							"div",
							null,
							h(Detail, { row, t }),
							row.pending
								? null
								: h(
										"div",
										{ className: "dsh-ttf-formActions" },
										h("button", { type: "button", className: "dsh-ttf-btn", disabled: busy, onClick: onEdit }, t("action.edit")),
									),
						)
					: null,
			);
		}

		/** 新建需求：只产出草稿。 */
		function DraftForm({ onSubmit, onCancel, busy, t }) {
			const [title, setTitle] = useState("");
			const [intro, setIntro] = useState("");
			return h(
				"div",
				{ className: "dsh-ttf-form" },
				h("input", {
					className: "dsh-ttf-input",
					value: title,
					placeholder: t("placeholder.title"),
					onChange: (event) => setTitle(event.target.value),
				}),
				h("input", {
					className: "dsh-ttf-input",
					value: intro,
					placeholder: t("placeholder.intro"),
					onChange: (event) => setIntro(event.target.value),
				}),
				h("div", { className: "dsh-ttf-note" }, t("note.draft")),
				h(
					"div",
					{ className: "dsh-ttf-formActions" },
					h("button", { type: "button", className: "dsh-ttf-btn", disabled: busy, onClick: onCancel }, t("action.cancel")),
					h(
						"button",
						{
							type: "button",
							className: "dsh-ttf-btn",
							disabled: busy || title.trim() === "",
							onClick: () => onSubmit({ title, intro }),
						},
						t("action.add"),
					),
				),
			);
		}

		/** 输入框上方的全宽条目。 */
		function TaskTreeDock(props) {
			const t = useT();
			const sessionId = props.sessionId;
			const [state, setState] = useState({ loading: true, data: null });
			const [open, setOpen] = useState(false);
			const [busy, setBusy] = useState(false);
			const [note, setNote] = useState(null);
			// 归档的**延迟渲染**：这里记的是"这一次打开面板期间点过的开关"，
			// 它只改按钮文案，不改行所在的列表。下次打开面板时清空，行才真的搬家。
			const [overrides, setOverrides] = useState({});
			const [expandedId, setExpandedId] = useState(null);
			const [editingId, setEditingId] = useState(null);
			const [drafting, setDrafting] = useState(false);

			const reload = useCallback(async () => {
				if (!sessionId) {
					setState({ loading: false, data: null });
					return;
				}
				try {
					const data = await api("/dsh-tree-task-flow/tree?sessionId=" + encodeURIComponent(sessionId));
					setState({ loading: false, data });
				} catch {
					setState({ loading: false, data: null });
				}
			}, [sessionId]);

			useEffect(() => {
				reload();
			}, [reload]);

			useEffect(() => {
				if (!sessionId) return undefined;
				const timer = setInterval(() => reload(), 4000);
				return () => clearInterval(timer);
			}, [sessionId, reload]);

			useEffect(() => {
				if (!note) return undefined;
				const timer = setTimeout(() => setNote(null), 8000);
				return () => clearTimeout(timer);
			}, [note]);

			// 打开面板 = 重新读一次，并把「延迟的归档」结算掉。
			useEffect(() => {
				if (!open) return;
				setOverrides({});
				reload();
			}, [open, reload]);

			const act = useCallback(
				async (body) => {
					setBusy(true);
					setNote(null);
					try {
						const result = await post(Object.assign({ sessionId }, body));
						if (result && typeof result.message === "string" && result.message !== "") {
							setNote(result.message);
						}
						await reload();
					} catch (failure) {
						setNote(String((failure && failure.message) || failure));
					} finally {
						setBusy(false);
					}
				},
				[sessionId, reload],
			);

			if (state.loading || !state.data) return null;

			const data = state.data;
			const lists = listsOf(data);
			const total = lists.active.length + lists.archived.length + lists.drafts.length;
			// 一条需求都没有的会话，一个像素都不占。
			if (total === 0) return null;

			const held = data.paused === true || data.stopped === true;
			const currentId = data.current || null;
			const currentRow = lists.active.find((row) => row.id === currentId) || null;
			// 没有进行中的需求时，条上照**最近的那一条**显，状态也照它自己的来。
			// 以前这里直接退回「待开始」，于是一条已经做完的需求在条上写着待开始、
			// 点开明明是已完成——两处对不上（用户报的就是这个）。
			const shownRow =
				currentRow !== null ? currentRow : lists.active.length > 0 ? lists.active[lists.active.length - 1] : null;
			const heading =
				shownRow !== null
					? shownRow.title
					: lists.archived.length > 0
						? t("label.archived")
						: t("label.drafts");
			const stateLabel = held
				? t("state.paused")
				: currentRow !== null
					? t("state.running")
					: shownRow !== null
						? t(statusKey(shownRow.status))
						: t("state.idle");
			const counts = currentRow === null ? null : countOf(currentRow);
			const listGlyph =
				icon("IconChecklistOutline", 14) === null
					? h("span", { className: "dsh-ttf-glyphFallback" }, "☰")
					: icon("IconChecklistOutline", 14);

			const rowOf = (row) => {
				const shown = overrides[row.id];
				return Object.assign({}, row, {
					archived: typeof shown === "boolean" ? shown : row.archived === true,
				});
			};

			const renderRow = (row) => {
				const view = rowOf(row);
				const expanded = expandedId === row.id || editingId === row.id;
				return h(RequirementRow, {
					key: row.id,
					row: view,
					isCurrent: row.id === currentId,
					expanded,
					busy,
					t,
					onToggle: () => {
						setEditingId(null);
						setExpandedId(expandedId === row.id ? null : row.id);
					},
					onStart: () => act({ action: "start", id: row.id }),
					onArchive: () => {
						const next = !(typeof overrides[row.id] === "boolean" ? overrides[row.id] : row.archived === true);
						setOverrides(Object.assign({}, overrides, { [row.id]: next }));
						setNote(t("note.archiveDeferred"));
						act({ action: next ? "archive" : "unarchive", id: row.id });
					},
					onEdit: () => setEditingId(row.id),
				});
			};

			return h(
				"div",
				{ className: "dsh-ttf-dock", "aria-label": t("nav") },
				h(
					"div",
					{ className: "dsh-ttf-panel" },
					h(
						"div",
						{ className: "dsh-ttf-bar" },
						h("span", { className: "dsh-ttf-glyph", "aria-hidden": true }, listGlyph),
						h("span", { className: "dsh-ttf-label" + (held ? " dsh-ttf-labelHeld" : "") }, stateLabel),
						h("span", { className: "dsh-ttf-title", title: heading }, heading),
						counts !== null && counts.total > 0
							? h("span", { className: "dsh-ttf-progress" }, counts.done + "/" + counts.total)
							: null,
						h(
							"div",
							{ className: "dsh-ttf-actions" },
							h(IconButton, {
								iconBase: held ? "IconPlayOutline" : "IconPauseOutline",
								label: held ? t("action.resume") : t("action.pause"),
								disabled: busy,
								onClick: () => act({ action: held ? "resume" : "pause" }),
							}),
							h(IconButton, {
								iconBase: open ? "IconChevronDownOutline" : "IconChevronUpOutline",
								label: open ? t("action.collapse") : t("action.expand"),
								onClick: () => setOpen(!open),
							}),
						),
					),
					note ? h("div", { className: "dsh-ttf-note" }, note) : null,
					open
						? h(
								"div",
								{ className: "dsh-ttf-body" },
								held ? h("div", { className: "dsh-ttf-note" }, t("note.paused")) : null,

								lists.active.length > 0
									? h(
											"div",
											null,
											h("div", { className: "dsh-ttf-section" }, t("label.requirements", { count: lists.active.length })),
											lists.active.map((row) =>
												editingId === row.id
													? h(EditForm, {
															key: row.id,
															row,
															busy,
															t,
															onCancel: () => setEditingId(null),
															onSubmit: async (patch) => {
																await act(Object.assign({ action: "pending", id: row.id }, patch));
																setEditingId(null);
															},
														})
													: renderRow(row),
											),
										)
									: null,

								lists.drafts.length > 0
									? h(
											"div",
											null,
											h("div", { className: "dsh-ttf-section" }, t("label.drafts") + " · " + lists.drafts.length),
											lists.drafts.map((row) =>
												h(
													"div",
													{ className: "dsh-ttf-row", key: row.id },
													h(
														"div",
														{ className: "dsh-ttf-rowHead" },
														h(StatusPill, { row, t }),
														h("span", { className: "dsh-ttf-tag" }, row.id),
														h("span", { className: "dsh-ttf-rowTitle" }, row.title || "（还没有标题）"),
													),
													h("div", { className: "dsh-ttf-note" }, t("note.draft")),
												),
											),
										)
									: null,

								lists.archived.length > 0
									? h(
											"div",
											null,
											h("div", { className: "dsh-ttf-section" }, t("label.archived") + " · " + lists.archived.length),
											lists.archived.map((row) => renderRow(row)),
										)
									: null,

								drafting
									? h(DraftForm, {
											busy,
											t,
											onCancel: () => setDrafting(false),
											onSubmit: async (patch) => {
												await act(Object.assign({ action: "draft" }, patch));
												setDrafting(false);
											},
										})
									: h(
											"div",
											{ className: "dsh-ttf-formActions" },
											h(
												"button",
												{ type: "button", className: "dsh-ttf-btn", disabled: busy, onClick: () => setDrafting(true) },
												t("action.newRequirement"),
											),
										),
							)
						: null,
				),
			);
		}

		/**
		 * 插件管理里本插件自己那一页（`plugins.bundle.config`）。
		 *
		 * 宿主给两类视图：`page` 是页面主体，`summary` 是这个 bundle 在列表里的
		 * 一句话。bundle 的配置宿主只渲染 `page`，`summary` 一律返回 null——标题与
		 * 描述由宿主从包的元数据里取，这里不重复一遍。
		 *
		 * 判断视图与用 hook 的两件事分在两个组件里：同一个组件里先按 props 早退、
		 * 再调 hook，视图一变 hook 数量就变，React 会直接抛错。
		 */
		function TaskTreeConfigEntry(ownerProps) {
			if (ownerProps && ownerProps.view === "summary") return null;
			return h(TaskTreeSettings);
		}

		/** 配置页的正文：两个开关 + 读不到设置时的说明。 */
		function TaskTreeSettings() {
			const t = useT();
			const [state, setState] = useState({ loading: true, data: null });
			const [busy, setBusy] = useState(false);
			const [note, setNote] = useState("");

			useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const data = await api("/dsh-tree-task-flow/settings");
						if (alive) setState({ loading: false, data });
					} catch {
						if (alive) setState({ loading: false, data: null });
					}
				})();
				return () => {
					alive = false;
				};
			}, []);

			if (state.loading) {
				return h("div", { className: "dsh-ttf-settingsPage" }, h("div", { className: "dsh-ttf-settingNote" }, t("settings.loading")));
			}
			if (!state.data) {
				return h("div", { className: "dsh-ttf-settingsPage" }, h("div", { className: "dsh-ttf-settingNote" }, t("settings.unavailable")));
			}

			const settings = state.data.settings ?? {};

			async function toggle(key, value) {
				setBusy(true);
				setNote("");
				try {
					const result = await post({ action: "setting", key, value });
					if (result && result.settings) {
						setState({ loading: false, data: Object.assign({}, state.data, { settings: result.settings }) });
					}
				} catch (failure) {
					setNote(String((failure && failure.message) || failure));
				} finally {
					setBusy(false);
				}
			}

			return h(
				"div",
				{ className: "dsh-ttf-settingsPage" },
				h("div", { className: "dsh-ttf-settingNote" }, t("setting.note")),
				state.data.enabled === false ? h("div", { className: "dsh-ttf-note" }, t("settings.off")) : null,
				h(
					"div",
					{ className: "dsh-ttf-settings" },
					SETTING_ROWS.map((row) => {
						const on = settings[row.key] === true;
						return h(
							"div",
							{ className: "dsh-ttf-setting", key: row.key },
							h(
								"button",
								{
									type: "button",
									role: "switch",
									"aria-checked": on,
									"aria-label": t("setting." + row.key),
									className: "dsh-ttf-switch" + (on ? " dsh-ttf-switchOn" : ""),
									disabled: busy,
									onClick: () => toggle(row.key, !on),
								},
								h("span", { className: "dsh-ttf-switchKnob" }),
							),
							h(
								"div",
								{ className: "dsh-ttf-settingText" },
								h("span", { className: "dsh-ttf-settingName" }, t("setting." + row.key)),
								h("span", { className: "dsh-ttf-settingNote" }, t(row.note)),
							),
						);
					}),
				),
				note ? h("div", { className: "dsh-ttf-note" }, note) : null,
			);
		}

		// ---------------------------------------------------------------- 挂载

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-tree-task-flow: dictionaries");
			translate = ctx.locale.bind(NS);
			ensureStyles();

			ctx.effect(
				() =>
					ctx.slots.inject("conversation.input.dock", () =>
						ctx.slots.register(
							{
								name: "conversation.input.dock",
								id: ENTRY_ID,
								order: 50,
								locale: NS,
							},
							TaskTreeDock,
						),
					),
				"dsh-tree-task-flow: conversation dock",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("plugins.bundle.config", () =>
						ctx.slots.register(
							{
								name: "plugins.bundle.config",
								key: BUNDLE_PACKAGE,
								locale: NS,
							},
							TaskTreeConfigEntry,
						),
					),
				"dsh-tree-task-flow: 插件配置页",
			);
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
