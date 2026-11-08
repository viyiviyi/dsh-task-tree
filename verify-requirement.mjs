/**
 * requirement.js 的纯逻辑自测。
 *
 * 需求这一层不碰 DSH、不碰磁盘，所以可以在插件目录直接跑，不需要任何宿主包。
 * 覆盖：草稿与确认、编号分配与不复用、AI 改与用户改（暂定版本）、双确认回路、
 * 完成 / 放弃 / 删除 / 归档、前置与成环、完成时的提示、活跃推导、两个列表、旧数据补齐。
 *
 * 跑法：`node verify-requirement.mjs`。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChildren, complete } from "./lib/plan.js";
import { createStore } from "./lib/store.js";
import {
  findNotes,
  normalizeNotes,
  notesInRange,
  parseNoteLines,
  renderNoteLines,
  upsertNote,
} from "./lib/notes.js";
import {
  LIMITS,
  addDraft,
  activeRequirement,
  activityAt,
  charCount,
  completionHints,
  completeRequirement,
  confirmPending,
  confirmRequirement,
  currentVersion,
  deleteRequirement,
  dependentsOf,
  dropRequirement,
  isDraft,
  listActive,
  listArchived,
  listDrafts,
  missingPrerequisites,
  normalizeRequirement,
  progressOf,
  questionPending,
  requirementOf,
  requirementOfTask,
  setArchived,
  setPrerequisites,
  taskCompletionHints,
  updateByAi,
  updateByUser,
  validateFields,
} from "./lib/requirement.js";

let pass = 0;
const failures = [];

/** 断言：可以是布尔，也可以是函数（里面建 fixture、调一串 API）。抛异常算失败。 */
function check(name, cond, detail) {
  let value = cond;
  let note = detail;
  if (typeof cond === "function") {
    try {
      value = cond();
    } catch (error) {
      value = false;
      note = `断言抛异常：${String(error?.message ?? error)}`;
    }
  }
  if (value) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(note ? `${name} — ${note}` : name);
    console.log(`  FAIL  ${name}${note ? ` — ${note}` : ""}`);
  }
}

const T0 = 1_700_000_000_000;

/** 一份空计划。需求都住在 `plan.goals` 里（历史键名）。 */
function emptyPlan() {
  return { version: 3, createdAt: T0, updatedAt: T0, goals: [] };
}

/**
 * 一条确认过的需求 + 两个任务，任务 A 下两个步骤。
 * 编号 R1；回调里可以继续加工。
 */
function fixture(now = T0) {
  const plan = emptyPlan();
  const draft = addDraft(plan, { detail: "用户原话在这" }, now);
  confirmRequirement(plan, draft.id, { title: "把菜单改成深色", intro: "菜单太亮" }, now);
  const requirement = requirementOf(plan, draft.id);
  addChildren(plan, requirement.id, [{ title: "任务A" }, { title: "任务B" }], now);
  const [taskA, taskB] = requirement.tasks;
  addChildren(plan, taskA.id, [{ title: "A1" }, { title: "A2" }], now);
  return { plan, requirement, taskA, taskB, now };
}

console.log("场景 1 · 草稿");

check("草稿：id 是 R1，状态 draft，没有版本历史，不进活跃列表", () => {
  const plan = emptyPlan();
  const draft = addDraft(plan, { detail: "用户原话" }, T0);
  return (
    draft.id === "R1" &&
    draft.status === "draft" &&
    draft.versions.length === 0 &&
    draft.pending === null &&
    isDraft(draft) &&
    listActive(plan).length === 0 &&
    listDrafts(plan).length === 1
  );
});

check("草稿也可以挂任务（用户一口气写全的那种）", () => {
  const plan = emptyPlan();
  const draft = addDraft(plan, { title: "一句话" }, T0);
  addChildren(plan, draft.id, [{ title: "任务" }], T0);
  return draft.tasks.length === 1;
});

check("草稿不能完成、不能放弃、不能归档，但可以改正文", () => {
  const plan = emptyPlan();
  const draft = addDraft(plan, {}, T0);
  const finished = completeRequirement(plan, draft.id, "x", T0);
  const updated = updateByAi(plan, draft.id, { title: "补充标题" }, T0 + 1);
  return (
    finished.reason.includes("草稿") &&
    dropRequirement(plan, draft.id, T0).reason.includes("草稿") &&
    setArchived(plan, draft.id, true, T0).reason.includes("草稿") &&
    updated.ok === true &&
    draft.title === "补充标题" &&
    draft.status === "draft" &&
    draft.versions.length === 0
  );
});

check("草稿上多次 update 不生成版本，confirm 时才落 v1", () => {
  const plan = emptyPlan();
  const draft = addDraft(plan, { detail: "原话" }, T0);
  updateByAi(plan, draft.id, { title: "甲" }, T0 + 1);
  updateByAi(plan, draft.id, { intro: "补简介" }, T0 + 2);
  updateByAi(plan, draft.id, { detail: "补详情" }, T0 + 3);
  const before = draft.versions.length;
  const confirmed = confirmRequirement(plan, draft.id, {}, T0 + 4);
  return (
    before === 0 &&
    confirmed.ok === true &&
    confirmed.version.n === 1 &&
    draft.status === "pending" &&
    draft.title === "甲" &&
    draft.intro === "补简介"
  );
});

check("确认草稿：标题必填、超长拒绝、确认后成为未完成并落下 v1", () => {
  const plan = emptyPlan();
  const draft = addDraft(plan, {}, T0);
  const noTitle = confirmRequirement(plan, draft.id, {}, T0);
  const tooLong = confirmRequirement(plan, draft.id, { title: "字".repeat(LIMITS.title + 1) }, T0);
  const ok = confirmRequirement(plan, draft.id, { title: "改菜单", intro: "太亮" }, T0);
  return (
    noTitle.ok === false &&
    tooLong.ok === false &&
    tooLong.reason.includes("超过") &&
    ok.ok === true &&
    draft.status === "pending" &&
    draft.versions.length === 1 &&
    draft.versions[0].n === 1 &&
    draft.versions[0].by === "ai" &&
    draft.versions[0].change === "初始需求"
  );
});

check("确认时不填标题就沿用草稿已有的标题（别逼着抄一遍）", () => {
  const plan = emptyPlan();
  const draft = addDraft(plan, { title: "草稿就带着标题" }, T0);
  const result = confirmRequirement(plan, draft.id, { intro: "补一句简介" }, T0);
  return result.ok === true && draft.title === "草稿就带着标题" && result.version.n === 1;
});

console.log("场景 2 · 编号");

check("编号按 R1、R2 递增，存在 plan.nextNumber 上", () => {
  const plan = emptyPlan();
  addDraft(plan, {}, T0);
  addDraft(plan, {}, T0);
  const third = addDraft(plan, {}, T0);
  return third.id === "R3" && plan.nextNumber === 4;
});

check("删掉的需求不回收编号", () => {
  const plan = emptyPlan();
  addDraft(plan, {}, T0);
  const second = addDraft(plan, {}, T0);
  deleteRequirement(plan, second.id, T0);
  const third = addDraft(plan, {}, T0);
  return second.id === "R2" && third.id === "R3";
});

console.log("场景 3 · AI 改需求");

check("AI 改需求：正文改掉、需求回到草稿、不生成版本", () => {
  const { plan, requirement } = fixture();
  const result = updateByAi(plan, requirement.id, { intro: "改成更深" }, T0 + 10);
  return (
    result.ok === true &&
    requirement.intro === "改成更深" &&
    requirement.status === "draft" &&
    currentVersion(requirement) === 1
  );
});

check("AI 改需求：既没有字段也没有说明时拒绝", () => {
  const { plan, requirement } = fixture();
  return updateByAi(plan, requirement.id, {}, T0).ok === false;
});

check("只给 change、正文没变：登记但不升版（折叠要靠它认「已经把用户的话写进需求」）", () => {
  const { plan, requirement } = fixture();
  const before = currentVersion(requirement);
  const result = updateByAi(plan, requirement.id, { change: "用户说继续做完，需求无变化" }, T0 + 1);
  return (
    result.ok === true &&
    result.noop === true &&
    result.changed.length === 0 &&
    currentVersion(requirement) === before &&
    requirement.updatedAt === T0 + 1
  );
});

check("AI 改标题超 50 字被拒绝，且不落盘", () => {
  const { plan, requirement } = fixture();
  const before = requirement.title;
  const result = updateByAi(plan, requirement.id, { title: "字".repeat(51) }, T0);
  return result.ok === false && requirement.title === before && currentVersion(requirement) === 1;
});

console.log("场景 4 · 用户改（暂定版本）");

check("用户改只生成暂定版本，生效正文不动", () => {
  const { plan, requirement } = fixture();
  const before = requirement.intro;
  const result = updateByUser(plan, requirement.id, { intro: "用户自己改的" }, T0 + 5);
  return (
    result.ok === true &&
    requirement.intro === before &&
    requirement.pending !== null &&
    requirement.pending.intro === "用户自己改的" &&
    currentVersion(requirement) === 1
  );
});

check("暂定版本是整份快照：只改简介，标题沿用生效版本", () => {
  const { plan, requirement } = fixture();
  updateByUser(plan, requirement.id, { intro: "只改简介" }, T0);
  return requirement.pending.title === requirement.title;
});

check("用户改回与生效版本一模一样，暂定版本被撤掉", () => {
  const { plan, requirement } = fixture();
  updateByUser(plan, requirement.id, { intro: "先改一下" }, T0);
  const result = updateByUser(plan, requirement.id, { intro: requirement.intro }, T0 + 1);
  return result.ok === true && requirement.pending === null && result.cancelled === true;
});

check("暂定版本期间 AI 不能改正文（先确认或退回）", () => {
  const { plan, requirement } = fixture();
  updateByUser(plan, requirement.id, { intro: "用户改的" }, T0);
  const result = updateByAi(plan, requirement.id, { intro: "AI 改的" }, T0 + 1);
  return result.ok === false && result.reason.includes("暂定版本");
});

check("暂定版本期间 AI 不能完成需求", () => {
  const { plan, requirement } = fixture();
  updateByUser(plan, requirement.id, { intro: "用户改的" }, T0);
  const result = completeRequirement(plan, requirement.id, "总结", T0 + 2);
  return result.ok === false && result.reason.includes("等着确认");
});

check("AI 确认暂定版本：正文改过来、版本 +1、by 是 user、pending 清空", () => {
  const { plan, requirement } = fixture();
  updateByUser(plan, requirement.id, { intro: "用户改的", change: "用户要求" }, T0);
  const result = confirmPending(plan, requirement.id, null, T0 + 1);
  return (
    result.ok === true &&
    requirement.intro === "用户改的" &&
    requirement.pending === null &&
    currentVersion(requirement) === 2 &&
    requirement.versions[1].by === "user" &&
    requirement.versions[1].change === "用户要求"
  );
});

check("AI 提问：暂定版本留着、疑问记下来、不升版", () => {
  const { plan, requirement } = fixture();
  updateByUser(plan, requirement.id, { intro: "深色还是夜间" }, T0);
  const result = questionPending(plan, requirement.id, "「深色」指配色还是夜间模式？", T0 + 1);
  return (
    result.ok === true &&
    requirement.pending !== null &&
    requirement.pending.question.includes("夜间模式") &&
    currentVersion(requirement) === 1
  );
});

check("空问题退回被拒绝；没有暂定版本时确认 / 提问都被拒绝", () => {
  const { plan, requirement } = fixture();
  updateByUser(plan, requirement.id, { intro: "x" }, T0);
  const emptyQuestion = questionPending(plan, requirement.id, "   ", T0);
  const { plan: other, requirement: fresh } = fixture();
  return (
    emptyQuestion.ok === false &&
    confirmPending(other, fresh.id, null, T0).ok === false &&
    questionPending(other, fresh.id, "问", T0).ok === false
  );
});

console.log("场景 5 · 完成");

check("完成需求：总结进 result、状态 done、版本不变", () => {
  const { plan, requirement } = fixture();
  const result = completeRequirement(plan, requirement.id, "做完了，结论在 README", T0 + 9);
  return (
    result.ok === true &&
    requirement.status === "done" &&
    requirement.result.text === "做完了，结论在 README" &&
    requirement.completedAt === T0 + 9 &&
    currentVersion(requirement) === 1
  );
});

check("完成需求：不给总结被拒绝", () => {
  const { plan, requirement } = fixture();
  return completeRequirement(plan, requirement.id, "", T0).ok === false;
});

check("完成过的需求不能再改、不能再放弃、不能再次完成", () => {
  const { plan, requirement } = fixture();
  completeRequirement(plan, requirement.id, "好了", T0);
  return (
    updateByAi(plan, requirement.id, { intro: "改" }, T0).ok === false &&
    dropRequirement(plan, requirement.id, T0).ok === false &&
    completeRequirement(plan, requirement.id, "再来一次", T0).ok === false
  );
});

console.log("场景 6 · 放弃与删除");

check("放弃需求：级联放弃未结束的任务与步骤，留下记录", () => {
  const { plan, requirement, taskA, taskB } = fixture();
  const result = dropRequirement(plan, requirement.id, T0 + 3);
  const dropped = result.dropped ?? [];
  return (
    result.ok === true &&
    requirement.status === "dropped" &&
    taskA.status === "dropped" &&
    taskB.status === "dropped" &&
    taskA.steps.every((step) => step.status === "dropped") &&
    dropped.some((line) => line.includes("任务A"))
  );
});

check("完成过的任务在放弃需求时保持原样（不改写历史）", () => {
  const { plan, requirement, taskA, taskB } = fixture();
  complete(plan, taskB.id, "B 做完了", T0);
  dropRequirement(plan, requirement.id, T0 + 1);
  return taskB.status === "done" && taskA.status === "dropped";
});

check("放弃的需求仍在活跃列表里（划掉），不是归档", () => {
  const { plan, requirement } = fixture();
  dropRequirement(plan, requirement.id, T0);
  const rows = listActive(plan);
  return rows.length === 1 && rows[0].status === "dropped" && listArchived(plan).length === 0;
});

check("删除需求：物理摘除，不看状态，连任务一起走", () => {
  const { plan, requirement } = fixture();
  completeRequirement(plan, requirement.id, "好了", T0);
  const result = deleteRequirement(plan, requirement.id, T0 + 1);
  return result.ok === true && plan.goals.length === 0 && requirementOf(plan, requirement.id) === null;
});

check("删除不存在的需求给出理由", () => {
  const plan = emptyPlan();
  return deleteRequirement(plan, "R9", T0).ok === false;
});

console.log("场景 7 · 归档");

check("归档与完成正交：完成过但没归档，仍在活跃列表", () => {
  const { plan, requirement } = fixture();
  completeRequirement(plan, requirement.id, "好了", T0);
  const rows = listActive(plan);
  return rows.length === 1 && rows[0].status === "done" && requirement.archived === false;
});

check("归档后从活跃列表消失、出现在已归档列表，可取消", () => {
  const { plan, requirement } = fixture();
  setArchived(plan, requirement.id, true, T0);
  const archived = listArchived(plan);
  const activeEmpty = listActive(plan).length === 0;
  setArchived(plan, requirement.id, false, T0 + 1);
  return archived.length === 1 && activeEmpty && listActive(plan).length === 1;
});

check("重复归档：值不变，changed 是 false", () => {
  const { plan, requirement } = fixture();
  setArchived(plan, requirement.id, true, T0);
  const again = setArchived(plan, requirement.id, true, T0 + 1);
  return again.ok === true && again.changed === false;
});

console.log("场景 8 · 前置");

check("设前置：找不到的目标、自指、成环都拒绝", () => {
  const plan = emptyPlan();
  addDraft(plan, {}, T0);
  confirmRequirement(plan, "R1", { title: "一" }, T0);
  addDraft(plan, {}, T0);
  confirmRequirement(plan, "R2", { title: "二" }, T0);
  const missing = setPrerequisites(plan, "R1", ["R9"], T0);
  const self = setPrerequisites(plan, "R1", ["R1"], T0);
  const ok = setPrerequisites(plan, "R2", ["R1"], T0);
  const cycle = setPrerequisites(plan, "R1", ["R2"], T0);
  return (
    missing.ok === false &&
    self.ok === false &&
    ok.ok === true &&
    cycle.ok === false &&
    cycle.reason.includes("成环")
  );
});

check("前置成环是隔着几层也能认出来的", () => {
  const plan = emptyPlan();
  for (const title of ["一", "二", "三"]) {
    const draft = addDraft(plan, {}, T0);
    confirmRequirement(plan, draft.id, { title }, T0);
  }
  setPrerequisites(plan, "R2", ["R1"], T0);
  setPrerequisites(plan, "R3", ["R2"], T0);
  const result = setPrerequisites(plan, "R1", ["R3"], T0);
  return result.ok === false && result.reason.includes("成环");
});

check("缺前置：未完成 / 已放弃 / 已删除分别标出来，完成的不算缺", () => {
  const plan = emptyPlan();
  for (const title of ["甲", "乙", "丙", "丁"]) {
    const draft = addDraft(plan, {}, T0);
    confirmRequirement(plan, draft.id, { title }, T0);
  }
  // 先把前置挂上，再造出三种状态——删除之后就挂不上去了（那正是该拒绝的行为）。
  setPrerequisites(plan, "R4", ["R1", "R2", "R3"], T0);
  completeRequirement(plan, "R1", "好了", T0);
  dropRequirement(plan, "R2", T0);
  deleteRequirement(plan, "R3", T0);
  const missing = missingPrerequisites(plan, requirementOf(plan, "R4"));
  const states = missing.map((item) => `${item.id}:${item.state}`).sort();
  return states.join(",") === "R2:dropped,R3:missing";
});

check("dependentsOf 找出以它为前置的需求", () => {
  const plan = emptyPlan();
  for (const title of ["甲", "乙", "丙"]) {
    const draft = addDraft(plan, {}, T0);
    confirmRequirement(plan, draft.id, { title }, T0);
  }
  setPrerequisites(plan, "R2", ["R1"], T0);
  setPrerequisites(plan, "R3", ["R1"], T0);
  return dependentsOf(plan, "R1").map((item) => item.id).join(",") === "R2,R3";
});

console.log("场景 9 · 完成时的提示");

check("下游已自报完成 → 提示复核（顺序颠倒）", () => {
  const plan = emptyPlan();
  for (const title of ["甲", "乙"]) {
    const draft = addDraft(plan, {}, T0);
    confirmRequirement(plan, draft.id, { title }, T0);
  }
  setPrerequisites(plan, "R2", ["R1"], T0);
  completeRequirement(plan, "R2", "先做了乙", T0);
  const result = completeRequirement(plan, "R1", "再做甲", T0 + 1);
  return result.hints.some((line) => line.includes("建议回头复核"));
});

check("下游的前置因这次完成而全满足 → 提示可以开始", () => {
  const plan = emptyPlan();
  for (const title of ["甲", "乙"]) {
    const draft = addDraft(plan, {}, T0);
    confirmRequirement(plan, draft.id, { title }, T0);
  }
  setPrerequisites(plan, "R2", ["R1"], T0);
  const result = completeRequirement(plan, "R1", "甲完了", T0);
  return result.hints.some((line) => line.includes("前置全部满足，可以开始了"));
});

check("自己是跳着做的 → 记一句，不追问", () => {
  const plan = emptyPlan();
  for (const title of ["甲", "乙"]) {
    const draft = addDraft(plan, {}, T0);
    confirmRequirement(plan, draft.id, { title }, T0);
  }
  setPrerequisites(plan, "R2", ["R1"], T0);
  const result = completeRequirement(plan, "R2", "跳着做的", T0);
  return result.hints.some((line) => line.includes("本次是跳着做的"));
});

check("全部结束 → 收尾一句；草稿不算没完成", () => {
  const plan = emptyPlan();
  const draft = addDraft(plan, {}, T0);
  confirmRequirement(plan, draft.id, { title: "甲" }, T0);
  addDraft(plan, {}, T0); // 还有一条草稿，不该影响结论
  const result = completeRequirement(plan, "R1", "完了", T0);
  return result.hints.some((line) => line.includes("需求全部完成"));
});

check("任务完成时：还剩几个 / 都完了 / 一个都没有", () => {
  const { plan, requirement, taskA, taskB } = fixture();
  const first = taskCompletionHints(requirement);
  complete(plan, taskA.id, "A 好了", T0);
  const stillOne = taskCompletionHints(requirement);
  complete(plan, taskB.id, "B 好了", T0);
  const allDone = taskCompletionHints(requirement);
  const empty = taskCompletionHints({ tasks: [] });
  return (
    first[0].includes("2 个任务") &&
    stillOne[0].includes("还剩 1 个任务") &&
    allDone[0].includes("可以写总结并完成它") &&
    empty.length === 0
  );
});

console.log("场景 10 · 活跃推导与列表");

check("进行中的需求由最后执行的那个任务决定", () => {
  const plan = emptyPlan();
  const a = addDraft(plan, {}, T0);
  confirmRequirement(plan, a.id, { title: "甲" }, T0);
  addChildren(plan, a.id, [{ title: "甲1" }], T0);
  const b = addDraft(plan, {}, T0 + 100);
  confirmRequirement(plan, b.id, { title: "乙" }, T0 + 100);
  addChildren(plan, b.id, [{ title: "乙1" }], T0 + 100);
  // 甲的任务更晚完成，尽管甲建得更早
  complete(plan, plan.goals[0].tasks[0].id, "甲1 好了", T0 + 200);
  return activeRequirement(plan).id === a.id;
});

check("都没有任务动过时，退回最后更新的那一条", () => {
  const plan = emptyPlan();
  addDraft(plan, {}, T0);
  confirmRequirement(plan, "R1", { title: "甲" }, T0);
  addDraft(plan, {}, T0);
  confirmRequirement(plan, "R2", { title: "乙" }, T0 + 50);
  return activeRequirement(plan).id === "R2";
});

check("没有开着的需求时，进行中是 null", () => {
  const { plan, requirement } = fixture();
  completeRequirement(plan, requirement.id, "好了", T0);
  return activeRequirement(plan) === null;
});

check("归档的需求不会成为「当前进行中」（否则列表上一个展开的都没有）", () => {
  const plan = emptyPlan();
  const a = addDraft(plan, {}, T0);
  confirmRequirement(plan, a.id, { title: "甲" }, T0);
  addChildren(plan, a.id, [{ title: "甲1" }], T0);
  const b = addDraft(plan, {}, T0);
  confirmRequirement(plan, b.id, { title: "乙" }, T0 + 10);
  addChildren(plan, b.id, [{ title: "乙1" }], T0 + 10);
  // 乙更新（活动更晚），但把它归档：当前应当退回甲，而不是指向一条不在列表里的需求。
  const archived = setArchived(plan, b.id, true, T0 + 20);
  return archived.ok === true && activeRequirement(plan)?.id === a.id;
});

check("activityAt 认得任务与步骤的时间", () => {
  const { plan, requirement, taskA } = fixture();
  const before = activityAt(requirement);
  complete(plan, taskA.steps[0].id, "A1 好了", T0 + 500);
  return before === T0 && activityAt(requirement) === T0 + 500;
});

check("展开进行中的需求：一级任务、二级步骤", () => {
  const { requirement, taskA } = fixture();
  const rows = progressOf(requirement);
  return (
    rows.length === 2 &&
    rows[0].task.id === taskA.id &&
    rows[0].steps.length === 2 &&
    rows[1].steps.length === 0
  );
});

check("列表行带缺哪个前置、下一个任务、待确认改动", () => {
  const { plan, requirement } = fixture();
  updateByUser(plan, requirement.id, { intro: "用户改的", change: "改成深色" }, T0);
  const [row] = listActive(plan);
  return (
    row.id === requirement.id &&
    row.nextTask !== null &&
    row.nextTask.title === "任务A" &&
    Array.isArray(row.missing) &&
    row.pending === "改成深色"
  );
});

check("需求里能由一个任务反查到它所属的需求", () => {
  const { plan, requirement, taskA } = fixture();
  return requirementOfTask(plan, taskA.steps[0].id)?.id === requirement.id;
});

console.log("场景 11 · 旧数据补齐");

check("旧版目标读进来补一条 v1，by 是 migrated，标题简介详情都在", () => {
  const legacy = {
    id: "g-abc",
    title: "老目标",
    detail: "老说明",
    status: "pending",
    createdAt: T0,
    tasks: [],
  };
  normalizeRequirement(legacy);
  return (
    legacy.intro === "" &&
    legacy.archived === false &&
    legacy.pending === null &&
    legacy.versions.length === 1 &&
    legacy.versions[0].by === "migrated" &&
    legacy.versions[0].detail === "老说明" &&
    legacy.versions[0].n === 1
  );
});

check("补齐是幂等的：补两次不会多一条版本", () => {
  const legacy = { id: "g-abc", title: "老目标", status: "pending", tasks: [] };
  normalizeRequirement(legacy);
  normalizeRequirement(legacy);
  return legacy.versions.length === 1;
});

check("新草稿的 versions: [] 不会被当成旧目标补出迁移版本", () => {
  const draft = { id: "R1", title: "", intro: "", detail: "", status: "draft", versions: [], tasks: [] };
  normalizeRequirement(draft);
  return draft.versions.length === 0;
});

check("草稿经 store 读回来、确认之后版本号是 v1（不是 v2）", () => {
  const root = mkdtempSync(join(tmpdir(), "ttf-draft-"));
  try {
    const store = createStore(root);
    const empty = emptyPlan();
    const draft = addDraft(empty, { detail: "原话" }, T0);
    store.writePlan("s", empty);

    // 走一次真实的"读出来再确认"：这正是工具层的路径。
    const plan = store.readPlan("s");
    const result = confirmRequirement(plan, draft.id, { title: "甲" }, T0);
    return result.ok === true && result.version.n === 1 && plan.goals[0].versions.length === 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("旧 id（g-xxx）照样能被当成需求查出来", () => {
  const legacy = { id: "g-abc", title: "老目标", status: "pending", tasks: [] };
  normalizeRequirement(legacy);
  const plan = { version: 3, goals: [legacy] };
  return requirementOf(plan, "g-abc") === legacy && listActive(plan).length === 1;
});

console.log("场景 12 · 字段校验");

check("标题按码点数：50 个中文刚好，51 个超", () => {
  return charCount("字".repeat(50)) === 50 && validateFields({ title: "字".repeat(50) }).length === 0 &&
    validateFields({ title: "字".repeat(51) }).length === 1;
});

check("简介 200 刚好、201 超；空标题被拒绝", () => {
  return (
    validateFields({ intro: "字".repeat(200) }).length === 0 &&
    validateFields({ intro: "字".repeat(201) }).length === 1 &&
    validateFields({ title: "   " }).length === 1
  );
});

check("超长报的是实际问题，不是静默截断", () => {
  const problems = validateFields({ title: "字".repeat(60) });
  return problems[0].includes("60") && problems[0].includes(String(LIMITS.title));
});

console.log("场景 13 · 笔记");

check("写笔记：新名字新增，同名覆盖且修订号 +1", () => {
  const state = normalizeNotes(null);
  const first = upsertNote(state, { key: "构建入口", text: "用 build.ps1" }, T0);
  // 同名覆盖会就地改同一个对象，所以这一轮的值要当场取下来，不能事后回看 first.note。
  const firstRev = first.note.rev;
  const second = upsertNote(state, { key: "构建入口", text: "用 build.ps1 -Release" }, T0 + 1);
  return (
    first.ok === true &&
    first.created === true &&
    firstRev === 1 &&
    second.created === false &&
    state.items.length === 1 &&
    state.items[0].rev === 2 &&
    state.items[0].text.includes("-Release")
  );
});

check("空名字、空正文被拒绝", () => {
  const state = normalizeNotes(null);
  return (
    upsertNote(state, { key: "  ", text: "x" }, T0).ok === false &&
    upsertNote(state, { key: "名字", text: "   " }, T0).ok === false
  );
});

check("查笔记：不给关键词给全部，给了就在名字与正文里找", () => {
  const state = normalizeNotes(null);
  upsertNote(state, { key: "构建入口", text: "build.ps1" }, T0);
  upsertNote(state, { key: "代码风格", text: "缩进用两个空格" }, T0 + 1);
  return findNotes(state, "").length === 2 && findNotes(state, "缩进").length === 1;
});

check("通告里的笔记段可再解析：渲染与解析能往返", () => {
  const state = normalizeNotes(null);
  upsertNote(state, { key: "构建入口", text: "第一行\n第二行" }, T0);
  upsertNote(state, { key: "坑", text: "别用 pwsh 7 的数组展开" }, T0 + 1);
  const text = renderNoteLines(findNotes(state, ""));
  const parsed = parseNoteLines(text);
  return (
    text.split("\n").length === 2 &&
    parsed.length === 2 &&
    parsed.some((item) => item.key === "构建入口" && item.text.includes("第一行 / 第二行")) &&
    parsed.some((item) => item.key === "坑" && item.rev === 1)
  );
});

check("区间里的笔记：seq 落在 (from, to] 内才算，老笔记没有 seq 一律算", () => {
  const state = normalizeNotes(null);
  upsertNote(state, { key: "早", text: "x", seq: 10 }, T0);
  upsertNote(state, { key: "中", text: "y", seq: 20 }, T0);
  upsertNote(state, { key: "晚", text: "z", seq: 30 }, T0);
  upsertNote(state, { key: "老", text: "w" }, T0);
  const keys = notesInRange(state, 10, 20).map((item) => item.key).sort();
  return keys.join(",") === "中,老";
});

check("笔记按会话落盘：两个会话互不串，重开还能读到", () => {
  const root = mkdtempSync(join(tmpdir(), "ttf-notes-"));
  try {
    const store = createStore(root);
    const a = store.readNotes("s-a");
    upsertNote(a, { key: "偏好", text: "回答简短" }, T0);
    store.writeNotes("s-a", a);

    const reopened = createStore(root).readNotes("s-a");
    const other = createStore(root).readNotes("s-b");
    return (
      reopened.items.length === 1 &&
      reopened.items[0].text === "回答简短" &&
      other.items.length === 0
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("计划落盘后重读：需求补上了版本历史，旧目标也能读", () => {
  const root = mkdtempSync(join(tmpdir(), "ttf-plan-"));
  try {
    const store = createStore(root);
    const plan = emptyPlan();
    const draft = addDraft(plan, {}, T0);
    confirmRequirement(plan, draft.id, { title: "甲" }, T0);
    store.writePlan("s-plan", plan);

    // 手写一份旧版计划：没有 versions / intro / archived 这些字段
    store.writePlan("s-legacy", {
      version: 2,
      goals: [{ id: "g-old", title: "老目标", detail: "老说明", status: "pending", tasks: [] }],
    });

    const reread = store.readPlan("s-plan");
    const legacy = store.readPlan("s-legacy");
    return (
      reread.goals[0].versions.length === 1 &&
      reread.goals[0].status === "pending" &&
      legacy.goals[0].versions.length === 1 &&
      legacy.goals[0].versions[0].by === "migrated"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("");
if (failures.length === 0) {
  console.log(`${pass} 项通过，全部通过。`);
} else {
  console.log(`${pass} 项通过，${failures.length} 项失败：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
