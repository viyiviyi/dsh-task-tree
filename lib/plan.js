/**
 * 计划树：目标 → 任务 → 子任务，固定三级。
 *
 * 纯逻辑模块——不碰 DSH、不碰磁盘。状态由调用方从 store 读出、改完写回。
 *
 * 节点状态只有三种：`pending` / `done` / `dropped`。
 * **谁是"当前节点"是推导出来的，不是存的**（`activePath`）——
 * 少一个需要同步的状态，就少一类 bug。
 *
 * 一个节点完成时必须提交 `result`（这个节点产出了什么）。它提交在这次
 * `tree_task_done` 调用的参数里，而那次调用是折叠边界、不会被收走，所以
 * 结果**留得住**；插件收走的是它前面那段执行过程。树渲染里也会把结果原样
 * 列出来（**不截断**），让 `tree_task_status` 随时能把交付内容重新摆到眼前。
 *
 * **子节点全部结束时，父节点不自动完成。** 那一刻转入**检查点**：
 * 模型要么继续给父节点拆新的子节点，要么提交父节点的结果并完成它。
 * 这样"这一层到底做完没有"始终由模型判断，不会被一条计数规则抢先定死。
 *
 * @module dsh-tree-task-flow/plan
 */

/** 节点状态取值。 */
export const STATUS = {
  PENDING: "pending",
  DONE: "done",
  DROPPED: "dropped",
};

/** 一个节点是否还"活着"（未完成、未丢弃）。 */
export function isOpen(node) {
  return node !== undefined && node !== null && node.status === STATUS.PENDING;
}

/** 已结束（完成或丢弃）。 */
function isClosed(node) {
  return node.status === STATUS.DONE || node.status === STATUS.DROPPED;
}

/** 进程内自增，配合时间戳保证 id 唯一且短。 */
let seq = 0;

function newId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 标题归一化：去空白，空标题给个占位。 */
function normalizeTitle(value, fallback) {
  return String(value ?? "").trim() || fallback;
}

/** 子任务节点（第三级，没有下级）。 */
function makeStep(input, now) {
  return {
    id: newId("s"),
    title: normalizeTitle(input?.title, "(未命名子任务)"),
    detail: String(input?.detail ?? ""),
    status: STATUS.PENDING,
    createdAt: now,
    completedAt: null,
    result: null,
  };
}

/** 任务节点（第二级）。 */
function makeTask(input, now) {
  return {
    id: newId("t"),
    title: normalizeTitle(input?.title, "(未命名任务)"),
    detail: String(input?.detail ?? ""),
    status: STATUS.PENDING,
    createdAt: now,
    completedAt: null,
    result: null,
    steps: [],
  };
}

/**
 * 建一棵全新的计划树。首版是单活动计划，所以这会替换掉原有的树。
 *
 * @param input - `{ title, detail?, tasks: [{ title, detail? }] }`。
 * @param now - 注入的时间戳，便于测试。
 * @returns 完整的计划树对象。
 */
/**
 * 建一个目标：它自己的字段 + 一批任务。
 *
 * 一个会话可以有**多个**目标，它们是最外层的兄弟，按创建顺序排。
 *
 * @param input - `{ title, detail?, tasks: [{ title, detail? }] }`。
 * @param now - 注入的时间戳，便于测试。
 * @returns 目标节点。
 */
export function createGoal(input, now = Date.now()) {
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  if (tasks.length === 0) {
    throw new Error("至少要有一个任务；请在 tasks 里给出");
  }
  return {
    id: newId("g"),
    title: normalizeTitle(input?.title, "(未命名目标)"),
    detail: String(input?.detail ?? ""),
    status: STATUS.PENDING,
    createdAt: now,
    completedAt: null,
    result: null,
    tasks: tasks.map((task) => makeTask(task, now)),
  };
}

/**
 * 建一棵全新的计划树：只含一个目标。
 *
 * @param input - `{ title, detail?, tasks: [{ title, detail? }] }`。
 * @param now - 注入的时间戳，便于测试。
 * @returns 完整的计划树对象。
 */
export function createPlan(input, now = Date.now()) {
  return {
    version: 2,
    createdAt: now,
    updatedAt: now,
    goals: [createGoal(input, now)],
  };
}

/**
 * 往计划里追加一个目标——同一个会话里再立一个目标走这里，不是重建整棵树。
 *
 * @param plan - 计划树。
 * @param input - 同 `createGoal`。
 * @param now - 时间戳。
 * @returns 新加的目标节点。
 */
export function addGoal(plan, input, now = Date.now()) {
  const goal = createGoal(input, now);
  if (!Array.isArray(plan.goals)) plan.goals = [];
  plan.goals.push(goal);
  plan.updatedAt = now;
  return goal;
}

/**
 * 计划里的全部目标。
 *
 * @param plan - 计划树。
 * @returns 目标数组；没有计划时是空数组。
 */
export function goalsOf(plan) {
  return Array.isArray(plan?.goals) ? plan.goals : [];
}

/**
 * 按 id 找节点，并给出它在树里的位置。
 *
 * @param plan - 计划树。
 * @param id - 节点 id（目标 / 任务 / 子任务都可以）。
 * @returns `{ level, goal, task, step, node }`，找不到返回 null。
 */
export function findNode(plan, id) {
  for (const goal of goalsOf(plan)) {
    if (goal.id === id) {
      return { level: "goal", goal, task: null, step: null, node: goal };
    }
    for (const task of goal.tasks ?? []) {
      if (task.id === id) {
        return { level: "task", goal, task, step: null, node: task };
      }
      for (const step of task.steps ?? []) {
        if (step.id === id) {
          return { level: "step", goal, task, step, node: step };
        }
      }
    }
  }
  return null;
}

/**
 * 推导"现在应该做哪个节点"。
 *
 * @param plan - 计划树。
 * @returns `null` 表示整棵树都结束了；否则 `{ goal, task, step }`，
 *   其中 `task` 为 `null` 表示目标下已没有未结束的任务，
 *   `step` 为 `null` 表示当前任务还没拆子任务（需要先 `tree_task_plan`）。
 */
export function activePath(plan) {
  const goal = goalsOf(plan).find(isOpen);
  if (!goal) return null;
  const task = (goal.tasks ?? []).find(isOpen);
  if (!task) return { goal, task: null, step: null };
  const step = (task.steps ?? []).find(isOpen);
  return { goal, task, step: step ?? null };
}

/**
 * 找出当前的检查点：一个**自己还没完成、但子节点已经全部结束**的节点。
 *
 * 只沿活动路径判断——模型一次推进一条路径，别的分支还没轮到。
 * 一个从没拆过子节点的节点不算检查点：它处于"待拆分"，不是"待拍板"。
 *
 * @param plan - 计划树。
 * @returns `{ level, goal, task, step, node }`，没有检查点时返回 null。
 */
export function checkpointOf(plan) {
  const active = activePath(plan);
  if (active === null) return null;
  const { goal } = active;

  if (active.task === null) {
    // 这个目标下已经没有未结束的任务，但目标自己还开着。
    const tasks = goal.tasks ?? [];
    return tasks.length > 0 ? { level: "goal", goal, task: null, step: null, node: goal } : null;
  }

  if (active.step !== null) return null;

  const steps = active.task.steps ?? [];
  if (steps.length === 0) return null;
  return { level: "task", goal, task: active.task, step: null, node: active.task };
}

/**
 * 给一个节点追加子节点。
 *
 * 目标接受任务（每个任务自带空的子任务列表），任务接受子任务。
 * 子任务是最低一级，不能再往下拆。
 *
 * @param plan - 计划树。
 * @param parentId - 父节点 id（目标或任务）。
 * @param items - `[{ title, detail? }]`。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, added? }`。
 */
export function addChildren(plan, parentId, items, now = Date.now()) {
  const found = findNode(plan, parentId);
  if (!found) return { ok: false, reason: `找不到节点 ${parentId}` };
  if (found.level === "step") {
    return { ok: false, reason: `子任务 ${parentId} 是最低一级，不能再拆` };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: "至少要给一个子节点" };
  }

  const added =
    found.level === "goal"
      ? items.map((item) => makeTask(item, now))
      : items.map((item) => makeStep(item, now));
  if (found.level === "goal") {
    found.goal.tasks.push(...added);
  } else {
    found.task.steps.push(...added);
  }
  plan.updatedAt = now;
  return { ok: true, added, level: found.level };
}

/**
 * 把一个节点标为完成，并记录它提交的结果。
 *
 * 完成必须带结果——插件要用它替换掉这个节点的执行过程。
 * 子节点全部结束不会让父节点自动完成，只会让它进入检查点（见 `checkpointOf`）。
 *
 * @param plan - 计划树。
 * @param id - 要完成的节点 id。
 * @param result - 这个节点产出了什么的说明文本。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, events?, active?, checkpoint? }`。
 */
export function complete(plan, id, result, now = Date.now()) {
  const found = findNode(plan, id);
  if (!found) return { ok: false, reason: `找不到节点 ${id}` };
  const { level, node } = found;

  if (node.status === STATUS.DONE) {
    return { ok: false, reason: `节点 ${id} 已经是完成状态` };
  }
  if (node.status === STATUS.DROPPED) {
    return { ok: false, reason: `节点 ${id} 已被丢弃，不能标记完成` };
  }

  const text = typeof result === "string" ? result.trim() : "";
  if (text === "") {
    return { ok: false, reason: `完成${levelLabel(level)}必须提交结果：请在 result 里写清它产出了什么` };
  }

  node.status = STATUS.DONE;
  node.completedAt = now;
  node.result = { text, at: now };
  plan.updatedAt = now;

  const events = [`${levelLabel(level)}「${node.title}」已完成`];
  const checkpoint = checkpointOf(plan);
  if (checkpoint !== null) {
    events.push(checkpointNote(checkpoint));
  }

  return {
    ok: true,
    events,
    active: activePath(plan),
    checkpoint: checkpoint === null ? null : { id: checkpoint.node.id, level: checkpoint.level },
  };
}

/**
 * 丢弃一个节点。丢弃目标会连同它下面的任务与子任务一起丢弃；丢弃任务会带上它的子任务。
 *
 * 改需求就用这个丢弃 + `tree_task_plan` 追加新子节点，旧节点留在树里可查。
 * 已经结束的子节点保持原样——丢的是"还要不要做"，不是改写历史。
 * 已经**完成**的节点不能丢（那会毁掉它交出的结果），丢过的也不能再丢一次。
 *
 * @param plan - 计划树。
 * @param id - 节点 id。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, dropped?, active?, checkpoint? }`。
 */
export function dropNode(plan, id, now = Date.now()) {
  const found = findNode(plan, id);
  if (!found) return { ok: false, reason: `找不到节点 ${id}` };

  if (found.node.status === STATUS.DONE) {
    return { ok: false, reason: `节点 ${id} 已经完成，丢弃会毁掉它的结果记录` };
  }
  if (found.node.status === STATUS.DROPPED) {
    return { ok: false, reason: `节点 ${id} 已经被丢弃` };
  }

  const dropped = [`${levelLabel(found.level)}「${found.node.title}」`];
  found.node.status = STATUS.DROPPED;

  // 目标是这一层唯一的"有孩子"的节点里最外那一层：丢它就把整支带走。
  const tasks = found.level === "goal" ? (found.node.tasks ?? []) : [found.node];
  for (const task of tasks) {
    if (task !== found.node && !isClosed(task)) {
      task.status = STATUS.DROPPED;
      dropped.push(`任务「${task.title}」`);
    }
    for (const step of task.steps ?? []) {
      if (!isClosed(step)) {
        step.status = STATUS.DROPPED;
        dropped.push(`子任务「${step.title}」`);
      }
    }
  }
  plan.updatedAt = now;

  const checkpoint = checkpointOf(plan);
  return {
    ok: true,
    dropped,
    active: activePath(plan),
    checkpoint: checkpoint === null ? null : { id: checkpoint.node.id, level: checkpoint.level },
  };
}

/**
 * 删掉一个节点。**删除和丢弃是两件事，别混着用：**
 *
 * - **丢弃**回答"这件事还要不要做"：节点留在树里划掉，将来还查得到"曾经有这么一件事，
 *   后来决定不做了"。它不改写历史。
 * - **删除**是**清理**：内容本身就是错的（建重了、写歪了、结果记在了错的地方），
 *   留着只会误导后面的人。所以它把这个节点连同它的全部子孙从树里凭空摘掉，
 *   **不看状态**——已完成的照样删得掉，那正是"这条记录不该留在这儿"的情形。
 *
 * 摘完树可能是空的（最后一个目标被删掉）：那时 `plan.goals` 是**空数组**，而不是
 * 没有计划——计划文件照旧在盘上，渲染会给出"还没有计划"的样子。
 *
 * 活动路径与检查点在删完**重新算**，调用方不要拿删除前的那一份去用。
 *
 * @param plan - 计划树。
 * @param id - 节点 id。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, removed?, active?, checkpoint? }`。
 */
export function deleteNode(plan, id, now = Date.now()) {
  const found = findNode(plan, id);
  if (!found) return { ok: false, reason: `找不到节点 ${id}` };

  // 先把要摘掉的那几个记下来——摘掉之后就找不着了。
  const removed = [`${levelLabel(found.level)}「${found.node.title}」`];
  if (found.level === "goal") {
    for (const task of found.node.tasks ?? []) {
      removed.push(`任务「${task.title}」`);
      for (const step of task.steps ?? []) removed.push(`子任务「${step.title}」`);
    }
    plan.goals = goalsOf(plan).filter((goal) => goal.id !== id);
  } else if (found.level === "task") {
    for (const step of found.node.steps ?? []) removed.push(`子任务「${step.title}」`);
    found.goal.tasks = (found.goal.tasks ?? []).filter((task) => task.id !== id);
  } else {
    found.task.steps = (found.task.steps ?? []).filter((step) => step.id !== id);
  }
  plan.updatedAt = now;

  const checkpoint = checkpointOf(plan);
  return {
    ok: true,
    removed,
    active: activePath(plan),
    checkpoint: checkpoint === null ? null : { id: checkpoint.node.id, level: checkpoint.level },
  };
}

/**
 * 改一个节点的标题或说明。
 *
 * @param plan - 计划树。
 * @param id - 节点 id。
 * @param patch - `{ title?, detail? }` 的任意子集。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, changed? }`。
 */
export function updateNode(plan, id, patch, now = Date.now()) {
  const found = findNode(plan, id);
  if (!found) return { ok: false, reason: `找不到节点 ${id}` };

  const changed = [];
  const { node } = found;
  if (typeof patch?.title === "string" && patch.title.trim() !== "") {
    node.title = patch.title.trim();
    changed.push("title");
  }
  if (typeof patch?.detail === "string") {
    node.detail = patch.detail;
    changed.push("detail");
  }
  if (changed.length === 0) {
    return { ok: false, reason: "没有给出任何要改的字段（title / detail）" };
  }
  plan.updatedAt = now;
  return { ok: true, changed };
}

/**
 * 层级的显示名。树渲染、检查点提示、命令回执都用它，保证几处称呼一致。
 *
 * @param level - `goal` / `task` / `step`。
 * @returns 中文称呼。
 */
export function levelLabel(level) {
  if (level === "goal") return "目标";
  if (level === "task") return "任务";
  return "子任务";
}

/**
 * 注入消息里的层级称呼。树渲染走 `levelLabel`（目标 / 任务 / 子任务），
 * 注入消息里 L3 一律叫"步骤"。
 */
const NOTICE_WORD = { goal: "目标", task: "任务", step: "步骤" };

/**
 * 节点在注入消息里的自称：目标不带标题，其余带「标题」。
 *
 * @param level - `goal` / `task` / `step`。
 * @param node - 节点。
 * @returns 自称文本。
 */
function subject(level, node) {
  return level === "goal" ? `目标${node.id}` : `${NOTICE_WORD[level]}「${node.title}」${node.id}`;
}

/**
 * 一条完成通告：这个节点做完了、过程归档了。
 *
 * 末尾**不带标点**——调用方按需要在后面接"，"或"。"再拼下一步提示。
 * 不重复提交内容：`result` 就在这次 `tree_task_done` 调用的参数里，再抄一遍是白占位置。
 *
 * @param level - `goal` / `task` / `step`。
 * @param node - 节点。
 * @returns 通告文本。
 */
export function doneNotice(level, node) {
  const self = subject(level, node);
  if (node.status !== STATUS.DONE) return `${self}已被丢弃`;
  return `${self}已经完成，执行过程已归档`;
}

/** 注入消息与 `tree_task_done` 结果共用的抬头。 */
export const NOTICE_PREFIX = "tree_task消息：";

/**
 * `tree_task_done` 的返回内容：下一步该干什么。
 *
 * 提示走工具结果本身，不再另外伪造一条用户消息；"哪个节点完成了、过程已归档"
 * 由折叠落下的那条通告负责。两者合起来才是一条完整的话，所以这里只给后半句。
 *
 * @param plan - 计划树。
 * @returns 返回文本。
 */
export function doneReply(plan) {
  return `${NOTICE_PREFIX}${renderContinue(plan)}`;
}

/**
 * 检查点那句话：这一层的下一级都结束了，是收尾还是再补几个。
 *
 * @param checkpoint - `checkpointOf(plan)` 的结果。
 * @returns 检查点文本。
 */
function checkpointNote(checkpoint) {
  const level = checkpoint.level;
  const childWord = level === "goal" ? "任务" : "步骤";
  const self = subject(level, checkpoint.node);
  return (
    `检查点：${self} 的${childWord}已全部结束，请确认${self} 是否完成，` +
    `如果完成请调用tree_task_done，如果还需继续，可使用 tree_task_plan 新增${childWord}继续。`
  );
}

/**
 * 节点状态的短标记。
 *
 * 写成 `[ ]` / `[x]` 是**故意的**：整棵树用 Markdown 的嵌套任务清单渲染，
 * 这两个标记在界面上会render成可以勾选的方框。`[-]` 不是标准任务清单标记，
 * 会原样显示成 `[-]`——丢弃的节点本来就该看着"不是个正常的框"。
 */
function mark(node) {
  if (node.status === STATUS.DONE) return "[x]";
  if (node.status === STATUS.DROPPED) return "[-]";
  return "[ ]";
}

/** 每一层的缩进宽度：两个空格，Markdown 嵌套列表的常规写法。 */
const INDENT = "  ";

/**
 * 一个节点的「说明 / 结果」字段，作为该列表项的下一层条目挂进去。
 *
 * **全文输出，一个字都不截。** `result` 是这个节点交付的全部文字，截掉半句
 * 就等于没交付。多行文本逐行输出；空行也要带上缩进，否则 Markdown 会认为
 * 列表项到此为止，后面的内容会被甩出列表。
 *
 * @param lines - 输出行数组，就地追加。
 * @param ownerIndent - 所属节点那一行的缩进层数。
 * @param label - 「说明」或「结果」。
 * @param text - 正文；空值不输出。
 */
function pushField(lines, ownerIndent, label, text) {
  const rows = String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  if (rows.length === 0) return;

  const pad = INDENT.repeat(ownerIndent + 1);
  lines.push(`${pad}- **${label}**：${rows[0]}`);
  for (const row of rows.slice(1)) {
    lines.push(row === "" ? pad : `${pad}${INDENT}${row}`);
  }
}

/**
 * 渲染一个目标。
 *
 * 输出是**规范的 Markdown 嵌套任务清单**（`- [ ]` 一层两个空格），复制出去
 * 就能正常预览——之前的写法靠纯空格缩进，四空格起就被 Markdown 当成代码块。
 *
 * @param goal - 目标节点。
 * @param plan - 整棵计划树，用来标出"当前"落在哪。
 * @param expand - `false` 时只渲染目标自己这一级（不含它下面的任务与子任务）。
 * @returns 多行 Markdown 文本。
 */
export function renderGoal(goal, plan, expand = true) {
  const active = activePath(plan);
  const checkpoint = checkpointOf(plan);
  const lines = [];

  const goalHere = active?.goal?.id === goal.id;
  lines.push(`- ${mark(goal)} **目标** \`${goal.id}\` ${goal.title}${goalHere ? " ← 当前" : ""}`);
  pushField(lines, 0, "说明", goal.detail);
  pushField(lines, 0, "结果", goal.result?.text);
  if (expand !== true) return lines.join("\n");

  for (const task of goal.tasks ?? []) {
    const taskHere = active?.task?.id === task.id || checkpoint?.node?.id === task.id;
    lines.push(
      `${INDENT}- ${mark(task)} **任务** \`${task.id}\` ${task.title}${taskHere ? " ← 当前" : ""}`,
    );
    pushField(lines, 1, "结果", task.result?.text);

    const steps = task.steps ?? [];
    if (steps.length === 0 && isOpen(task)) {
      lines.push(`${INDENT.repeat(2)}- 还没有子节点，用 tree_task_plan 补上`);
    }
    for (const step of steps) {
      const stepHere = active?.step?.id === step.id;
      lines.push(
        `${INDENT.repeat(2)}- ${mark(step)} **子任务** \`${step.id}\` ${step.title}${stepHere ? " ← 当前" : ""}`,
      );
      pushField(lines, 2, "结果", step.result?.text);
    }
  }
  return lines.join("\n");
}

/**
 * 渲染计划树。
 *
 * 默认把**已经结束的目标**收成目标那一级：一个会话跑久了会有好几个做完的目标，
 * 每个都摊开会把树变成一大坨没人看的文字。要某个目标的完整树就指名它。
 *
 * @param plan - 计划树；null 表示还没有计划。
 * @param only - 只渲染这个 id 所在的目标，并展开到底；不传就是全部目标。
 * @returns 多行 Markdown 文本。
 */
export function renderTree(plan, only = null) {
  const goals = goalsOf(plan);
  if (goals.length === 0) return "（还没有计划。用 tree_task_create 建立目标与任务。）";

  const wanted = typeof only === "string" && only.trim() !== "" ? only.trim() : null;
  if (wanted !== null) {
    const found = findNode(plan, wanted);
    if (found === null) {
      return `找不到节点 ${wanted}。不带 id 调用可以看到本会话的全部目标。`;
    }
    return renderGoal(found.goal, plan, true);
  }

  return goals.map((goal) => renderGoal(goal, plan, isOpen(goal))).join("\n");
}

/**
 * 注入消息里的收尾提示。它接在完成通告后面，所以自带前置标点（`lead`）。
 *
 * 三种落点：还有同级就报下一个；同级到头就进检查点；整棵树完了就让汇报。
 *
 * @param plan - 计划树。
 * @returns `{ lead, text }`；`lead` 是要接在通告末尾的标点。
 */
export function continueNote(plan) {
  const checkpoint = checkpointOf(plan);
  if (checkpoint !== null) return { lead: "。", text: checkpointNote(checkpoint) };

  const active = activePath(plan);
  if (active === null) return { lead: "，", text: "请汇报最终结果。" };

  if (active.step !== null) {
    return {
      lead: "，",
      text: `接下来需要进行步骤：「${active.step.title}」(${active.step.id})。`,
    };
  }

  if (active.task !== null) {
    return {
      lead: "，",
      text: `接下来需要进行任务：「${active.task.title}」(${active.task.id})。`,
    };
  }

  // 目标下面还没拆任务，或者刚从上一个目标轮到这一个。
  return {
    lead: "，",
    text: `接下来需要进行目标：「${active.goal.title}」(${active.goal.id})。`,
  };
}

/**
 * 同一句话独立成句。自动续行那边没有完成通告可接，直接用 `text`。
 *
 * @param plan - 计划树。
 * @returns 指令文本。
 */
export function renderContinue(plan) {
  return continueNote(plan).text;
}
