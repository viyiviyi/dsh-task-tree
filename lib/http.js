/**
 * 任务树条目用的 HTTP 接口。
 *
 * 条目跑在浏览器里，拿不到宿主内存中的 store，所以数据要经由这里出去。
 * 全部挂在 `/dsh-tree-task-flow/` 前缀下；只读写插件**自己的**状态目录，
 * 不碰会话日志（那是后端内部格式）。
 *
 * 条目要显示三样东西，都在这里算好给它：
 *
 *   - **每层的结果**：节点完成时提交的文本。条目不自己去挖计划树的深层结构，
 *     接口直接把三层各自的结果摆出来。
 *   - **检查点状态**：一个节点自己的子节点全部结束、而它自己还开着的那一刻。
 *     折叠出来的汇总消息会直接写明这一层够不够收尾。
 *   - **暂停状态**：条目上的暂停/继续按钮写的就是这个。暂停挂的是
 *     `agent/pre-step`（见 `pause.js`），不插消息、不改计划，所以它不属于计划树，
 *     单独回传。
 *   - **设置**：面板上那两个开关（见 `settings.js`）。它跟会话无关，读的时候顺手带上，
 *     改的时候写盘并**就地改活配置**，所以改完立刻生效，不用重启。
 *
 * 条目上的按钮都写计划树，所以写完要把**新的**活动路径、结果与检查点一并回传，
 * 免得条目还要再发一次请求才知道自己按出了什么效果。
 *
 * @module dsh-tree-task-flow/http
 */

import { activePath, complete, deleteNode, dropNode, levelLabel } from "./plan.js";
import { SETTING_KEYS, settingsSnapshot } from "./settings.js";
import {
  addDraft,
  currentVersion,
  deleteRequirement,
  dropRequirement,
  listActive,
  listArchived,
  listDrafts,
  missingPrerequisites,
  nextTaskOf,
  progressOf,
  requirementOf,
  setArchived,
  updateByUser,
} from "./requirement.js";

/** 统一的 JSON 响应。 */
function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

/** 读请求体并解析 JSON；读不动就当空对象，别让面板拿到 500。 */
async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * 一条需求压成面板要的形状。
 *
 * 列表上只显示标题、简介与状态；`detail` 与 `versions` 也一起给——面板是本机的，
 * 展开时不用再发一次请求，而"要不要展示"是面板自己的事。
 *
 * @param plan - 计划树。
 * @param requirement - 需求节点。
 * @returns 面板用的行对象。
 */
function rowOf(plan, requirement) {
  const task = nextTaskOf(requirement);
  return {
    id: requirement.id,
    title: requirement.title,
    intro: requirement.intro,
    detail: requirement.detail,
    status: requirement.status,
    archived: requirement.archived === true,
    pending: requirement.pending
      ? {
          title: requirement.pending.title,
          intro: requirement.pending.intro,
          detail: requirement.pending.detail,
          change: requirement.pending.change,
          question: requirement.pending.question,
          at: requirement.pending.at,
        }
      : null,
    missing: missingPrerequisites(plan, requirement).map((item) => ({
      id: item.id,
      state: item.state,
    })),
    prerequisites: requirement.prerequisites ?? [],
    nextTask: task === null ? null : { id: task.id, title: task.title },
    version: currentVersion(requirement),
    changes: (requirement.versions ?? []).length,
    updatedAt: requirement.updatedAt ?? null,
    result: requirement.result?.text ?? null,
    tasks: (requirement.tasks ?? []).map((each) => ({
      id: each.id,
      title: each.title,
      status: each.status,
      result: each.result?.text ?? null,
      steps: (each.steps ?? []).map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        result: step.result?.text ?? null,
      })),
    })),
  };
}

/**
 * 面板要的整份数据：两个列表 + 草稿区 + 当前进行中的展开。
 *
 * 「当前进行中」由**最后执行的那个任务**推导（`activeRequirement`），面板不另存状态。
 *
 * @param plan - 计划树。
 * @returns 面板用的数据；没有计划时三个列表都是空的。
 */
function panelData(plan) {
  if (plan === null) {
    return {
      requirements: { active: [], archived: [], drafts: [] },
      current: null,
      progress: [],
    };
  }
  const active = listActive(plan).map((row) => rowOf(plan, requirementOf(plan, row.id)));
  const archived = listArchived(plan).map((row) => rowOf(plan, requirementOf(plan, row.id)));
  const drafts = listDrafts(plan).map((requirement) => rowOf(plan, requirement));
  // 当前进行中的那一条：它的任务与步骤要在列表里就地展开。
  const live = active.find((row) => row.status === "pending") ?? null;
  const current = live ?? null;
  return {
    requirements: { active, archived, drafts },
    current: current === null ? null : current.id,
    progress:
      current === null
        ? []
        : progressOf(requirementOf(plan, current.id)).map(({ task, steps }) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            steps: steps.map((step) => ({ id: step.id, title: step.title, status: step.status })),
          })),
  };
}

/** 一条节点提交过的结果；还没提交就是 null。 */
function resultOf(node) {
  if (!node?.result) return null;
  return {
    id: node.id,
    title: node.title,
    text: node.result.text,
    at: node.result.at,
  };
}

/** 一次写操作之后，面板需要的全部新状态。 */
function afterWrite(plan) {
  return panelData(plan);
}

/**
 * 注册全部面板接口。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, autoContinue, pause, cfg }`；插件被关闭时 `autoContinue`
 *   与 `pause` 是 null。`cfg` 是那一份**活的对象**：读的时候用它报当前开关，
 *   改的时候就地改它——各模块按事件现读，所以下一刻就生效。
 */
export function registerHttp(ctx, { store, autoContinue, pause = null, cfg = null }) {
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      // 面板要的全部数据：需求两个列表 + 草稿区 + 当前进行中的展开 + 按住状态。
      host.webServer.register(
        {
          kind: "exact",
          path: "/dsh-tree-task-flow/tree",
          handler: async (request, response) => {
            if (request.method !== "GET") return sendJson(response, 405, { ok: false, error: "只支持 GET" });
            const url = new URL(request.url ?? "/", "http://localhost");
            const sessionId = url.searchParams.get("sessionId") ?? "";
            const plan = store.readPlan(sessionId);

            sendJson(response, 200, {
              ok: true,
              sessionId,
              ...afterWrite(plan),
              stopped: autoContinue?.isStopped?.(sessionId) === true,
              paused: pause?.isPaused?.(sessionId) === true,
              settings: settingsSnapshot(cfg),
            });
          },
        },
        "dsh-tree-task-flow: tree",
      );

      // 插件管理里本插件那一页用的接口：**跟会话无关**，只回两个开关的当前值与总开关
      // 状态。那一页不是某个会话的界面，没有"当前会话"这个概念，所以它不能走 `/tree`。
      host.webServer.register(
        {
          kind: "exact",
          path: "/dsh-tree-task-flow/settings",
          handler: async (request, response) => {
            if (request.method !== "GET") return sendJson(response, 405, { ok: false, error: "只支持 GET" });
            sendJson(response, 200, {
              ok: true,
              enabled: cfg?.enabled === true,
              settings: settingsSnapshot(cfg),
            });
          },
        },
        "dsh-tree-task-flow: settings",
      );

      // 面板上的按钮都走这一个端点。
      host.webServer.register(
        {
          kind: "exact",
          path: "/dsh-tree-task-flow/action",
          handler: async (request, response) => {
            if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "只支持 POST" });
            const body = await readJsonBody(request);
            const sessionId = String(body.sessionId ?? "");
            const action = String(body.action ?? "");

            // 暂停 / 继续。暂停会同时压住自动续行兜底，两个状态一起回传，
            // 免得条目还要再问一次。
            if (action === "pause" || action === "resume") {
              const outcome = pause?.[action]?.(sessionId) ?? null;
              return sendJson(response, 200, {
                ok: true,
                paused: pause?.isPaused?.(sessionId) === true,
                stopped: autoContinue?.isStopped?.(sessionId) === true,
                // 跨重启的那次「继续」可能什么都没能唤醒，把话说给界面听。
                message: typeof outcome?.text === "string" ? outcome.text : null,
                woke: outcome?.woke === true,
              });
            }

            // 面板上的开关。跟会话无关，所以不读 sessionId。
            //
            // 两件事一起做：**写盘**（重启后还在）与**就地改活配置**（这一刻就生效）。
            // 各模块都是"事件来了现读 cfg"，所以改完不用重启，下一次事件就是新值。
            if (action === "setting") {
              const key = String(body.key ?? "");
              if (!SETTING_KEYS.includes(key)) {
                return sendJson(response, 400, { ok: false, error: `不认识的开关：${key}` });
              }
              if (typeof body.value !== "boolean") {
                return sendJson(response, 400, { ok: false, error: "开关的值只能是 true 或 false" });
              }
              store.patchSettings({ [key]: body.value });
              if (cfg !== null && typeof cfg === "object") cfg[key] = body.value;
              return sendJson(response, 200, { ok: true, settings: settingsSnapshot(cfg) });
            }

            // 面板上新建需求：**只产出草稿**，等 AI 沟通确认之后才算真需求。
            if (action === "draft") {
              const plan = store.readPlan(sessionId) ?? {
                version: 3,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                goals: [],
              };
              const requirement = addDraft(plan, {
                title: body.title,
                intro: body.intro,
                detail: body.detail,
              });
              store.writePlan(sessionId, plan);
              return sendJson(response, 200, { ok: true, id: requirement.id, ...afterWrite(plan) });
            }

            // 用户改需求正文：**只落暂定版本**，不动正在生效的正文（`docs/09` §3.3）。
            // 点这个按钮**不叫醒 AI**——它下次被唤起时会先看到这条待确认。
            if (action === "pending") {
              const plan = store.readPlan(sessionId);
              if (plan === null) return sendJson(response, 404, { ok: false, error: "这个会话还没有需求" });
              const outcome = updateByUser(plan, String(body.id ?? ""), {
                title: body.title,
                intro: body.intro,
                detail: body.detail,
                change: body.change,
              });
              if (!outcome.ok) return sendJson(response, 200, { ok: false, error: outcome.reason });
              store.writePlan(sessionId, plan);
              return sendJson(response, 200, {
                ok: true,
                cancelled: outcome.cancelled === true,
                message: outcome.cancelled === true ? "改回和当前版本一样了，暂定版本已撤掉。" : "已提交这个版本的改动，等 AI 确认。",
                ...afterWrite(plan),
              });
            }

            if (action === "archive" || action === "unarchive") {
              const plan = store.readPlan(sessionId);
              if (plan === null) return sendJson(response, 404, { ok: false, error: "这个会话还没有需求" });
              const outcome = setArchived(plan, String(body.id ?? ""), action === "archive");
              if (!outcome.ok) return sendJson(response, 200, { ok: false, error: outcome.reason });
              store.writePlan(sessionId, plan);
              return sendJson(response, 200, { ok: true, ...afterWrite(plan) });
            }

            // 点某条需求的「开始」：这是**能叫醒 AI 的三种动作之一**。
            if (action === "start") {
              const plan = store.readPlan(sessionId);
              const requirement = plan === null ? null : requirementOf(plan, String(body.id ?? ""));
              if (requirement === null) {
                return sendJson(response, 200, { ok: false, error: "找不到这条需求" });
              }
              const outcome = pause?.nudge?.(
                sessionId,
                `开始做需求 ${requirement.id}「${requirement.title}」。` +
                  "先用 tree_task_start 开始它（会折叠上一次折叠之后的过程，并给出这条需求的详情），再按计划往下推。",
                "开始需求",
              ) ?? { woke: false, reason: "unavailable", text: "插件没在运行，叫不醒会话。" };
              return sendJson(response, 200, {
                ok: true,
                woke: outcome.woke === true,
                message: outcome.text,
                paused: pause?.isPaused?.(sessionId) === true,
                stopped: autoContinue?.isStopped?.(sessionId) === true,
              });
            }

            if (action === "reset") {
              store.writePlan(sessionId, null);
              // 计划没了，游标也必须跟着清：游标里记的是"这一层总结到哪儿了"，
              // 留着旧节点 id，下一次建树的第一层就会被误判成"没换节点"。
              store.writeSurfaces(sessionId, {
                sessionId,
                goal: null,
                task: null,
                step: null,
                updatedAt: Date.now(),
              });
              return sendJson(response, 200, { ok: true, active: null, checkpoint: null, results: null });
            }

            if (action === "done" || action === "drop" || action === "delete") {
              const plan = store.readPlan(sessionId);
              if (plan === null) return sendJson(response, 404, { ok: false, error: "这个会话没有计划" });
              const id = String(body.id ?? "");
              const found = requirementOf(plan, id) !== null;
              // 完成必须带结果：插件要用它替换掉这个节点的执行过程。
              const outcome = found
                ? action === "drop"
                  ? dropRequirement(plan, id)
                  : deleteRequirement(plan, id)
                : action === "done"
                  ? complete(plan, id, body.result)
                  : action === "drop"
                    ? dropNode(plan, id)
                    : deleteNode(plan, id);
              if (!outcome.ok) return sendJson(response, 200, { ok: false, error: outcome.reason });
              store.writePlan(sessionId, plan);
              return sendJson(response, 200, {
                ok: true,
                events: outcome.events ?? outcome.dropped ?? outcome.removed ?? [],
                ...afterWrite(plan),
              });
            }

            return sendJson(response, 400, { ok: false, error: `不认识的动作：${action}` });
          },
        },
        "dsh-tree-task-flow: action",
      );

      ctx.logger?.info?.("dsh-tree-task-flow: 插件配置页接口已挂载");
    }, "dsh-tree-task-flow: http");
  });
}
