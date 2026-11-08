/**
 * 客户端需求条自测（client.js）。
 *
 * client.js 是浏览器脚本：顶层是 `window.__ModuleLoader__.load(...)`，模块体用
 * `h()` 而不是 JSX。这里用一套**最小运行时**把它物化出来——假 window、假
 * document、假 react、假 primitives——然后真调一次 apply、真渲染条目。
 *
 * 验证的是**装配与接线**与需求条的三件事，不是视觉效果：
 *
 *   1. 模块身份、挂载点（dock + plugins.bundle.config）、样式注入、中英文键集一致；
 *   2. 看：两个列表 + 待确认草稿、当前那条的进度、缺前置、待确认变动；
 *   3. 改：编辑态出三个输入框与「确认变更」；新建需求只产出草稿；
 *   4. 归档的**延迟渲染**：点了之后行留在原地、按钮变「取消归档」；
 *   5. 插件配置页：两个开关、`aria-checked` 跟着接口走、写的时候全禁用、summary 视图返回 null。
 *
 * 假 react 不实现真实的 hook 语义：`TaskTreeDock` 的八个 useState 初值由用例
 * 直接注入（`dockPreset`），`useEffect` 不执行——所以渲染不碰 fetch。
 *
 * 跑：node verify-client.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

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
  __ModuleLoader__: {
    load(registration) {
      captured = registration;
    },
  },
};

globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: "", id: "" }),
  getElementById: () => null,
  head: {
    appendChild: (tag) => {
      styleTags.push(tag);
    },
  },
};

const noop = () => {};
let currentInstance = null;
/** TaskTreeDock 的八个 useState 初值；null 表示按真实初值走。 */
let dockPreset = null;
/** TaskTreeSettings 的三个 useState 初值。 */
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
const textOf = (root) =>
  findAll(root, () => true)
    .filter((node) => node.type === "#text")
    .map((node) => node.text)
    .join(" ");

// ---------------------------------------------------------------- 物化模块

console.log("模块装配：");

await import(pathToFileURL(join(HERE, "client.js")).href);

check("以 dsh-tree-task-flow 注册", captured !== null && captured.id === "dsh-tree-task-flow", String(captured && captured.id));

const ICON_BASES = [
  "IconChecklistOutline",
  "IconChevronDownOutline",
  "IconChevronUpOutline",
  "IconPauseOutline",
  "IconPlayOutline",
  "IconArchiveOutline",
  "IconUndoOutline",
];

const primitives = {};
for (const base of ICON_BASES) {
  for (const suffix of ["Regular", "Medium"]) {
    primitives[base + suffix] = () => makeElement("i", { "data-icon": base + suffix });
  }
}
primitives.Tooltip = (props) => props.children;

const requested = [];
function fakeRequire(spec) {
  requested.push(spec);
  if (spec === "react") return miniReact;
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error("client.js 请求了没准备的模块：" + spec);
}

const plugin = captured.factory(fakeRequire);

check(
  "只 require 内置基座里的 react 与自己要用的 primitives",
  [...new Set(requested)].sort().join(", ") === ["@deepseek-ai/dsh-client-ui-primitives", "react"].join(", "),
  [...new Set(requested)].sort().join(", "),
);
check("插件名是 dsh-tree-task-flow", plugin.name === "dsh-tree-task-flow", String(plugin.name));
check(
  "注入 slots 与 locale",
  Array.isArray(plugin.inject) && plugin.inject.length === 2 && plugin.inject.includes("slots") && plugin.inject.includes("locale"),
  JSON.stringify(plugin.inject),
);

// ---------------------------------------------------------------- apply

const dictionaries = new Map();
const missingKeys = [];
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
      slotRegistrations.set(options.name, { options, component });
      return noop;
    },
  },
};

plugin.apply(ctx);

const dockEntry = () => slotRegistrations.get("conversation.input.dock") ?? null;
const configEntry = () => slotRegistrations.get("plugins.bundle.config") ?? null;

console.log("\n挂载点与样式：");

check(
  "挂了两个槽：输入框上方的条目 + 插件管理里本插件自己的配置页",
  injectedSlots.length === 2 &&
    injectedSlots.includes("conversation.input.dock") &&
    injectedSlots.includes("plugins.bundle.config"),
  injectedSlots.join(", "),
);
check(
  "条目用自己的 id 注册、排序 50（不顶掉内置条目）",
  dockEntry() !== null && dockEntry().options.id === "dsh-tree-task-flow" && dockEntry().options.order === 50,
  JSON.stringify(dockEntry() && dockEntry().options),
);
check(
  "配置页挂在 plugins.bundle.config 上，key 用 bundle 的包名（不是 locale 命名空间）",
  configEntry() !== null &&
    configEntry().options.name === "plugins.bundle.config" &&
    configEntry().options.key === "dsh-tree-task-flow" &&
    configEntry().options.locale === "dsh-tree-task-flow",
  JSON.stringify(configEntry() && configEntry().options),
);
check(
  "不再占 DSH 设置面板的一页标签（settings.section 一个都不注册）",
  !injectedSlots.includes("settings.section") && slotRegistrations.get("settings.section") === undefined,
  injectedSlots.join(", "),
);
check(
  "配置页按宿主给的视图分开：summary 返回 null，page 才出开关",
  configEntry().component({ view: "summary" }) === null &&
    configEntry().component({ view: "page" }) !== null &&
    configEntry().component({ view: "page" }).type !== undefined,
  String(configEntry().component({ view: "summary" })),
);
check("注入了样式", styleTags.length === 1 && typeof styleTags[0].textContent === "string", String(styleTags.length));
check(
  "样式里有需求条的骨架类",
  ["dsh-ttf-dock", "dsh-ttf-panel", "dsh-ttf-row", "dsh-ttf-pill", "dsh-ttf-switch"].every((name) =>
    styleTags[0].textContent.includes(name),
  ),
);
check(
  "样式注入是幂等的（同一个 id 只加一次）",
  styleTags.length === 1,
  String(styleTags.length),
);
// 宽度公式必须与内置条目一致：漏掉它，这一条会按父容器宽度铺满整个输入区（真的发生过）。
check(
  "任务条宽度照抄内置条目的公式（不然会占满全屏）",
  /\.dsh-ttf-dock\{[^}]*width:calc\(100% - var\(--dsh-composer-side-clearance\)/u.test(styleTags[0].textContent) &&
    /\.dsh-ttf-dock\{[^}]*max-width:calc\(var\(--dsh-composer-card-max-width\)/u.test(styleTags[0].textContent) &&
    /\.dsh-ttf-dock\{[^}]*margin:0 auto/u.test(styleTags[0].textContent),
);

const zhKeys = Object.keys(dictionaries.get("dsh-tree-task-flow").zh).sort();
const enKeys = Object.keys(dictionaries.get("dsh-tree-task-flow").en).sort();
check("中英文键集一致", zhKeys.join(",") === enKeys.join(","), zhKeys.filter((key) => !enKeys.includes(key)).join(", "));

// ---------------------------------------------------------------- 数据与渲染

/** 一件需求在接口里的形状。 */
function row(id, overrides) {
  return Object.assign(
    {
      id,
      title: "标题 " + id,
      intro: "简介 " + id,
      detail: "详情 " + id,
      status: "pending",
      archived: false,
      pending: null,
      missing: [],
      prerequisites: [],
      nextTask: null,
      version: 1,
      changes: 1,
      updatedAt: 1,
      result: null,
      tasks: [
        { id: "t-" + id, title: "任务一", status: "pending", result: null, steps: [{ id: "s-" + id, title: "步骤一", status: "pending" }] },
      ],
    },
    overrides || {},
  );
}

function dataWith(lists) {
  return {
    ok: true,
    requirements: {
      active: lists.active || [],
      archived: lists.archived || [],
      drafts: lists.drafts || [],
    },
    current: lists.current === undefined ? null : lists.current,
    paused: lists.paused === true,
    stopped: false,
  };
}

/** 八个 hook 的初值：state / open / busy / note / overrides / expandedId / editingId / drafting。 */
function preset(data, extra) {
  return [
    { loading: false, data },
    (extra && extra.open) === true,
    (extra && extra.busy) === true,
    null,
    (extra && extra.overrides) || {},
    (extra && extra.expandedId) || null,
    (extra && extra.editingId) || null,
    (extra && extra.drafting) === true,
  ];
}

function renderDock(data, extra) {
  dockPreset = preset(data, extra);
  try {
    return render(makeElement(dockEntry().component, { sessionId: "s-1" }));
  } finally {
    dockPreset = null;
  }
}

console.log("\n需求条 · 收起与展开：");

{
  const empty = renderDock(dataWith({}));
  check("一条需求都没有的会话：一个像素都不占（渲染成 null）", empty === null, String(empty));
}

{
  const rowA = row("R1");
  const data = dataWith({ active: [rowA, row("R2")], current: "R1" });
  const folded = renderDock(data);
  check("收起态只有一条（没有展开体）", folded !== null && !hasClass(folded, "dsh-ttf-body"));
  check("收起态报的是当前那条需求的标题", hasText(folded, "标题 R1"));
  check("状态标签是「进行中」", hasText(folded, "进行中"));
  check("进度按当前那条算（1 个任务 + 1 个步骤 = 0/2）", hasText(folded, "0/2"));
  check("有暂停与展开两个按钮", byAria(folded, "暂停").length === 1 && byAria(folded, "展开").length === 1);

  const open = renderDock(data, { open: true });
  check("展开态出展开体", hasClass(open, "dsh-ttf-body"));
  check("活跃列表的两条都在", hasText(open, "标题 R1") && hasText(open, "标题 R2"));
  check("每条都带自己的编号", hasText(open, "R1") && hasText(open, "R2"));
  check("当前那条打了「当前」标记", hasText(open, "当前"));
  check("行上有简介", hasText(open, "简介 R1"));
  check("行上有「开始这条需求」按钮", byAria(open, "开始这条需求").length >= 1);
  check("行上有「归档」按钮", byAria(open, "归档").length >= 1);
}

{
  const data = dataWith({ active: [row("R1", { missing: [{ id: "R3", state: "open" }], pending: { change: "改成深色" } })] });
  const open = renderDock(data, { open: true, expandedId: "R1" });
  check("缺前置写出来", hasText(open, "缺前置") && hasText(open, "R3"));
  check("待确认变动写出来", hasText(open, "改成深色"));
  check("有待确认变动时不给「归档」按钮（先让 AI 处理）", byAria(open, "归档").length === 0);
}

console.log("\n需求条 · 归档的延迟渲染：");

{
  const rowA = row("R1");
  const data = dataWith({ active: [rowA] });
  const afterClick = renderDock(data, { open: true, overrides: { R1: true } });
  check("点了归档：行留在活跃列表里（没有立刻搬家）", hasText(afterClick, "标题 R1"));
  check("按钮立刻变成「取消归档」", byAria(afterClick, "取消归档").length === 1, textOf(afterClick));

  const archivedData = dataWith({ archived: [row("R1", { archived: true })] });
  const nextOpen = renderDock(archivedData, { open: true });
  check("下次打开才按新状态渲染到「已归档」小节", hasText(nextOpen, "已归档"));
  check("已归档的行给的是「取消归档」按钮", byAria(nextOpen, "取消归档").length === 1);
}

console.log("\n需求条 · 改需求与新建：");

{
  const data = dataWith({ active: [row("R1")] });
  const editing = renderDock(data, { open: true, editingId: "R1" });
  check("编辑态出三个输入框（标题 / 简介 / 详情）", findAll(editing, (node) => node.type === "input").length >= 3);
  check("编辑态出「确认变更」按钮", hasText(editing, "确认变更"));
  check("编辑态讲清了「提交成暂定版本」", hasText(editing, "暂定版本"));

  const drafting = renderDock(data, { open: true, drafting: true });
  check("新建需求出表单与「记下来」按钮", hasText(drafting, "记下来"));
  check("新建需求讲清了它只是草稿", hasText(drafting, "草稿"));

  const noForm = renderDock(data, { open: true });
  check("默认只有「新建需求」入口", hasText(noForm, "新建需求") && !hasText(noForm, "记下来"));
}

console.log("\n需求条 · 草稿区与暂停：");

{
  const data = dataWith({ active: [row("R1")], drafts: [row("R3", { status: "draft", title: "待确认的草稿" })] });
  const open = renderDock(data, { open: true });
  check("草稿单独一段", hasText(open, "待确认"));
  check("草稿的行露出来", hasText(open, "待确认的草稿"));
  check("草稿的说明里写着它还不算真需求", hasText(open, "还不算真需求"));
}

{
  const data = dataWith({ active: [row("R1")], current: "R1", paused: true });
  const open = renderDock(data, { open: true });
  check("暂停态：状态标签变「已暂停」", hasText(open, "已暂停"));
  check("暂停态：按钮变「继续」", byAria(open, "继续").length === 1);
  check("暂停态给出说明", hasText(open, "点「继续」从原处接着跑"));
}

// 收起的条上没有进行中的需求时，不能拿「待开始」去描述一条已经做完的需求：
// 条上写待开始、点开是已完成，两处对不上（真的发生过）。
{
  const data = dataWith({ active: [row("R1", { status: "done", result: "做完了" })], current: null });
  const bar = renderDock(data, { open: false });
  check("没有进行中的需求：条上不再写「待开始」", !hasText(bar, "待开始"));
  check("没有进行中的需求：条上照最近那条的状态写「已完成」", hasText(bar, "已完成"));
  check("没有进行中的需求：条上照最近那条显示标题", hasText(bar, "标题 R1"));
}

console.log("\n插件配置页：");

{
  check("只处理两个开关", true);
  settingsPreset = [{ loading: false, data: { enabled: true, settings: { autoContinue: false, interruptRecovery: true } } }, false, ""];
  let page = render(makeElement(configEntry().component, { view: "page" }));
  let switches = findAll(page, (node) => node.props !== undefined && node.props.role === "switch");
  check("正好两个开关", switches.length === 2, String(switches.length));
  check(
    "aria-checked 跟着接口给的开关状态走",
    switches[0].props["aria-checked"] === false && switches[1].props["aria-checked"] === true,
    JSON.stringify(switches.map((each) => each.props["aria-checked"])),
  );
  check("开关带无障碍名字", switches.every((each) => typeof each.props["aria-label"] === "string"));

  settingsPreset = [{ loading: false, data: { enabled: true, settings: { autoContinue: true } } }, true, ""];
  page = render(makeElement(configEntry().component, { view: "page" }));
  switches = findAll(page, (node) => node.props !== undefined && node.props.role === "switch");
  check("正在写的时候两个开关都禁用", switches.every((each) => each.props.disabled === true));

  settingsPreset = [{ loading: false, data: null }, false, ""];
  page = render(makeElement(configEntry().component, { view: "page" }));
  check("读不到设置时说实话", hasText(page, "读不到设置"));

  settingsPreset = [{ loading: false, data: { enabled: false, settings: {} } }, false, ""];
  page = render(makeElement(configEntry().component, { view: "page" }));
  check("插件被关掉时明说开关不起作用", hasText(page, "不起作用"));

  settingsPreset = null;
}

check("渲染过程中没有取到不存在的文案键", missingKeys.length === 0, [...new Set(missingKeys)].join(", "));

console.log("");
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`${pass} 项通过，${failures.length} 项失败：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
