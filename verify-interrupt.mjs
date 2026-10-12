/**
 * interrupt.js 的自测：意外中断怎么认、什么时候拉、拉几次、什么时候收走重来。
 *
 * 钉住的规则（判据来自 2026-10-08 扫本机 187 个会话日志的结论）：
 *
 *   1. **网络类**（`turn/end.reason.kind === 'error'` 且码属于传输类）→ 中断后
 *      第 1、5、10、30 分钟各拉一次；`QUOTA` 不拉（等再久也不会好）。
 *   2. **工具类**（本轮出现 `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` 合成结果）→
 *      立刻拉一次；再中同一类就把「拉起消息 + 那条 assistant 消息 + 合成错误结果」
 *      一起收走再来一次；第三次停手。
 *   3. **输出类**（`MALFORMED_RESPONSE`：模型给出的工具调用参数不是合法 JSON，整条响应
 *      被 DSH 作废）→ 立刻拉一次；再失败**不收走**（一个工具都没执行，没有东西可收）
 *      直接再拉一次；第三次停手。提示词必须说清「没有任何工具被执行」，不能说
 *      「结果未知、先确认影响」。
 *   4. **一条链只跑一遍**：时刻表用完标 `exhausted`，新错误不再开链；
 *      真人一发消息就清链。
 *   5. 安全阀：暂停 / 停止 / 没计划 / 计划结束 / agent 不空闲，一律不拉；
 *      `aborted` 与正常收尾都把链清掉。
 *   6. 链落盘，跨重启在 `agent/status` 变 idle 时重新排上。
 *
 * 假 ctx 提供 `on` / `get('agents')` / `logger`；假 agent 记下 followup；
 * 假 session 复刻 DSH surface 的 replace 硬规则（`sourceEventSeqs` 必须覆盖
 * 全部被遮蔽节点）；定时器换成可手动触发的记录器。
 *
 * 跑：node verify-interrupt.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DELAYS_MS,
  HIDE_SUMMARY,
  NETWORK_CODES,
  REVIVE_SUMMARY,
  SYNTHETIC_TOOL_CODES,
  classifyInterrupt,
  registerInterruptRecovery,
} from "./lib/interrupt.js";
import { addChildren, createPlan } from "./lib/plan.js";
import { PLUGIN_SOURCE_KIND, hasSummary, isPluginSource, noticeSummary } from "./lib/region.js";
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

// ---------------------------------------------------------------- 假件

/** 可手动触发的定时器。 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let timers = [];
globalThis.setTimeout = (fn, ms) => {
  const handle = { fn, ms, cancelled: false };
  timers.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  if (handle) handle.cancelled = true;
};

function makeCtx() {
  const map = new Map();
  const logs = [];
  const agents = new Map();
  return {
    agents,
    logs,
    on(event, handler) {
      const list = map.get(event) ?? [];
      list.push(handler);
      map.set(event, list);
    },
    logger: {
      info: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
    },
    get(service) {
      return service === "agents" ? { get: (id) => agents.get(id) ?? null } : undefined;
    },
    async fire(event, ...args) {
      for (const handler of map.get(event) ?? []) {
        if (event === "agent/pre-step") await handler(...args, async () => ({ kind: "enter" }));
        else await handler(...args);
      }
    },
    handlers: (event) => map.get(event) ?? [],
  };
}

function makeAgent(sessionId, status = "idle") {
  return {
    session: { id: sessionId },
    status,
    inbox: { nextTurn: [], nextStep: [] },
    followed: [],
    followup(message) {
      this.followed.push(message);
    },
  };
}

/** 假 session：复刻 DSH surface 的 append/replace 硬规则。 */
function makeSession(id) {
  const events = [];
  const nodes = [];
  function record(type, data, opts = {}) {
    const seq = events.length;
    events[seq] = { type, data, ...opts };
    return seq;
  }
  return {
    id,
    get surface() {
      return { nodes: [...nodes] };
    },
    eventAt: (seq) => events[seq],
    /** 测试用：往表层追加一条真实事件。 */
    push(type, data, opts = {}) {
      const seq = record(type, data, opts);
      nodes.push(seq);
      return seq;
    },
    append(type, data, opts = {}) {
      const op = opts?.surfaceOp;
      if (op === undefined) throw new Error(`surface event "${type}" requires a surfaceOp marker`);
      if (op === "append") {
        const seq = record(type, data, { surfaceOp: "append" });
        nodes.push(seq);
        return;
      }
      const startIdx = nodes.indexOf(op.startSeq);
      const endIdx = nodes.indexOf(op.endSeq);
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) throw new Error("坏区间");
      const shadowed = nodes.slice(startIdx, endIdx + 1);
      const covered = new Set(opts.sourceEventSeqs ?? []);
      const missing = shadowed.filter((s) => !covered.has(s));
      if (missing.length > 0) {
        throw new Error(`sourceEventSeqs 没覆盖全，缺 ${missing.join(",")}`);
      }
      const seq = record(type, data, {
        surfaceOp: op,
        sourceEventSeqs: opts.sourceEventSeqs,
      });
      nodes.splice(startIdx, endIdx - startIdx + 1, seq);
    },
    live: () => [...nodes],
  };
}

const root = mkdtempSync(join(tmpdir(), "tt-verify-interrupt-"));
const store = createStore(root);

/** 建一棵"进行中"的计划树：目标是开放的、任务下有未完成步骤。 */
function seedPlan(sessionId) {
  const plan = createPlan({ title: "验证目标", tasks: [{ title: "任务一" }] });
  addChildren(plan, plan.goals[0].tasks[0].id, [{ title: "步骤一" }, { title: "步骤二" }]);
  store.writePlan(sessionId, plan);
  return plan;
}

/** 装一套 harness：ctx + 模块 + 一个 idle 的 agent。 */
function setup(sessionId, { status = "idle", withPlan = true } = {}) {
  const ctx = makeCtx();
  const agent = makeAgent(sessionId, status);
  ctx.agents.set(sessionId, agent);
  if (withPlan) seedPlan(sessionId);
  const control = registerInterruptRecovery(ctx, { store, cfg: {}, pause: null });
  return { ctx, agent, control };
}

/** 让所有的定时器到点。 */
function fireTimers() {
  const pending = timers.filter((t) => !t.cancelled);
  timers = [];
  for (const timer of pending) timer.fn();
}

const textOf = (message) => (message?.content ?? []).map((b) => b.text ?? "").join("");

try {
  // ------------------------------------------------------------ 判据

  console.log("\n判据 classifyInterrupt：");

  for (const code of NETWORK_CODES) {
    const hit = classifyInterrupt({ kind: "error", error: { code } });
    check(`error/${code} 归网络类`, hit?.class === "network" && hit.code === code, JSON.stringify(hit));
  }
  check(
    "error/QUOTA 不归这套管（余额不足等再久也不会好）",
    classifyInterrupt({ kind: "error", error: { code: "QUOTA" } }) === null,
  );
  check(
    "error/MALFORMED_RESPONSE 单归输出类（不是工具类）",
    classifyInterrupt({ kind: "error", error: { code: "MALFORMED_RESPONSE" } })?.class === "malformed" &&
      classifyInterrupt({ kind: "error", error: { code: "MALFORMED_RESPONSE" } })?.code === "MALFORMED_RESPONSE",
    JSON.stringify(classifyInterrupt({ kind: "error", error: { code: "MALFORMED_RESPONSE" } })),
  );
  check("error 没有 code 时不管", classifyInterrupt({ kind: "error", error: {} }) === null);
  for (const code of SYNTHETIC_TOOL_CODES) {
    check(
      `interrupted + ${code} 归工具类`,
      classifyInterrupt({ kind: "interrupted" }, code)?.class === "tool",
    );
  }
  check(
    "interrupted 但没有合成错误（纯进程重启）不归这套管",
    classifyInterrupt({ kind: "interrupted" }, null) === null,
  );
  for (const kind of ["completed", "aborted", "blocked", "max-tokens", "forked"]) {
    check(`${kind} 不归这套管`, classifyInterrupt({ kind }, "TOOL_OUTCOME_UNKNOWN") === null);
  }

  // ------------------------------------------------------------ 网络类

  console.log("\n网络类：分时拉起");

  const net = "s-net";
  const netSetup = setup(net);
  const netSession = makeSession(net);
  const startedAt = Date.now();

  await netSetup.ctx.fire("session/event", netSession, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "TRANSPORT" } } },
  });

  const chain = store.readRevive(net);
  check("建了一条网络类的链", chain?.class === "network" && chain.code === "TRANSPORT", JSON.stringify(chain));
  check("时刻表是四个累计时刻", chain?.pending?.length === 4, String(chain?.pending?.length));
  check(
    "四个时刻分别是 1 / 5 / 10 / 30 分钟后",
    chain.pending.every((at, index) => Math.abs(at - startedAt - DEFAULT_DELAYS_MS[index]) < 1000),
    JSON.stringify(chain.pending.map((at) => Math.round((at - startedAt) / 1000))),
  );
  const firstTimer = timers.find((t) => !t.cancelled);
  check(
    "先排了最近的那一次（约 1 分钟）",
    firstTimer !== undefined && Math.abs(firstTimer.ms - 60_000) < 1000,
    String(firstTimer?.ms),
  );

  fireTimers();
  check("到点拉起一次", netSetup.agent.followed.length === 1, String(netSetup.agent.followed.length));
  const reviveMessage = netSetup.agent.followed[0];
  check("拉起的 source 摘要能被认出来", hasSummary(reviveMessage?.source, REVIVE_SUMMARY));
  check(
    "拉起的 source 摘要带上了「树形任务流 · 」前缀",
    reviveMessage?.source?.summary === noticeSummary(REVIVE_SUMMARY),
    String(reviveMessage?.source?.summary),
  );
  check(
    "拉起的 source 是生产者自有的 kind（v4 会话才收）",
    reviveMessage?.source?.kind === "plugin:dsh-tree-task-flow",
    String(reviveMessage?.source?.kind),
  );
  const reviveText = textOf(reviveMessage);
  check("正文点出中断码", reviveText.includes("TRANSPORT"), reviveText.slice(0, 60));
  check("正文说清接下来做哪个步骤", reviveText.includes("步骤一"), reviveText.slice(0, 80));
  check(
    "拉起后那个时刻被消费掉",
    store.readRevive(net)?.pending?.length === 3,
    String(store.readRevive(net)?.pending?.length),
  );

  // 同一条链里再中一次：不该把时刻表重置回 1 分钟。
  await netSetup.ctx.fire("session/event", netSession, {
    type: "turn/end",
    data: { turn: 2, reason: { kind: "error", error: { code: "TRANSPORT" } } },
  });
  check(
    "同一条链内再次中断不重置时刻表",
    store.readRevive(net)?.pending?.length === 3,
    String(store.readRevive(net)?.pending?.length),
  );

  // 正常收尾 → 链结束。
  await netSetup.ctx.fire("session/event", netSession, {
    type: "turn/end",
    data: { turn: 3, reason: { kind: "completed" } },
  });
  check("这一轮正常跑完就把链清掉", store.readRevive(net) === null);

  // ------------------------------------------------------------ 用完就停手

  console.log("\n链只跑一遍：");

  const dry = "s-dry";
  const drySetup = setup(dry);
  const drySession = makeSession(dry);
  await drySetup.ctx.fire("session/event", drySession, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "TIMEOUT" } } },
  });
  // 手动把时刻表掏空，模拟四次机会都用完。
  store.writeRevive(dry, { ...store.readRevive(dry), pending: [] });
  timers = [];
  await drySetup.ctx.fire("agent/status", { agent: drySetup.agent, status: "idle" });
  check("时刻表空了就标成用完", store.readRevive(dry)?.exhausted === true);
  check("用完的链不再排定时器", timers.filter((t) => !t.cancelled).length === 0);

  await drySetup.ctx.fire("session/event", drySession, {
    type: "turn/end",
    data: { turn: 4, reason: { kind: "error", error: { code: "TIMEOUT" } } },
  });
  check("用完的链不再开新链", store.readRevive(dry)?.exhausted === true);
  check("也不会拉起", drySetup.agent.followed.length === 0, String(drySetup.agent.followed.length));

  await drySetup.ctx.fire(
    "agent/pre-step",
    { agent: { session: { id: dry } }, messages: [{ source: { kind: "user" } }] },
  );
  check("真人一发消息就把用完的链清掉", store.readRevive(dry) === null);

  // ------------------------------------------------------------ 跨重启

  console.log("\n跨重启重建：");

  const reboot = "s-reboot";
  const rebootSetup = setup(reboot);
  const rebootSession = makeSession(reboot);
  await rebootSetup.ctx.fire("session/event", rebootSession, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "SERVER" } } },
  });
  check("先有了一条链", store.readRevive(reboot)?.class === "network");
  // 模拟进程重启：定时器全没了，只剩磁盘上的链。
  store.writeRevive(reboot, {
    ...store.readRevive(reboot),
    pending: [Date.now() + 5 * 60_000, Date.now() + 10 * 60_000],
  });
  timers = [];
  await rebootSetup.ctx.fire("agent/status", { agent: rebootSetup.agent, status: "idle" });
  const rebuilt = timers.filter((t) => !t.cancelled);
  check("重启后会话一空闲就把剩下的时刻排上", rebuilt.length === 1, String(rebuilt.length));
  check("排的是最近的那个未来时刻（约 5 分钟）", Math.abs(rebuilt[0]?.ms - 300_000) < 1000, String(rebuilt[0]?.ms));

  // ------------------------------------------------------------ 安全阀

  console.log("\n安全阀：");

  const paused = "s-paused";
  const pausedCtx = makeCtx();
  const pausedAgent = makeAgent(paused);
  pausedCtx.agents.set(paused, pausedAgent);
  seedPlan(paused);
  registerInterruptRecovery(pausedCtx, {
    store,
    cfg: {},
    pause: { isPaused: (id) => id === paused },
  });
  await pausedCtx.fire("session/event", makeSession(paused), {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT" } } },
  });
  fireTimers();
  check("暂停中的会话不拉起", pausedAgent.followed.length === 0, String(pausedAgent.followed.length));

  const stopped = "s-stopped";
  const stoppedSetup = setup(stopped);
  store.patchHeld(stopped, { stopped: true });
  await stoppedSetup.ctx.fire("session/event", makeSession(stopped), {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "TRANSPORT" } } },
  });
  fireTimers();
  check("被按了停止的会话不拉起", stoppedSetup.agent.followed.length === 0);
  store.patchHeld(stopped, { stopped: false });

  const finished = "s-finished";
  const finishedCtx = makeCtx();
  const finishedAgent = makeAgent(finished);
  finishedCtx.agents.set(finished, finishedAgent);
  registerInterruptRecovery(finishedCtx, { store, cfg: {}, pause: null });
  await finishedCtx.fire("session/event", makeSession(finished), {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "TRANSPORT" } } },
  });
  check("没有计划树的会话不建链", store.readRevive(finished) === null);

  const done = "s-done";
  const doneCtx = makeCtx();
  const doneAgent = makeAgent(done);
  doneCtx.agents.set(done, doneAgent);
  const donePlan = seedPlan(done);
  for (const step of donePlan.goals[0].tasks[0].steps) step.status = "done";
  store.writePlan(done, donePlan);
  registerInterruptRecovery(doneCtx, { store, cfg: {}, pause: null });
  await doneCtx.fire("session/event", makeSession(done), {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "TRANSPORT" } } },
  });
  check("计划已经收尾的会话不建链", store.readRevive(done) === null, JSON.stringify(store.readRevive(done)));

  const busy = "s-busy";
  const busySetup = setup(busy, { status: "running" });
  await busySetup.ctx.fire("session/event", makeSession(busy), {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "TRANSPORT" } } },
  });
  fireTimers();
  check("agent 不空闲时不拉起", busySetup.agent.followed.length === 0);

  // ------------------------------------------------------------ 工具类

  console.log("\n工具类：立刻一次 + 收走再来一次");

  timers = [];
  const tool = "s-tool";
  const toolSetup = setup(tool);
  const toolSession = makeSession(tool);

  // 会话重载时 DSH 补下的合成结果，顺序是 tool/result → turn/end(interrupted)。
  await toolSetup.ctx.fire("session/event", toolSession, {
    type: "tool/result",
    data: {
      turn: 1,
      step: 1,
      message: { id: "r1", role: "tool", toolCallId: "c1", isError: true },
      error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" },
    },
  });
  await toolSetup.ctx.fire("session/event", toolSession, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "interrupted" } },
  });
  check(
    "建了一条工具类的链",
    store.readRevive(tool)?.class === "tool" && store.readRevive(tool)?.code === "TOOL_OUTCOME_UNKNOWN",
    JSON.stringify(store.readRevive(tool)),
  );
  check("turn/end 那一刻 agent 还没空闲，先不推", toolSetup.agent.followed.length === 0);
  check("也不排定时器（工具类是立刻拉，不是定时）", timers.filter((t) => !t.cancelled).length === 0);

  await toolSetup.ctx.fire("agent/status", { agent: toolSetup.agent, status: "idle" });
  check("agent 一空闲就拉起来", toolSetup.agent.followed.length === 1, String(toolSetup.agent.followed.length));
  const toolText = textOf(toolSetup.agent.followed[0]);
  check("正文点明「结果未知」", toolText.includes("TOOL_OUTCOME_UNKNOWN"), toolText.slice(0, 80));
  check("正文叮嘱别盲目重试", toolText.includes("不要盲目重试"), toolText.slice(0, 120));

  // 第二次：这一轮的表层上有「assistant 调用 + 合成结果 + 拉起消息」，收走它们再来一次。
  const assistSeq = toolSession.push("assistant/message", {
    message: {
      id: "a1",
      role: "assistant",
      content: [{ type: "tool-call", id: "c1", name: "pwsh", arguments: "{}" }],
    },
  });
  const resultSeq = toolSession.push("tool/result", {
    turn: 1,
    step: 1,
    message: { id: "r1", role: "tool", toolCallId: "c1", isError: true },
    error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" },
  });
  const reviveSeq = toolSession.push("user/message", {
    id: "tt-revive-s-tool-x",
    role: "user",
    content: [{ type: "text", text: "tree_task消息：…" }],
    source: { kind: PLUGIN_SOURCE_KIND, form: "notice", summary: noticeSummary(REVIVE_SUMMARY) },
  });
  const nodesBefore = toolSession.live().length;

  await toolSetup.ctx.fire("session/event", toolSession, {
    type: "tool/result",
    data: {
      turn: 3,
      step: 1,
      message: { id: "r2", role: "tool", toolCallId: "c2", isError: true },
      error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" },
    },
  });
  await toolSetup.ctx.fire("session/event", toolSession, {
    type: "turn/end",
    data: { turn: 3, reason: { kind: "interrupted" } },
  });

  const hiddenNodes = toolSession.live();
  check(
    "第二次中断把三样东西收成了一条",
    hiddenNodes.length === nodesBefore - 2,
    `nodes=${hiddenNodes.length} before=${nodesBefore} chain=${JSON.stringify(store.readRevive(tool))} logs=${toolSetup.ctx.logs.join(" | ")}`,
  );
  check("收走用的是 replace，不是追加", hiddenNodes.length < nodesBefore);
  const hiddenEvent = toolSession.eventAt(hiddenNodes[hiddenNodes.length - 1]);
  check(
    "落下的那条是折叠通告，且摘要带统一前缀",
    hiddenEvent?.data?.source?.summary === noticeSummary(HIDE_SUMMARY),
    String(hiddenEvent?.data?.source?.summary),
  );
  check(
    "被收走的范围正好是 assistant + 合成结果 + 拉起消息",
    Array.isArray(hiddenEvent?.sourceEventSeqs) &&
      hiddenEvent.sourceEventSeqs.length === 3 &&
      hiddenEvent.sourceEventSeqs.includes(assistSeq) &&
      hiddenEvent.sourceEventSeqs.includes(resultSeq) &&
      hiddenEvent.sourceEventSeqs.includes(reviveSeq),
    JSON.stringify(hiddenEvent?.sourceEventSeqs),
  );
  await toolSetup.ctx.fire("agent/status", { agent: toolSetup.agent, status: "idle" });
  check("收走之后再拉一次", toolSetup.agent.followed.length === 2, String(toolSetup.agent.followed.length));

  // 第三次：收走这一手都用过了，停手。
  await toolSetup.ctx.fire("session/event", toolSession, {
    type: "tool/result",
    data: {
      turn: 5,
      step: 1,
      message: { id: "r3", role: "tool", toolCallId: "c3", isError: true },
      error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" },
    },
  });
  await toolSetup.ctx.fire("session/event", toolSession, {
    type: "turn/end",
    data: { turn: 5, reason: { kind: "interrupted" } },
  });
  await toolSetup.ctx.fire("agent/status", { agent: toolSetup.agent, status: "idle" });
  check("第三次停手，不再拉", toolSetup.agent.followed.length === 2, String(toolSetup.agent.followed.length));
  check("停手记在链上", store.readRevive(tool)?.exhausted === true);

  // ------------------------------------------------------------ 输出类

  console.log("\n输出类（MALFORMED_RESPONSE）：立刻一次 + 什么都不收再来一次 + 停手");

  const malformed = "s-malformed";
  const malformedSetup = setup(malformed);
  const malformedSession = makeSession(malformed);
  await malformedSetup.ctx.fire("session/event", malformedSession, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "MALFORMED_RESPONSE" } } },
  });
  check(
    "MALFORMED_RESPONSE 建的是输出类的链",
    store.readRevive(malformed)?.class === "malformed",
    JSON.stringify(store.readRevive(malformed)),
  );
  check("turn/end 那一刻还没空闲，先不推", malformedSetup.agent.followed.length === 0);
  await malformedSetup.ctx.fire("agent/status", { agent: malformedSetup.agent, status: "idle" });
  check("agent 一空闲就拉起来", malformedSetup.agent.followed.length === 1, String(malformedSetup.agent.followed.length));
  const malformedText = textOf(malformedSetup.agent.followed[0]);
  check("正文说清「没有任何工具被执行」", malformedText.includes("没有任何工具被执行"), malformedText.slice(0, 140));
  check("正文不说「做没做没人知道」", !malformedText.includes("做没做没人知道"), malformedText.slice(0, 140));
  check("正文也不劝「不要盲目重试」", !malformedText.includes("不要盲目重试"), malformedText.slice(0, 140));

  // 第二次：没有合成结果可定位，所以一条都不该被收走，只再拉一次。
  malformedSession.push("user/message", {
    id: "tt-revive-s-malformed-x",
    role: "user",
    content: [{ type: "text", text: "tree_task消息：…" }],
    source: { kind: PLUGIN_SOURCE_KIND, form: "notice", summary: noticeSummary(REVIVE_SUMMARY) },
  });
  const malformedNodesBefore = malformedSession.live().length;
  await malformedSetup.ctx.fire("session/event", malformedSession, {
    type: "turn/end",
    data: { turn: 3, reason: { kind: "error", error: { code: "MALFORMED_RESPONSE" } } },
  });
  check(
    "第二次中断什么都不收走",
    malformedSession.live().length === malformedNodesBefore,
    `nodes=${malformedSession.live().length} before=${malformedNodesBefore}`,
  );
  check("链上如实记着没做收走", store.readRevive(malformed)?.hidden === false, JSON.stringify(store.readRevive(malformed)));
  await malformedSetup.ctx.fire("agent/status", { agent: malformedSetup.agent, status: "idle" });
  check(
    "没有东西可收也照样再拉一次",
    malformedSetup.agent.followed.length === 2,
    String(malformedSetup.agent.followed.length),
  );

  // 第三次：停手，不再重复告警。
  await malformedSetup.ctx.fire("session/event", malformedSession, {
    type: "turn/end",
    data: { turn: 5, reason: { kind: "error", error: { code: "MALFORMED_RESPONSE" } } },
  });
  await malformedSetup.ctx.fire("agent/status", { agent: malformedSetup.agent, status: "idle" });
  check("第三次停手，不再拉", malformedSetup.agent.followed.length === 2, String(malformedSetup.agent.followed.length));
  check("停手记在链上", store.readRevive(malformed)?.exhausted === true);
  const warnsBefore = malformedSetup.ctx.logs.length;
  await malformedSetup.ctx.fire("session/event", malformedSession, {
    type: "turn/end",
    data: { turn: 7, reason: { kind: "error", error: { code: "MALFORMED_RESPONSE" } } },
  });
  check("停手之后不再重复告警", malformedSetup.ctx.logs.length === warnsBefore, `${malformedSetup.ctx.logs.length} vs ${warnsBefore}`);

  // ------------------------------------------------------------ aborted

  console.log("\naborted 与停止：");

  const aborted = "s-aborted";
  const abortedSetup = setup(aborted);
  await abortedSetup.ctx.fire("session/event", makeSession(aborted), {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { code: "TRANSPORT" } } },
  });
  check("先有链", store.readRevive(aborted) !== null);
  await abortedSetup.ctx.fire("session/event", makeSession(aborted), {
    type: "turn/end",
    data: { turn: 2, reason: { kind: "aborted", reason: { kind: "user" } } },
  });
  check("aborted 把链清掉", store.readRevive(aborted) === null);

  await abortedSetup.ctx.fire("session/event", makeSession(aborted), {
    type: "turn/end",
    data: { turn: 3, reason: { kind: "error", error: { code: "TRANSPORT" } } },
  });
  await abortedSetup.ctx.fire("agent/turn-stopping", {
    agent: { session: { id: aborted } },
    signal: { aborted: true },
  });
  check("人按停止也把链清掉", store.readRevive(aborted) === null);
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  rmSync(root, { recursive: true, force: true });
}

console.log("\n────────────────────────────────────────────────────────────");
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
