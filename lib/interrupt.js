/**
 * 意外中断的自动拉起。
 *
 * 模型跑到一半停住，有两种完全不同的停法，**只有后一种值得插件插手**：
 *
 *   ① **正常收尾**：`turn/end` 的 `reason.kind` 是 `completed` / `max-tokens`。
 *      模型自己把话说完、把工具停下来了。计划没做完是模型偷懒，那是
 *      `auto-continue.js` 的活，不在这里掺和。
 *
 *   ② **意外中断**：模型根本没机会说完。DSH 层面只有两种形态（2026-10-08 扫本机
 *      187 个会话日志得出的结论，全量 2000+ 次 `turn/end` 都落在这两类里）：
 *
 *      - **模型 API 调用失败**：`turn/end` 的 `reason.kind === 'error'`，里面是
 *        一个 `LlmFailure`（`{ message, code }`）。见过的码有 `TRANSPORT`
 *        （连接被断）、`RATE_LIMIT`（429）、`QUOTA`（402 余额不足）、
 *        `MALFORMED_RESPONSE`（模型吐出的工具调用参数不是合法 JSON）。
 *        DSH 自带的 `dsh-llm-retry` 会**先**快速重试 5 次（500ms→10s 退避），
 *        这里接的是它耗光之后那一段长间隔。
 *
 *      - **工具执行到一半进程没了**：会话重新加载时，DSH 的崩溃修复
 *        （`dsh-session` 的 `repair.js`，`openTurnClosers`）发现"有工具调用没落盘
 *        结果"，补一条合成错误结果——`error.code` 是 `TOOL_OUTCOME_UNKNOWN`
 *        （调用已记录、结果没落盘）或 `TOOL_NOT_STARTED`（调用还没记录）——
 *        同时补一条 `turn/end` `reason.kind === 'interrupted'`。
 *        **这不是"工具报错"**：它意味着那次操作到底做没做，没人知道。
 *
 * ## 为什么不看 `isError`
 *
 * 全量日志里带 `isError` 的工具结果有 800 多条，绝大多数是
 * `FS_STALE_VERSION`(283)、`FS_EDIT_NOT_FOUND`(133)、`WEB_BLOCKED_URL`(63)、
 * `SEARCH_FAILED`(13) 这一类——模型看得懂，自己会改道，`turn` 照样走完。
 * 拿它当判据只会到处乱拉。真正和"停住"绑定的只有上面那种**没有真实结果**的
 * 合成错误。
 *
 * ## 拉起的节奏
 *
 * | 中断 | 节奏 |
 * |---|---|
 * | 网络类（`TRANSPORT` / `TIMEOUT` / `SERVER` / `RATE_LIMIT` / `EMPTY_RESPONSE`） | 中断后第 1、5、10、30 分钟各一次 |
 * | 工具类（合成错误 `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`） | 立刻一次；再失败就把那次工具调用连拉起消息一起收走，再拉一次，然后停手 |
 * | 输出类（`MALFORMED_RESPONSE`） | 立刻一次；再失败就直接再拉一次（没有东西可收），然后停手 |
 *
 * ## 为什么 `MALFORMED_RESPONSE` 要单独一类
 *
 * 它的全文是「模型给出的工具调用参数不是合法 JSON」，**整条响应被 DSH 直接作废**：
 * 一个工具都没执行，连 `tool/call` 都没落盘，也就没有"结果未知"可言。把它和合成
 * 错误混在一起，会同时错两处——提示词让人去勘察一个不存在的副作用，收走逻辑又
 * 找不到对象却照样宣称"连同拉起消息一起收走了"（2026-10-12 在
 * session-ff946de5 上逐分支推演时发现）。
 *
 * `QUOTA`（余额不足）**不拉**：等再久也不会自己好，白烧消息。
 * `aborted`（人按了停止）永远不拉。
 *
 * ## 一条链只跑一遍
 *
 * 时刻表用完就把它标成 `exhausted` 停在磁盘上，不再开新的链——否则"拉起→失败→
 * 从头再来"会无限循环下去。**真人一发消息就把它清掉**：人回来了，环境大概也变了，
 * 值得重来一遍。
 *
 * @module dsh-tree-task-flow/interrupt
 */

import { activePath, renderContinue } from "./plan.js";
import { hasSummary, isPluginSource, pluginSource, summaryMessage } from "./region.js";

/**
 * 传输类的模型 API 失败码——这些等一会儿大概率会好。
 *
 * 与 `@deepseek-ai/dsh-llm` 的 `DEFAULT_RETRYABLE_CODES` 保持一致
 * （那边还有 `EMPTY_RESPONSE`），**但不含 `QUOTA`**：余额不足不会自己好。
 */
export const NETWORK_CODES = Object.freeze([
  "TRANSPORT",
  "TIMEOUT",
  "SERVER",
  "RATE_LIMIT",
  "EMPTY_RESPONSE",
]);

/**
 * "结果未知"的合成错误码——会话重载时由 DSH 的崩溃修复补上。
 *
 * 这类结果**不是工具真的报错**，而是"那次调用到底做没做，没人知道"。
 */
export const SYNTHETIC_TOOL_CODES = Object.freeze(["TOOL_OUTCOME_UNKNOWN", "TOOL_NOT_STARTED"]);

/**
 * 模型给出的工具调用参数不是合法 JSON。
 *
 * 由 DSH 的 provider 适配器在**解析服务端返回的响应流**时抛出：收到 `message_stop` 后对
 * 每个 tool-call 块的实参做 `JSON.parse`，失败即 `MALFORMED_RESPONSE`。此刻那一条响应
 * 已被整条作废，没有任何工具被执行。
 */
const MALFORMED_CODE = "MALFORMED_RESPONSE";

/** 需要"一有结果就立刻拉"的两类：都要等 agent 空下来才能真正推消息。 */
const IMMEDIATE_CLASSES = Object.freeze(["tool", "malformed"]);

/** 默认时刻表：中断后第 1、5、10、30 分钟各一次。 */
export const DEFAULT_DELAYS_MS = Object.freeze([60_000, 300_000, 600_000, 1_800_000]);

/** 拉起消息在界面上的那一行摘要，也是"这条是我注入的"的识别标记。 */
export const REVIVE_SUMMARY = "中断拉起";

/** 收走失败尝试时落下的那条消息的摘要。 */
export const HIDE_SUMMARY = "中断重试 · 上一次尝试已作废";

/** 同一毫秒内连发两条也不撞 id。 */
let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/**
 * 拉起消息的开头一句——按中断类别说实话。
 *
 * 三类的中断事实完全不同，用同一句话只会把模型带偏：
 *
 * - `tool`：确实发起过工具调用，结果没落盘，"做没做"真的没人知道，所以要先勘察影响；
 * - `malformed`：那整条响应被判废，**一个工具都没执行**，没有影响可勘察，原样重做即可；
 * - `network`：请求根本没送达，同上，重来一遍。
 *
 * @param kind - `'network'` / `'tool'` / `'malformed'`。
 * @param code - 中断码。
 * @returns 一句话（不含后续的续行提示）。
 */
export function reviveLead(kind, code) {
  if (kind === "tool") {
    return `tree_task消息：上一轮的工具调用没有留下结果（${code}），它到底做没做没人知道——先确认那一步的实际影响，再决定要不要重做，不要盲目重试。`;
  }
  if (kind === "malformed") {
    return `tree_task消息：上一轮模型给出的工具调用参数不是合法 JSON（${code}），DSH 把那一整条响应作废了——没有任何工具被执行，也没有任何副作用要勘察，把那一步原样重做一遍就行。写实参时把引号和括号写全（长文本尤其当心），必要时一次只调用一个工具。`;
  }
  return `tree_task消息：上一轮因为 ${code} 中断了，会话没跑完。`;
}

/**
 * 判定这次 `turn/end` 算不算意外中断。
 *
 * @param reason - `turn/end` 的 `reason`。
 * @param syntheticCode - 这一轮里出现过的合成错误码，没有则 null。
 * @returns `{ class: 'network' | 'tool' | 'malformed', code }`，不属于这套机制时返回 null。
 */
export function classifyInterrupt(reason, syntheticCode = null) {
  const kind = reason?.kind;
  if (kind === "error") {
    const code = reason?.error?.code;
    if (typeof code !== "string" || code === "") return null;
    if (NETWORK_CODES.includes(code)) return { class: "network", code };
    if (code === MALFORMED_CODE) return { class: "malformed", code };
    return null; // QUOTA 等：不归这套管
  }
  if (kind === "interrupted") {
    if (typeof syntheticCode !== "string" || syntheticCode === "") return null;
    return { class: "tool", code: syntheticCode };
  }
  return null;
}

/**
 * 注册意外中断拉起。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, cfg, pause }`。
 * @returns 控制接口：`{ stop(sessionId), revive(sessionId) }`。
 */
export function registerInterruptRecovery(ctx, { store, cfg, pause = null }) {
  /** 每个会话一个待触发的定时器（网络类）。 */
  const timers = new Map();
  /** 这一轮里见到过的合成错误码：sessionId → code。 */
  const synthetic = new Map();
  /** 工具类 / 输出类中断在等 agent 空下来：sessionId → `{ code, klass }`。 */
  const waiting = new Map();

  /** 取实时 agent；拿不到可选服务时 cordis 会抛错，所以反射式取。 */
  function liveAgent(sessionId) {
    return ctx.get?.("agents")?.get?.(sessionId) ?? null;
  }

  function clearTimer(sessionId) {
    const handle = timers.get(sessionId);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(sessionId);
    }
  }

  function delays() {
    const configured = cfg?.interruptDelaysMs;
    return Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_DELAYS_MS;
  }

  /** 计划树还在进行中吗——没拆完、有检查点都算"还在进行"。 */
  function pending(plan) {
    if (plan === null) return false;
    const active = activePath(plan);
    return active !== null && active.step !== null;
  }

  /**
   * 开关关着时整个模块都不动。
   *
   * 它是**面板上随时可改**的，所以每次事件现读 `cfg`，不能开机读一次就定死；
   * 注册与否也不该取决于它（见 `lib/index.js` 里那句"无条件注册"）。
   *
   * 判据写成"**显式 false 才算关**"：这一项的默认值是开，缺字段的意思是"没配，
   * 按默认走"，不该被当成关掉——直接构造这个模块的调用方（自检、以后别的入口）
   * 往往只给一个 `{}`。
   */
  function off() {
    return cfg?.interruptRecovery === false;
  }

  /** 现在能不能拉：暂停 / 停止 / 没计划 / 没加载 / 不空闲，一条不满足就不拉。 */
  function blockedBy(sessionId) {
    if (pause?.isPaused?.(sessionId) === true) return "paused";
    if (store.readHeld(sessionId)?.stopped === true) return "stopped";
    const plan = store.readPlan(sessionId);
    if (plan === null) return "no-plan";
    if (!pending(plan)) return "finished";
    const agent = liveAgent(sessionId);
    if (agent === null) return "unloaded";
    if (agent.status !== "idle") return "busy";
    return null;
  }

  /**
   * 推一条拉起消息。
   *
   * @param sessionId - 要拉起的会话。
   * @param kind - `'network'` / `'tool'` / `'malformed'`。
   * @param code - 触发这次拉起的中断码。
   * @returns `{ ok, reason?, text? }`。
   */
  function revive(sessionId, kind, code) {
    if (off()) return { ok: false, reason: "disabled" };
    const blocked = blockedBy(sessionId);
    if (blocked !== null) return { ok: false, reason: blocked };

    const plan = store.readPlan(sessionId);
    const text = `${reviveLead(kind, code)}${renderContinue(plan)}`;

    const agent = liveAgent(sessionId);
    try {
      agent.followup({
        id: nextId(`tt-revive-${sessionId}`),
        role: "user",
        content: [{ type: "text", text }],
        source: pluginSource(REVIVE_SUMMARY),
      });
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-tree-task-flow: 中断拉起失败：${String(error?.message ?? error)}`,
      );
      return { ok: false, reason: "error" };
    }
    ctx.logger?.info?.(
      `dsh-tree-task-flow: 意外中断拉起（${kind}/${code}）：${sessionId}`,
    );
    return { ok: true };
  }

  /**
   * 排下一次网络类拉起。
   *
   * 磁盘上的 `pending` 是**绝对时刻**；已经过去的一律丢掉（进程没起来时补拉没有意义），
   * 一个不剩就把这条链标成用完。
   */
  function scheduleNext(sessionId) {
    if (off()) return;
    clearTimer(sessionId);
    const state = store.readRevive(sessionId);
    if (state === null || state.class !== "network") return;

    const now = Date.now();
    const future = (state.pending ?? []).filter((at) => typeof at === "number" && at > now);
    if (future.length === 0) {
      store.writeRevive(sessionId, { ...state, pending: [], exhausted: true });
      return;
    }

    const next = future[0];
    const handle = setTimeout(() => {
      timers.delete(sessionId);
      const fresh = store.readRevive(sessionId);
      if (fresh === null) return;
      // 到点就消费掉这个时刻，拉起成功与否都不还给它。
      store.writeRevive(sessionId, {
        ...fresh,
        pending: (fresh.pending ?? []).filter((at) => at !== next),
      });
      revive(sessionId, "network", fresh.code);
      scheduleNext(sessionId);
    }, next - now);
    handle.unref?.();
    timers.set(sessionId, handle);
  }

  /** 链结束：把定时器与磁盘状态一起清掉。 */
  function endChain(sessionId) {
    clearTimer(sessionId);
    waiting.delete(sessionId);
    store.clearRevive(sessionId);
  }

  /**
   * 收走"上一次没成的那一下"。
   *
   * 收走三样连在一起的东西：**发起那次工具调用的 assistant 消息**、它的
   * **结果未知的合成错误结果**、以及**我们刚推的那条拉起消息**。留着它们，
   * 模型下一轮多半还会照着再来一遍；收走之后它才可能换条路走。
   *
   * ★ **只对 `tool` 类调用**。`malformed` 类（`MALFORMED_RESPONSE`）什么都没执行、
   * 没有合成结果可定位，走到这里只会以「只收走拉起消息」收场，却仍然落下一条
   * "连同拉起消息一起收走了"的通告——话说过头了，所以那类压根不调它。
   *
   * @param session - 当前会话。
   * @param code - 触发这次收走的中断码。
   * @returns 是否真的收走了。
   */
  function hideFailedAttempt(session, code) {
    const nodes = session.surface?.nodes ?? [];
    if (nodes.length === 0 || typeof session.eventAt !== "function") return false;

    // ① 最后一条我们注入的拉起消息。
    let reviveIdx = -1;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const event = session.eventAt(nodes[index]);
      if (
        event?.type === "user/message" &&
        isPluginSource(event.data?.source) &&
        // 带不带「树形任务流 · 」前缀都认：升级前落下的那几条没有前缀。
        hasSummary(event.data?.source, REVIVE_SUMMARY)
      ) {
        reviveIdx = index;
        break;
      }
    }
    if (reviveIdx === -1) return false;

    // ② 它前面最近的那条"结果未知"合成结果。
    let resultIdx = -1;
    for (let index = reviveIdx - 1; index >= 0; index -= 1) {
      const event = session.eventAt(nodes[index]);
      if (event?.type === "user/message" && isPluginSource(event.data?.source)) break;
      if (event?.type === "tool/result" && SYNTHETIC_TOOL_CODES.includes(event.data?.error?.code)) {
        resultIdx = index;
        break;
      }
    }

    // ③ 再往前，发起那次调用的 assistant 消息。
    let startIdx = resultIdx === -1 ? reviveIdx : resultIdx;
    if (resultIdx !== -1) {
      for (let index = resultIdx - 1; index >= 0 && resultIdx - index <= 5; index -= 1) {
        const event = session.eventAt(nodes[index]);
        if (event?.type === "assistant/message") {
          startIdx = index;
          break;
        }
      }
    }

    const from = nodes[startIdx];
    const to = nodes[reviveIdx];
    const shadowed = nodes.slice(startIdx, reviveIdx + 1);
    const count = shadowed.length;
    const text =
      `tree_task消息：上一次尝试（${code}）已经作废，它那一段过程连同拉起消息一起收走了。` +
      `重新开始这一步，换一条路走。`;

    try {
      session.append("user/message", summaryMessage(nextId("tt-hide"), text, HIDE_SUMMARY), {
        surfaceOp: { op: "replace", startSeq: from, endSeq: to },
        sourceEventSeqs: shadowed,
      });
    } catch (error) {
      // 收不走不算致命：下一次中断还会再试。绝不因此中断会话。
      ctx.logger?.warn?.(
        `dsh-tree-task-flow: 收走失败尝试失败，保留原区间：${String(error?.message ?? error)}`,
      );
      return false;
    }
    ctx.logger?.info?.(
      `dsh-tree-task-flow: 已收走 ${count} 条失败尝试（${code}），再拉一次：${session.id}`,
    );
    return true;
  }

  /**
   * 工具类 / 输出类：立刻拉起一次，第二次失败再拉一次，第三次停手。
   *
   * 两次之间的差别只在于"有没有东西可收"：`tool` 那类确实发起过工具调用，把那次调用
   * 连同拉起消息一起收走，模型下一轮才可能换条路走；`malformed` 那类什么都没执行，
   * 没有东西可收，收了反而只是一句空话。
   *
   * @param session - 当前会话。
   * @param sessionId - 会话 id。
   * @param turn - 中断所在的轮次。
   * @param klass - `'tool'` / `'malformed'`。
   * @param code - 中断码。
   */
  function onImmediateInterrupt(session, sessionId, turn, klass, code) {
    const chain = store.readRevive(sessionId);
    // 这条链已经用完两次、停手了：不再重复告警，等真人发消息把它清掉。
    if (chain?.class === klass && chain.exhausted === true) return;
    const attempts = chain?.class === klass ? chain.attempts ?? 0 : 0;

    if (attempts === 0) {
      store.writeRevive(sessionId, {
        turn,
        class: klass,
        code,
        pending: [],
        attempts: 1,
        hidden: false,
      });
      // turn/end 到达时 agent 往往还没翻回 idle，这里只登记，等 idle 再推。
      waiting.set(sessionId, { code, klass });
      return;
    }

    if (attempts === 1) {
      const hidden = klass === "tool" ? hideFailedAttempt(session, code) : false;
      store.writeRevive(sessionId, {
        ...chain,
        turn,
        code,
        attempts: 2,
        hidden,
      });
      waiting.set(sessionId, { code, klass });
      return;
    }

    // 两次都用过了还是停住：停手，等人。
    store.writeRevive(sessionId, { ...chain, turn, code, exhausted: true });
    waiting.delete(sessionId);
    ctx.logger?.warn?.(
      `dsh-tree-task-flow: ${klass} 类中断重复出现（${code}），已停手，等真人介入：${sessionId}`,
    );
  }

  /** 网络类：开一条链或接着用剩下的时刻。 */
  function onNetworkInterrupt(sessionId, turn, code) {
    const chain = store.readRevive(sessionId);
    if (chain?.exhausted === true) return;
    const sameChain = chain?.class === "network" && Array.isArray(chain.pending) && chain.pending.length > 0;
    const now = Date.now();
    const pending = sameChain ? chain.pending : delays().map((delay) => now + delay);
    store.writeRevive(sessionId, {
      turn,
      class: "network",
      code,
      pending,
      attempts: 0,
      hidden: false,
    });
    scheduleNext(sessionId);
  }

  // ---------------------------------------------------------------- 会话事件

  ctx.on("session/event", (session, event) => {
    if (off()) return;
    const sessionId = session?.id;
    if (sessionId === undefined || event === undefined) return;

    if (event.type === "turn/start") {
      synthetic.delete(sessionId);
      return;
    }

    if (event.type === "tool/result") {
      const code = event.data?.error?.code;
      if (SYNTHETIC_TOOL_CODES.includes(code)) synthetic.set(sessionId, code);
      return;
    }

    if (event.type !== "turn/end") return;

    const reason = event.data?.reason;
    const sawSynthetic = synthetic.get(sessionId) ?? null;
    synthetic.delete(sessionId);

    // 正常收尾 / 被按住：这条链到此为止。
    if (reason?.kind === "completed" || reason?.kind === "max-tokens" ||
        reason?.kind === "aborted" || reason?.kind === "blocked" || reason?.kind === "forked") {
      endChain(sessionId);
      return;
    }

    const hit = classifyInterrupt(reason, sawSynthetic);
    if (hit === null) return;

    // 拉起的唯一前提：这棵树上还有没做完的活。
    const plan = store.readPlan(sessionId);
    if (plan === null || !pending(plan)) {
      endChain(sessionId);
      return;
    }

    const turn = event.data?.turn;
    if (IMMEDIATE_CLASSES.includes(hit.class)) {
      onImmediateInterrupt(session, sessionId, turn, hit.class, hit.code);
      return;
    }
    onNetworkInterrupt(sessionId, turn, hit.code);
  });

  // ---------------------------------------------------------------- agent 状态

  ctx.on("agent/status", (payload) => {
    if (off()) return;
    const sessionId = payload?.agent?.session?.id;
    if (sessionId === undefined || payload?.status !== "idle") return;

    // 工具类 / 输出类中断一直在等这个时刻：agent 终于空下来了。
    const queued = waiting.get(sessionId);
    if (queued !== undefined) {
      waiting.delete(sessionId);
      revive(sessionId, queued.klass, queued.code);
    }

    // 跨重启：磁盘上还留着没跑完的时刻表，重新排上。
    scheduleNext(sessionId);
  });

  // 真人一发消息就清链：人回来了，环境大概也变了，允许重新开一条。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    const sessionId = payload?.agent?.session?.id;
    if (sessionId === undefined) return decision;
    const fromHuman = (payload?.messages ?? []).some(
      (message) => message?.source?.kind === "user",
    );
    if (fromHuman) endChain(sessionId);
    return decision;
  });

  // 人按了停止：这条链立刻作废，一条都不许再推。
  ctx.on("agent/turn-stopping", (payload) => {
    const sessionId = payload?.agent?.session?.id;
    if (sessionId === undefined) return;
    if (payload?.signal?.aborted === true) endChain(sessionId);
  });

  return {
    /** 停掉某个会话的拉起（人按停止时用）。 */
    stop(sessionId) {
      endChain(sessionId);
    },
    /** 立刻尝试拉起一次（给命令用）。 */
    revive(sessionId, kind = "network", code = "MANUAL") {
      return revive(sessionId, kind, code);
    },
  };
}
