/**
 * tools.js 的工具层自测（需求模型这一版）。
 *
 * 用假 ctx 与假 store 把工具层单独拎出来跑，覆盖这些事：
 *
 *   1. 十个工具都在；边界仍按工具名区分（`create` / `start` / `done`），`requirement` 不是边界。
 *   2. 提出需求先落**草稿**，确认之后才进活跃列表。
 *   3. 需求的改法：AI 直接改（版本 +1）/ 确认用户暂定版本 / 有歧义就退回。
 *   4. 归档与完成正交；归档不返回整棵树。
 *   5. 任务与步骤的加法、完成时必须带 `result`、完成后的提示。
 *   6. 查询：列表（含计数与展开）、一次查多条、版本历史、关键词。
 *   7. 笔记：写、覆盖、查。
 *   8. 任何返回都**不截断**结果文本。
 *
 * 工具层不拦任何别的工具——检查点只是提示，没有 `tools/pre-execute` 闸门，
 * 所以假 ctx 只需要 `tools.register`。
 *
 * 跑：node verify-tools.mjs
 */

import { registerTools } from "./lib/tools.js";
import { updateByUser } from "./lib/requirement.js";

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

/** 现在这十个工具，顺序无关，只用来核对集合。 */
const NINE_TOOLS = [
  "tree_task_status",
  "tree_task_create",
  "tree_task_requirement",
  "tree_task_start",
  "tree_task_plan",
  "tree_task_done",
  "tree_task_update",
  "tree_task_drop",
  "tree_task_delete",
  "tree_task_note",
];

/** 已经删掉的工具——它们出现在注册表里就说明删漏了。 */
const REMOVED_TOOLS = ["tree_task_save", "tree_task_recall", "tree_task_forget"];

/** 假 ctx + 假 store + 假会话。 */
function makeHarness() {
  const plans = new Map();
  const notes = new Map();
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
    readPlan: (sessionId) => plans.get(sessionId) ?? null,
    writePlan: (sessionId, plan) => {
      plans.set(sessionId, plan);
    },
    readNotes: (sessionId) => notes.get(sessionId) ?? { version: 1, items: [], updatedAt: null },
    writeNotes: (sessionId, state) => {
      notes.set(sessionId, state);
    },
  };

  registerTools(ctx, { store, cfg: {} });
  return { tools, store, plans, notes };
}

const execFor = (sessionId, name) => ({
  name,
  agent: { session: { id: sessionId, surface: { nodes: [0] } } },
});

/** 调一个工具，返回它的文本。 */
async function call(h, sessionId, name, args) {
  const def = h.tools.get(name);
  if (def === undefined) throw new Error(`没有工具 ${name}`);
  const value = await def.execute(args ?? {}, execFor(sessionId, name));
  return String(value?.text ?? "");
}

// ---------------------------------------------------------------- 场景 1

console.log("\n场景 1 · 十个工具的注册表与 schema");
{
  const h = makeHarness();

  check("恰好注册十个工具", h.tools.size === 10, `实际 ${h.tools.size}`);
  for (const name of NINE_TOOLS) check(`  ${name} 已注册`, h.tools.has(name));
  check(
    "记忆三工具都已移除",
    REMOVED_TOOLS.every((name) => !h.tools.has(name)),
    REMOVED_TOOLS.filter((name) => h.tools.has(name)).join(", "),
  );

  const done = h.tools.get("tree_task_done");
  check(
    "tree_task_done 把 result 列为必填",
    (done.parameters.required ?? []).includes("result"),
    JSON.stringify(done.parameters.required),
  );

  const create = h.tools.get("tree_task_create");
  check(
    "create 收 title / intro / detail / tasks，一个都不必填（草稿可以先只有详情）",
    Object.keys(create.parameters.properties).sort().join(",") === "detail,intro,tasks,title" &&
      create.parameters.required === undefined,
    JSON.stringify(create.parameters),
  );
  check(
    "create 的说明写清了先落草稿、要确认",
    create.description.includes("草稿") && create.description.includes("confirm"),
    create.description,
  );

  const requirement = h.tools.get("tree_task_requirement");
  const actions = requirement.parameters.properties.action.enum.join(",");
  check(
    "requirement 的 action 枚举齐了七种",
    actions === "confirm,update,confirmChange,question,archive,unarchive,prerequisites",
    actions,
  );
  check(
    "requirement 只要求 action 必填（id 可换成 ids 批量归档）",
    (requirement.parameters.required ?? []).join(",") === "action",
    JSON.stringify(requirement.parameters.required),
  );
  check(
    "requirement 的说明写明归档支持批量",
    requirement.description.includes("可批量") &&
      requirement.parameters.properties.ids.description.includes("批量"),
    requirement.parameters.properties.ids.description,
  );
  check(
    "requirement 的说明写明暂定版本要确认、确认后版本号加一",
    requirement.description.includes("暂定版本") && requirement.description.includes("版本号加一"),
    requirement.description,
  );

  const plan = h.tools.get("tree_task_plan");
  check(
    "plan 只收 parentId 与 children，两个都必填",
    Object.keys(plan.parameters.properties).sort().join(",") === "children,parentId" &&
      (plan.parameters.required ?? []).sort().join(",") === "children,parentId",
  );
  check("plan 的说明撇清「建新需求」——那是 create", plan.description.includes("tree_task_create"));
  check(
    "plan 的说明讲明白调用前先读完资料",
    plan.description.includes("读完所需资料"),
    plan.description,
  );
  check(
    "start 的说明要求调用前先读取文件与文档，并写明折叠范围",
    h.tools.get("tree_task_start").description.includes("调用前先读取") &&
      h.tools.get("tree_task_start").description.includes("折叠"),
    h.tools.get("tree_task_start").description,
  );

  check(
    "done 的说明开头就是「完成步骤、任务或需求」",
    done.description.startsWith("完成步骤、任务或需求"),
    done.description.slice(0, 40),
  );
  check(
    "done 的说明讲清折叠范围与 result 要能独立看懂",
    done.description.includes("折叠") && done.description.includes("独立看懂"),
    done.description.slice(-80),
  );
  check(
    "done 的说明要求每完成一个步骤调用一次，不合并",
    done.description.includes("每完成一个步骤调用一次") && done.description.includes("不要合并"),
    done.description,
  );
  check(
    "「折叠」只出现在 start 与 done 的描述里",
    [...h.tools]
      .filter(([, def]) => (def.description ?? "").includes("折叠"))
      .map(([name]) => name)
      .sort()
      .join(",") === "tree_task_done,tree_task_start",
    [...h.tools]
      .filter(([, def]) => (def.description ?? "").includes("折叠"))
      .map(([name]) => name)
      .join(", "),
  );

  check(
    "note 只收 key / text / query，都不是必填",
    Object.keys(h.tools.get("tree_task_note").parameters.properties).sort().join(",") === "key,query,text",
  );
  check(
    "status 支持一次查多条（ids 是数组）",
    h.tools.get("tree_task_status").parameters.properties.ids.type === "array",
  );

  const descHits = [...h.tools].filter(([, def]) => /needs/u.test(def.description ?? "")).map(([name]) => name);
  check("所有 description 都不提 needs", descHits.length === 0, descHits.join(", "));
}

// ---------------------------------------------------------------- 场景 2

console.log("\n场景 2 · 提出需求（草稿）");
{
  const h = makeHarness();
  const text = await call(h, "s1", "tree_task_create", { detail: "用户说：把菜单改成深色" });

  check("create 返回草稿编号", text.includes("R1"), text);
  check("create 说明确认前仍是草稿", text.includes("仍是草稿"), text);
  check("create 指向 update 补正文与 confirm 确认", text.includes("update") && text.includes("confirm"), text);

  const plan = h.plans.get("s1");
  check(
    "草稿落盘：状态 draft、没有版本历史、没有标题",
    plan.goals[0].status === "draft" && plan.goals[0].versions.length === 0 && plan.goals[0].title === "",
  );

  const list = await call(h, "s1", "tree_task_status", {});
  check("草稿不出现在活跃列表里，只在草稿区", list.includes("活跃 0 条") && list.includes("草稿 1 条"), list);

  const withTasks = await call(h, "s2", "tree_task_create", {
    title: "一口气写全",
    tasks: [{ title: "任务甲" }, { title: "任务乙" }],
  });
  const plan2 = h.plans.get("s2");
  check(
    "create 可以顺手带任务，任务是真任务（有自己的 id）",
    plan2.goals[0].tasks.length === 2 && /^t-/u.test(plan2.goals[0].tasks[0].id),
    withTasks,
  );
  check("带任务也还是草稿", plan2.goals[0].status === "draft");
}

// ---------------------------------------------------------------- 场景 3

console.log("\n场景 3 · 确认草稿成正式需求");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "原话" });

  const noTitle = await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm" });
  check("confirm 缺标题被拒", noTitle.includes("没有确认") && noTitle.includes("标题"), noTitle);

  const tooLong = await call(h, "s1", "tree_task_requirement", {
    id: "R1",
    action: "confirm",
    title: "字".repeat(60),
  });
  check("confirm 标题超 50 字被拒", tooLong.includes("超过"), tooLong);

  const okText = await call(h, "s1", "tree_task_requirement", {
    id: "R1",
    action: "confirm",
    title: "菜单改深色",
    intro: "菜单太亮，改成深色",
  });
  check("confirm 成功并报版本 v1", okText.includes("v1"), okText);

  const plan = h.plans.get("s1");
  check(
    "确认后：状态 pending、版本历史一条、by 是 ai",
    plan.goals[0].status === "pending" &&
      plan.goals[0].versions.length === 1 &&
      plan.goals[0].versions[0].by === "ai",
  );

  const list = await call(h, "s1", "tree_task_status", {});
  check("确认后出现在活跃列表里", list.includes("活跃 1 条") && list.includes("菜单改深色"), list);
}

// ---------------------------------------------------------------- 场景 4

console.log("\n场景 4 · 改需求（AI 改 / 确认用户改动 / 退回）");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "原话" });
  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "甲", intro: "第一版" });

  const updated = await call(h, "s1", "tree_task_requirement", {
    id: "R1",
    action: "update",
    intro: "第二版",
    change: "用户说要更深",
  });
  check("update 改正文后回到草稿，不升版", updated.includes("仍是草稿") && updated.includes("第二版"), updated);
  check(
    "update 后状态是草稿、版本仍是一条",
    h.plans.get("s1").goals[0].status === "draft" && h.plans.get("s1").goals[0].versions.length === 1,
  );

  const reconfirmed = await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm" });
  check("再次 confirm 生成 v2", reconfirmed.includes("v2"), reconfirmed);

  // 造一份"用户提交的暂定版本"：工具层没有这个动作，那是面板按钮，直接改状态。
  const plan = h.plans.get("s1");
  updateByUser(plan, "R1", { intro: "用户自己改的", change: "改成夜间" });

  const blocked = await call(h, "s1", "tree_task_requirement", {
    id: "R1",
    action: "update",
    intro: "AI 还想改",
  });
  check("有暂定版本时 AI 改正文被拒", blocked.includes("暂定版本"), blocked);

  const doneBlocked = await call(h, "s1", "tree_task_done", { id: "R1", result: "总结" });
  check("有暂定版本时完成需求被拒", doneBlocked.includes("先确认"), doneBlocked);

  const questioned = await call(h, "s1", "tree_task_requirement", {
    id: "R1",
    action: "question",
    question: "「夜间」指配色还是自动切换？",
  });
  check("question 把疑问记下来", questioned.includes("等用户改"), questioned);
  check("question 不升版", h.plans.get("s1").goals[0].versions.length === 2);

  const confirmed = await call(h, "s1", "tree_task_requirement", {
    id: "R1",
    action: "confirmChange",
  });
  check("confirmChange 转正并报 v3", confirmed.includes("v3"), confirmed);
  check(
    "转正后正文是用户改的那一版，by 记 user",
    h.plans.get("s1").goals[0].intro.includes("用户自己改的") && h.plans.get("s1").goals[0].versions[2].by === "user",
  );
  check("转正后暂定版本清空", h.plans.get("s1").goals[0].pending === null);
}

// ---------------------------------------------------------------- 场景 5

console.log("\n场景 5 · 归档与前置");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "x" });
  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "甲" });
  await call(h, "s1", "tree_task_create", { detail: "y" });
  await call(h, "s1", "tree_task_requirement", { id: "R2", action: "confirm", title: "乙" });

  const archived = await call(h, "s1", "tree_task_requirement", { id: "R1", action: "archive" });
  check("archive 报一句结果，不倒整棵树", archived.includes("已归档") && !archived.includes("已归档（"), archived);

  const list = await call(h, "s1", "tree_task_status", {});
  check("归档后活跃剩一条、已归档一条", list.includes("活跃 1 条") && list.includes("已归档 1 条"), list);

  const again = await call(h, "s1", "tree_task_requirement", { id: "R1", action: "archive" });
  check("重复归档说「本来就是归档状态」", again.includes("本来就是归档状态"), again);

  const back = await call(h, "s1", "tree_task_requirement", { id: "R1", action: "unarchive" });
  check("unarchive 把它放回活跃", back.includes("取消归档"), back);

  const pre = await call(h, "s1", "tree_task_requirement", {
    id: "R2",
    action: "prerequisites",
    ids: ["R1"],
  });
  check("设前置成功并报出来", pre.includes("R1"), pre);
  check(
    "前置那一行不把同一个编号说两遍",
    pre.includes("**前置**：R1（未完成）") && !pre.includes("缺 R1（"),
    pre,
  );
  const cycle = await call(h, "s1", "tree_task_requirement", {
    id: "R1",
    action: "prerequisites",
    ids: ["R2"],
  });
  check("成环被拒", cycle.includes("成环"), cycle);
  const unknownAction = await call(h, "s1", "tree_task_requirement", { id: "R1", action: "nope" });
  check("不认识的动作被拒", unknownAction.includes("不认识的动作"), unknownAction);
}

// ---------------------------------------------------------------- 场景 6

console.log("\n场景 6 · 任务与步骤");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "x" });
  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "甲" });

  const added = await call(h, "s1", "tree_task_plan", {
    parentId: "R1",
    children: [{ title: "任务一" }, { title: "任务二" }],
  });
  check("给需求加任务报「任务」", added.includes("已添加 2 个任务"), added);
  check("返回只给这条需求的进度，不是整个列表", added.includes("R1") && !added.includes("需求列表"));

  const plan = h.plans.get("s1");
  const taskA = plan.goals[0].tasks[0];
  const steps = await call(h, "s1", "tree_task_plan", {
    parentId: taskA.id,
    children: [{ title: "步骤一" }],
  });
  check("给任务加步骤报「步骤」", steps.includes("已添加 1 个步骤"), steps);

  const stepId = h.plans.get("s1").goals[0].tasks[0].steps[0].id;
  const tooDeep = await call(h, "s1", "tree_task_plan", { parentId: stepId, children: [{ title: "更深" }] });
  check("步骤是最低一级，不能再拆", tooDeep.includes("最低一级"), tooDeep);

  const noResult = await call(h, "s1", "tree_task_done", { id: stepId });
  check("done 缺 result 被拒", noResult.includes("没有完成"), noResult);
  check("被拒后节点状态不变", h.plans.get("s1").goals[0].tasks[0].steps[0].status === "pending");

  const doneStep = await call(h, "s1", "tree_task_done", { id: stepId, result: "这一步做了" });
  check(
    "完成最后一个步骤后进入检查点（问这条任务算不算做完）",
    doneStep.includes("检查点") && doneStep.includes("tree_task_done"),
    doneStep,
  );

  const rename = await call(h, "s1", "tree_task_update", { id: taskA.id, title: "任务一（改名）" });
  check("update 能改任务标题", rename.includes("title"), rename);

  const refuseRequirement = await call(h, "s1", "tree_task_update", { id: "R1", title: "改需求" });
  check("update 拒绝改需求（要留版本历史）", refuseRequirement.includes("tree_task_requirement"), refuseRequirement);
}

// ---------------------------------------------------------------- 场景 6b

console.log("\n场景 6b · 开始需求");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "x" });

  const draft = await call(h, "s1", "tree_task_start", { id: "R1" });
  check("草稿不能开工，先确认", draft.includes("仍是草稿") && draft.includes("confirm"), draft);
  check("草稿没有被记上开始时间", h.plans.get("s1").goals[0].startedAt === undefined);

  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "甲", intro: "简介一句" });
  await call(h, "s1", "tree_task_plan", { parentId: "R1", children: [{ title: "任务一" }] });

  const text = await call(h, "s1", "tree_task_start", { id: "R1" });
  check("开始需求返回这条需求的详情", text.includes("## R1") && text.includes("简介一句") && text.includes("任务一"), text);
  check("记下开始时间", typeof h.plans.get("s1").goals[0].startedAt === "number");
  check("找不到的需求开工被拒", (await call(h, "s1", "tree_task_start", { id: "R9" })).includes("找不到需求"));

  await call(h, "s1", "tree_task_done", { id: "R1", result: "做完了" });
  const again = await call(h, "s1", "tree_task_start", { id: "R1" });
  check("已经完成的需求不能再开工", again.includes("不能再开工"), again);
}

// ---------------------------------------------------------------- 场景 7

console.log("\n场景 7 · 完成任务与需求时的提示");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "x" });
  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "甲" });
  await call(h, "s1", "tree_task_plan", { parentId: "R1", children: [{ title: "任务一" }, { title: "任务二" }] });
  const plan = h.plans.get("s1");
  const [taskA, taskB] = plan.goals[0].tasks;

  const first = await call(h, "s1", "tree_task_done", { id: taskA.id, result: "甲完成" });
  check("完成一个任务时提示还剩几个", first.includes("还剩 1 个任务"), first);

  const last = await call(h, "s1", "tree_task_done", { id: taskB.id, result: "乙完成" });
  check("任务都完了，提示可以写总结", last.includes("可以写总结并完成它"), last);

  const noSummary = await call(h, "s1", "tree_task_done", { id: "R1", result: "   " });
  check("完成需求必须有总结", noSummary.includes("没有完成"), noSummary);

  const summary = await call(h, "s1", "tree_task_done", { id: "R1", result: "做完了，坑在 README" });
  check("需求完成时返回「简」列表", summary.includes("需求列表（") && summary.includes("活跃 1 条"), summary);
  const saved = h.plans.get("s1").goals[0];
  check(
    "总结落进 result，状态 done",
    saved.status === "done" && saved.result.text.includes("坑在 README"),
  );
  check("整个会话结束时有收尾提示", summary.includes("全部完成"), summary);
}

// ---------------------------------------------------------------- 场景 8

console.log("\n场景 8 · 放弃与删除");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "x" });
  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "甲" });
  await call(h, "s1", "tree_task_plan", { parentId: "R1", children: [{ title: "任务一" }] });
  const taskId = h.plans.get("s1").goals[0].tasks[0].id;

  const dropped = await call(h, "s1", "tree_task_drop", { id: "R1" });
  check("放弃需求会报出被放弃的东西", dropped.includes("已放弃需求 R1"), dropped);
  check("任务也跟着放弃", h.plans.get("s1").goals[0].tasks[0].status === "dropped");

  const list = await call(h, "s1", "tree_task_status", {});
  check("放弃的需求仍在活跃列表里（划掉）", list.includes("已放弃"), list);

  await call(h, "s2", "tree_task_create", { detail: "y" });
  await call(h, "s2", "tree_task_requirement", { id: "R1", action: "confirm", title: "乙" });
  const dropUnknown = await call(h, "s2", "tree_task_drop", { id: "R7" });
  check("放弃不存在的节点说清楚", dropUnknown.includes("没有放弃") && dropUnknown.includes("R7"), dropUnknown);
  const removed = await call(h, "s2", "tree_task_delete", { id: "R1" });
  check("删掉最后一条需求后说「现在没有需求了」", removed.includes("现在没有需求了"), removed);

  const draftDelete = await call(h, "s3", "tree_task_create", { detail: "z" });
  const delDraft = await call(h, "s3", "tree_task_delete", { id: "R1" });
  check("草稿也能直接删", delDraft.includes("已删除") && h.plans.get("s3").goals.length === 0);
}

console.log("\n场景 8b · 批量放弃 / 删除 / 归档");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "a" });
  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "甲" });
  await call(h, "s1", "tree_task_plan", {
    parentId: "R1",
    children: [{ title: "一" }, { title: "二" }, { title: "三" }],
  });
  const plan = h.plans.get("s1");
  const [t1, t2, t3] = plan.goals[0].tasks.map((each) => each.id);

  const dropped = await call(h, "s1", "tree_task_drop", { ids: [t1, t2, t2, "nope"] });
  check(
    "批量放弃一次处理多个",
    dropped.includes("已放弃 2 个节点") && dropped.includes("任务「一」") && dropped.includes("任务「二」"),
    dropped,
  );
  check("同一个 id 给两遍只算一次", !dropped.includes("已放弃 3 个"), dropped);
  check("找不到的 id 单独报出来", dropped.includes("已经不在了") && dropped.includes("nope"), dropped);
  check(
    "该放弃的都真的放弃了，没点的没动",
    plan.goals[0].tasks[0].status === "dropped" &&
      plan.goals[0].tasks[1].status === "dropped" &&
      plan.goals[0].tasks[2].status !== "dropped",
  );

  const removed = await call(h, "s1", "tree_task_delete", { ids: ["R1", t3] });
  check("批量删除：父节点连子孙一起摘掉", removed.includes("已删除") && h.plans.get("s1").goals.length === 0, removed);
  check("被父节点带走的子节点记成「已经不在了」", removed.includes("已经不在了") && removed.includes(t3), removed);

  const h2 = makeHarness();
  for (const title of ["甲", "乙", "丙"]) {
    const created = await call(h2, "s1", "tree_task_create", { detail: title });
    const id = created.match(/R\d+/u)[0];
    await call(h2, "s1", "tree_task_requirement", { id, action: "confirm", title });
  }
  const archived = await call(h2, "s1", "tree_task_requirement", { action: "archive", ids: ["R1", "R2", "R9"] });
  check(
    "批量归档一次处理多条",
    archived.includes("已归档 2 条") && archived.includes("R1") && archived.includes("R2"),
    archived,
  );
  check("批量里不存在的编号单独报出来", archived.includes("R9"), archived);
  check("真的归档了两条", h2.plans.get("s1").goals.filter((each) => each.archived === true).length === 2);
  check(
    "不存在的编号不会顺手把别的也归档",
    h2.plans.get("s1").goals.find((each) => each.id === "R3").archived !== true,
  );

  const unarchived = await call(h2, "s1", "tree_task_requirement", { action: "unarchive", ids: ["R1", "R2"] });
  check("批量取消归档", unarchived.includes("已取消归档 2 条"), unarchived);
  check("取消之后一条归档都没有了", h2.plans.get("s1").goals.every((each) => each.archived !== true));
}

// ---------------------------------------------------------------- 场景 9

console.log("\n场景 9 · 查询");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "第一条的详情" });
  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "改菜单", intro: "太亮" });
  await call(h, "s1", "tree_task_create", { detail: "第二条的详情" });
  await call(h, "s1", "tree_task_requirement", { id: "R2", action: "confirm", title: "加导出", intro: "要 CSV" });
  await call(h, "s1", "tree_task_requirement", { id: "R2", action: "update", detail: "更长更长的详情", change: "补了细节" });
  // update 把需求放回草稿，要再确认一次才有第二版。
  await call(h, "s1", "tree_task_requirement", { id: "R2", action: "confirm", change: "确认补充的细节" });

  const list = await call(h, "s1", "tree_task_status", {});
  check("列表带计数与两条需求", list.includes("活跃 2 条") && list.includes("改菜单") && list.includes("加导出"), list);
  check("列表只给标题与简介，不给详情", !list.includes("更长更长的详情"));

  const one = await call(h, "s1", "tree_task_status", { ids: ["R2"] });
  check("按编号查详情会给出详情全文", one.includes("更长更长的详情"), one);
  check("默认节包含任务列表", one.includes("**任务**"), one);

  const withVersions = await call(h, "s1", "tree_task_status", { ids: ["R2"], include: ["detail", "versions"] });
  check("要历史就给版本历史，两次改动都在", withVersions.includes("v1") && withVersions.includes("v2"));

  const many = await call(h, "s1", "tree_task_status", { ids: ["R1", "R2"] });
  check("一次查多条，两条都在", many.includes("R1") && many.includes("R2") && many.includes("---"));

  const missing = await call(h, "s1", "tree_task_status", { ids: ["R9"] });
  check("查不存在的需求说清楚", missing.includes("找不到需求 R9"));

  const matched = await call(h, "s1", "tree_task_status", { match: "CSV" });
  check("按关键词找得到（在简介里）", matched.includes("加导出") && !matched.includes("改菜单"));

  const empty = await call(h, "s9", "tree_task_status", {});
  check("空会话给出下一步提示", empty.includes("还没有需求"), empty);
}

// ---------------------------------------------------------------- 场景 10

console.log("\n场景 10 · 笔记");
{
  const h = makeHarness();

  const wrote = await call(h, "s1", "tree_task_note", { key: "构建入口", text: "用 build.ps1" });
  check("写笔记当场返回", wrote.includes("已记下") && wrote.includes("r1"), wrote);

  const again = await call(h, "s1", "tree_task_note", { key: "构建入口", text: "用 build.ps1 -Release" });
  check("同名覆盖，修订号 +1", again.includes("已更新") && again.includes("r2"), again);

  await call(h, "s1", "tree_task_note", { key: "偏好", text: "回答简短" });

  const all = await call(h, "s1", "tree_task_note", {});
  check("不给参数就是查全部", all.includes("笔记 2 条") && all.includes("构建入口") && all.includes("偏好"), all);

  const found = await call(h, "s1", "tree_task_note", { query: "Release" });
  check("按关键词查", found.includes("构建入口") && !found.includes("偏好"), found);

  const empty = await call(h, "s2", "tree_task_note", {});
  check("没有笔记时给写法的提示", empty.includes("还没有笔记"), empty);

  const bad = await call(h, "s3", "tree_task_note", { key: "名字" });
  check("只给 key 不给 text 时被拒（不会写空笔记）", bad.includes("没有记下"), bad);

  check(
    "笔记真的写进 store 了",
    h.notes.get("s1").items.length === 2 && h.notes.get("s1").items[0].rev === 2,
  );
}

// ---------------------------------------------------------------- 场景 11

console.log("\n场景 11 · 不截断");
{
  const h = makeHarness();
  await call(h, "s1", "tree_task_create", { detail: "x" });
  await call(h, "s1", "tree_task_requirement", { id: "R1", action: "confirm", title: "甲" });
  await call(h, "s1", "tree_task_plan", { parentId: "R1", children: [{ title: "任务一" }] });
  const taskId = h.plans.get("s1").goals[0].tasks[0].id;

  const long = `${"很长的交付说明。".repeat(60)}结尾标记`;
  await call(h, "s1", "tree_task_done", { id: taskId, result: long });

  const detail = await call(h, "s1", "tree_task_status", { ids: ["R1"] });
  check("任务结果原样出现在详情里，一个字都没截", detail.includes("结尾标记"), "");
  check("详情里带着完整长度", detail.includes("很长的交付说明。".repeat(60)));
}

// ---------------------------------------------------------------- 结尾

console.log("");
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`${pass} 项通过，${failures.length} 项失败：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
