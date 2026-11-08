/**
 * 十个 `tree_task_*` 工具。
 *
 * 语义分三层：
 *
 *   - **需求**（`tree_task_create` / `tree_task_requirement` / `tree_task_start`）——用户要什么；
 *   - **任务与步骤**（`tree_task_plan` / `tree_task_update` / `tree_task_drop` / `tree_task_delete`）——
 *     AI 怎么把它做出来；
 *   - **查询与笔记**（`tree_task_status` / `tree_task_note`）。
 *
 * ## 为什么 `create` / `start` / `done` 必须各占一个名字
 *
 * 它们划出过程折叠的区间（见 `lib/region.js` 与 `docs/06`）：`create` 是需求的起点标记，
 * `start` 是开工并折叠资料段，`done` 是完成并折叠一段。`plan` 在任务中途反复调用，一旦让它兼任
 * 起点，每次补步骤都会把起点往后推，`done` 与它之间那段过程就永远收不走。所以边界
 * **按工具名认，不看实参**。`tree_task_requirement` 是中途动作（确认变更、归档、设前置），
 * **不是边界**。
 *
 * 工具本身**只做状态读写**——不注入消息、不动 surface。「完成时把那一段过程折起来」
 * 由 `agent/pre-step` 监听器负责。
 *
 * 所有工具共用同一套契约：
 * - `parameters` 用**原始 JSON Schema**（不能 import 宿主的 schemastery）
 * - 返回 `{ text }`，由 `output.render` 渲染成一个文本块
 *
 * @module dsh-tree-task-flow/tools
 */

import { findNotes, renderNoteLines, upsertNote } from "./notes.js";
import { renderAdded, renderDetail, renderList, renderNotes, statusLabel } from "./render.js";
import {
  addChildren,
  complete,
  continueNote,
  deleteNode,
  dropNode,
  findNode,
  goalsOf,
  updateNode,
} from "./plan.js";
import {
  REQUIREMENT_STATUS,
  addDraft,
  confirmPending,
  confirmRequirement,
  completeRequirement,
  deleteRequirement,
  dropRequirement,
  listActive,
  listArchived,
  listDrafts,
  isDraft,
  questionPending,
  requirementOf,
  setArchived,
  setPrerequisites,
  taskCompletionHints,
  updateByAi,
  activeRequirement,
} from "./requirement.js";
import { previewFold, tailSeq } from "./region.js";

/** 所有工具统一的返回形状与渲染。 */
const OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
  },
  render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
};

/** 统一包装返回值。 */
const ok = (text) => ({ text });

/**
 * 判断一个 id 指的是不是需求（需求住在 `plan.goals` 里，层级名仍是 `goal`）。
 *
 * @param found - `findNode()` 的结果。
 * @returns 是需求为 true。
 */
function isRequirementNode(found) {
  return found !== null && found.level === "goal";
}

/**
 * 把「一个 id」或「一批 ids」读成一个去重后的列表。
 *
 * 批量只给那些**入参就一个小东西、彼此不冲突**的动作用（放弃、删除、归档）：
 * 一次说清一批，省掉来回奔波的调用。带正文的动作（改标题、写 result）不批量——
 * 那些的入参本来就是大头，合并没有意义。
 *
 * @param args - 工具实参。
 * @returns id 列表，可能为空。
 */
function idListOf(args) {
  const list = [];
  if (typeof args?.id === "string" && args.id.trim() !== "") list.push(args.id.trim());
  if (Array.isArray(args?.ids)) {
    for (const each of args.ids) {
      if (typeof each === "string" && each.trim() !== "") list.push(each.trim());
    }
  }
  return [...new Set(list)];
}

/**
 * 下一步那句话：`continueNote` 给的文本（已经自带句号），这里只取文本。
 *
 * @param plan - 计划。
 * @returns 一句话。
 */
function nextStep(plan) {
  return continueNote(plan).text;
}

/**
 * 完成之后补的那一句：这一段过程这次能不能收走。
 *
 * 折叠发生在下一步之前（`agent/pre-step`），工具这一刻已经能算出结果，所以把「收不走、
 * 先写需求」直接说在返回里——刚完成一个节点的时候，模型最容易顺手把用户的话落进需求。
 *
 * @param session - 当前会话。
 * @param plan - 计划树。
 * @param cursors - 游标（`foldedAt` 决定起点）；可以不给。
 * @returns 一行文本，或空数组。
 */
function foldNote(session, plan, cursors = null) {
  if (session === undefined || session === null) return [];
  let preview;
  try {
    preview = previewFold(session, plan, cursors);
  } catch {
    return [];
  }
  if (preview.folds !== true || preview.blocked === null) return [];
  return [
    `本次折叠未执行：区间内有一条用户消息（seq ${preview.blocked.seq}）尚未写入需求。` +
      "先用 tree_task_requirement 的 update 动作写进需求，下一次调用就会折叠。",
  ];
}

/**
 * 注册全部工具。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, cfg }`。
 */
export function registerTools(ctx, { store, cfg }) {
  const sessionOf = (exec) => exec?.agent?.session?.id ?? null;

  // 游标只在有状态后端时读得到（自检里那套假 store 没有这一层）。读不到就当没有：
  // 折叠退回「上一个边界」，不影响正确性。
  const cursorsOf = (sessionId) => {
    try {
      return typeof store.readSurfaces === "function" ? store.readSurfaces(sessionId) : null;
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------- 查询

  ctx.tools.register({
    name: "tree_task_status",
    description:
      "取回这个会话的需求列表（YAML：active / archived / drafts），并展开当前进行中需求的任务与步骤。" +
      "给 ids 时按编号返回指定需求的完整信息（YAML）。开工前、上下文被压缩之后、或不确定下一步时调用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "要查的需求编号，例如 [\"R1\",\"R5\"]。填了就不返回列表，只返回这几条的全貌。",
        },
        match: { type: "string", description: "按关键词过滤需求，匹配标题、简介、详情。" },
        include: {
          type: "array",
          items: { type: "string", enum: ["detail", "versions", "tasks"] },
          description: "给 ids 时生效，默认 detail 和 tasks；versions 是版本历史，tasks 是任务与结果。",
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      const include = Array.isArray(args?.include) ? args.include : ["detail", "tasks"];
      const ids = Array.isArray(args?.ids) ? args.ids.map((id) => String(id)) : [];

      if (ids.length > 0) {
        const chunks = [];
        for (const id of ids) {
          const requirement = requirementOf(plan, id);
          if (requirement === null) {
            chunks.push(`找不到需求 ${id}。`);
            continue;
          }
          chunks.push(renderDetail(plan, requirement, include));
        }
        return ok(chunks.join("\n\n---\n\n"));
      }

      if (plan === null) {
        return ok("这个会话还没有需求。先用 tree_task_create 记录需求草稿。");
      }

      const keyword = String(args?.match ?? "").trim().toLowerCase();
      const keep = (requirement) =>
        keyword === "" ||
        `${requirement.title} ${requirement.intro} ${requirement.detail}`.toLowerCase().includes(keyword);
      // 列表接口给的是摘要行，展开要用原对象。
      const pick = (rows) =>
        rows.map((row) => requirementOf(plan, row.id)).filter((item) => item !== null).filter(keep);

      const rows = {
        active: pick(listActive(plan)),
        archived: pick(listArchived(plan)),
        drafts: pick(listDrafts(plan)),
      };
      return ok(renderList(plan, rows, activeRequirement(plan)));
    },
  });

  // ---------------------------------------------------------------- 需求

  ctx.tools.register({
    name: "tree_task_create",
    description:
      "记录一条需求草稿。给出已知的标题、简介、详情，不确定的字段留空。" +
      "草稿用 tree_task_requirement 的 update 动作逐次修改正文，再用 confirm 动作确认并生成版本。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "标题，不超过 50 字。用户说得很清楚时直接填。" },
        intro: { type: "string", description: "简介，不超过 200 字，说明用户要什么。" },
        detail: {
          type: "string",
          description: "详情，不限长。用户原话、背景、约束都可以放；只有 AI 能写。",
        },
        tasks: {
          type: "array",
          description: "用户已说明要做的任务时一并给出；未说明则留空，开工时再拆。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "任务标题" },
              detail: { type: "string", description: "补充说明" },
            },
            required: ["title"],
          },
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      let plan = store.readPlan(sessionId);
      if (plan === null) {
        plan = { version: 3, createdAt: Date.now(), updatedAt: Date.now(), goals: [] };
      }
      const requirement = addDraft(plan, args ?? {});

      // 用户一口气写全的那种（标题、简介都有）：仍然要确认一次，但不必重复提问。
      if (requirement.tasks.length > 0) {
        addChildrenTasks(plan, requirement);
      }
      store.writePlan(sessionId, plan);

      return ok(
        [
          `已记下需求草稿 ${requirement.id}。`,
          "",
          "确认之前仍是草稿。用 tree_task_requirement 的 update 动作补充正文（标题不超过 50 字，",
          "简介不超过 200 字），再用 confirm 动作确认并生成版本。",
        ].join("\n"),
      );
    },
  });

  ctx.tools.register({
    name: "tree_task_requirement",
    description:
      "修改需求的状态或正文。每个动作都要给 id；archive / unarchive 可以只给 ids。\n" +
      "- update：修改需求正文，只改给出的字段，其余字段保持不变；更新后需求回到草稿，可多次调用。\n" +
      "- confirm：确认草稿为正式需求并生成版本（第一次为 v1，之后每次确认版本号加一）。\n" +
      "- confirmChange：确认用户提交的暂定版本（版本号加一）。\n" +
      "- question：暂定版本有歧义时，把疑问写进 question。\n" +
      "- archive / unarchive：从活跃列表移出或移回，可批量。\n" +
      "- prerequisites：设置前置需求；ids 是前置需求编号，整体替换，空数组清空。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "需求编号，例如 R3。archive / unarchive 可只给 ids。" },
        action: {
          type: "string",
          enum: ["confirm", "update", "confirmChange", "question", "archive", "unarchive", "prerequisites"],
          description: "要执行的动作",
        },
        title: { type: "string", description: "标题（不超过 50 字）。confirm 时可沿用草稿标题，update 时用于修改标题。" },
        intro: { type: "string", description: "简介（不超过 200 字）" },
        detail: { type: "string", description: "需求详情，不限长度" },
        change: {
          type: "string",
          description: "本次修改的说明，写入版本历史。confirm 时默认「初始需求」。",
        },
        question: { type: "string", description: "action=question 时要问用户的话（必填）" },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "prerequisites 时是前置需求编号；archive / unarchive 时是批量处理的需求编号。",
        },
      },
      required: ["action"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const plan = store.readPlan(sessionId);
      if (plan === null) return ok("这个会话还没有需求。");
      const id = String(args?.id ?? "");
      const action = String(args?.action ?? "");
      const patch = { title: args?.title, intro: args?.intro, detail: args?.detail, change: args?.change };

      let said = null;
      if (action === "confirm") {
        const result = confirmRequirement(plan, id, patch);
        if (!result.ok) return ok(`没有确认：${result.reason}`);
        said = `已确认 ${id} 为正式需求（v${result.version.n}）。`;
      } else if (action === "update") {
        const result = updateByAi(plan, id, patch);
        if (!result.ok) return ok(`没有修改：${result.reason}`);
        said = result.noop === true
          ? `${id} 的正文没有变化，只登记了这次说明。`
          : `已改动 ${id} 的需求正文（仍是草稿，确认后生成版本）。`;
      } else if (action === "confirmChange") {
        const result = confirmPending(plan, id, args?.change);
        if (!result.ok) return ok(`没有确认：${result.reason}`);
        said = `已确认 ${id} 的改动（v${result.version.n}）。`;
      } else if (action === "question") {
        const result = questionPending(plan, id, args?.question);
        if (!result.ok) return ok(`没有退回：${result.reason}`);
        said = `已把疑问记在 ${id} 上，暂定版本留着等用户改。`;
      } else if (action === "archive" || action === "unarchive") {
        const word = action === "archive" ? "归档" : "取消归档";
        const targets = idListOf(args);
        if (targets.length === 0) return ok(`没有${word}：要给 id 或 ids。`);
        const changed = [];
        const same = [];
        const failed = [];
        for (const each of targets) {
          const result = setArchived(plan, each, action === "archive");
          if (!result.ok) {
            failed.push(`${each}（${result.reason}）`);
            continue;
          }
          (result.changed ? changed : same).push(each);
        }
        if (targets.length === 1) {
          if (failed.length > 0) return ok(`没有${word}：${failed.join("、")}`);
          said =
            changed.length === 1
              ? `${id} 已${word}。`
              : `${id} 本来${action === "archive" ? "就是归档状态" : "没归档"}，没动。`;
        } else {
          const parts = [];
          if (changed.length > 0) parts.push(`已${word} ${changed.length} 条：${changed.join("、")}`);
          if (same.length > 0) parts.push(`${same.length} 条本来就是这个状态：${same.join("、")}`);
          if (failed.length > 0) parts.push(`${failed.length} 条没动：${failed.join("、")}`);
          said = `${parts.join("；")}。`;
        }
      } else if (action === "prerequisites") {
        const result = setPrerequisites(plan, id, args?.ids);
        if (!result.ok) return ok(`没有设置：${result.reason}`);
        said = `${id} 的前置已设为：${(result.requirement.prerequisites ?? []).join("、") || "无"}。`;
      } else {
        return ok(`不认识的动作：${action}`);
      }

      store.writePlan(sessionId, plan);
      const requirement = requirementOf(plan, id);
      if (requirement === null) return ok(said);
      return ok(`${said}\n\n${renderDetail(plan, requirement, ["detail"])}`);
    },
  });

  // ---------------------------------------------------------------- 任务

  ctx.tools.register({
    name: "tree_task_plan",
    description:
      "向需求追加任务，或向任务追加步骤。任务是可独立验收的交付；步骤是一次可以完成的工作单元，不能再拆。" +
      "调用前先读完所需资料。新建需求用 tree_task_create。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentId: { type: "string", description: "父节点 id：需求编号或任务 id。" },
        children: {
          type: "array",
          description: "要追加的子节点，按执行顺序；父节点是需求时是任务，是任务时是步骤。至少给一个。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "子节点标题" },
              detail: { type: "string", description: "补充说明" },
            },
            required: ["title"],
          },
        },
      },
      required: ["parentId", "children"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const plan = store.readPlan(sessionId);
      if (!plan) return ok("这个会话还没有需求。先用 tree_task_create 记录需求草稿。");
      const result = addChildren(plan, args?.parentId, args?.children);
      if (!result.ok) return ok(`没有添加：${result.reason}`);
      store.writePlan(sessionId, plan);
      const found = findNode(plan, args?.parentId);
      const lines = [renderAdded(result.added, result.level), renderDetail(plan, found.goal, ["tasks"])];
      return ok(lines.join("\n"));
    },
  });

  ctx.tools.register({
    name: "tree_task_start",
    description:
      "开始一条已确认的需求：返回需求详情（简介、详情、前置、任务与步骤），并记录开工点。" +
      "调用前先读取完成本需求所需的文件与文档。本次调用会折叠上一次折叠成功位置到本次 start 之前的过程；" +
      "这次开工到需求完成之间的过程，在需求完成时整条折叠。草稿不能开始，先用 confirm 确认。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要开始的需求编号。" },
      },
      required: ["id"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const plan = store.readPlan(sessionId);
      if (!plan) return ok("这个会话还没有需求。");

      const requirement = requirementOf(plan, String(args?.id ?? ""));
      if (requirement === null) return ok(`没有开始：找不到需求 ${args?.id}`);
      if (isDraft(requirement)) {
        return ok(
          `没有开始：${requirement.id} 仍是草稿。先用 tree_task_requirement 的 confirm 动作确认，再开始。`,
        );
      }
      if (requirement.status !== REQUIREMENT_STATUS.OPEN) {
        return ok(`没有开始：${requirement.id} 已经是${statusLabel(requirement)}，不能再开工。`);
      }

      const now = Date.now();
      requirement.startedAt = now;
      requirement.updatedAt = now;
      plan.updatedAt = now;
      store.writePlan(sessionId, plan);

      const lines = [`${requirement.id} 需求开始，需求详情：`, renderDetail(plan, requirement, ["detail", "tasks"])];
      lines.push(...foldNote(exec?.agent?.session, plan, cursorsOf(sessionId)));
      return ok(lines.filter((line) => line !== "").join("\n"));
    },
  });

  ctx.tools.register({
    name: "tree_task_done",
    description:
      "完成步骤、任务或需求，并记录结果。每完成一个步骤调用一次；多个节点完成时分别调用，不要合并成一次。" +
      "完成后折叠这段执行过程：完成步骤或任务时，折叠上一个 done 或 start 到本次调用之前的过程；" +
      "完成需求时，折叠这条需求从开工到本次调用之前的全部过程。折叠后只保留 result，result 必须能独立看懂：" +
      "步骤写这一步做了什么；任务写交付物、验证方式、已知限制；需求写总结（做了什么、结论、遗留问题）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要完成的节点：需求编号、任务 id 或步骤 id。" },
        result: {
          type: "string",
          description: "这个节点产出了什么。折叠后只保留这段文本，所以必须能独立看懂。",
        },
      },
      required: ["id", "result"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const plan = store.readPlan(sessionId);
      if (!plan) return ok("这个会话还没有需求。");

      const found = findNode(plan, args?.id);
      if (found === null) return ok(`没有完成：找不到节点 ${args?.id}`);

      const id = String(args?.id ?? "");
      const label = found.level === "goal" ? "需求" : found.level === "task" ? "任务" : "步骤";
      const lines = [`${id} ${label}已完成，结果：`, String(args?.result ?? ""), ""];

      if (isRequirementNode(found)) {
        const done = completeRequirement(plan, id, args?.result);
        if (!done.ok) return ok(`没有完成：${done.reason}`);
        store.writePlan(sessionId, plan);
        const next = activeRequirement(plan);
        lines.push(next === null ? "请把结果交付给用户。" : `后续需求：${next.id}「${next.title}」`);
        lines.push(...(done.hints ?? []));
      } else {
        const done = complete(plan, id, args?.result);
        if (!done.ok) return ok(`没有完成：${done.reason}`);
        store.writePlan(sessionId, plan);
        lines.push(`后续：${nextStep(plan)}`);
        lines.push(...taskCompletionHints(found.goal));
      }

      lines.push(...foldNote(exec?.agent?.session, plan, cursorsOf(sessionId)));

      return ok(lines.filter((line) => line !== "").join("\n"));
    },
  });

  ctx.tools.register({
    name: "tree_task_update",
    description:
      "修改任务或步骤的标题与说明。修改需求正文用 tree_task_requirement 的 update 动作。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "任务或步骤的 id" },
        title: { type: "string", description: "新的标题" },
        detail: { type: "string", description: "新的说明" },
      },
      required: ["id"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const plan = store.readPlan(sessionId);
      if (!plan) return ok("这个会话还没有需求。");
      const found = findNode(plan, args?.id);
      if (isRequirementNode(found)) {
        return ok(
          `没有修改：${args?.id} 是需求，改它请用 tree_task_requirement action=update（要留版本历史）。`,
        );
      }
      const result = updateNode(plan, args?.id, args ?? {});
      if (!result.ok) return ok(`没有修改：${result.reason}`);
      store.writePlan(sessionId, plan);
      const after = findNode(plan, args?.id);
      return ok(`已更新 ${result.changed.join(" / ")}。\n\n${renderDetail(plan, after.goal, ["tasks"])}`);
    },
  });

  ctx.tools.register({
    name: "tree_task_drop",
    description:
      "放弃节点：标记为不再执行，保留在树中可查。放弃需求时，其下未完成的任务与步骤一并放弃，已完成节点不变。" +
      "给 id 或 ids，至少给出一个。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要放弃的节点 id" },
        ids: { type: "array", items: { type: "string" }, description: "要放弃的一批节点 id" },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const plan = store.readPlan(sessionId);
      if (!plan) return ok("这个会话还没有需求。");

      const targets = idListOf(args);
      if (targets.length === 0) return ok("没有放弃：要给 id 或 ids。");

      if (targets.length === 1) {
        const id = targets[0];
        const found = findNode(plan, id);
        if (found === null) return ok(`没有放弃：找不到节点 ${id}`);

        if (isRequirementNode(found)) {
          const result = dropRequirement(plan, id);
          if (!result.ok) return ok(`没有放弃：${result.reason}`);
          store.writePlan(sessionId, plan);
          return ok([`已放弃需求 ${id}：${result.dropped.join("、")}`, nextStep(plan)].join("\n"));
        }

        const result = dropNode(plan, id);
        if (!result.ok) return ok(`没有放弃：${result.reason}`);
        store.writePlan(sessionId, plan);
        return ok(
          [`已放弃：${result.dropped.join("、")}`, "", renderDetail(plan, found.goal, ["tasks"]), "", nextStep(plan)].join(
            "\n",
          ),
        );
      }

      // 批量：按给的顺序一个个来，前面被父节点带走的后面就找不到了——记成「已经不在了」。
      const dropped = [];
      const gone = [];
      const failed = [];
      for (const each of targets) {
        const found = findNode(plan, each);
        if (found === null) {
          gone.push(each);
          continue;
        }
        const result = isRequirementNode(found) ? dropRequirement(plan, each) : dropNode(plan, each);
        if (!result.ok) {
          failed.push(`${each}（${result.reason}）`);
          continue;
        }
        dropped.push(...result.dropped);
      }
      if (dropped.length === 0) {
        return ok([`没有放弃：${[...gone, ...failed].join("、")}`, nextStep(plan)].join("\n"));
      }
      store.writePlan(sessionId, plan);
      const lines = [`已放弃 ${dropped.length} 个节点：${dropped.join("、")}`];
      if (gone.length > 0) lines.push(`（${gone.length} 个已经不在了：${gone.join("、")}）`);
      if (failed.length > 0) lines.push(`（${failed.length} 个没动：${failed.join("、")}）`);
      lines.push("", nextStep(plan));
      return ok(lines.join("\n"));
    },
  });

  ctx.tools.register({
    name: "tree_task_delete",
    description:
      "删除节点：从树中物理移除，不可逆，不保留状态，其下子节点一并移除。" +
      "仅在内容错误、重复创建、结果记错位置时使用；不再执行的节点用 tree_task_drop。" +
      "给 id 或 ids，至少给出一个。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要删除的节点 id" },
        ids: { type: "array", items: { type: "string" }, description: "要删除的一批节点 id" },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const plan = store.readPlan(sessionId);
      if (!plan) return ok("这个会话还没有需求。");

      const targets = idListOf(args);
      if (targets.length === 0) return ok("没有删除：要给 id 或 ids。");

      if (targets.length === 1) {
        const id = targets[0];
        const found = findNode(plan, id);
        const result = isRequirementNode(found) ? deleteRequirement(plan, id) : deleteNode(plan, id);
        if (!result.ok) return ok(`没有删除：${result.reason}`);
        store.writePlan(sessionId, plan);

        const lines = [`已删除：${result.removed.join("、")}`, ""];
        if (found !== null && !isRequirementNode(found)) {
          // 删的是任务或步骤：它所在的那条需求还在，把这条需求的进度给出来。
          const owner = findNode(plan, found.goal.id);
          lines.push(owner === null ? "" : renderDetail(plan, owner.node, ["tasks"]));
        } else {
          const rest = goalsOf(plan).length;
          lines.push(
            rest === 0
              ? "这个会话现在没有需求了。用 tree_task_create 记录需求草稿。"
              : `这个会话还剩 ${rest} 条需求，要看细节用 tree_task_status。`,
          );
        }
        lines.push("", nextStep(plan));
        return ok(lines.join("\n"));
      }

      // 批量：按给的顺序一个个来，前面被父节点带走的后面就找不到了——记成「已经不在了」。
      const removed = [];
      const gone = [];
      const failed = [];
      for (const each of targets) {
        const found = findNode(plan, each);
        if (found === null) {
          gone.push(each);
          continue;
        }
        const result = isRequirementNode(found) ? deleteRequirement(plan, each) : deleteNode(plan, each);
        if (!result.ok) {
          failed.push(`${each}（${result.reason}）`);
          continue;
        }
        removed.push(...result.removed);
      }
      if (removed.length === 0) {
        return ok([`没有删除：${[...gone, ...failed].join("、")}`, nextStep(plan)].join("\n"));
      }
      store.writePlan(sessionId, plan);
      const rest = goalsOf(plan).length;
      const lines = [
        `已删除 ${removed.length} 个节点：${removed.join("、")}`,
        ...(gone.length > 0 ? [`（${gone.length} 个已经不在了：${gone.join("、")}）`] : []),
        ...(failed.length > 0 ? [`（${failed.length} 个没动：${failed.join("、")}）`] : []),
        "",
        rest === 0
          ? "这个会话现在没有需求了。用 tree_task_create 记录需求草稿。"
          : `这个会话还剩 ${rest} 条需求，要看细节用 tree_task_status。`,
        "",
        nextStep(plan),
      ];
      return ok(lines.join("\n"));
    },
  });

  // ---------------------------------------------------------------- 笔记

  ctx.tools.register({
    name: "tree_task_note",
    description:
      "记录与当前工作有关、但不属于任何单条需求的事实与偏好，例如构建入口、已遇到的问题、对产出的要求。" +
      "同时给出 key 与 text 为写入；同一 key 再次写入会覆盖并递增修订号。" +
      "查询时只给 query；不给任何参数返回全部。上下文中同名笔记以修订号最大的为准。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string", description: "笔记的短名称，例如「构建入口」" },
        text: { type: "string", description: "笔记正文" },
        query: { type: "string", description: "查询关键词" },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const key = String(args?.key ?? "").trim();
      const text = String(args?.text ?? "").trim();

      if (key === "" && text === "") {
        const state = store.readNotes(sessionId);
        return ok(renderNotes(findNotes(state, args?.query), args?.query));
      }

      const state = store.readNotes(sessionId);
      const note = upsertNote(state, { key, text, seq: tailSeq(exec?.agent?.session) });
      if (!note.ok) return ok(`没有记下：${note.reason}`);
      store.writeNotes(sessionId, state);
      return ok(
        [
          `${note.created ? "已记下" : "已更新"}笔记「${note.note.key}」(r${note.note.rev})。`,
          "",
          renderNoteLines([note.note]),
        ].join("\n"),
      );
    },
  });

  void cfg;
}

/**
 * 草稿自带任务时，把它们挂到这条需求下面。
 *
 * @param plan - 计划。
 * @param requirement - 刚建的草稿（`tasks` 里是 `{title, detail}`）。
 */
function addChildrenTasks(plan, requirement) {
  const items = requirement.tasks;
  requirement.tasks = [];
  addChildren(plan, requirement.id, items);
}
