/**
 * 七个 `tree_task_*` 工具。
 *
 * **写树分成两个工具，不是可以合并的重复。** `tree_task_create` 与 `tree_task_done`
 * 是折叠区间的两个边界（见 `lib/region.js`）：`create` 是"开工"那一下，`done` 是
 * "收工"那一下。`create` 只在新建目标时调用一次，`plan` 却在任务中途反复调用——
 * 把两者并成一个工具，折叠起点就只能靠实参里有没有 `parentId` 去猜，
 * 模型一次写漏或多写就会把起点挪走，那段过程就再也收不走了。
 * 代价是两个工具的实参形状有点像（都是一串 `{title, detail}`），
 * 所以 `plan` 的说明里专门写了一句"建新目标不归它管"。
 *
 * 工具本身**只做状态读写**——不注入消息、不动 surface，也不拦任何别的工具。
 * 「完成时把这个节点的执行过程从上下文里折起来、换成一条携带它结果的汇总」
 * 那件事完全由 `agent/pre-step` 监听器负责（它比对游标与 `activePath` 就知道
 * 哪一层刚结束）。
 *
 * 工具能决定的只有一件事：**这个节点算不算做完了**。而它做完了就必须交出
 * `result`——插件正是拿这段文字去顶替它整段执行过程。没有结果的完成会让那段
 * 上下文白白消失，所以 `result` 是必填的。
 *
 * 所有工具共用同一套契约：
 * - `parameters` 用**原始 JSON Schema**（不能 import 宿主的 schemastery）
 * - 返回 `{ text }`，由 `output.render` 渲染成一个文本块
 *
 * @module dsh-tree-task-flow/tools
 */

import {
  addChildren,
  addGoal,
  complete,
  createPlan,
  deleteNode,
  doneReply,
  dropNode,
  findNode,
  goalsOf,
  renderContinue,
  renderGoal,
  renderTree,
  updateNode,
} from "./plan.js";

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
 * 追加子节点时，父节点层级对应的子节点称呼。
 * @param level - `addChildren` 报回来的父节点层级。
 * @returns 中文称呼。
 */
function childLabel(level) {
  return level === "goal" ? "任务" : "子任务";
}

/**
 * 注册全部工具。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, cfg }`。
 */
export function registerTools(ctx, { store, cfg }) {
  const sessionOf = (exec) => exec?.agent?.session?.id ?? null;

  // ---------------------------------------------------------------- 计划树

  ctx.tools.register({
    name: "tree_task_status",
    description:
      "查看计划树：目标、任务、子任务各自的状态与已提交的结果，以及现在该推进哪个节点。" +
      "任务开头、上下文被压缩之后、或者不确定下一步做什么时，调用它。" +
      "默认只展开还没结束的目标——已经做完的目标只留目标那一行，要看它的完整树就把 id 填上。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description:
            "可选。填目标 id 就返回那个目标的完整树（已完成的目标默认不展开）；" +
            "填任务或子任务 id，就按它所在的那个目标展开。",
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      return ok(renderTree(plan, args?.id ?? null));
    },
  });

  ctx.tools.register({
    name: "tree_task_create",
    description:
      "新建一个目标：这个目标 + 它下面的若干任务。**它是「开工」那一下**——" +
      "折叠上下文时，插件就认这次调用作为「这一轮从哪儿开始」。" +
      "一个会话可以有多个目标，按调用顺序排在计划里——已经建过的目标和它们的历史都留着，" +
      "不会被这次调用替换掉。" +
      "这里的任务是交付节点——一件能独立验收的交付内容，可以是需要完成或验证的某件事，" +
      "也可以是一个检查点，不是步骤本身。" +
      "建完记得用 tree_task_plan 给这个目标下的第一个任务拆子任务。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "目标：一句话说清最终要达成什么" },
        detail: { type: "string", description: "目标的补充说明" },
        tasks: {
          type: "array",
          description: "目标下的任务列表（交付节点），按建议的执行顺序排列",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "任务标题" },
              detail: { type: "string", description: "任务的补充说明" },
            },
            required: ["title"],
          },
        },
      },
      required: ["title", "tasks"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const existing = store.readPlan(sessionId);
      let plan;
      let goal;
      try {
        if (existing === null) {
          plan = createPlan(args);
          [goal] = plan.goals;
        } else {
          plan = existing;
          goal = addGoal(plan, args);
        }
      } catch (error) {
        return ok(`建立目标失败：${String(error?.message ?? error)}`);
      }
      store.writePlan(sessionId, plan);
      return ok(
        [
          existing === null ? `计划已建立，目标「${goal.title}」。` : `已新增目标「${goal.title}」。`,
          "",
          renderGoal(goal, plan, true),
          "",
          "下一步：给这个目标下的第一个任务拆子任务——用 tree_task_plan，" +
            "parentId 填那个任务的 id。",
        ].join("\n"),
      );
    },
  });

  ctx.tools.register({
    name: "tree_task_plan",
    description:
      "给一个节点追加子节点：给目标追加任务，给任务追加子任务。" +
      "给任务追加的是步骤（需要一次性做完的事情）。" +
      "子任务是最低一级，不能再往下拆。" +
      "**建新目标不归它管，那是 tree_task_create**——它只往已有的节点上接子节点。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentId: { type: "string", description: "父节点 id（目标或任务），例如 t-abc123" },
        children: {
          type: "array",
          description: "要追加的子节点，按执行顺序；父节点是目标时是任务（交付节点），是任务时是子任务（步骤）",
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
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。先用 tree_task_create 建立目标与任务。");
      const result = addChildren(plan, args?.parentId, args?.children);
      if (!result.ok) return ok(`没有添加：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);
      const found = findNode(plan, args?.parentId);
      return ok(
        [
          `已添加 ${result.added.length} 个${childLabel(result.level)}：`,
          ...result.added.map((node) => `- \`${node.id}\` ${node.title}`),
          "",
          renderGoal(found.goal, plan, true),
        ].join("\n"),
      );
    },
  });

  ctx.tools.register({
    name: "tree_task_done",
    description:
      "完成一个节点并提交它的结果（目标 / 任务 / 子任务都给它的 id）。**必须写 result**：" +
      "插件会把这个节点从开始到现在的执行过程从上下文里折叠掉，换成一条只携带这段结果的汇总消息。" +
      "任务的 result 写交付物与验收方式（文件在哪、怎么跑、验出什么、已知限制）；" +
      "子任务的 result 一句话说清这步做了什么、结果如何就够。" +
      "这次调用与它的返回都会留在上下文里，被收起的只是它前面的执行过程。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要完成的节点 id" },
        result: {
          type: "string",
          description:
            "这个节点产出了什么。它整段执行过程会被这条结果顶替，所以要能独立看懂：" +
            "任务写交付物与验收方式，子任务写清这步做了什么。",
        },
      },
      required: ["id", "result"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。");
      const result = complete(plan, args?.id, args?.result);
      if (!result.ok) return ok(`没有完成：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);
      // 返回的就是"下一步该干什么"：这条结果连同这次调用都留在表层上，
      // 折叠只收走它前面的执行过程。不重复节点状态，也不回整棵树。
      return ok(doneReply(plan));
    },
  });

  ctx.tools.register({
    name: "tree_task_update",
    description: "修改一个节点的标题或说明。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "节点 id" },
        title: { type: "string", description: "新的标题" },
        detail: { type: "string", description: "新的说明" },
      },
      required: ["id"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。");
      const result = updateNode(plan, args?.id, args ?? {});
      if (!result.ok) return ok(`没有修改：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);
      const found = findNode(plan, args?.id);
      return ok(`已更新 ${result.changed.join(" / ")}。\n\n${renderGoal(found.goal, plan, true)}`);
    },
  });

  ctx.tools.register({
    name: "tree_task_drop",
    description:
      "丢弃一个节点：目标、任务、子任务都能丢。丢弃目标会连同它下面的任务与子任务一起走，" +
      "丢弃任务会带上它的子任务。改需求用这个，不要重建整棵树——" +
      "已丢弃的节点会留在树里可查。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要丢弃的节点 id" },
      },
      required: ["id"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。");
      const result = dropNode(plan, args?.id);
      if (!result.ok) return ok(`没有丢弃：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);
      const found = findNode(plan, args?.id);
      return ok(
        [
          `已丢弃：${result.dropped.join("、")}`,
          "",
          renderGoal(found.goal, plan, true),
          "",
          renderContinue(plan),
        ].join("\n"),
      );
    },
  });

  ctx.tools.register({
    name: "tree_task_delete",
    description:
      "从树里删掉一个节点——**清理**用的，不是「这件事不做了」。" +
      "丢弃（tree_task_drop）是留个记号：这件事我不做，但树里还查得到它曾经有过；" +
      "删除是把内容凭空摘掉，连同它下面的任务或子任务一起，" +
      "**不看状态**（已完成、已丢弃的都删得掉）。" +
      "内容写错了、建重了、结果记在了错的地方，就用这个。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要删除的节点 id" },
      },
      required: ["id"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。");
      // 删掉之后就查不到"这次动的是哪个目标"了，先记一份。
      const touched = findNode(plan, args?.id);
      const result = deleteNode(plan, args?.id);
      if (!result.ok) return ok(`没有删除：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);

      const lines = [`已删除：${result.removed.join("、")}`, ""];
      if (touched !== null && touched.level !== "goal") {
        // 删的是任务或子任务：它所在的那个目标还在，照旧只给它一个目标的树。
        lines.push(renderGoal(touched.goal, plan, true));
      } else {
        // 删的是目标：那个目标已经不存在了，没有"它所在的树"可给。
        // 剩下的目标数说一句就够——要看细节再调 tree_task_status。
        const rest = goalsOf(plan).length;
        lines.push(
          rest === 0
            ? "计划树现在空了。（要用就用 tree_task_create 建新目标。）"
            : `这个会话还剩 ${rest} 个目标，要看细节用 tree_task_status。`,
        );
      }
      lines.push("", renderContinue(plan));
      return ok(lines.join("\n"));
    },
  });

  void cfg;
}
