/**
 * 入口装配自测（index.js + prompt.js）。
 *
 * 用假 ctx 直接跑 `apply`，覆盖三件事：
 *
 *   1. 启用后注册的是**六个**工具，记忆三工具与全部 `needs` 字段都清干净了。
 *   2. 资料层已经不存在：`lib/resource.js` 没了，也没有任何模块还引用它、
 *      或残留 `registerResourceCapture` / `injectResources` / `pickResources` 之类的符号；
 *      配置项里也没有资料相关的开关。
 *   3. 提示词**只有一段**——注册的 `text` 是个按作用域解析的函数：工具在作用域里
 *      就输出正文常量，不在就输出空串；正文里不再重复工具清单。
 *
 * 另外核对默认态与关闭态：不给 config 时按"安装即启用"注册全部东西；
 * 显式 `enabled: false` 时一个工具、一段提示词都不注册，只留命令与面板接口。
 *
 * 假 ctx 只实现 `apply` 装配路径真正用到的那几样：`effect` / `systemPrompt.section`
 * / `tools.register` / `on` / `get` / `inject` / `logger`。
 *
 * 跑：node verify-entry.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, apply, inject, name as PLUGIN_NAME } from "./lib/index.js";
import { DEFAULT_ORDER, SECTION_NAME, SECTION_TEXT, registerPromptSection } from "./lib/prompt.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "lib");

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

/** 需求模型下的十个工具。 */
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

/** 已移除的记忆三工具——再出现在任何地方都说明删漏了。 */
const REMOVED_TOOLS = ["tree_task_save", "tree_task_recall", "tree_task_forget"];

/** 假 ctx：只给装配路径真正用到的东西，多给会掩盖真实耦合。 */
function makeHarness() {
  const tools = [];
  const sections = [];
  const handlers = new Map();
  const effects = [];
  const injected = [];
  const logs = [];

  const ctx = {
    effect(register, label) {
      effects.push(label);
      return register();
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
      },
    },
    tools: {
      register(def) {
        tools.push(def);
      },
      get(toolName) {
        return tools.find((tool) => tool.name === toolName);
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    get() {
      return undefined;
    },
    inject(services) {
      injected.push(services);
    },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      debug: (message) => logs.push(message),
    },
  };

  return { ctx, tools, sections, handlers, effects, injected, logs };
}

const stateRoot = () => join(HERE, ".verify-entry-state");

// ---------------------------------------------------------------- 启用态

console.log("启用态：");
const on = makeHarness();
apply(on.ctx, { enabled: true, rootDir: stateRoot() });

const names = on.tools.map((tool) => tool.name).sort();
const toolNames = names.join(", ");

check("插件名是 dsh-tree-task-flow", PLUGIN_NAME === "dsh-tree-task-flow", PLUGIN_NAME);
check(
  "inject 只声明 systemPrompt 与 tools",
  inject.length === 2 && inject.includes("systemPrompt") && inject.includes("tools"),
  JSON.stringify(inject),
);
check("注册了十个工具", names.length === 10, toolNames);
check(
  "十个工具正好是这一组",
  NINE_TOOLS.every((want) => names.includes(want)),
  toolNames,
);
check(
  "记忆三工具一个都没有",
  REMOVED_TOOLS.every((gone) => !names.includes(gone)),
  toolNames,
);
check(
  "没有任何工具 schema 提到 needs",
  on.tools.every((tool) => !JSON.stringify(tool.parameters ?? {}).includes("needs")),
);
check(
  "没有任何工具描述提到 needs 或记忆",
  on.tools.every((tool) => !/needs|记忆/u.test(tool.description ?? "")),
);

const doneTool = on.tools.find((tool) => tool.name === "tree_task_done");
check(
  "tree_task_done 的 result 必填",
  (doneTool?.parameters?.required ?? []).includes("result"),
  JSON.stringify(doneTool?.parameters?.required),
);
check(
  "tree_task_done 的 result 有说明",
  typeof doneTool?.parameters?.properties?.result?.description === "string",
);

// ---------------------------------------------------------------- 提示词

console.log("\n提示词段落：");
check("只注册了一段", on.sections.length === 1, String(on.sections.length));
check("段落名固定", on.sections[0]?.name === SECTION_NAME, String(on.sections[0]?.name));
check("段落排序固定", on.sections[0]?.order === DEFAULT_ORDER, String(on.sections[0]?.order));
check("正文是按作用域解析的函数", typeof on.sections[0]?.text === "function");
check(
  "工具在作用域里时输出正文常量",
  on.sections[0]?.text({ scope: undefined }) === SECTION_TEXT,
);

// 工具不在作用域里，整段就该消失——这正是与内置工具段落一致的地方。
const blindSections = [];
const blindCtx = {
  tools: { get: () => undefined },
  systemPrompt: { section: (section) => blindSections.push(section) },
};
registerPromptSection(blindCtx, DEFAULT_ORDER)();
check(
  "工具不在作用域里时输出空串",
  blindSections[0]?.text({ scope: undefined }) === "",
  JSON.stringify(blindSections[0]?.text({ scope: undefined })),
);

check("文本不含 needs", !SECTION_TEXT.includes("needs"));
check("文本不含“记忆”", !SECTION_TEXT.includes("记忆"));
check(
  "文本不含记忆三工具",
  REMOVED_TOOLS.every((gone) => !SECTION_TEXT.includes(gone)),
  REMOVED_TOOLS.filter((gone) => SECTION_TEXT.includes(gone)).join(", "),
);
check("文本以通配点名这组工具", SECTION_TEXT.includes("tree_task_*"));
check(
  "文本点名不超过六个具体工具（其余交给各自的 description）",
  (SECTION_TEXT.match(/tree_task_[a-z]+/gu) ?? []).length <= 6,
  String((SECTION_TEXT.match(/tree_task_[a-z]+/gu) ?? []).length),
);
check("文本点名了开工第一步的状态工具", SECTION_TEXT.includes("tree_task_status"));
check(
  "文本点名了建草稿与转正的两个入口",
  SECTION_TEXT.includes("tree_task_create") && SECTION_TEXT.includes("tree_task_requirement"),
);
check("文本不再声称检查点会拒绝别的工具", !/一律被拒|只放行/u.test(SECTION_TEXT));
check("文本不再讲资料注入", !/资料注入|注入资料/u.test(SECTION_TEXT));
check(
  "提示词教了分层：需求、任务、步骤",
  SECTION_TEXT.includes("需求") &&
    SECTION_TEXT.includes("任务与步骤") &&
    !SECTION_TEXT.includes("任务执行步骤三级"),
);
check(
  "段落不再重复拆分口径（任务归 plan、步骤归 plan）",
  !SECTION_TEXT.includes("一件能独立验收") && !SECTION_TEXT.includes("交付物"),
);
check("段落不再重复 result 写法（归 done）", !SECTION_TEXT.includes("result"));
check(
  "段落讲了草稿的 update 与 confirm 两步",
  SECTION_TEXT.includes("update") && SECTION_TEXT.includes("confirm"),
);
check(
  "段落要求每完成一个节点调用一次 done",
  SECTION_TEXT.includes("每完成一个步骤") && SECTION_TEXT.includes("tree_task_done"),
);
check(
  "段落不出现内部机制词（折叠、游标、边界、面板行为）",
  ["折叠", "游标", "边界", "白占一个格子", "不叫醒"].every((gone) => !SECTION_TEXT.includes(gone)),
);
check(
  "段落是动作导向的：不解释机制、不定义概念",
  !SECTION_TEXT.includes("它就是"),
);
check(
  "段落与内置段落同风格：无标题、无加粗、无列表",
  !/^#/mu.test(SECTION_TEXT) &&
    !SECTION_TEXT.includes("**") &&
    !/^\s*[-*] /mu.test(SECTION_TEXT),
);
check(
  "分层规则不掺臆造数字（不给步数/轮数的承诺）",
  !/\d+\s*~\s*\d+/u.test(SECTION_TEXT) && !/\d+\s*(steps|rounds)/iu.test(SECTION_TEXT),
);
check(
  "段落不超过 340 字（模型每次请求都要付这份税）",
  [...SECTION_TEXT].length <= 340,
  String([...SECTION_TEXT].length),
);
check(
  "registerPromptSection 返回 disposer（供 effect 持有）",
  typeof registerPromptSection(on.ctx, DEFAULT_ORDER) === "function",
);

// 再装配一次，确认正文不随装配次数变化。
const again = makeHarness();
apply(again.ctx, { enabled: true, rootDir: stateRoot() });
check(
  "两次装配得到相同的正文",
  again.sections[0]?.text({ scope: undefined }) === on.sections[0]?.text({ scope: undefined }) &&
    again.sections.length === 1,
);

// ---------------------------------------------------------------- 监听面

console.log("\n监听面：");
check("不挂 tools/pre-execute（插件不拦任何别的工具）", !on.handlers.has("tools/pre-execute"));
check(
  "pre-step 上正好五个监听（压缩提示 + 折叠 + 续行 + 暂停闸门 + 中断拉起清链）",
  (on.handlers.get("agent/pre-step") ?? []).length === 5,
  String((on.handlers.get("agent/pre-step") ?? []).length),
);
check("挂了停止信号监听", on.handlers.has("agent/turn-stopping"));
check("挂了状态监听", on.handlers.has("agent/status"));
check("挂了会话事件监听（意外中断靠它认 turn/end）", on.handlers.has("session/event"));
check(
  "没有挂 tools/result（资料捕获已随资料层一起删除）",
  !on.handlers.has("tools/result"),
);

// ---------------------------------------------------------------- 资料层

console.log("\n资料层：");
check("lib/resource.js 已删除", !existsSync(join(LIB, "resource.js")));

const libFiles = readdirSync(LIB).filter((file) => file.endsWith(".js"));
const sources = Object.fromEntries(
  libFiles.map((file) => [file, readFileSync(join(LIB, file), "utf8")]),
);

check(
  "没有模块引用 resource.js",
  libFiles.every((file) => !/["'][^"']*resource\.js["']/u.test(sources[file])),
  libFiles.filter((file) => /["'][^"']*resource\.js["']/u.test(sources[file])).join(", "),
);
check(
  "资料层符号已清干净",
  libFiles.every(
    (file) =>
      !/registerResourceCapture|injectResources|pickResources|normalizePathKey|resourceTotalBytes/u.test(
        sources[file],
      ),
  ),
  libFiles
    .filter((file) =>
      /registerResourceCapture|injectResources|pickResources|normalizePathKey|resourceTotalBytes/u.test(
        sources[file],
      ),
    )
    .join(", "),
);
check(
  "lib 里没有文件名带 resource",
  libFiles.every((file) => !/resource/iu.test(file)),
  libFiles.filter((file) => /resource/iu.test(file)).join(", "),
);
check(
  "配置项里没有资料相关开关",
  !Object.keys(DEFAULT_CONFIG).some((key) =>
    /resource|injectResources|reloadOnCompaction|cutOnStepDone/iu.test(key),
  ),
  Object.keys(DEFAULT_CONFIG).join(", "),
);
check(
  "config 示例文件里也没有资料开关",
  !/resource|injectResources|reloadOnCompaction|cutOnStepDone/iu.test(
    readFileSync(join(HERE, "config.example.yml"), "utf8"),
  ),
);
check(
  "bundles 的 patch 不写 config（安装即启用走的是 DEFAULT_CONFIG）",
  !/^\s*config:/mu.test(readFileSync(join(HERE, "cordis.patch.yml"), "utf8")),
);

// ---------------------------------------------------------------- 默认态

console.log("\n默认态（安装即启用，不给 config）：");
check("enabled 默认是 true", DEFAULT_CONFIG.enabled === true, String(DEFAULT_CONFIG.enabled));
check(
  "autoContinue 默认是 false（有设置界面了，默认值按「会不会打扰人」定）",
  DEFAULT_CONFIG.autoContinue === false,
  String(DEFAULT_CONFIG.autoContinue),
);
check(
  "interruptRecovery 默认是 true",
  DEFAULT_CONFIG.interruptRecovery === true,
  String(DEFAULT_CONFIG.interruptRecovery),
);
// 旧规矩是"没有配置界面，功能就不能默认关"，所以那时要求一个默认关的布尔开关都没有。
// 现在有界面了，规矩换成：**默认关的只允许那种"会主动往会话里推消息"的开关**——
// 别的功能默认关就等于不存在，而这一种默认开才叫打扰人。
check(
  "默认关的布尔开关只允许 autoContinue（它会主动往会话里推消息）",
  Object.entries(DEFAULT_CONFIG)
    .filter(([, value]) => value === false)
    .every(([key]) => key === "autoContinue"),
  JSON.stringify(DEFAULT_CONFIG),
);

// 用户装完不做任何配置，走的就是这条路。它必须和显式 enabled:true 等价，
// 否则"安装即启用"就只是 README 里的一句话。
const bare = makeHarness();
apply(bare.ctx);
check(
  "不给 config 也注册十个工具",
  bare.tools.map((tool) => tool.name).sort().join(", ") === NINE_TOOLS.slice().sort().join(", "),
  bare.tools.map((tool) => tool.name).join(", "),
);
check("不给 config 也加一段提示词", bare.sections.length === 1, String(bare.sections.length));
check(
  "不给 config 也挂 pre-step（压缩提示 + 折叠 + 续行 + 暂停闸门 + 中断拉起清链）",
  (bare.handlers.get("agent/pre-step") ?? []).length === 5,
  String((bare.handlers.get("agent/pre-step") ?? []).length),
);
check("不给 config 也挂了停止信号监听", bare.handlers.has("agent/turn-stopping"));
check(
  "不给 config 也会打印启用日志",
  bare.logs.some((line) => line.includes("已启用")),
  bare.logs.join(" | "),
);
check("rootDir 默认是 null（落到 $DSH_HOME）", DEFAULT_CONFIG.rootDir === null);

// ---------------------------------------------------------------- 关闭态

console.log("\n关闭态（显式 enabled: false）：");
const off = makeHarness();
apply(off.ctx, { enabled: false, rootDir: stateRoot() });

check("一个工具都不注册", off.tools.length === 0, String(off.tools.length));
check("一段提示词都不注册", off.sections.length === 0, String(off.sections.length));
check("不挂 pre-step", !off.handlers.has("agent/pre-step"));
check("关闭态同样不拦任何工具", !off.handlers.has("tools/pre-execute"));
check("面板接口照挂", off.injected.length > 0, JSON.stringify(off.injected));
check(
  "日志说明是被配置关掉的",
  off.logs.some((line) => line.includes("已按配置关闭")),
  off.logs.join(" | "),
);

// ---------------------------------------------------------------- 汇总

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
}
