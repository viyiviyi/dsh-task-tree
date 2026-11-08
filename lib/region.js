/**
 * 折叠：把一段执行过程从上下文里收起来，换成一条说明收走了什么的短消息。
 *
 * 规则只有一条，**只看表层，与计划树无关**（计划树只用来认出"这次完成的是不是一条需求"）：
 *
 *   - `tree_task_start`：把**上一次折叠成功之后**到它之前的那一段收走；
 *   - `tree_task_done`：把**上一次 done / start / create 之后**到它之前的那一段收走；
 *   - 完成的是**需求**时折「全部」：一路退到这条需求开工的那次 `tree_task_create`。
 *
 * 边界调用（`create` / `start` / `done`）本身永远留在表层——那是模型看"计划是什么、
 * 下一步干什么"的地方。写树的 `tree_task_plan` **不是边界**，它跟普通过程一样落在
 * 区间里就被收走。
 *
 * **为什么 `start` 认「上次折叠成功」而不是「上一个边界」**：折叠会被挡（用户的话
 * 还没写进需求），挡掉的那一段如果只按边界算，下一条边界一出现它就永远落在区间外，
 * 再也收不走。记一个"折到哪儿了"的游标，`start` 时从那里补折，被挡的过程才有第二次机会。
 *
 * **为什么 `done` 认「上一个边界」而不是「上次折叠成功」**：一次 done 收的就是它前面
 * 这一小节过程，边界本身已经把范围划清了；用游标反而会把更早的、已经由 start 收过的
 * 内容再卷一遍。
 *
 * 判定表见 `docs/06-折叠范围规则.md`。
 *
 * 两条硬约束：
 *
 *   - 中间夹着真人消息就**整段不折**：往前折丢了需求，往后折丢了回应，两边都出事；
 *   - 中间没有过程（两次调用挨着）就**什么都不注入**，不追加、不留空消息。
 *
 * 于是上下文长成这样：
 *
 *     [节点 0] 系统提示词
 *     [用户消息]
 *     [tree_task_create 调用]  [返回：草稿编号]
 *     [tree_task_start 调用]   [返回：需求详情]
 *     [tree_task消息：隐藏了 4 条过程上下文。读取：… 写入：…]
 *     [tree_task_done 调用]    [返回：接下来需要进行任务：「二」(t-4)。]
 *     [当前这一段执行过程]     ← 下一次折叠的对象
 *
 * 这一段过程里还夹着一次 `tree_task_plan` 的调用与返回——它不是边界，
 * 于是随这一条通告一起收走了。
 *
 * 时机是 `agent/pre-step`：上一轮已结束、下一个请求还没构造。工具执行中途不能折叠
 * ——那一刻 surface 还在增长，替换会把自己卷进去。
 *
 * @module dsh-tree-task-flow/region
 */

import { activePath } from "./plan.js";
import { requirementOf } from "./requirement.js";

/** 本插件放下的消息都带这个身份。 */
export const PLUGIN = "dsh-tree-task-flow";

/**
 * 本插件消息的 source kind。
 *
 * DSH 的会话格式 v4 要求消息来源带**生产者自有的** kind：老写法
 * `{ kind: "plugin", plugin: "包名" }` 只在 v3 → v4 迁移那一刻被改写成
 * `plugin:<包名>`（第三方插件一律加前缀，见 `dsh-session-format-v3-to-v4`
 * 的转换表）。**已经是 v4 的会话不再经过迁移**，写入时直接按 v4 校验，
 * 于是老写法被拒：
 *
 *     format v4 message requires a producer-owned source kind
 *
 * 这条错误来自 DSH 自己的编码路径（`releasedV4SessionFormatCodec.encodeEvent`
 * → `assertV4RowAdmission` → `assertV4SourceRowAdmission`），位置在会话落盘那一段，
 * 插件自己的 try/catch 拦不住。所以从这里起**直接写迁移后的那个 kind**——
 * 它在 v4 里合法，在 v3 里是"非空且非 plugin 的直接来源"，原样保留、同样合法。
 */
export const PLUGIN_SOURCE_KIND = `plugin:${PLUGIN}`;

/**
 * 界面上那一行摘要的统一前缀。
 *
 * 折叠、压缩、恢复续行、计划续行、中断拉起、中断重试——本插件往会话里放的通知不止一种，
 * 界面上都是一行摘要。**前缀只在这里加一次**：调用点写自己的裸标签
 * （「恢复续行」「中断拉起」），谁都别再手写它，否则迟早有一条漏掉或者写成两遍。
 */
export const SUMMARY_PREFIX = "树形任务流 · ";

/**
 * 给一个裸标签配上统一前缀，得到界面上真正显示的那一行。
 *
 * @param label - 裸标签，例如「恢复续行」。
 * @returns 带前缀的摘要文本。
 */
export function noticeSummary(label) {
  return `${SUMMARY_PREFIX}${label}`;
}

/**
 * 这条 source 的摘要是不是某个标签。
 *
 * **带不带前缀都认**：升级之前落在会话里的那几条摘要没有前缀，
 * 而按摘要做匹配的地方（收走失败尝试时找那条拉起消息）得能认出它们。
 *
 * @param source - 消息的 source。
 * @param label - 裸标签。
 * @returns 命中为 true。
 */
export function hasSummary(source, label) {
  if (typeof source?.summary !== "string") return false;
  return source.summary === label || source.summary === noticeSummary(label);
}

/**
 * 本插件一条 notice 消息的 source。
 *
 * 字段与老写法保持一致：`form: "notice"` 让界面渲染成可展开的一行说明，
 * `summary` 是那一行的文字。**摘要一律走 {@link noticeSummary} 加前缀**——
 * 界面上那一行必须自己说清是哪个插件发的，不能只写「恢复续行」。
 *
 * @param label - 界面上显示的那一行（不含前缀）。
 * @returns 消息 source。
 */
export function pluginSource(label) {
  return { kind: PLUGIN_SOURCE_KIND, form: "notice", summary: noticeSummary(label) };
}

/**
 * 这条 source 是不是本插件留下的。
 *
 * **两种写法都认**：v4 起写 `plugin:dsh-tree-task-flow`，而旧版留在 v3 会话里、
 * 或压缩折叠区间里带着的老消息仍是 `{ kind: "plugin", plugin: "dsh-tree-task-flow" }`。
 * 只认新写法会让老会话里的历史通告被当成普通过程，只认老写法会让新会话里的通告
 * 被反复折叠。
 *
 * @param source - 消息的 source。
 * @returns 是否本插件所留。
 */
export function isPluginSource(source) {
  if (source === undefined || source === null) return false;
  if (source.kind === PLUGIN_SOURCE_KIND) return true;
  return source.kind === "plugin" && source.plugin === PLUGIN;
}

/** 三层固定的名字。只给界面用的游标同步按这个顺序走。 */
const LEVELS = ["goal", "task", "step"];

/**
 * 边界调用：`tree_task_create` 与 `tree_task_done`。它们的调用与返回不进替换区间，
 * 是折叠的起止点。**`tree_task_plan` 不在其中**——它跟别的过程一样，落在区间里就被收走。
 */
const BOUNDARY_TOOLS = new Set(["tree_task_create", "tree_task_start", "tree_task_done"]);

/** 注入消息的抬头。 */
const NOTICE_PREFIX = "tree_task消息：";

/** 会改动文件的工具：它们的调用参数里带路径，算进"写入"列表。 */
const WRITE_TOOLS = new Set(["write", "edit", "str_replace_editor"]);

/** 只读取文件的工具：算进"读取"列表。 */
const READ_TOOLS = new Set(["read", "read_image"]);

/** 折叠消息的编号，保证同一毫秒内连折两次也不会撞 id。 */
let foldSeq = 0;

function foldId() {
  foldSeq += 1;
  return `tt-fold-${Date.now().toString(36)}-${foldSeq.toString(36)}`;
}

/** 取当前 surface 的最后一个节点 seq；surface 为空时返回 null。 */
export function tailSeq(session) {
  const nodes = session.surface?.nodes;
  return nodes !== undefined && nodes.length > 0 ? nodes[nodes.length - 1] : null;
}

/** 这条 assistant 消息里调用了哪些工具。 */
function toolNamesOf(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part?.type === "tool-call").map((part) => part.name);
}

/** 这条 assistant 消息里有没有边界调用。 */
function isBoundaryCall(event) {
  return toolNamesOf(event).some((name) => BOUNDARY_TOOLS.has(name));
}

/** 这条 assistant 消息里有没有 `tree_task_done`。 */
function isDoneCall(event) {
  return toolNamesOf(event).includes("tree_task_done");
}

/** 这条 assistant 消息里有没有 `tree_task_start`。 */
function isStartCall(event) {
  return toolNamesOf(event).includes("tree_task_start");
}

/** 这条消息是不是真人发的——插件注入的消息 source 是 plugin，不算。 */
function isHumanMessage(event) {
  return event?.type === "user/message" && event.data?.source?.kind === "user";
}

/** 这条消息是不是本插件自己落下的折叠通告。 */
function isPluginNotice(event) {
  return event?.type === "user/message" && isPluginSource(event.data?.source);
}

/**
 * `tree_task_requirement` 里算得上「把用户的话写进需求」的那几个动作。
 *
 * `archive` / `prerequisites` / `question` 不算：归档与设前置改的是关联，不是需求正文；
 * `question` 是"我还没看懂"，正好相反——那一段更不该被收走。
 */
const REQUIREMENT_WRITE_ACTIONS = new Set(["confirm", "update", "confirmChange"]);

/** 解析一次工具调用的实参；坏 JSON 返回 null。 */
function argsOf(call) {
  if (typeof call?.arguments !== "string") return null;
  try {
    const value = JSON.parse(call.arguments);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * 这条 assistant 消息里有没有「写需求」的调用。
 *
 * 这是 `docs/09` §7.2 那条前提的判据：区间里最晚的一条用户消息之后，必须有过一次写需求，
 * 那段过程才可以收。**它挡的是"忘了写"，挡不住"糊弄写"**——写进去的内容有没有真吸收，
 * 只有模型自己知道。
 *
 * @param event - 表层事件。
 * @returns 有写需求调用为 true。
 */
function isRequirementWriteCall(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (part?.type !== "tool-call") return false;
    if (part.name === "tree_task_create") return true;
    if (part.name !== "tree_task_requirement") return false;
    const args = argsOf(part);
    // 实参解析不出来就**不当**写入：宁可这次不折，也别把没吸收的过程收走。
    return args !== null && REQUIREMENT_WRITE_ACTIONS.has(String(args.action ?? ""));
  });
}

/**
 * 一次 `tree_task_done` 调用指向的节点 id。
 *
 * @param event - 表层事件。
 * @returns id；不是 done 调用或没给 id 时返回 null。
 */
function doneTargetId(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return null;
  const call = content.find((part) => part?.type === "tool-call" && part.name === "tree_task_done");
  if (call === undefined) return null;
  const args = argsOf(call);
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  return id === "" ? null : id;
}

/**
 * 这次 done 是不是在完成一条**需求**（而不是任务或步骤）。
 *
 * 需求完成要收走整条：从它开工那一刻起，连同中间那些任务级通告。
 *
 * @param event - 表层事件。
 * @param plan - 计划树（`null` 时一律当作不是需求完成）。
 * @returns 是需求完成返回它的编号，否则 null。
 */
function requirementDoneId(event, plan) {
  if (plan === null) return null;
  const id = doneTargetId(event);
  if (id === null) return null;
  return requirementOf(plan, id) === null ? null : id;
}

/** 从一次工具调用的参数里取它指向的文件路径；不是文件类调用就返回 null。 */
function filePathOf(call) {
  if (typeof call?.arguments !== "string") return null;
  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  const value = args?.file_path ?? args?.path;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * 被这次替换收走的那一段里，读过和写过哪些文件。
 *
 * 路径取自工具调用的 `file_path` / `path` 参数——界面列出文件变更用的是同一个来源。
 * 只认读写文件的工具：`pwsh` / `bash` 这类命令里碰过什么文件看不出来，不计入。
 *
 * @param session - 当前会话。
 * @param shadowed - 被收走的节点 seq，按位置顺序。
 * @returns `{ read, write }`，各是去重后的路径数组，按出现顺序。
 */
export function touchedFiles(session, shadowed) {
  const read = new Set();
  const write = new Set();
  for (const seq of shadowed) {
    const event = session.eventAt(seq);
    if (event?.type !== "assistant/message") continue;
    for (const part of event.data?.message?.content ?? []) {
      if (part?.type !== "tool-call") continue;
      const path = filePathOf(part);
      if (path === null) continue;
      if (WRITE_TOOLS.has(part.name)) write.add(path);
      else if (READ_TOOLS.has(part.name)) read.add(path);
    }
  }
  return { read: [...read], write: [...write] };
}

/**
 * 造一条汇总消息：它取代的是一段执行过程，携带的是"收走了什么"。
 *
 * 形态是 `notice` + `summary`：界面把它渲染成一行可读的说明，展开才是正文。
 * 刻意**不用** `snapshot`——那个形态是"运行时上下文快照"的专属标签，
 * 借用它会让任务汇总在界面上冒充系统提示词/运行环境快照。
 *
 * source 走 {@link pluginSource}：**必须是生产者自有的 kind**，否则 v4 会话
 * 会拒绝这条消息（见 `PLUGIN_SOURCE_KIND` 的说明）。
 */
export function summaryMessage(id, text, summary) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: pluginSource(summary),
  };
}

/**
 * 汇总消息的正文：只有两样东西——这次收走了多少条过程上下文、那一段里修改或生成了哪些文件。
 *
 * 文件列表是给后面用的：过程收走了，"这活改过哪些文件"得留下，否则模型要从头再找一遍。
 * 只列**写入**的文件：读取过的文件在后续步骤里通常还要再读一次，列出来只是噪音。
 *
 * 通告只讲折叠本身，不带任务、需求、笔记的提示——那些由工具返回负责。
 *
 * @param count - 被这次替换收走的节点条数。
 * @param files - `touchedFiles()` 的结果。
 * @returns 正文文本，可能多行。
 */
function renderSummary(count, files) {
  const lines = [`${NOTICE_PREFIX}此处隐藏了${count}条过程上下文。`];
  if (files.write.length > 0) {
    lines.push("其中修改或生成了文件：");
    lines.push(...files.write);
  }
  return lines.join("\n");
}

/**
 * 汇总消息的一行摘要（**不含统一前缀**——前缀由 `pluginSource` 加）。
 *
 * @param count - 被这次替换收走的节点条数。
 * @param files - `touchedFiles()` 的结果。
 * @returns 一行摘要。
 */
function summaryLine(count, files) {
  return files.write.length === 0
    ? `此处隐藏了${count}条过程上下文`
    : `此处隐藏了${count}条过程上下文 · 修改或生成 ${files.write.length} 个文件`;
}

/**
 * 这条 assistant 消息里有没有**新建目标**的那次 `tree_task_create`。
 *
 * 折叠起点只认这一种调用。**不能拿 `tree_task_plan` 顶替**：`plan` 在任务中途
 * 反复调用（每补一次步骤就调一次），而起点取的是"上一次 done 之后最早的那次"，
 * 于是每一次补步骤都会把起点往后推，`done` 与它之间那段过程永远收不走。
 * 靠实参里有没有 `parentId` 去区分也只是把"认错起点"的机会交给了模型——
 * 专门一个工具、按名字认，才是可靠的。
 *
 * @param event - 表层上的事件。
 * @returns 是否新建了目标。
 */
function isCreateCall(event) {
  return toolNamesOf(event).includes("tree_task_create");
}

/**
 * 找这一次要折叠的区间。
 *
 * 终点是末尾最近的一次**会触发折叠的边界调用**：`tree_task_start` 或 `tree_task_done`
 * （`tree_task_create` 只当起点用，它自己不触发折叠）。
 *
 * 起点分三种：
 *
 *   - `start`：上一次**折叠成功**的位置（`cursors.foldedAt`），那里没有（或已经被
 *     后一次折叠收走）就退回上一个边界调用；
 *   - `done` 完成的是任务 / 步骤：上一个边界调用（`done` / `start` / `create`）；
 *   - `done` 完成的是需求：一路退到这条需求开工的那次 `create`（「折全部」）。
 *
 * 边界调用本身永远留在表层，区间从它的 `tool/result` 之后开始。
 *
 * @param session - 当前会话。
 * @param plan - 计划树，只用来认出「完成的是不是一条需求」。
 * @param cursors - `store.readSurfaces()` 的结果，读 `foldedAt`；可以不给。
 * @returns `{ from, to, shadowed, trigger, requirementId }`；这一轮不该折时返回 null。
 */
export function foldRange(session, plan = null, cursors = null) {
  const nodes = session.surface?.nodes ?? [];
  if (typeof session.eventAt !== "function" || nodes.length === 0) return null;

  // 终点：末尾最近的一次 start / done。两个都没有（比如刚 create 完）就不折。
  let endIdx = -1;
  let trigger = null;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index]);
    if (isDoneCall(event)) {
      endIdx = index;
      trigger = "done";
      break;
    }
    if (isStartCall(event)) {
      endIdx = index;
      trigger = "start";
      break;
    }
  }
  if (endIdx === -1) return null;

  // 这次 done 是不是在完成一条需求？是的话，起点要一路退到它开工那一刻，
  // 把中间那些任务级通告也一并收掉（`docs/09` §7.1）。
  const requirementId =
    trigger === "done" ? requirementDoneId(session.eventAt(nodes[endIdx]), plan) : null;

  // 默认起点：这次触发之前最近的一次边界调用。
  let startIdx = -1;
  for (let index = endIdx - 1; index >= 0; index -= 1) {
    if (isBoundaryCall(session.eventAt(nodes[index]))) {
      startIdx = index;
      break;
    }
  }

  // 需求级折叠：退到「上一次需求完成」之后最早的那次 create。
  if (requirementId !== null) {
    let anchorIdx = -1;
    for (let index = endIdx - 1; index >= 0; index -= 1) {
      if (requirementDoneId(session.eventAt(nodes[index]), plan) !== null) {
        anchorIdx = index;
        break;
      }
    }
    startIdx = -1;
    for (let index = anchorIdx + 1; index < endIdx; index += 1) {
      if (isCreateCall(session.eventAt(nodes[index]))) {
        startIdx = index;
        break;
      }
    }
    if (startIdx === -1) startIdx = anchorIdx;
  }

  // start 折叠：从**上一次折叠成功**的地方起；一次都没成功过，就退回这次开工的那次
  // create。这里**不保护中间那些边界调用**——它们都在"上次折叠成功"之后就都属于
  // 这条需求的过程，留着只是白占上下文（start 的返回里会把需求详情重新给一遍）。
  if (trigger === "start") {
    startIdx = -1;
    const foldedAt = Number(cursors?.foldedAt ?? 0);
    if (foldedAt > 0) {
      const at = nodes.indexOf(foldedAt);
      if (at !== -1) startIdx = at;
    }
    if (startIdx === -1) {
      for (let index = endIdx - 1; index >= 0; index -= 1) {
        if (isCreateCall(session.eventAt(nodes[index]))) {
          startIdx = index;
          break;
        }
      }
    }
  }

  // 区间从起点调用的 `tool/result` 之后开始；找不到起点（-1）就退回表层第一个节点之后
  // （节点 0 是系统提示词，受 DSH 的重写保护，不能进替换区间）。
  //
  // 还要跳过紧邻的两样东西：那次调用自己的 `tool/result`，以及**上一次折叠落下的通告**
  // ——后者虽然夹在区间里，却已经是收过的结果，再收一次就会一轮轮空折下去。
  let from = startIdx === -1 ? 1 : startIdx + 1;
  while (from < endIdx) {
    const event = session.eventAt(nodes[from]);
    if (event?.type === "tool/result") {
      from += 1;
      continue;
    }
    // 上一次折叠落下的通告：普通折叠要跳过它（它已经是收过的结果，再收一次会一轮轮空折下去）；
    // **需求级折叠反过来要收它**——那些任务级通告正是这条需求的历史，留着就是层层堆叠。
    if (requirementId === null && isPluginNotice(event)) {
      from += 1;
      continue;
    }
    break;
  }
  const to = endIdx - 1;
  if (from > to) return null;

  // 区间里只剩上一次折叠留下的通告（和那几次调用的 tool/result）时，什么都不做。
  //
  // 需求级折叠**故意不跳过通告**（那些任务级通告是这条需求的历史，第一次折全部时要一起收
  // 走）。可是折完之后区间里就只剩刚插进去的那条通告了，`tree_task_done` 的调用还在表层
  // 上，终点于是每次都指向它——再折一次等于拿一条新通告换掉一条旧通告，**每个 step 都插
  // 一条**。2026-11-07 现场：R8 完成后连着插了几十条「隐藏了1条过程上下文」。
  let hasContent = false;
  for (let index = from; index <= to; index += 1) {
    const event = session.eventAt(nodes[index]);
    if (event?.type === "tool/result" || isPluginNotice(event)) continue;
    hasContent = true;
    break;
  }
  if (!hasContent) return null;

  return {
    from,
    to,
    endIdx,
    requirementId,
    trigger,
    shadowed: nodes.slice(from, to + 1),
  };
}

/**
 * 这一次折叠会不会被「用户的话还没写进需求」挡住。
 *
 * 判据（`docs/09` §7.2）：区间里**最晚的那条用户消息之后**必须有过一次写需求。
 * 一次写需求盖住它之前的所有用户消息，所以只比最晚那一条就够。
 *
 * @param session - 当前会话。
 * @param range - `foldRange()` 的结果。
 * @returns `{ seq }`（被挡住时）或 null。
 */
export function foldBlockReason(session, range) {
  const nodes = session.surface.nodes;

  // 从后往前找区间里最晚的一条真人消息。
  let humanSeq = null;
  for (let index = range.to; index >= range.from; index -= 1) {
    if (isHumanMessage(session.eventAt(nodes[index]))) {
      humanSeq = nodes[index];
      break;
    }
  }
  if (humanSeq === null) return null;

  for (let index = range.from; index < range.endIdx; index += 1) {
    if (nodes[index] <= humanSeq) continue;
    if (isRequirementWriteCall(session.eventAt(nodes[index]))) return null;
  }
  return { seq: humanSeq };
}

/**
 * 给调用方看的一眼预览：这一次会不会折、被挡的话是哪一条用户消息。
 *
 * `tree_task_done` 用它把「这段收不走、先去写需求」直接说在返回里——那一刻模型刚完成
 * 一个节点，最容易顺手把用户的话落进需求。
 *
 * @param session - 当前会话。
 * @param plan - 计划树。
 * @param cursors - 游标（读 `foldedAt`）；可以不给。
 * @returns `{ folds, blocked, requirementId, trigger }`。
 */
export function previewFold(session, plan, cursors = null) {
  const range = foldRange(session, plan, cursors);
  if (range === null) return { folds: false, blocked: null, requirementId: null, trigger: null };
  return {
    folds: true,
    blocked: foldBlockReason(session, range),
    requirementId: range.requirementId,
    trigger: range.trigger,
  };
}

/**
 * 折一次：把边界调用之间那一段过程收走，换成一条说明收走了什么的短消息。
 *
 * 一轮最多折一次——折完这一段就已经不在上下文里了。
 *
 * @param ctx - 挂载本行的 Cordis 上下文，只用来记日志。
 * @param session - 当前会话。
 * @param plan - 计划树，用来认出「这次完成的是不是一条需求」并拼出活跃需求指针。
 * @param store - 状态读写（笔记要跟着通告走）。
 * @param cursors - 游标；给了就把这次折叠成功的位置记进 `foldedAt`。
 * @returns 是否真的替换了内容。
 */
export function foldOnce(ctx, session, plan = null, store = null, cursors = null) {
  const range = foldRange(session, plan, cursors);
  if (range === null) return false;

  // 用户的话还没写进需求：整段不折（`docs/09` §7.2）。不说出来，模型就永远不知道该先写需求。
  if (foldBlockReason(session, range) !== null) return false;

  const nodes = session.surface.nodes;
  const files = touchedFiles(session, range.shadowed);
  try {
    session.append(
      "user/message",
      summaryMessage(
        foldId(),
        renderSummary(range.shadowed.length, files),
        summaryLine(range.shadowed.length, files),
      ),
      {
        surfaceOp: { op: "replace", startSeq: nodes[range.from], endSeq: nodes[range.to] },
        sourceEventSeqs: range.shadowed,
      },
    );
    // 这次折叠成功的位置 = 刚插进去的那条通告。下一次 start 就从它之后补折
    // （被挡过的那几段因此还有机会收走）。通告落在原区间起点那个下标上。
    if (cursors !== null && typeof cursors === "object") {
      const notice = session.surface?.nodes?.[range.from];
      if (notice !== undefined) cursors.foldedAt = notice;
    }
    return true;
  } catch (error) {
    // 注入失败不能拖垮会话，原区间原样留着，下一轮还有机会。
    ctx.logger?.warn?.(`dsh-tree-task-flow: 折叠失败，保留原区间：${String(error?.message ?? error)}`);
    return false;
  }
}

/**
 * 把三层游标对齐到当前的节点路径。
 *
 * 游标**不参与折叠区间的计算**（那由 `foldRange` 在表层上现算），它只记"这一层走到
 * 哪儿了"，给界面和排查用。一层的 key 变了（换节点了）就重建这个槽，游标落在
 * **进入这一层那一刻的末尾节点**上。
 *
 * 上层重建会顺带重建下层：上层一换，下层的边界就已经并进上层了。
 *
 * @param session - 当前会话。
 * @param cursors - `store.readSurfaces()` 读出来的游标对象，**就地修改**。
 * @param active - `activePath(plan)` 的结果；`null` 表示整棵树已结束。
 * @returns 是否有改动（调用方据此决定要不要写盘）。
 */
export function syncCursors(session, cursors, active) {
  const tail = tailSeq(session);
  let changed = false;
  let outerRebuilt = false;

  for (const level of LEVELS) {
    const key = active?.[level]?.id ?? null;
    const slot = cursors[level] ?? null;
    // `Object.hasOwn` 同时挡住旧格式留下的槽：那种槽没有 cursor 字段，
    // 直接当成没对齐、重建一次就好，不必迁移磁盘上的文件。
    const aligned =
      slot !== null && key !== null && slot.key === key && Object.hasOwn(slot, "cursor");
    if (aligned && !outerRebuilt) continue;

    // 外层一旦重建（或清空），内层的边界就已经并进外层了，无论 key 是否相同都要重来。
    outerRebuilt = true;
    if (key === null) {
      if (slot !== null) {
        cursors[level] = null;
        changed = true;
      }
      continue;
    }
    cursors[level] = { key, cursor: tail };
    changed = true;
  }

  return changed;
}

/**
 * 注册折叠。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store }`。
 */
export function registerRegion(ctx, { store }) {
  ctx.on("agent/pre-step", async (payload, next) => {
    // 先让其余监听器跑完，此时本步的一切决定都已落定。
    const decision = await next();
    if (decision?.kind === "reject" || payload?.signal?.aborted) return decision;

    const session = payload?.agent?.session;
    if (session === undefined) return decision;

    const sessionId = session.id;
    const plan = store.readPlan(sessionId);
    if (plan === null) return decision;

    // 折叠只看表层：边界调用之间那一段过程。计划树只用来认出「这次完成的是不是一条需求」，
    // 需求完成时起点要一路退到它开工那一刻。游标里的 `foldedAt` 是 start 折叠的起点。
    const cursors = store.readSurfaces(sessionId);
    let changed = foldOnce(ctx, session, plan, store, cursors);

    // 三层游标照旧维护，它是给界面看的，不参与上面那次判断。
    if (syncCursors(session, cursors, activePath(plan))) changed = true;

    if (changed) {
      cursors.sessionId = sessionId;
      cursors.updatedAt = Date.now();
      store.writeSurfaces(sessionId, cursors);
    }
    return decision;
  });
}
