/**
 * tools.js 的工具层自测。
 *
 * 用假 ctx 与假 store 把工具层单独拎出来跑，覆盖这些事：
 *
 *   1. 六个工具都在，`schema` 与描述里再没有 `needs` 的痕迹，完成必须带 `result`。
 *   2. `tree_task_done` 缺 `result`、给空白 `result` 都被拒，且节点状态不变。
 *   3. 三级固定的约束：子任务不能再往下拆，目标下加的是任务、任务下加的是子任务。
 *   4. 写树分成两个工具：`tree_task_create` 新建目标，`tree_task_plan` 只给已有节点追加子节点。
 *   5. 返回只给"本次动到的那个目标"的树，不再倾倒整棵树。
 *   6. `tree_task_status` 默认把已完成的目标收成一级，指名 id 才展开。
 *   7. 任何返回都不截断结果文本。
 *
 * **工具层不拦任何别的工具。** 检查点只是给模型的提示，不再有 `tools/pre-execute`
 * 闸门，所以假 ctx 只需要 `tools.register`——多给的假件会掩盖真实耦合。
 *
 * 跑：node verify-tools.mjs
 */

import { addChildren, complete, createPlan } from "./lib/plan.js";
import { registerTools } from "./lib/tools.js";

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 当前这七个工具，顺序无关，只用来核对集合。 */
const SEVEN_TOOLS = [
  "tree_task_status",
  "tree_task_create",
  "tree_task_plan",
  "tree_task_done",
  "tree_task_update",
  "tree_task_drop",
  "tree_task_delete",
];

/** 已经删掉的工具——它们出现在注册表里就说明删漏了。 */
const REMOVED_TOOLS = ["tree_task_save", "tree_task_recall", "tree_task_forget"];

/** 假 ctx + 假 store。 */
function makeHarness() {
  const sessions = new Map();
  const tools = new Map();

  const ctx = {
    tools: {
      register(def) {
        if (tools.has(def.name)) throw new Error(`重复注册工具 ${def.name}`);
        tools.set(def.name, def);
      },
    },
  };

  const store = {
    readPlan: (sessionId) => sessions.get(sessionId) ?? null,
    writePlan: (sessionId, plan) => {
      sessions.set(sessionId, plan);
    },
  };

  registerTools(ctx, { store, cfg: {} });
  return { tools, store, sessions };
}

/** 递归找某个键名，返回命中路径；用来证明 schema 里再没有 needs。 */
function findKey(value, key, path = "$") {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...findKey(item, key, `${path}[${index}]`)));
  } else if (value !== null && typeof value === "object") {
    for (const [name, inner] of Object.entries(value)) {
      if (name === key) hits.push(`${path}.${name}`);
      hits.push(...findKey(inner, key, `${path}.${name}`));
    }
  }
  return hits;
}

const execFor = (sessionId, name) => ({ name, agent: { session: { id: sessionId } } });

// ---------------------------------------------------------------- 场景 1

console.log("\n场景 1 · 七个工具的注册表与 schema");
{
  const h = makeHarness();

  check("恰好注册七个工具", h.tools.size === 7, `实际 ${h.tools.size}：${[...h.tools.keys()].join(", ")}`);
  for (const name of SEVEN_TOOLS) check(`  ${name} 已注册`, h.tools.has(name));
  check(
    "记忆三工具都已移除",
    REMOVED_TOOLS.every((name) => !h.tools.has(name)),
    REMOVED_TOOLS.filter((name) => h.tools.has(name)).join(", "),
  );

  const needsHits = [];
  for (const [name, def] of h.tools) {
    needsHits.push(...findKey(def.parameters, "needs").map((path) => `${name}:${path}`));
  }
  check("所有 parameters 都不含 needs 字段", needsHits.length === 0, needsHits.join(", "));

  const descHits = [...h.tools].filter(([, def]) => /needs/u.test(def.description ?? "")).map(([name]) => name);
  check("所有 description 都不提 needs", descHits.length === 0, descHits.join(", "));

  const done = h.tools.get("tree_task_done");
  check(
    "tree_task_done 把 result 列为必填",
    (done.parameters.required ?? []).includes("result"),
    JSON.stringify(done.parameters.required),
  );

  const created = h.tools.get("tree_task_create");
  check(
    "tree_task_create 只收 title / detail / tasks",
    JSON.stringify(Object.keys(created.parameters.properties).sort()) ===
      JSON.stringify(["detail", "tasks", "title"]),
    JSON.stringify(Object.keys(created.parameters.properties)),
  );
  check(
    "tree_task_create 把 title 与 tasks 列为必填",
    JSON.stringify(created.parameters.required) === JSON.stringify(["title", "tasks"]),
    JSON.stringify(created.parameters.required),
  );

  const planTool = h.tools.get("tree_task_plan");
  check(
    "tree_task_plan 只收 parentId 与 children，两个都必填",
    JSON.stringify(Object.keys(planTool.parameters.properties).sort()) ===
      JSON.stringify(["children", "parentId"]) &&
      JSON.stringify(planTool.parameters.required) === JSON.stringify(["parentId", "children"]),
    JSON.stringify({ keys: Object.keys(planTool.parameters.properties), required: planTool.parameters.required }),
  );
  check(
    "tree_task_plan 的说明撇清「建目标」这件事——那是 tree_task_create",
    /tree_task_create/u.test(planTool.description),
    planTool.description,
  );
  check(
    "工具描述教了分层：任务是交付节点、子任务是步骤",
    /交付节点/u.test(created.description) && /步骤/u.test(planTool.description),
  );
  check(
    "create 描述说清任务可以是什么：交付内容，也可以是检查点",
    /能独立验收的交付内容/u.test(created.description) &&
      /检查点/u.test(created.description) &&
      !/交付物/u.test(created.description),
  );
  check(
    "create 描述提醒建完给第一个任务拆子任务",
    /tree_task_plan/u.test(created.description) && /第一个任务/u.test(created.description),
  );
  check(
    "tree_task_status 的 id 参数写明可以看已完成目标的完整树",
    /完整树/u.test(h.tools.get("tree_task_status").parameters.properties.id.description),
    h.tools.get("tree_task_status").parameters.properties.id.description,
  );
  check(
    "tree_task_done 的 result 说明按两层分别写了写法",
    /验收/u.test(done.description) && /验收/u.test(done.parameters.properties.result.description),
  );

  const del = h.tools.get("tree_task_delete");
  check(
    "tree_task_delete 只收 id 且必填",
    JSON.stringify(Object.keys(del.parameters.properties)) === JSON.stringify(["id"]) &&
      JSON.stringify(del.parameters.required) === JSON.stringify(["id"]),
    JSON.stringify({ keys: Object.keys(del.parameters.properties), required: del.parameters.required }),
  );
  check(
    "tree_task_delete 的说明与丢弃划清界限",
    /丢弃/u.test(del.description) &&
      /tree_task_drop/u.test(del.description) &&
      /清理/u.test(del.description),
    del.description,
  );

  for (const [name, def] of h.tools) {
    check(`  ${name} 的返回形状是 { text }`, def.output?.schema?.properties?.text?.type === "string");
  }
}

// ---------------------------------------------------------------- 场景 2

console.log("\n场景 2 · 完成必须交出 result");
{
  const h = makeHarness();
  const plan = createPlan({ title: "目标A", tasks: [{ title: "任务1" }] }, 1000);
  h.store.writePlan("s2", plan);
  const [task1] = plan.goals[0].tasks;
  addChildren(plan, task1.id, [{ title: "子1" }], 1000);
  const [step1] = task1.steps;
  const done = h.tools.get("tree_task_done");

  const missing = await done.execute({ id: step1.id }, execFor("s2", "tree_task_done"));
  check("缺 result 被拒", /必须提交结果/u.test(missing.text), missing.text);
  check("被拒时节点仍是 pending", step1.status === "pending", step1.status);
  check("被拒时没有落下结果", step1.result === null, JSON.stringify(step1.result));

  const blank = await done.execute({ id: step1.id, result: "   " }, execFor("s2", "tree_task_done"));
  check("空白 result 被拒", /必须提交结果/u.test(blank.text), blank.text);
  check("空白被拒时节点仍是 pending", step1.status === "pending", step1.status);

  const unknown = await done.execute({ id: "s-不存在", result: "随便" }, execFor("s2", "tree_task_done"));
  check("未知 id 被拒", /没有完成/u.test(unknown.text), unknown.text);

  const good = await done.execute({ id: step1.id, result: "子1 产出了 X" }, execFor("s2", "tree_task_done"));
  check(
    "正常提交被接受并记下结果",
    step1.status === "done" && step1.result?.text === "子1 产出了 X",
    JSON.stringify({ status: step1.status, result: step1.result }),
  );
  check(
    "完成时返回的就是下一步该干什么",
    good.text.startsWith("tree_task消息：") && good.text.includes("检查点"),
    JSON.stringify(good.text).slice(0, 160),
  );
  check(
    "返回里不重复提交内容",
    !good.text.includes("子1 产出了 X"),
    JSON.stringify(good.text).slice(0, 160),
  );
  check(
    "tree_task_done 的说明里讲了这次调用与返回都留在上下文里",
    /这次调用与它的返回都会留在上下文里/u.test(done.description),
    done.description,
  );

  const twice = await done.execute({ id: step1.id, result: "再来一次" }, execFor("s2", "tree_task_done"));
  check("重复完成被拒", /已经是完成状态/u.test(twice.text), twice.text);
}

// ---------------------------------------------------------------- 场景 3

console.log("\n场景 3 · 三级固定的约束");
{
  const h = makeHarness();
  const plan = createPlan({ title: "目标A", tasks: [{ title: "任务1" }] }, 1000);
  h.store.writePlan("s6", plan);
  const [task1] = plan.goals[0].tasks;
  addChildren(plan, task1.id, [{ title: "子1" }], 1000);
  const [step1] = task1.steps;

  const planTool = h.tools.get("tree_task_plan");

  const deeper = await planTool.execute(
    { parentId: step1.id, children: [{ title: "更深一层" }] },
    execFor("s6", "tree_task_plan"),
  );
  check("子任务不能再往下拆", /不能再拆/u.test(deeper.text), deeper.text);

  const onGoal = await planTool.execute(
    { parentId: plan.goals[0].id, children: [{ title: "任务2" }] },
    execFor("s6", "tree_task_plan"),
  );
  check("目标下追加的是任务", /已添加 1 个任务/u.test(onGoal.text), onGoal.text);

  const onTask = await planTool.execute(
    { parentId: task1.id, children: [{ title: "子2" }] },
    execFor("s6", "tree_task_plan"),
  );
  check("任务下追加的是子任务", /已添加 1 个子任务/u.test(onTask.text), onTask.text);

  const empty = await planTool.execute({ parentId: task1.id, children: [] }, execFor("s6", "tree_task_plan"));
  check("不给子节点被拒", /至少要给一个子节点/u.test(empty.text), empty.text);

  const noPlan = await planTool.execute(
    { parentId: "t-无", children: [{ title: "x" }] },
    execFor("s6-无计划", "tree_task_plan"),
  );
  check("没有计划时提示先建树", /还没有计划/u.test(noPlan.text), noPlan.text);
}

// ---------------------------------------------------------------- 场景 4

console.log("\n场景 4 · 同一个会话里可以再立一个目标");
{
  const h = makeHarness();
  const create = h.tools.get("tree_task_create");

  const first = await create.execute(
    { title: "目标A", detail: "目标A 的说明", tasks: [{ title: "任务1" }] },
    execFor("s9", "tree_task_create"),
  );
  const plan1 = h.store.readPlan("s9");
  check(
    "第一次调用建起计划与第一个目标",
    /计划已建立/u.test(first.text) && plan1.goals.length === 1 && plan1.goals[0].title === "目标A",
    first.text.slice(0, 80),
  );
  check("目标的 detail 记下来了", plan1.goals[0].detail === "目标A 的说明", plan1.goals[0].detail);

  const second = await create.execute(
    { title: "目标B", tasks: [{ title: "任务2" }] },
    execFor("s9", "tree_task_create"),
  );
  const plan2 = h.store.readPlan("s9");
  check(
    "第二次调用是新增目标，不是替换整棵树",
    /已新增目标/u.test(second.text) && plan2.goals.length === 2,
    second.text.slice(0, 80),
  );
  check(
    "第一个目标原样留着",
    plan2.goals[0].id === plan1.goals[0].id && plan2.goals[0].title === "目标A",
    JSON.stringify({ before: plan1.goals[0].id, after: plan2.goals[0].id }),
  );
  check("两个目标的 id 不同", plan2.goals[0].id !== plan2.goals[1].id);
  check(
    "返回只给新建的那个目标的树",
    second.text.includes("目标B") && !second.text.includes("目标A"),
    second.text.slice(0, 200),
  );

  const noTitle = await create.execute(
    { tasks: [{ title: "任务3" }] },
    execFor("s9", "tree_task_create"),
  );
  check(
    "不给 title 时沿用占位标题，不抛错（原有兜底行为）",
    plan2.goals.length === 3 &&
      h.store.readPlan("s9").goals[2].title === "(未命名目标)" &&
      noTitle.text.includes("未命名目标"),
    noTitle.text.slice(0, 120),
  );
}

// ---------------------------------------------------------------- 场景 5

console.log("\n场景 5 · 返回只给本次动到的那个目标");
{
  const h = makeHarness();
  const planTool = h.tools.get("tree_task_plan");
  const create = h.tools.get("tree_task_create");

  await create.execute(
    { title: "目标甲", tasks: [{ title: "任务甲1" }] },
    execFor("s10", "tree_task_create"),
  );
  await create.execute(
    { title: "目标乙", tasks: [{ title: "任务乙1" }] },
    execFor("s10", "tree_task_create"),
  );

  const plan = h.store.readPlan("s10");
  const [goalA, goalB] = plan.goals;

  const addToB = await planTool.execute(
    { parentId: goalB.tasks[0].id, children: [{ title: "乙的子步骤" }] },
    execFor("s10", "tree_task_plan"),
  );
  check(
    "给目标乙加子节点时返回里有目标乙",
    addToB.text.includes("目标乙") && addToB.text.includes("乙的子步骤"),
    addToB.text.slice(0, 160),
  );
  check(
    "给目标乙加子节点时返回里没有目标甲",
    !addToB.text.includes("目标甲"),
    addToB.text.slice(0, 200),
  );

  const addToA = await planTool.execute(
    { parentId: goalA.id, children: [{ title: "任务甲2" }] },
    execFor("s10", "tree_task_plan"),
  );
  check(
    "换回目标甲时返回里只有目标甲",
    addToA.text.includes("目标甲") && !addToA.text.includes("目标乙"),
    addToA.text.slice(0, 200),
  );
}

// ---------------------------------------------------------------- 场景 6

console.log("\n场景 6 · status 默认收起已完成的目标");
{
  const h = makeHarness();
  const planTool = h.tools.get("tree_task_plan");
  const create = h.tools.get("tree_task_create");
  const status = h.tools.get("tree_task_status");

  await create.execute(
    { title: "做完的目标", detail: "这个目标的说明", tasks: [{ title: "它的任务" }] },
    execFor("s11", "tree_task_create"),
  );
  await create.execute(
    { title: "没做完的目标", tasks: [{ title: "还在干的任务" }] },
    execFor("s11", "tree_task_create"),
  );
  const plan = h.store.readPlan("s11");
  const [doneGoal, openGoal] = plan.goals;
  complete(plan, doneGoal.tasks[0].id, "任务做完了。");
  complete(plan, doneGoal.id, "目标做完了，交付了甲、乙、丙。");

  const plain = await status.execute({}, execFor("s11", "tree_task_status"));
  check("默认返回里目标那一行还在", plain.text.includes("做完的目标"), plain.text.slice(0, 200));
  check(
    "默认不展开已完成目标的任务",
    !plain.text.includes("它的任务"),
    plain.text.slice(0, 300),
  );
  check(
    "已完成目标自己的结果照给（不截断）",
    plain.text.includes("目标做完了，交付了甲、乙、丙。"),
    plain.text.slice(0, 300),
  );
  check(
    "没做完的那个目标照旧展开到任务",
    plain.text.includes("还在干的任务"),
    plain.text.slice(0, 400),
  );

  const named = await status.execute({ id: doneGoal.id }, execFor("s11", "tree_task_status"));
  check(
    "指名目标 id 就把它的完整树给出来",
    named.text.includes("它的任务") && !named.text.includes("没做完的目标"),
    named.text.slice(0, 300),
  );

  const byTask = await status.execute({ id: doneGoal.tasks[0].id }, execFor("s11", "tree_task_status"));
  check(
    "给任务 id 时按它所在的目标展开",
    byTask.text.includes("它的任务") && byTask.text.includes("做完的目标"),
    byTask.text.slice(0, 300),
  );

  const unknown = await status.execute({ id: "g-不存在" }, execFor("s11", "tree_task_status"));
  check("给不存在的 id 时给出明确说明", /找不到节点/u.test(unknown.text), unknown.text);

  const none = await status.execute({}, execFor("s11-无计划", "tree_task_status"));
  check("没有计划时指向 tree_task_create", /tree_task_create/u.test(none.text), none.text);
}

// ---------------------------------------------------------------- 场景 7

console.log("\n场景 7 · 任何返回都不截断结果");
{
  const h = makeHarness();
  const longTail = "尾巴在第一百八十字之后。".repeat(20);
  const longResult = `交付物：很多文件。\n\n验收方式：跑一遍。\n${longTail}`;
  const plan = createPlan({ title: "目标长", detail: "说明也长".repeat(60), tasks: [{ title: "任务长" }] }, 1000);
  h.store.writePlan("s12", plan);
  const [task1] = plan.goals[0].tasks;
  addChildren(plan, task1.id, [{ title: "子长" }], 1000);
  const [step1] = task1.steps;
  complete(plan, step1.id, longResult, 1000);
  complete(plan, task1.id, longResult, 1000);

  const text = await h.tools.get("tree_task_status").execute({}, execFor("s12", "tree_task_status"));
  // 渲染时每一行会带缩进，所以逐行核对，而不是整段包含。
  const resultLines = longResult.split("\n").filter((line) => line.trim() !== "");
  check(
    "子任务的整段结果原样在返回里",
    resultLines.every((line) => text.text.includes(line)),
    `结果 ${resultLines.length} 行，长度 ${longResult.length}`,
  );
  check("不再出现省略号截断", !text.text.includes("…"), text.text.split("\n").find((line) => line.includes("…")) ?? "");
  check("目标的说明也不截断", text.text.includes("说明也长".repeat(60)), "");

  const goal = await h.tools.get("tree_task_plan").execute(
    { parentId: task1.id, children: [{ title: "再加一个" }] },
    execFor("s12", "tree_task_plan"),
  );
  check(
    "tree_task_plan 的返回里结果也不截断",
    resultLines.every((line) => goal.text.includes(line)),
    "",
  );
}

// ---------------------------------------------------------------- 场景 8

console.log("\n场景 8 · tree_task_delete 真把节点摘掉");
{
  const h = makeHarness();
  const create = h.tools.get("tree_task_create");
  const planTool = h.tools.get("tree_task_plan");
  const done = h.tools.get("tree_task_done");
  const drop = h.tools.get("tree_task_drop");
  const del = h.tools.get("tree_task_delete");

  await create.execute(
    { title: "目标甲", tasks: [{ title: "任务甲1" }, { title: "任务甲2" }] },
    execFor("s11", "tree_task_create"),
  );
  await create.execute({ title: "目标乙", tasks: [{ title: "任务乙1" }] }, execFor("s11", "tree_task_create"));

  const plan = h.store.readPlan("s11");
  const [goalA, goalB] = plan.goals;
  const [taskA1, taskA2] = goalA.tasks;
  await planTool.execute(
    { parentId: taskA1.id, children: [{ title: "步骤甲1" }, { title: "步骤甲2" }] },
    execFor("s11", "tree_task_plan"),
  );
  const [stepA1, stepA2] = taskA1.steps;

  // 先把一个步骤做完、再把另一个丢弃：两种"结束态"都要能删。
  await done.execute({ id: stepA1.id, result: "步骤甲1 的结果" }, execFor("s11", "tree_task_done"));
  await drop.execute({ id: stepA2.id }, execFor("s11", "tree_task_drop"));

  const delDone = await del.execute({ id: stepA1.id }, execFor("s11", "tree_task_delete"));
  check(
    "已完成的步骤删得掉（丢弃做不到这件事）",
    delDone.text.startsWith("已删除：") &&
      delDone.text.includes("子任务「步骤甲1」") &&
      !delDone.text.includes("步骤甲1 的结果"),
    delDone.text.slice(0, 200),
  );
  check(
    "删完之后返回给的是它所在那个目标的树",
    delDone.text.includes("目标甲") && !delDone.text.includes("目标乙"),
    delDone.text.slice(0, 200),
  );
  const afterStep = h.store.readPlan("s11");
  check("步骤真的从树里消失了", afterStep.goals[0].tasks[0].steps.length === 1, String(afterStep.goals[0].tasks[0].steps.length));

  const delTask = await del.execute({ id: taskA1.id }, execFor("s11", "tree_task_delete"));
  check(
    "删任务会把剩下的子任务一起带走",
    delTask.text.includes("步骤甲2") && h.store.readPlan("s11").goals[0].tasks.length === 1,
    delTask.text.slice(0, 200),
  );

  const delGoal = await del.execute({ id: goalA.id }, execFor("s11", "tree_task_delete"));
  check(
    "删目标是整支一起走",
    delGoal.text.includes("任务甲2") && h.store.readPlan("s11").goals.length === 1,
    delGoal.text.slice(0, 200),
  );
  check(
    "删掉的目标不再渲染出树，剩下那个目标还在盘上",
    !delGoal.text.includes("**目标**") &&
      delGoal.text.includes("还剩 1 个目标") &&
      h.store.readPlan("s11").goals[0].id === goalB.id,
    delGoal.text.slice(0, 200),
  );

  const gone = await del.execute({ id: "g-nope" }, execFor("s11", "tree_task_delete"));
  check("删不存在的节点被拒", gone.text.startsWith("没有删除："), gone.text);
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
}
