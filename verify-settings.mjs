/**
 * 设置界面的自测：**开关的名单、落盘、优先级、以及"改了真的立刻生效"**。
 *
 * 这一份盯的是四件容易出错的事：
 *
 *   1. **可改的键只有一份定义。** 宿主用 `lib/settings.js` 的 `SETTING_KEYS` 校验，
 *      界面用 `client.js` 里的 `SETTING_ROWS` 画开关。两份名单一旦对不上，
 *      现象是"点了一下，界面安静地什么都没发生"——最难查的一种。这里从
 *      `client.js` 源码里把那份名单抠出来，逐字对上。
 *   2. **落盘与跨重启。** 开关是"这台机器上的偏好"，写盘了才算数；换一个
 *      store 实例（等于重启）读回来的必须还是它。
 *   3. **优先级：界面改过的 > profile 的 config > 默认值。** 界面上改完被
 *      profile 顶回去，人会以为开关坏了。
 *   4. **改了立刻生效。** 两个开关都必须在**同一个进程里**打开/关掉就换行为，
 *      因为 `apply()` 里 `cfg` 是活对象、各模块按事件现读它。这一条是本次改动的
 *      核心：`interruptRecovery` 以前是"注册与否取决于配置"，那就没法运行中打开。
 *
 * 接口那一段走的是**真注册出来的路由**（假 webServer 收下 `register()`，再拿假的
 * request/response 打进去），不是对着纯函数打桩。
 *
 * 跑：node verify-settings.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, apply } from "./lib/index.js";
import { SETTING_KEYS, pickSettings, settingsSnapshot } from "./lib/settings.js";
import { createStore } from "./lib/store.js";

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

/**
 * 假 ctx：装配路径真正用到的那几样 + 一个假 webServer。
 *
 * `inject(["webServer"], fn)` 会**当场把 fn 调起来**（真宿主是拿到服务后回调），
 * 这样面板接口在自检里也真的被注册一遍。
 */
function makeHarness({ agents = null } = {}) {
  const handlers = new Map();
  const routes = [];

  const ctx = {
    effect(register) {
      return register();
    },
    systemPrompt: { section() {} },
    tools: {
      register() {},
      get() {
        return undefined;
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    get(name) {
      return name === "agents" ? agents : undefined;
    },
    inject(services, fn) {
      if (!Array.isArray(services) || !services.includes("webServer")) return;
      if (typeof fn !== "function") return;
      fn({
        effect: (register) => register(),
        webServer: {
          register(def) {
            routes.push(def);
          },
        },
      });
    },
    logger: { info() {}, warn() {}, debug() {} },
  };

  return { ctx, handlers, routes };
}

/** 触发某个事件上的全部监听器。 */
function emit(harness, event, ...args) {
  for (const handler of harness.handlers.get(event) ?? []) handler(...args);
}

/**
 * 打一次面板接口。
 *
 * request 必须是**异步可迭代**的：`readJsonBody` 是 `for await (const chunk of request)`。
 */
async function call(route, { method = "GET", url = "", body = null } = {}) {
  const response = {
    status: 0,
    text: "",
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.text = text;
    },
  };
  const request = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(JSON.stringify(body));
    },
  };
  await route.handler(request, response);
  return { status: response.status, body: response.text === "" ? null : JSON.parse(response.text) };
}

const routeOf = (harness, suffix) => harness.routes.find((route) => route.path.endsWith(suffix));

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "tt-verify-settings-"));
}

/** 一份"还有进行中的子任务"的计划：两个开关的判据都要求它。 */
function makePlan() {
  return {
    version: 2,
    createdAt: 1,
    updatedAt: 1,
    goals: [
      {
        id: "g-1",
        title: "目标",
        status: "pending",
        tasks: [
          {
            id: "t-1",
            title: "任务",
            status: "pending",
            steps: [{ id: "s-1", title: "步骤", status: "pending" }],
          },
        ],
      },
    ],
  };
}

/** 假 agent：够 `agent/status` 那条续行判据用。 */
function makeAgent(sessionId, followed) {
  return {
    id: sessionId,
    session: { id: sessionId },
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) {
      followed.push(message);
    },
  };
}

const SESSION = "s-settings";

// ---------------------------------------------------------------- 名单

console.log("\n可改的键只有一份定义：");

{
  check(
    "SETTING_KEYS 正好是那两个开关",
    SETTING_KEYS.join(",") === "autoContinue,interruptRecovery",
    SETTING_KEYS.join(","),
  );

  const source = readFileSync(join(HERE, "client.js"), "utf8");
  const block = /const SETTING_ROWS = \[([\s\S]*?)\n\t\t\];/u.exec(source)?.[1] ?? "";
  const rows = [...block.matchAll(/key:\s*"([^"]+)"/gu)].map((match) => match[1]);
  check(
    "界面上画的开关与宿主的名单逐字对上",
    rows.length > 0 && rows.join(",") === SETTING_KEYS.join(","),
    `client.js: ${rows.join(",")} / settings.js: ${SETTING_KEYS.join(",")}`,
  );

  // 每个开关都得有名字与说明，否则界面上会出现一个只有滑块、没有字的开关。
  for (const key of SETTING_KEYS) {
    check(`文案里有 setting.${key}`, source.includes(`"setting.${key}":`));
    check(`文案里有 setting.${key}Note`, source.includes(`"setting.${key}Note":`));
  }
}

console.log("\n挑拣：只认名单上的键，且值必须是布尔：");

{
  check(
    "不认识的键被丢掉",
    JSON.stringify(pickSettings({ autoContinue: true, nope: true })) === '{"autoContinue":true}',
    JSON.stringify(pickSettings({ autoContinue: true, nope: true })),
  );
  check(
    "值不是布尔的也丢掉（\"false\" 这种会把判断带偏）",
    JSON.stringify(pickSettings({ autoContinue: "false", interruptRecovery: 1 })) === "{}",
    JSON.stringify(pickSettings({ autoContinue: "false", interruptRecovery: 1 })),
  );
  check("null / 非对象退回空", JSON.stringify(pickSettings(null)) === "{}");
  check(
    "快照按布尔报，缺的算 false",
    JSON.stringify(settingsSnapshot({})) === '{"autoContinue":false,"interruptRecovery":false}',
    JSON.stringify(settingsSnapshot({})),
  );
}

// ---------------------------------------------------------------- 落盘

console.log("\n落盘与跨重启：");

{
  const root = tempRoot();
  try {
    const store = createStore(root);
    check("没改过时读出来是空对象", JSON.stringify(store.readSettings()) === "{}");

    store.patchSettings({ autoContinue: true });
    check("写进去了", store.readSettings().autoContinue === true);

    store.patchSettings({ interruptRecovery: false });
    check(
      "改一个键不会把另一个抹掉（读改写）",
      store.readSettings().autoContinue === true && store.readSettings().interruptRecovery === false,
      JSON.stringify(store.readSettings()),
    );

    // 换一个 store 实例 = 重启一次。
    check("重启之后还是它", createStore(root).readSettings().autoContinue === true);

    writeFileSync(join(root, "settings.json"), "{ 这不是 JSON", "utf8");
    check("坏文件当空，不抛", JSON.stringify(createStore(root).readSettings()) === "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 优先级

console.log("\n优先级：界面改过的 > profile 的 config > 默认值：");

{
  // ① 谁都没说 → 用默认值。
  const bare = tempRoot();
  try {
    createStore(bare).writePlan(SESSION, makePlan());
    const harness = makeHarness();
    apply(harness.ctx, { rootDir: bare });
    const tree = await call(routeOf(harness, "/tree"), {
      url: `/dsh-tree-task-flow/tree?sessionId=${SESSION}`,
    });
    check(
      "没人说过就是默认值：autoContinue=false / interruptRecovery=true",
      tree.body?.settings?.autoContinue === false && tree.body?.settings?.interruptRecovery === true,
      JSON.stringify(tree.body?.settings),
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  // ② profile 说了 → 听 profile 的。
  const profiled = tempRoot();
  try {
    createStore(profiled).writePlan(SESSION, makePlan());
    const harness = makeHarness();
    apply(harness.ctx, { rootDir: profiled, autoContinue: true, interruptRecovery: false });
    const tree = await call(routeOf(harness, "/tree"), {
      url: `/dsh-tree-task-flow/tree?sessionId=${SESSION}`,
    });
    check(
      "profile 说的算",
      tree.body?.settings?.autoContinue === true && tree.body?.settings?.interruptRecovery === false,
      JSON.stringify(tree.body?.settings),
    );
  } finally {
    rmSync(profiled, { recursive: true, force: true });
  }

  // ③ 界面上改过 → **盖过 profile**（哪怕 profile 写的是相反的）。
  const both = tempRoot();
  try {
    createStore(both).writePlan(SESSION, makePlan());
    createStore(both).patchSettings({ autoContinue: true, interruptRecovery: false });
    const harness = makeHarness();
    apply(harness.ctx, { rootDir: both, autoContinue: false, interruptRecovery: true });
    const tree = await call(routeOf(harness, "/tree"), {
      url: `/dsh-tree-task-flow/tree?sessionId=${SESSION}`,
    });
    check(
      "界面上改过的盖过 profile",
      tree.body?.settings?.autoContinue === true && tree.body?.settings?.interruptRecovery === false,
      JSON.stringify(tree.body?.settings),
    );
  } finally {
    rmSync(both, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 改了立刻生效

console.log("\nautoContinue：改了立刻生效，不用重启：");

{
  const root = tempRoot();
  try {
    const store = createStore(root);
    store.writePlan(SESSION, makePlan());
    const followed = [];
    const agents = { get: (id) => (id === SESSION ? makeAgent(SESSION, followed) : undefined) };
    const harness = makeHarness({ agents });
    apply(harness.ctx, { rootDir: root });
    const action = routeOf(harness, "/action");

    emit(harness, "agent/status", { status: "idle", agent: agents.get(SESSION) });
    check("默认关着：一条都不推", followed.length === 0, String(followed.length));

    const opened = await call(action, {
      method: "POST",
      body: { action: "setting", key: "autoContinue", value: true },
    });
    check("接口回了新的开关状态", opened.body?.settings?.autoContinue === true, JSON.stringify(opened.body));
    check("也写盘了", createStore(root).readSettings().autoContinue === true);

    emit(harness, "agent/status", { status: "idle", agent: agents.get(SESSION) });
    check("打开后**同一个进程里**立刻就推了", followed.length === 1, String(followed.length));

    await call(action, { method: "POST", body: { action: "setting", key: "autoContinue", value: false } });
    emit(harness, "agent/status", { status: "idle", agent: agents.get(SESSION) });
    check("再关掉就又不动了", followed.length === 1, String(followed.length));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\ninterruptRecovery：改了立刻生效（以前是「注册与否」定死的）：");

{
  const root = tempRoot();
  try {
    const store = createStore(root);
    store.writePlan(SESSION, makePlan());
    const harness = makeHarness();
    apply(harness.ctx, { rootDir: root });
    const action = routeOf(harness, "/action");
    const session = { id: SESSION };
    const interrupt = {
      type: "turn/end",
      data: { turn: 3, reason: { kind: "error", error: { code: "TRANSPORT" } } },
    };

    emit(harness, "session/event", session, interrupt);
    check("开着时排上了拉起链", store.readRevive(SESSION) !== null, JSON.stringify(store.readRevive(SESSION)));

    const closed = await call(action, {
      method: "POST",
      body: { action: "setting", key: "interruptRecovery", value: false },
    });
    check("接口回了新状态", closed.body?.settings?.interruptRecovery === false, JSON.stringify(closed.body));

    store.clearRevive(SESSION);
    emit(harness, "session/event", session, interrupt);
    check(
      "关掉后同一个进程里立刻就不管了",
      store.readRevive(SESSION) === null,
      JSON.stringify(store.readRevive(SESSION)),
    );

    await call(action, { method: "POST", body: { action: "setting", key: "interruptRecovery", value: true } });
    emit(harness, "session/event", session, interrupt);
    check("再打开又管了", store.readRevive(SESSION) !== null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 接口的边界

console.log("\n接口的边界：");

{
  const root = tempRoot();
  try {
    createStore(root).writePlan(SESSION, makePlan());
    const harness = makeHarness();
    apply(harness.ctx, { rootDir: root });
    const action = routeOf(harness, "/action");

    const unknownKey = await call(action, {
      method: "POST",
      body: { action: "setting", key: "enabled", value: true },
    });
    check(
      "不认识的键被拒（连 enabled 都不许从这儿改）",
      unknownKey.status === 400 && typeof unknownKey.body?.error === "string",
      JSON.stringify(unknownKey),
    );
    check("被拒时一个字节都没写盘", createStore(root).readSettings().enabled === undefined);

    const badValue = await call(action, {
      method: "POST",
      body: { action: "setting", key: "autoContinue", value: "true" },
    });
    check("值不是布尔被拒", badValue.status === 400, JSON.stringify(badValue));

    const missing = await call(routeOf(harness, "/tree"), { url: "/dsh-tree-task-flow/tree" });
    check("没有 sessionId 时没有计划可给（404）", missing.status === 404, JSON.stringify(missing));

    // 设置面板那一页专用的与会话无关的接口。
    const settingsRoute = routeOf(harness, "/settings");
    check("挂了 /settings 路由（设置面板不认会话，不能走 /tree）", settingsRoute !== undefined);

    const page = await call(settingsRoute, { url: "/dsh-tree-task-flow/settings" });
    check("读得到设置", page.status === 200 && page.body?.ok === true, JSON.stringify(page));
    check(
      "回的是当前两个开关的值",
      page.body?.settings?.autoContinue === false && page.body?.settings?.interruptRecovery === true,
      JSON.stringify(page.body?.settings),
    );
    check("顺便报总开关状态（关掉的插件不该画一排骗人的开关）", page.body?.enabled === true, JSON.stringify(page.body));

    const refused = await call(settingsRoute, { method: "POST", url: "/dsh-tree-task-flow/settings" });
    check("只收 GET，别的动作 405", refused.status === 405, JSON.stringify(refused));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 状态目录

console.log("\n状态目录里确实多了一份设置：");

{
  const root = tempRoot();
  try {
    mkdirSync(root, { recursive: true });
    createStore(root).patchSettings({ autoContinue: true });
    const onDisk = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    check("写的是 settings.json，且带时间戳", onDisk.autoContinue === true && typeof onDisk.at === "number", JSON.stringify(onDisk));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 汇总

console.log("\n" + "─".repeat(60));
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
  process.exit(0);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
