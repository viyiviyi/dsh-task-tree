/**
 * 系统提示词段落：**只有一段**，讲的是"这组工具是什么、一次工作怎么开头、完成时守什么时机"。
 *
 * 工具清单与填法**不在这里**——每个工具怎么用由它自己的 `description` 承担。同一句话
 * 写在两处，只会让它在每一次请求里占两份位置，而模型真要调用时读的始终是
 * `description`。计划当前的状态同样不在这里，由 `tree_task_status` 现取。
 *
 * 写法与内置工具段落一致：`text` 是个函数，工具不在当前作用域里就输出空串。
 *
 * @module dsh-tree-task-flow/prompt
 */

/** 段落名。注册表要求全局唯一。 */
export const SECTION_NAME = "dsh-tree-task-flow";

/**
 * 默认排序。
 *
 * 落在 TOOL_PTY（1700）与 TOOL_WEB_SEARCH（2000）之间的空档：与内置工具指引同区，
 * 又不与任何已占用的号相撞。内置贡献方靠 `getSectionOrder` 取中央分配的位置，
 * 外部插件没有这个待遇，只能自己挑一个不冲突的有限值。
 */
export const DEFAULT_ORDER = 1800;

/**
 * 段落正文。
 *
 * 只讲这次工作按什么顺序走、什么时候该动哪个工具，不讲工具怎么填——填法归各自的
 * `description`。三个入口工具（状态、建草稿、改需求）在这里点名，其余仍交给描述：
 * 光说"用工具"换不到指代明确，十来个字不值得省。
 *
 * 流水线：需求草稿 → update 多次修改（仍是草稿）→ confirm 生成版本 → 读资料 → start。
 * 任务与步骤的拆分口径归 `plan`，result 写法归 `done`，笔记覆盖归 `note`。
 */
export const SECTION_TEXT =
  "`tree_task_*` 工具记录这个会话的工作结构。需求记录用户提出的要求；任务与步骤记录实现路径；" +
  "笔记记录不属于任何单条需求的工作事实与偏好。\n\n" +
  "开工前先调用 tree_task_status 取回需求列表。用户提出要求后，先用 tree_task_create 记录需求草稿；" +
  "草稿阶段用 tree_task_requirement 的 update 动作逐次修改正文，每次只给出要改的字段，修改后仍是草稿；" +
  "标题与简介确定后，用同一工具的 confirm 动作确认并生成版本。确认之后，调用 tree_task_start 开始工作，" +
  "调用前先读取所需的文件与文档。\n\n" +
  "每完成一个步骤、任务或需求，调用一次 tree_task_done。";

/**
 * 注册段落。调用方必须包在 `ctx.effect()` 里，否则热更新后会重复注册而抛错。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param order - 段落排序。
 * @returns 注册返回的 disposer（由 ctx.effect 持有）。
 */
export function registerPromptSection(ctx, order) {
  return () =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order,
      text: ({ scope }) =>
        ctx.tools.get("tree_task_status", scope) === undefined ? "" : SECTION_TEXT,
    });
}
