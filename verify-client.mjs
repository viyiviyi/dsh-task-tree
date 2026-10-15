/**
 * 客户端条目自测（client.js）。
 *
 * client.js 是浏览器脚本：顶层是 `window.__ModuleLoader__.load(...)`，模块体用
 * `h()` 而不是 JSX。这里用一套**最小运行时**把它物化出来——假 window、假
 * document、假 react、假 primitives——然后真调一次 apply、真渲染一次条目。
 *
 * 验证的是**装配与接线**，不是视觉效果：
 *
 *   1. 模块身份与依赖：注册 id、`inject`、只 require 内置基座里那两样。
 *   2. 挂载点：注册在 `conversation.input.dock`，用自己的 id 与 order 50，
 *      不顶掉内置的 todo(0) / goal(10) / queue(20)。
 *   3. 样式注入：一个带 `data-plugin-css` 的 <style>（客户端 HMR 靠它卸载），
 *      正文含条目外壳、单行条、图标按钮、展开体这些关键类。
 *   4. 文案：zh / en 键集一致，渲染过程中没有取到不存在的键。
 *   5. 渲染：折叠态是单行条（状态标签 + 目标标题 + 进度 + 暂停/继续、
 *      清空、设置、展开四个图标按钮，没有展开体）；展开态出展开体，且只摊开正在走的
 *      那条路径；暂停态状态标签变「已暂停」、按钮变「继续」、并给出暂停说明。
 *   6. 设置：摊开后是两个开关，`role="switch"` + `aria-checked` 跟着接口给的
 *      开关状态走，文案里的键都在。
 *
 * 假 react 不实现真实的 hook 语义：`TaskTreeDock` 的四个 `useState` 初值由
 * 用例直接注入（`dockPreset`），`useEffect` 不执行——所以渲染不碰 fetch。
 *
 * 跑：node verify-client.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "client.js"), "utf8");

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

// ---------------------------------------------------------------- 最小运行时

let captured = null;
const styleTags = [];

globalThis.window = {
  location: { origin: "http://localhost" },
  confirm: () => true,
  __ModuleLoader__: {
    load(registration) {
      captured = registration;
    },
  },
};

globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: {
    appendChild: (tag) => {
      styleTags.push(tag);
    },
  },
};

const noop = () => {};
let currentInstance = null;
/** TaskTreeDock 的三个 useState（state / open / busy）加一个 note；null 表示按真实初值走。 */
let dockPreset = null;
/** TaskTreeSettings 的三个 useState（state / busy / note）初值。假 react 不跑 useEffect，
 *  所以"取回设置之后"的样子只能这样喂进去。 */
let settingsPreset = null;

function makeElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type, props: merged };
}

const miniReact = {
  createElement: makeElement,
  useState(initial) {
    const instance = currentInstance;
    const index = instance.hookIndex++;
    if (instance.preset !== null && index < instance.preset.length) {
      return [instance.preset[index], noop];
    }
    if (!(index in instance.values)) {
      instance.values[index] = typeof initial === "function" ? initial() : initial;
    }
    return [instance.values[index], noop];
  },
  useEffect() {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};

/** 渲染成元素树：宿主元素是 `{ type, props, children }`，文本是 `{ type: "#text", text }`。 */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") {
    return { type: "#text", props: {}, text: String(node), children: [] };
  }
  if (Array.isArray(node)) {
    return { type: "#fragment", props: {}, children: node.map(render).filter(Boolean) };
  }

  const { type, props } = node;
  if (typeof type === "function") {
    const previous = currentInstance;
    currentInstance = {
      hookIndex: 0,
      values: [],
      preset:
        type.name === "TaskTreeDock"
          ? dockPreset
          : type.name === "TaskTreeSettings"
            ? settingsPreset
            : null,
    };
    let output;
    try {
      output = type(props || {});
    } finally {
      currentInstance = previous;
    }
    return render(output);
  }

  const raw = props === undefined ? undefined : props.children;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return { type, props: props || {}, children: list.map(render).filter(Boolean) };
}

function walk(node, visit) {
  if (node === null) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(root, predicate) {
  const hits = [];
  walk(root, (node) => {
    if (predicate(node)) hits.push(node);
  });
  return hits;
}

function classOf(node) {
  const value = node.props === undefined ? undefined : node.props.className;
  return typeof value === "string" ? value.split(/\s+/u) : [];
}

const hasClass = (root, want) => findAll(root, (node) => classOf(node).includes(want)).length > 0;
const byAria = (root, label) =>
  findAll(root, (node) => node.props !== undefined && node.props["aria-label"] === label);
const hasText = (root, want) =>
  findAll(root, (node) => node.type === "#text" && node.text.includes(want)).length > 0;
const hasIcon = (root, want) =>
  findAll(root, (node) => node.props !== undefined && node.props["data-icon"] === want).length > 0;

// ---------------------------------------------------------------- 物化模块

console.log("模块装配：");

await import(pathToFileURL(join(HERE, "client.js")).href);

check("以 dsh-tree-task-flow 注册", captured !== null && captured.id === "dsh-tree-task-flow", String(captured && captured.id));

/**
 * 升级后的外壳：图标名后缀是笔画粗细（`IconCheckOutlineRegular`），尺寸走
 * `size` 属性。每个假图标把自己被取到时的名字记在 `data-icon` 上，好断言
 * 「真的取到了图标」而不是退了文字。
 */
const ICON_BASES = [
  "IconChecklistOutline",
  "IconChevronDownOutline",
  "IconChevronRightOutline",
  "IconChevronUpOutline",
  "IconCheckOutline",
  "IconCloseOutline",
  "IconPauseOutline",
  "IconPlayOutline",
  "IconSettingsOutline",
  "IconTrashOutline",
];

const primitives = {};
for (const base of ICON_BASES) {
  for (const suffix of ["Regular", "Medium"]) {
    primitives[base + suffix] = () => makeElement("i", { "data-icon": base + suffix });
  }
}
primitives.Tooltip = (props) => props.children;

/** 旧外壳：同一个图标，名字里带的是尺寸（`IconCheckOutline16` 这种）。 */
const legacyPrimitives = {};
for (const base of ICON_BASES) {
  for (const suffix of ["14", "16"]) {
    legacyPrimitives[base + suffix] = () => makeElement("i", { "data-icon": base + suffix });
  }
}
legacyPrimitives.Tooltip = (props) => props.children;

let currentPrimitives = primitives;

const requested = [];
function fakeRequire(spec) {
  requested.push(spec);
  if (spec === "react") return miniReact;
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") return currentPrimitives;
  throw new Error("client.js 请求了没准备的模块：" + spec);
}

const plugin = captured.factory(fakeRequire);

const REQUIRED = ["@deepseek-ai/dsh-client-ui-primitives", "react"];
check(
  "只 require 内置基座里的 react 与自己要用的 primitives",
  [...new Set(requested)].sort().join(", ") === REQUIRED.join(", "),
  [...new Set(requested)].sort().join(", "),
);
check("插件名是 dsh-tree-task-flow", plugin.name === "dsh-tree-task-flow", String(plugin.name));
check(
  "注入 slots 与 locale",
  Array.isArray(plugin.inject) &&
    plugin.inject.length === 2 &&
    plugin.inject.includes("slots") &&
    plugin.inject.includes("locale"),
  JSON.stringify(plugin.inject),
);

// ---------------------------------------------------------------- apply

const dictionaries = new Map();
const missingKeys = [];
let slotRegistration = null;
/** 每个槽各自的注册（槽名 → `{ options, component }`）：现在挂了两个槽，不能只留最后一个。 */
const slotRegistrations = new Map();
const injectedSlots = [];

const ctx = {
  effect(register) {
    register();
    return noop;
  },
  locale: {
    register(ns, dicts) {
      dictionaries.set(ns, dicts);
    },
    bind(ns) {
      return (key, params) => {
        const dict = dictionaries.get(ns);
        const table = dict === undefined ? undefined : dict.zh;
        let text = table === undefined ? undefined : table[key];
        if (typeof text !== "string") {
          missingKeys.push(key);
          return key;
        }
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split("{" + name + "}").join(String(value));
          }
        }
        return text;
      };
    },
  },
  slots: {
    inject(name, callback) {
      injectedSlots.push(name);
      callback();
    },
    register(options, component) {
      slotRegistration = { options, component };
      slotRegistrations.set(options.name, { options, component });
      return noop;
    },
  },
};

plugin.apply(ctx);

console.log("\n挂载点与样式：");

/**
 * 按槽名**现取**注册。每次 remount 都会重新 import 一份模块、注册一批新组件，
 * 所以不能在这里存快照——存下来就永远指向第一次那份旧模块里的组件了。
 */
function dockEntry() {
  return slotRegistrations.get("conversation.input.dock") ?? null;
}
function sectionEntry() {
  return slotRegistrations.get("settings.section") ?? null;
}

check(
  "挂了两个槽：输入框上方的条目 + 设置面板里的一页",
  injectedSlots.length === 2 &&
    injectedSlots.includes("conversation.input.dock") &&
    injectedSlots.includes("settings.section"),
  injectedSlots.join(", "),
);
check(
  "条目用自己的 id 注册（不顶掉内置条目）",
  dockEntry() !== null && dockEntry().options.id === "dsh-tree-task-flow",
  String(dockEntry() && dockEntry().options.id),
);
check(
  "条目排序 50，排在内置 todo(0) / goal(10) / queue(20) 之后",
  dockEntry() !== null && dockEntry().options.order === 50,
  String(dockEntry() && dockEntry().options.order),
);
check("条目注册的是个组件", dockEntry() !== null && typeof dockEntry().component === "function");

console.log("\n设置面板里的一页：");

check("注册进了 settings.section（不再挂在任务条上）", sectionEntry() !== null);
check(
  "用的也是插件自己的 id",
  sectionEntry() !== null && sectionEntry().options.id === "dsh-tree-task-flow",
  String(sectionEntry() && sectionEntry().options.id),
);
check(
  "排序 60（排在任务条之后，不与内置页抢位）",
  sectionEntry() !== null && sectionEntry().options.order === 60,
  String(sectionEntry() && sectionEntry().options.order),
);
check(
  "导航里的名字由 label thunk 现取（换语言跟着换）",
  sectionEntry() !== null &&
    typeof sectionEntry().options.label === "function" &&
    sectionEntry().options.label() === "树形任务流",
  sectionEntry() === null ? "" : String(sectionEntry().options.label),
);
check(
  "设置页注册的是个组件",
  sectionEntry() !== null && typeof sectionEntry().component === "function",
);

check("注入了一个样式标签", styleTags.length === 1, String(styleTags.length));
const styleTag = styleTags[0];
check(
  "样式标签带 data-plugin-css（HMR 靠它卸载）",
  styleTag !== undefined && typeof styleTag.dataset.pluginCss === "string" && styleTag.dataset.pluginCss.length > 0,
  JSON.stringify(styleTag && styleTag.dataset),
);
const CSS = styleTag === undefined ? "" : styleTag.textContent;
for (const cls of [
  ".dsh-ttf-dock",
  ".dsh-ttf-panel",
  ".dsh-ttf-bar",
  ".dsh-ttf-iconBtn",
  ".dsh-ttf-iconBtnText",
  ".dsh-ttf-label",
  ".dsh-ttf-progress",
  ".dsh-ttf-body",
  ".dsh-ttf-row",
  ".dsh-ttf-tagWarn",
  ".dsh-ttf-settingsPage",
  ".dsh-ttf-switch",
]) {
  check(`样式里有 ${cls}`, CSS.includes(cls));
}
check(
  "条目宽度沿用内置的算法（不会与消息正文错位）",
  CSS.includes("--dsh-composer-side-clearance") &&
    CSS.includes("--dsh-composer-dock-inset") &&
    CSS.includes("--dsh-composer-card-max-width"),
);
check(
  "样式用内置的颜色变量，不是写死色值",
  CSS.includes("var(--dsw-specific-tip)") && CSS.includes("var(--dsw-alias-border-l1)"),
);

console.log("\n文案：");

const zhDict = dictionaries.get("dsh-tree-task-flow") === undefined ? {} : dictionaries.get("dsh-tree-task-flow").zh;
const enDict = dictionaries.get("dsh-tree-task-flow") === undefined ? {} : dictionaries.get("dsh-tree-task-flow").en;
const zhKeys = Object.keys(zhDict).sort();
const enKeys = Object.keys(enDict).sort();

check("注册了 zh 与 en", Object.keys(zhDict).length > 0 && Object.keys(enDict).length > 0);
check("zh 与 en 键集一致", zhKeys.join(",") === enKeys.join(","), zhKeys.filter((key) => !enKeys.includes(key)).join(", "));
for (const key of [
  "state.running",
  "state.paused",
  "action.pause",
  "action.resume",
  "action.reset",
  "action.expand",
  "action.collapse",
  "note.paused",
]) {
  check(`有 ${key}`, typeof zhDict[key] === "string" && zhDict[key].length > 0);
}

// ---------------------------------------------------------------- 渲染

const DATA = {
  ok: true,
  plan: {
    sessionId: "s1",
    goals: [
      {
        id: "g1",
        title: "示例目标",
        detail: "目标的补充说明",
      status: "pending",
      tasks: [
        {
          id: "t1",
          title: "任务一",
          status: "pending",
          steps: [
            {
              id: "x1",
              title: "子任务一",
              status: "done",
              result: {
                id: "x1",
                title: "子任务一",
                text: "子任务一产出的东西\n第二行：补充细节\n第三行：还有一点",
                at: 1700000000000,
              },
            },
          ],
        },
      ],
    }],
  },
  // 渲染单测：把当前项指到最深一层，好一次看见整条活动路径。
  active: { goalId: "g1", taskId: "t1", stepId: "x1" },
  checkpoint: null,
  stopped: false,
  paused: false,
};

function renderDock(data, open) {
  dockPreset = [{ loading: false, data }, open, false, null];
  try {
    return render(makeElement(dockEntry().component, { sessionId: "s1" }));
  } finally {
    dockPreset = null;
  }
}

/** 渲染设置页。`data` 是 `/settings` 返回的那一份；null 表示读不到。 */
function renderSettings(data, busy = false) {
  settingsPreset = [{ loading: false, data }, busy, ""];
  try {
    return render(makeElement(sectionEntry().component, {}));
  } finally {
    settingsPreset = null;
  }
}

console.log("\n折叠态（单行条）：");
const collapsed = renderDock(DATA, false);

check("渲染出条目外壳", hasClass(collapsed, "dsh-ttf-dock"));
check("渲染出卡片", hasClass(collapsed, "dsh-ttf-panel"));
check("渲染出单行条", hasClass(collapsed, "dsh-ttf-bar"));
check("左侧是清单图标", hasIcon(collapsed, "IconChecklistOutlineRegular"));
check("状态标签是「进行中」", hasText(collapsed, "进行中"));
check("显示目标标题", hasText(collapsed, "示例目标"));
check("显示进度与当前节点", hasText(collapsed, "1/3") && hasText(collapsed, "任务一"));
check("没有展开体", !hasClass(collapsed, "dsh-ttf-body"));
check("运行中有「暂停」按钮", byAria(collapsed, "暂停").length === 1, String(byAria(collapsed, "暂停").length));
check("运行中没有「继续」按钮", byAria(collapsed, "继续").length === 0);
check("有「清空计划」按钮", byAria(collapsed, "清空计划").length === 1);
check(
  "任务条上没有「设置」按钮（设置挪到 DSH 设置面板里了）",
  byAria(collapsed, "设置").length === 0,
);
check("有「展开」按钮", byAria(collapsed, "展开").length === 1);
check(
  "按钮是图标按钮（走内置样式）",
  findAll(collapsed, (node) => classOf(node).includes("dsh-ttf-iconBtn")).length === 3,
  String(findAll(collapsed, (node) => classOf(node).includes("dsh-ttf-iconBtn")).length),
);
check("暂停按钮用的是内置图标", hasIcon(collapsed, "IconPauseOutlineRegular"));
check(
  "图标取得到时按钮里没有退化的文字",
  findAll(collapsed, (node) => classOf(node).includes("dsh-ttf-iconText")).length === 0,
);

console.log("\n展开态（卡片）：");
const expanded = renderDock(DATA, true);

check("出现展开体", hasClass(expanded, "dsh-ttf-body"));
check("有「收起」按钮", byAria(expanded, "收起").length >= 1, String(byAria(expanded, "收起").length));
check("展开后不再有「展开」按钮（该收的都摊开了）", byAria(expanded, "展开").length === 0, String(byAria(expanded, "展开").length));
check("画出目标", hasText(expanded, "示例目标"));
check("画出任务", hasText(expanded, "任务一"));
check("画出子任务", hasText(expanded, "子任务一"));
check("三层缩进都在", hasClass(expanded, "dsh-ttf-depth0") && hasClass(expanded, "dsh-ttf-depth1") && hasClass(expanded, "dsh-ttf-depth2"));
check("当前节点带「当前」标签", hasText(expanded, "当前"));
check("提交过的结果可见", hasText(expanded, "子任务一产出的东西"));
const resultBlocks = findAll(expanded, (node) => classOf(node).includes("dsh-ttf-result"));
check("结果有专门的呈现块", resultBlocks.length >= 1, String(resultBlocks.length));
check(
  "结果默认收起，只占一行",
  resultBlocks.every((node) => !classOf(node).includes("dsh-ttf-resultOpen")),
);
check(
  "放不下的结果标成可点开",
  resultBlocks.some((node) => classOf(node).includes("dsh-ttf-resultClick")),
);

console.log("\n正在运行的标记：");
const running = findAll(expanded, (node) => classOf(node).includes("dsh-ttf-markSpin"));
check("活动路径上的节点画出转圈标记", running.length === 2, String(running.length));
check(
  "转的还是原来那个虚线圆（外观没变，只是加转动）",
  running.every(
    (node) =>
      findAll(node, (child) => child.type === "circle").length === 1 &&
      findAll(node, (child) => child.type === "circle")[0].props.strokeDasharray === "2.4 2.4",
  ),
);
check(
  "转圈标记外面还是原来的标记格（颜色和尺寸都没动）",
  findAll(expanded, (node) => classOf(node).includes("dsh-ttf-markCell")).length === 2,
  String(findAll(expanded, (node) => classOf(node).includes("dsh-ttf-markCell")).length),
);

const idle = renderDock(Object.assign({}, DATA, { active: null }), true);
check(
  "没有活动节点时一个都不转",
  findAll(idle, (node) => classOf(node).includes("dsh-ttf-markSpin")).length === 0,
);
check(
  "没有活动节点时整棵树默认收起（只留目标那一行）",
  !hasText(idle, "任务一") && !hasText(idle, "子任务一"),
);
check(
  "收起的节点仍是待办圈",
  findAll(idle, (node) => classOf(node).includes("dsh-ttf-markCell")).length === 1,
  String(findAll(idle, (node) => classOf(node).includes("dsh-ttf-markCell")).length),
);

console.log("\n默认只摊开正在走的那条路径：");
const TWO = {
  ok: true,
  plan: {
    sessionId: "s1",
    goals: [
      {
        id: "g1",
        title: "示例目标",
        status: "pending",
        tasks: [
          { id: "t1", title: "任务一", status: "done", steps: [{ id: "x1", title: "子任务一", status: "done" }] },
          { id: "t2", title: "任务二", status: "pending", steps: [{ id: "x2", title: "子任务二", status: "pending" }] },
        ],
      },
    ],
  },
  active: { goalId: "g1", taskId: "t2", stepId: "x2" },
  checkpoint: null,
  stopped: false,
  paused: false,
};
const two = renderDock(TWO, true);
check("目标展开，两条任务都看得见", hasText(two, "任务一") && hasText(two, "任务二"));
check("当前任务展开，看得见正在跑的子任务", hasText(two, "子任务二"));
check("已经收尾的任务默认收起，不画它的子节点", !hasText(two, "子任务一"));

console.log("\n多个目标：");
const MULTI = {
  ok: true,
  plan: {
    sessionId: "s1",
    goals: [
      TWO.plan.goals[0],
      {
        id: "g2",
        title: "第二个目标",
        status: "pending",
        tasks: [
          {
            id: "t3",
            title: "任务三",
            status: "pending",
            steps: [{ id: "x3", title: "子任务三", status: "pending" }],
          },
        ],
      },
    ],
  },
  active: { goalId: "g2", taskId: "t3", stepId: "x3" },
  checkpoint: null,
  stopped: false,
  paused: false,
};
const multi = renderDock(MULTI, true);
check("多个目标时，条上写的是目标个数", hasText(multi, "2 个目标"));
check("两个目标都渲染出来", hasText(multi, "示例目标") && hasText(multi, "第二个目标"));
check("正在走的那个目标默认摊开", hasText(multi, "子任务三"));
check("已经收尾的那个目标默认收起", !hasText(multi, "子任务一"));

const checkpointed = renderDock(
  Object.assign({}, TWO, {
    active: null,
    checkpoint: { id: "t1", level: "task", label: "任务", title: "任务一" },
  }),
  true,
);
check(
  "检查点所在的任务默认展开（不用人自己去翻）",
  hasText(checkpointed, "子任务一") && !hasText(checkpointed, "子任务二"),
);

console.log("\n外观约定（树形、分界、标题、结果）：");
check("同一层的节点之间有分界线", SOURCE.includes(".dsh-ttf-node+.dsh-ttf-node{"));
check("详情里的内容块之间有分界线", SOURCE.includes(".dsh-ttf-detail>*+*{"));
check(
  "三层节点各自带层级类（树形连线靠它画）",
  hasClass(expanded, "dsh-ttf-node") &&
    hasClass(expanded, "dsh-ttf-depth1") &&
    hasClass(expanded, "dsh-ttf-depth2"),
);
check(
  "节点标题不缩略，多了换行",
  SOURCE.includes('".dsh-ttf-rowTitle{min-width:0;flex:1;white-space:pre-wrap;word-break:break-word}"') &&
    !/\.dsh-ttf-rowTitle\{[^}]*text-overflow/u.test(SOURCE),
);
check("结果默认只占一行（行数钳到 1）", SOURCE.includes("-webkit-line-clamp:1"));
check(
  "转圈靠 CSS 关键帧（1s 匀速、无限，与内置待办面板同款）",
  SOURCE.includes("@keyframes dsh-ttf-spin{to{transform:rotate(360deg)}}") &&
    SOURCE.includes("animation:dsh-ttf-spin 1s linear infinite"),
);
check("点开后取消钳制，看全文", SOURCE.includes(".dsh-ttf-resultOpen{display:block"));
check(
  "旧写法已经清干净（pre 呈现、三层 padding 缩进）",
  !SOURCE.includes("dsh-ttf-pre") && !SOURCE.includes("dsh-ttf-depth0{padding-left"),
);
const dropButtons = byAria(expanded, "丢弃");
// 这份数据里「子任务一」已经完成（完成态不给丢弃按钮），还开着的只剩目标与任务一。
check(
  "还开着的节点都能丢——目标也算一个",
  dropButtons.length === 2,
  String(dropButtons.length),
);
const deleteButtons = byAria(expanded, "删除");
check(
  "删除给到每一个节点——已完成的那个也有",
  deleteButtons.length === 3,
  String(deleteButtons.length),
);
check("删除用的是垃圾桶图标", hasIcon(expanded, "IconTrashOutlineRegular"));
check("丢弃改用划掉图标（垃圾桶让给删除）", hasIcon(expanded, "IconCloseOutlineRegular"));

console.log("\n进度不把丢弃的算进去：");
const DROPPED = {
  ok: true,
  plan: {
    sessionId: "s1",
    goals: [
      {
        id: "g1",
        title: "示例目标",
        status: "pending",
        tasks: [
          {
            id: "t1",
            title: "任务一",
            status: "done",
            steps: [{ id: "x1", title: "子任务一", status: "done" }],
          },
          {
            id: "t2",
            title: "任务二",
            status: "dropped",
            steps: [{ id: "x2", title: "子任务二", status: "dropped" }],
          },
          { id: "t3", title: "任务三", status: "pending", steps: [] },
        ],
      },
    ],
  },
  active: { goalId: "g1", taskId: "t3", stepId: null },
  checkpoint: null,
  stopped: false,
  paused: false,
};

const droppedBar = renderDock(DROPPED, false);
check(
  "丢弃的任务与子任务，分子分母都不算",
  hasText(droppedBar, "2/4"),
  "找的是 2/4（目标 + 任务一 + 子任务一 + 任务三，共 4 项；做完的是任务一与子任务一）",
);
check("旧口径的 2/6 不再出现", !hasText(droppedBar, "2/6"));

const ALL_DROPPED = {
  ok: true,
  plan: {
    sessionId: "s1",
    goals: [
      {
        id: "g1",
        title: "弃掉的目标",
        status: "dropped",
        tasks: [
          {
            id: "t1",
            title: "任务一",
            status: "dropped",
            steps: [{ id: "x1", title: "子任务一", status: "dropped" }],
          },
        ],
      },
    ],
  },
  active: null,
  checkpoint: null,
  stopped: false,
  paused: false,
};

const allDroppedBar = renderDock(ALL_DROPPED, false);
check("整棵树都丢弃时不报分数（0/0 比不显示更费解）", !hasClass(allDroppedBar, "dsh-ttf-progress"));

console.log("\n暂停态：");
const paused = renderDock(Object.assign({}, DATA, { paused: true }), true);

check("状态标签变「已暂停」", hasText(paused, "已暂停"));
check("出现「继续」按钮", byAria(paused, "继续").length === 1, String(byAria(paused, "继续").length));
check("不再有「暂停」按钮", byAria(paused, "暂停").length === 0);
check("继续按钮用的是内置播放图标", hasIcon(paused, "IconPlayOutlineRegular"));
check("给出暂停说明", hasText(paused, "点「继续」从原处接着跑"));

console.log("\n停止态与空态：");
const stopped = renderDock(Object.assign({}, DATA, { stopped: true }), false);
check("人按过停止时也显示「已暂停」并给「继续」", hasText(stopped, "已暂停") && byAria(stopped, "继续").length === 1);

console.log("\n设置面板里的那一页（settings.section）：");

const settingsPage = renderSettings({ ok: true, enabled: true, settings: { autoContinue: false, interruptRecovery: true } });

check("渲染成设置页", hasClass(settingsPage, "dsh-ttf-settingsPage"));
check("说明写清改完立刻生效、重启还在", hasText(settingsPage, "改完立刻生效"));
const switches = findAll(settingsPage, (node) => node.props && node.props.role === "switch");
check("正好两个开关", switches.length === 2, String(switches.length));
check(
  "两个开关的名字都在",
  hasText(settingsPage, "任务没做完") && hasText(settingsPage, "工具出错或网络断了"),
);
check(
  "aria-checked 跟着接口给的开关状态走",
  switches.map((node) => node.props["aria-checked"]).join(",") === "false,true",
  switches.map((node) => node.props["aria-checked"]).join(","),
);
check(
  "开着的那个带 switchOn 类，关着的不带",
  switches.filter((node) => classOf(node).includes("dsh-ttf-switchOn")).length === 1 &&
    classOf(switches[1]).includes("dsh-ttf-switchOn"),
);
check(
  "每个开关都能点（按钮不是 disabled）",
  switches.every((node) => node.props.disabled !== true),
);

const busyPage = renderSettings({ ok: true, enabled: true, settings: { autoContinue: true, interruptRecovery: true } }, true);
check(
  "正在写的时候两个开关都按下去不动",
  findAll(busyPage, (node) => node.props && node.props.role === "switch").every(
    (node) => node.props.disabled === true,
  ),
);

const offPage = renderSettings({ ok: true, enabled: false, settings: { autoContinue: false, interruptRecovery: true } });
check("插件被关掉时页面上说清这两个开关不起作用", hasText(offPage, "enabled: false"));

settingsPreset = [{ loading: true, data: null }, false, ""];
const loadingPage = render(makeElement(sectionEntry().component, {}));
settingsPreset = null;
check("还没读到时说「正在读设置」而不是画一排假开关", hasText(loadingPage, "正在读设置"));

check("读不到设置时说读不到", hasText(renderSettings(null), "读不到设置"));

dockPreset = [{ loading: false, empty: true }, false, false, null];
const empty = render(makeElement(dockEntry().component, { sessionId: "s1" }));
dockPreset = null;
check("没有计划时什么都不渲染", empty === null);

check("渲染过程没有取到不存在的文案键", missingKeys.length === 0, missingKeys.join(", "));

console.log("\n客户端源码约定：");
check("仍以手写模块格式加载", SOURCE.includes("window.__ModuleLoader__.load("));
check("没有走 JSX（不出现 React.createElement 之外的编译产物）", !SOURCE.includes("react/jsx-runtime"));
check("不再用「停止自动续行」这套旧文案", !SOURCE.includes("btn.stop") && !SOURCE.includes("state.stopped"));

// ------------------------------------------------- 换一套外壳再物化一遍

/**
 * 图标名在外壳升级时改过一次（尺寸后缀 → 笔画后缀）。上面测的是新版外壳，
 * 这里换回旧版外壳与「一个图标都没有」的外壳各物化一遍，确认这两条路都走得通。
 * client.js 是模块脚本，按 URL 缓存，所以换场景时给 URL 挂一个不同的 query。
 */
const CLIENT_URL = pathToFileURL(join(HERE, "client.js")).href;

async function remount(shell, tag) {
  styleTags.length = 0;
  captured = null;
  currentPrimitives = shell;
  await import(CLIENT_URL + "?" + tag);
  const plugin = captured.factory(fakeRequire);
  plugin.apply(ctx);
  return plugin;
}

console.log("\n旧外壳（图标名里带尺寸）：");
await remount(legacyPrimitives, "legacy-shell");

const legacyCollapsed = renderDock(DATA, false);
check("条首仍取得到清单图标", hasIcon(legacyCollapsed, "IconChecklistOutline14"));
check("动作按钮仍取得到图标", hasIcon(legacyCollapsed, "IconPauseOutline16"));
check(
  "按钮里没有退化的文字",
  findAll(legacyCollapsed, (node) => classOf(node).includes("dsh-ttf-iconText")).length === 0,
);

console.log("\n外壳一个图标都没有（退回文字）：");
await remount({ Tooltip: (props) => props.children }, "no-icons");

const plainDock = renderDock(DATA, false);
const textButtons = findAll(plainDock, (node) => classOf(node).includes("dsh-ttf-iconBtnText"));
check("三个动作按钮都退回文字", textButtons.length === 3, String(textButtons.length));
check(
  "文字按钮按文字宽度撑开（不再是固定 28px 宽）",
  SOURCE.includes(".dsh-ttf-iconBtnText{width:auto;min-width:28px;max-width:112px;"),
);
check(
  "文字超长用省略号收住，压不到相邻按钮",
  SOURCE.includes(".dsh-ttf-iconText{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;"),
);
check("条首换成同类字符，不留空白", hasClass(plainDock, "dsh-ttf-glyphFallback"));
check(
  "退回文字后每个按钮仍认得出是哪个动作",
  byAria(plainDock, "暂停").length === 1 && byAria(plainDock, "清空计划").length === 1 && byAria(plainDock, "展开").length === 1,
);
check("换外壳渲染也没有取到不存在的文案键", missingKeys.length === 0, missingKeys.join(", "));

// ---------------------------------------------------------------- 汇总

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
}
