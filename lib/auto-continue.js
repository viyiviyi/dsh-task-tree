/**
 * 自动续行兜底。
 *
 * 主路径其实**不需要这里**：`tree_task_done` 的返回文本里已经带了"请继续执行下一个步骤"，
 * 模型通常会在同一轮里接着往下做。
 *
 * 这里兜的是"模型仍然停下来"的情况：本轮结束、agent 回到 `idle` 时，
 * 如果计划还在进行中，就推一条续行消息把下一轮唤醒。
 *
 * 两条安全阀缺一不可（方案 §7.1）：
 *
 * 1. **队列里还有人在等的时候绝不抢**：`inbox.nextTurn` / `nextStep` 非空就退出。
 * 2. **连续续行轮次有上限**，达到就停，避免把 token 烧在一个卡住的任务上。
 *
 * @module dsh-tree-task-flow/auto-continue
 */

import { activePath, renderContinue } from "./plan.js";
import { pluginSource } from "./region.js";

/**
 * 注册续行兜底。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, cfg }`。
 */
export function registerAutoContinue(ctx, { store, cfg }) {
  /** 每个会话连续续行了多少次。 */
  const rounds = new Map();

  /**
   * 被用户强行打断过的会话——**不再自动续行**。
   *
   * 这是"会话停不下来"的解法。用户按下停止 → 本轮中止 → agent 回到 idle；
   * 没有这道闸，下面的 `agent/status` 监听器会立刻把它再拉起来，用户就永远停不下来。
   * `agent/turn-stopping` 的 payload 带 `signal`，`signal.aborted` 正是
   * "这一轮是被中止的"这个事实。
   */
  const stopped = new Set();

  /** 这个会话是不是被"停止"按住：内存说是，或磁盘说是。 */
  function heldNow(sessionId) {
    return stopped.has(sessionId) || store?.readHeld?.(sessionId)?.stopped === true;
  }

  /**
   * 用户按下停止：**从落盘的 `turn/end` 认，不能从 `agent/turn-stopping` 认。**
   *
   * `agent/turn-stopping` 只在"这一轮本来就要正常收尾"时才发——`dsh-agent-loop` 里
   * 唯一一处 dispatch 在 `turn()` 的 try 里，紧挨着前面那句 `signal.throwIfAborted()`。
   * 用户按停止会让信号 abort、从别处抛出，catch 里直接记下
   * `turn/end reason.kind = "aborted"` 并重新抛出，那条 dispatch 根本走不到。
   * 也就是说 `payload.signal.aborted` 在那里几乎永远是 `false`——拿它当闸门等于没闸门：
   * 会话被停掉之后 `agent/status` 一转 `idle`，续行立刻又把它拉起来。
   *
   * 可靠的事实是**落盘的 `turn/end`**：中止一定会在 `finally` 里被记成
   * `reason: { kind: "aborted", reason: { kind: "user" } }`（cause 为 `user` 就是人按的，
   * 另有 `parent` / `hook` / `disposed`）。而且它发生在驱动循环 `setPhase(idle)`
   * 之前——`agent/status` 是之后才发的，所以这个标记一定赶得上那次判断。
   *
   * 中止就是中止：不管是谁按的，插件都不该自作主张把这一轮重新拉起来。
   */
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    if (event.data?.reason?.kind !== "aborted") return;
    const sessionId = session?.id;
    if (sessionId === undefined) return;
    stopped.add(sessionId);
    // 落盘：重启后条目上仍看得到「继续」，也仍然压得住自动续行。
    store?.patchHeld?.(sessionId, { stopped: true });
  });

  /**
   * 次要路径，留着兜底：如果中止恰好发生在 `agent/turn-stopping` 的 dispatch 过程中
   * （信号在那一刻才变 abort），上面那条 `turn/end` 判据同样会兜住它；这里只是让
   * 标记更早一点落下。**不要把它当成主判据**，原因见上。
   */
  ctx.on("agent/turn-stopping", (payload) => {
    const sessionId = payload?.agent?.session?.id;
    if (sessionId === undefined) return;
    if (payload?.signal?.aborted === true) {
      stopped.add(sessionId);
      store?.patchHeld?.(sessionId, { stopped: true });
    }
  });

  // 只有**真人**发的消息才重置配额。
  //
  // 必须按来源区分，不能按"这一步有没有消息"：`agent.followup()` 推的消息同样会
  // 从 inbox 进入下一步的 `payload.messages`，那样每一轮都会把自己刚用掉的配额
  // 重置回去，`maxAutoRounds` 也就失去了意义。
  // `source.kind === 'user'` 才是真人，插件推的是 `plugin:dsh-tree-task-flow`
  // （v3 老会话里是 `{ kind: 'plugin', plugin: 'dsh-tree-task-flow' }`；两种都不是 `'user'`）。
  //
  // 注意这是 waterfall：必须 await next() 并把它返回，否则会截断监听器链。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    const sessionId = payload?.agent?.session?.id;
    if (sessionId === undefined) return decision;
    const fromHuman = (payload?.messages ?? []).some(
      (message) => message?.source?.kind === "user",
    );
    if (fromHuman) {
      rounds.set(sessionId, 0);
      // 人回来了，解除中断标记，允许新一轮的续行。
      stopped.delete(sessionId);
      store?.patchHeld?.(sessionId, { stopped: false });
    }
    return decision;
  });

  ctx.on("agent/status", (payload) => {
    if (cfg.autoContinue !== true) return;
    if (payload?.status !== "idle") return;

    const agent = payload.agent;
    const sessionId = agent?.session?.id;
    if (agent === undefined || sessionId === undefined) return;

    // ★ 安全阀 0：这一轮是被用户**中止**的 → 绝不能把它拉起来。
    if (heldNow(sessionId)) return;

    // 安全阀 1：已经有排队输入，别抢在用户前面。
    const inbox = agent.inbox;
    if ((inbox?.nextTurn?.length ?? 0) > 0 || (inbox?.nextStep?.length ?? 0) > 0) return;

    // 安全阀 2：轮次上限。
    const used = rounds.get(sessionId) ?? 0;
    if (used >= cfg.maxAutoRounds) return;

    // 只有"**本会话的**计划还在进行中"才值得续。
    const plan = store.readPlan(sessionId);
    const active = activePath(plan);
    if (active === null || active.step === null) return;

    rounds.set(sessionId, used + 1);
    try {
      agent.followup({
        id: `tt-continue-${sessionId}-${Date.now().toString(36)}`,
        role: "user",
        content: [{ type: "text", text: renderContinue(plan) }],
        source: pluginSource("计划续行"),
      });
      ctx.logger?.info?.(
        `dsh-tree-task-flow: 自动续行 ${used + 1}/${cfg.maxAutoRounds}（步骤 ${active.step.id}）`,
      );
    } catch (error) {
      ctx.logger?.warn?.(`dsh-tree-task-flow: 自动续行失败：${String(error?.message ?? error)}`);
    }
  });

  // 交给 /task-tree 命令用的控制接口：人得有一句话就能接管的手段。
  return {
    /** 停止某个会话的自动续行（用户中断时自动调用，也可由 /task-tree stop 显式调用）。 */
    stop(sessionId) {
      if (sessionId !== undefined) stopped.add(sessionId);
    },
    /** 重新允许某个会话自动续行。 */
    resume(sessionId) {
      if (sessionId !== undefined) stopped.delete(sessionId);
    },
    /** 这个会话当前是不是处于被停止状态（跨重启）。 */
    isStopped(sessionId) {
      return heldNow(sessionId);
    },
  };
}
