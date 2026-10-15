/**
 * dsh-tree-task-flow —— 三级任务树：完成时提交结果，同时把执行过程折叠掉。
 *
 * 与 DSH 内置任务系统的差别在于**上下文的收放方式**：
 *
 * ```
 * 一个节点的上下文 =
 *     ① 节点 0：会话级稳定前缀（身份 / 工具 / 工具说明）   ← 不随计划变化
 *   + ② 这一层已有的汇总消息                                ← 同级逐条累积，不被卷走
 *   + ③ 当前节点的执行过程                                  ← 完成时整段折叠成一条汇总
 * ```
 *
 * ② 与 ③ 的分工是「留给后面的」与「用完就扔的」。节点完成时一次
 * `surfaceOp: replace` 把 `[当前节点的全部执行过程]` 换成 `[一条携带提交结果的汇总消息]`，
 * 汇总落在同级上一条汇总之后，因此下一条汇总的折叠范围够不到它。
 *
 * @module dsh-tree-task-flow
 */

import { registerAutoContinue } from "./auto-continue.js";
import { registerCommands } from "./commands.js";
import { registerCompactionNotice } from "./compaction.js";
import { registerHttp } from "./http.js";
import { registerInterruptRecovery } from "./interrupt.js";
import { registerPause } from "./pause.js";
import { DEFAULT_ORDER, registerPromptSection } from "./prompt.js";
import { registerRegion } from "./region.js";
import { pickSettings } from "./settings.js";
import { createStore, defaultRoot } from "./store.js";
import { registerTools } from "./tools.js";

/** Cordis 插件名。 */
export const name = "dsh-tree-task-flow";

/**
 * 依赖的服务。
 *
 * `tools` **必须写进 inject**：cordis 在访问一个没有 inject 的服务属性时会直接抛错
 * （`cannot get property "tools" without inject`），整个插件加载失败、dsh 起不来。
 * 反过来，也只有 inject 了才拿得到 `ctx.tools`。
 */
export const inject = ["systemPrompt", "tools"];

/** 本行没给 config 时使用的默认值。 */
export const DEFAULT_CONFIG = {
  /**
   * 总开关。
   *
   * ★ **默认开启**：装上就用。安装这个插件本身就是用户点的头，
   * 再让每个人去改一遍 profile 配置没有道理。
   *
   * 想关掉就在 profile 的 `cordis.patch.yml` 里显式写 `enabled: false`——
   * 关掉之后它一个字节都不碰会话（见下面 apply 里的分支）。
   */
  enabled: true,
  /**
   * 是否允许在模型停下时自动续行。
   *
   * ★ **默认关闭。** 它会趁你没说话的时候**往会话里推一条消息**、把模型再叫起来跑一轮，
   * 是最需要人知情的一项。
   *
   * 这里曾经写死过一条规矩："插件还没有配置界面，功能就不能默认关"——默认关等于这个
   * 功能不存在，没人会去翻 YAML 把它打开。**那条规矩随着设置界面一起作废**：现在面板上
   * 就能点开，默认值该按"会不会打扰人"来定，而不是按"能不能被发现"。
   *
   * 想打开：面板上的设置里点一下，或在 profile 里写 `autoContinue: true`。
   */
  autoContinue: false,
  /** 连续自动续行的轮次上限，达到就停。 */
  maxAutoRounds: 5,
  /**
   * 意外中断的自动拉起。
   *
   * ★ **默认开启**。它和 `autoContinue` 管的是两件事：`autoContinue` 是"模型自己
   * 正常收尾了、但计划没做完"，本项是"模型根本没机会说完就断了"——网络断了、
   * 模型 API 报错、或者进程在工具执行中途没了。后者不加干预就永远停在那儿。
   *
   * 用户按停止（`aborted`）永远不拉起；余额不足（`QUOTA`）也不拉（等再久也不会好）。
   */
  interruptRecovery: true,
  /**
   * 网络类中断的拉起时刻表，单位毫秒，相对中断那一刻。
   *
   * 默认 `[1 分钟, 5 分钟, 10 分钟, 30 分钟]`——四个**累计时刻**，不是递增间隔。
   * 一条链只跑一遍；跑完还失败就停手，等真人发消息再允许重开。
   */
  interruptDelaysMs: null,
  /** 工具说明段落的排序。 */
  promptOrder: DEFAULT_ORDER,
  /** 状态目录；null 表示 $DSH_HOME/dsh-task-tree。 */
  rootDir: null,
};

/**
 * 挂载插件。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param config - 本行的 config；未提供或字段缺失时按默认值兜底。
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const root = cfg.rootDir ?? defaultRoot();
  const store = createStore(root);

  // 面板上改过的开关盖在 profile 的 config 之上：**人在界面上的选择优先**。
  // 不这么做的话，界面改完、profile 一改又被顶回去，人会以为开关坏了。
  //
  // `cfg` 是**活的对象**：面板改开关时就地改它，各模块拿的是同一个引用，
  // 所以立刻生效，不用重启。这也是为什么各模块要按事件现读 `cfg`，不是开机读一次。
  Object.assign(cfg, pickSettings(store.readSettings()));

  // 被显式关掉时，一个字节都不碰会话：不注册工具、不加提示词段落、不折叠上下文、
  // 不续行——只留一条命令，让人能确认"装了但被关掉了"以及怎么打开。
  if (cfg.enabled !== true) {
    registerCommands(ctx, { store, cfg, pause: null, enabled: false });
    // 条目接口照挂：客户端条目与 enabled 无关，照样会来读。读不到计划它就返回
    // null，一个像素都不占；而既有的计划文件仍然能看到。
    // 只读插件自己的状态目录，不碰任何会话。
    registerHttp(ctx, { store, autoContinue: null, pause: null, cfg });
    ctx.logger?.warn?.(
      "dsh-tree-task-flow: 已按配置关闭（enabled=false）。要打开请在 profile 的 cordis.patch.yml 里把它设为 true。",
    );
    return;
  }

  // 工具说明段。必须包在 effect 里，否则热更新后会重复注册而抛错。
  ctx.effect(registerPromptSection(ctx, cfg.promptOrder), "dsh-tree-task-flow.section");

  // 六个工具。tools 已在 inject 里声明，这里必定就绪。
  registerTools(ctx, { store, cfg });

  // 内置压缩之后提醒模型去看计划树。
  //
  // ★ **必须在 registerRegion 之前注册**：先注册的是外层，它的后置代码才会
  // 排在折叠之后——否则这条提示会被同一轮折叠顺手收走。
  registerCompactionNotice(ctx, { store });

  // 节点完成时把它的执行过程折叠成一条携带结果的汇总消息。
  registerRegion(ctx, { store });

  // 模型停下来时的续行兜底。返回的控制接口交给 /task-tree 命令，
  // 让人随时能一句话停下来。
  const autoContinue = registerAutoContinue(ctx, { store, cfg });

  // 暂停闸门：挂在 `agent/pre-step` 上，人点暂停就停在"上一个工具跑完、
  // 下一次模型请求还没发出"那个岔口。它同时压住上面的自动续行兜底。
  const pause = registerPause(ctx, { store, autoContinue });

  // 意外中断的拉起：网络类按 1/5/10/30 分钟各一次，工具类（结果未知的合成错误）
  // 立刻一次，再失败就收走那一次尝试再来一次。它与 autoContinue 并存：
  // 那边管"模型正常收尾但计划没做完"，这边管"模型没机会说完就断了"。
  //
  // ★ **无条件注册**：开关（`interruptRecovery`）在面板上随时可改，注册与否取决于
  // 它就没法在运行中打开。真正的闸门放在模块内部——事件来了先问一句 `cfg`。
  registerInterruptRecovery(ctx, { store, cfg, pause });

  // /task-tree 命令：查看与管理任务树，也是"暂停 / 继续"的开关。
  registerCommands(ctx, { store, cfg, pause, enabled: true });

  // 任务树条目要用的 HTTP 接口。`cfg` 传进去是为了让面板能读到并改掉那几个开关。
  registerHttp(ctx, { store, autoContinue, pause, cfg });

  ctx.logger?.info?.(`dsh-tree-task-flow: 已启用（状态目录 ${root}）`);
}
