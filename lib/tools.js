/**
 * 五个 `tree_task_*` 工具。
 *
 * **写树只有一个入口 `tree_task_plan`**：不填 `parentId` 就是新建目标，填了就是给
 * 那个节点追加子节点。分成两个工具（原来的 `tree_task_create` + `tree_task_plan`）
 * 的时候，两者都是"一串 `{title, detail}`"，模型会把 `create` 的顶层 `title`
 * 混进 `plan` 的实参里——2026-10-12 就有一次这样的实参写出了不合法 JSON。
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
  doneReply,
  dropNode,
  findNode,
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
    name: "tree_task_plan",
    description:
      "写计划树的**唯一**入口，两个用法：\n" +
      "① 不填 parentId = 新建一个目标：这时要填 title（目标一句话）与 children（这个目标下的任务）。" +
      "一个会话可以有多个目标，按调用顺序排，已经建过的目标不会被替换掉。\n" +
      "② 填 parentId = 给那个节点追加子节点：父节点是目标时加的是任务，父节点是任务时加的是子任务。" +
      "子任务是最低一级，不能再往下拆。\n" +
      "这里的任务与子任务都是交付节点——一件能独立验收的交付内容或一个步骤，标题要能独立看懂。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentId: {
          type: "string",
          description: "父节点 id（目标或任务），例如 t-abc123。**不填就是新建一个目标**。",
        },
        title: { type: "string", description: "新建目标时填：这个目标一句话说清最终要达成什么" },
        detail: { type: "string", description: "新建目标时填：目标的补充说明" },
        children: {
          type: "array",
          description:
            "要添加的子节点，按执行顺序。新建目标时它们是这个目标下的任务；" +
            "填了 parentId 时，父节点是目标则它们是任务，父节点是任务则它们是子任务。",
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
      required: ["children"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const children = args?.children;
      if (!Array.isArray(children) || children.length === 0) {
        return ok("没有添加：children 至少要给一个子节点。");
      }

      const parentId = typeof args?.parentId === "string" ? args.parentId.trim() : "";
      const existing = store.readPlan(sessionId);

      // ---- 不填 parentId：新建一个目标（这是原来 tree_task_create 的活）----
      if (parentId === "") {
        const title = String(args?.title ?? "").trim();
        if (title === "") {
          return ok(
            "没有建立：不填 parentId 就是新建目标，这时必须在 title 里给出目标的标题" +
              "（children 里给这个目标下的任务）。",
          );
        }
        let plan;
        let goal;
        try {
          if (existing === null) {
            plan = createPlan({ title, detail: args?.detail, tasks: children });
            [goal] = plan.goals;
          } else {
            plan = existing;
            goal = addGoal(plan, { title, detail: args?.detail, tasks: children });
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
            "下一步：给这个目标下的第一个任务拆子任务——还是用 tree_task_plan，" +
              "parentId 填那个任务的 id。",
          ].join("\n"),
        );
      }

      // ---- 填了 parentId：给那个节点追加子节点 ----
      if (existing === null) {
        return ok(
          "本会话还没有计划。用 tree_task_plan 新建一个目标：不填 parentId，填 title 与 children。",
        );
      }
      const result = addChildren(existing, parentId, children);
      if (!result.ok) return ok(`没有添加：${result.reason}`);
      store.writePlan(sessionId, existing);
      const found = findNode(existing, parentId);
      return ok(
        [
          `已添加 ${result.added.length} 个${childLabel(result.level)}：`,
          ...result.added.map((node) => `- \`${node.id}\` ${node.title}`),
          "",
          renderGoal(found.goal, existing, true),
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

  void cfg;
}
