/**
 * auto-continue.js 的自动续行自测。
 *
 * 这个模块此前**没有任何直接自检**——它默认关着，谁也没踩到。改成默认开之后，
 * 它每一次判断失误都会真的把会话推起来，所以这里把它的每一条闸门都钉住：
 *
 *   1. 计划还没跑完 + agent 空闲 → 推一条，摘要带「树形任务流 · 」前缀。
 *   2. **用户按下停止（`turn/end` 的 `reason.kind === "aborted"`）→ 绝不再推。**
 *      这是本文件最要紧的一条：早先的闸门挂在 `agent/turn-stopping` 上并看
 *      `signal.aborted`，而那个事件只在"这一轮本来就要正常收尾"时才发，
 *      中止根本走不到那里——等于没闸门，停掉之后立刻又被拉起来。
 *   3. 真人发言才解除停止、重置续行配额。
 *   4. 正常收尾（`completed`）不设停止闸门，照续。
 *   5. 连续续行到 `maxAutoRounds` 就停。
 *   6. 队列里有人排队时不抢。
 *   7. `autoContinue` 不是 true 时一个字节都不推。
 *   8. agent 不空闲、或计划整棵都结束了，不推。
 *
 * 跑：node verify-auto-continue.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAutoContinue } from "./lib/auto-continue.js";
import { addChildren, createPlan } from "./lib/plan.js";
import { createStore } from "./lib/store.js";

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

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "tt-verify-auto-"));
}

/** 一份"还有进行中的子任务"的计划：activePath().step 非空才值得续行。 */
function planWithOpenStep() {
  const plan = createPlan({ title: "目标", tasks: [{ title: "任务" }] }, 1000);
  const [task] = plan.goals[0].tasks;
  addChildren(plan, task.id, [{ title: "子任务一" }, { title: "子任务二" }], 1000);
  return plan;
}

/** 一棵已经全部结束的计划：没什么可接着跑的。 */
function finishedPlan() {
  const plan = planWithOpenStep();
  const goal = plan.goals[0];
  const [task] = goal.tasks;
  for (const step of task.steps) {
    step.status = "done";
    step.result = { text: "做完了", at: 1000 };
  }
  task.status = "done";
  task.result = { text: "做完了", at: 1000 };
  goal.status = "done";
  goal.result = { text: "做完了", at: 1000 };
  return plan;
}

/**
 * 假 ctx + 真 store + 假 agent。
 *
 * @param options - `{ cfg, plan, sessionId }`。
 */
function makeHarness({
  cfg = { autoContinue: true, maxAutoRounds: 5 },
  plan = planWithOpenStep(),
  sessionId = "s-1",
} = {}) {
  const root = makeRoot();
  const store = createStore(root);
  if (plan !== null) store.writePlan(sessionId, plan);

  const followed = [];
  const agent = {
    session: { id: sessionId },
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) {
      followed.push(message);
    },
  };
  const logs = [];

  const handlers = new Map();
  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    get(name) {
      if (name !== "agents") return undefined;
      return { get: (id) => (id === sessionId ? agent : null) };
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) },
  };

  const control = registerAutoContinue(ctx, { store, cfg });

  return {
    root,
    store,
    agent,
    followed,
    logs,
    control,
    sessionId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    /** 发一条会话事件。 */
    event(type, data) {
      for (const handler of handlers.get("session/event") ?? []) {
        handler({ id: sessionId }, { type, data });
      }
    },
    /** 发一次状态变化。 */
    status(next) {
      agent.status = next;
      for (const handler of handlers.get("agent/status") ?? []) {
        handler({ status: next, agent });
      }
    },
    /** 造一次"这一轮结束了"并接着回到 idle——真实顺序就是先 turn/end 再 status。 */
    endTurn(reason, nextStatus = "idle") {
      this.event("turn/end", { turn: 1, reason });
      this.status(nextStatus);
    },
    /** 走一次 pre-step（真人发言 / 插件注入的消息都从这里过）。 */
    async preStep(messages) {
      for (const handler of handlers.get("agent/pre-step") ?? []) {
        await handler({ agent, messages }, async () => ({ kind: "enter" }));
      }
    },
  };
}

const ABORTED = { kind: "aborted", reason: { kind: "user" } };
const COMPLETED = { kind: "completed" };

// ---------------------------------------------------------------- 场景 1

console.log("\n场景 1 · 计划没跑完 + agent 空闲 → 推一条");
{
  const h = makeHarness();
  h.status("idle");
  check("推了一条", h.followed.length === 1, String(h.followed.length));
  check(
    "推的是「接下来该做什么」，正文来自计划树",
    h.followed[0]?.content?.[0]?.text?.includes("接下来需要进行"),
    JSON.stringify(h.followed[0]?.content),
  );
  check(
    "摘要带「树形任务流 · 」前缀，人看得出是谁发的",
    h.followed[0]?.source?.summary === "树形任务流 · 计划续行",
    String(h.followed[0]?.source?.summary),
  );
  h.cleanup();
}

// ---------------------------------------------------------------- 场景 2

console.log("\n场景 2 · 用户按下停止 → 绝不再推（本文件最要紧的一条）");
{
  const h = makeHarness();
  h.endTurn(ABORTED);
  check("停止那一刻一条都没推", h.followed.length === 0, String(h.followed.length));
  check(
    "停止落了盘：held/<sessionId>.json 里 stopped 为 true",
    h.store.readHeld(h.sessionId)?.stopped === true,
    JSON.stringify(h.store.readHeld(h.sessionId)),
  );
  check("控制接口也自认被停止", h.control.isStopped(h.sessionId) === true);

  // 再空转几次也不该动——每次 idle 都来一遍。
  h.status("idle");
  h.status("idle");
  check("之后又空闲两次仍然一条不推", h.followed.length === 0, String(h.followed.length));

  // 换个进程（内存全空、只剩磁盘）也得压得住：重启后重新注册。
  const again = makeHarness({ sessionId: h.sessionId });
  again.store.patchHeld(h.sessionId, { stopped: true });
  again.status("idle");
  check("重启后按磁盘上的停止标记照样不推", again.followed.length === 0, String(again.followed.length));
  again.cleanup();
  h.cleanup();
}

// ---------------------------------------------------------------- 场景 3

console.log("\n场景 3 · 真人发言才解除停止");
{
  const h = makeHarness();
  h.endTurn(ABORTED);
  check("停止后不推", h.followed.length === 0);

  await h.preStep([{ source: { kind: "plugin:dsh-tree-task-flow" } }]);
  check("插件自己推的消息**不算**真人，停止仍在", h.control.isStopped(h.sessionId) === true);

  await h.preStep([{ source: { kind: "user" } }]);
  check("真人说话后解除停止", h.control.isStopped(h.sessionId) === false);
  check(
    "解除也落盘",
    h.store.readHeld(h.sessionId)?.stopped === false,
    JSON.stringify(h.store.readHeld(h.sessionId)),
  );

  h.status("idle");
  check("解除之后空闲下来才会再推一条", h.followed.length === 1, String(h.followed.length));
  h.cleanup();
}

// ---------------------------------------------------------------- 场景 4

console.log("\n场景 4 · 正常收尾（completed）不设停止闸门");
{
  const h = makeHarness();
  h.endTurn(COMPLETED);
  check("正常收尾之后照推", h.followed.length === 1, String(h.followed.length));
  check("也没有落下停止标记", h.control.isStopped(h.sessionId) === false);
  h.cleanup();
}

// ---------------------------------------------------------------- 场景 5

console.log("\n场景 5 · 连续续行的轮次上限");
{
  const h = makeHarness({ cfg: { autoContinue: true, maxAutoRounds: 2 } });
  for (let index = 0; index < 5; index += 1) h.status("idle");
  check("最多推 maxAutoRounds 条", h.followed.length === 2, String(h.followed.length));

  await h.preStep([{ source: { kind: "user" } }]);
  h.status("idle");
  check("真人发言重置配额后又能推", h.followed.length === 3, String(h.followed.length));
  h.cleanup();
}

// ---------------------------------------------------------------- 场景 6

console.log("\n场景 6 · 队列里有人排队时不抢");
{
  const h = makeHarness();
  h.agent.inbox.nextTurn.push({});
  h.status("idle");
  check("有排队输入时不推", h.followed.length === 0, String(h.followed.length));

  h.agent.inbox.nextTurn.length = 0;
  h.agent.inbox.nextStep.push({});
  h.status("idle");
  check("nextStep 里有人也不推", h.followed.length === 0, String(h.followed.length));
  h.cleanup();
}

// ---------------------------------------------------------------- 场景 7

console.log("\n场景 7 · 关掉时一个字节都不推");
{
  const h = makeHarness({ cfg: { autoContinue: false } });
  h.status("idle");
  h.endTurn(COMPLETED, "idle");
  check("cfg 不是 true 时不推", h.followed.length === 0, String(h.followed.length));
  h.cleanup();
}

// ---------------------------------------------------------------- 场景 8

console.log("\n场景 8 · 不该续的情形");
{
  const busy = makeHarness();
  busy.status("running");
  check("agent 在跑时不推", busy.followed.length === 0, String(busy.followed.length));
  busy.cleanup();

  const finished = makeHarness({ plan: finishedPlan() });
  finished.status("idle");
  check("整棵树都结束了不推", finished.followed.length === 0, String(finished.followed.length));
  finished.cleanup();

  const noPlan = makeHarness({ plan: null });
  noPlan.status("idle");
  check("没有计划树时不推", noPlan.followed.length === 0, String(noPlan.followed.length));
  noPlan.cleanup();
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
