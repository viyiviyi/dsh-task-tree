/**
 * 界面上的开关：**哪些键可以改**，以及怎么把它们并进配置。
 *
 * 单独成文件是为了让"可改的键"只有一份定义：`lib/index.js` 开机时用它把落盘的
 * 选择并进配置，`lib/http.js` 收到面板的请求时用它校验键名。两处各写一份，
 * 迟早会出现"界面能点、开机不认"或者反过来的错位。
 *
 * 优先级：**界面改过的（落盘）> profile 里的 config > DEFAULT_CONFIG**。
 * 界面上改完还被 profile 顶回去，人会以为开关坏了。
 *
 * @module dsh-tree-task-flow/settings
 */

/**
 * 面板可以改的键。
 *
 * 只收布尔开关：它们都是"要不要让插件自己动起来"这类事，改了立刻能看出效果，
 * 也不需要额外解释。`maxAutoRounds` / `interruptDelaysMs` 这类带数值的旋钮
 * 留在 profile 里——界面上给一个数字要配输入框与校验，不值当。
 */
export const SETTING_KEYS = ["autoContinue", "interruptRecovery"];

/**
 * 从一个对象里挑出认识的开关，且值必须是布尔。
 *
 * 落盘的 `settings.json` 可能被人手改坏、也可能是旧版本留下的键，
 * 所以这里**只认名单上的键**，其余一概忽略；值不是布尔的也忽略，
 * 免得一个 `"false"` 字符串把 `cfg.autoContinue !== true` 那种判断带偏。
 *
 * @param value - 待挑选的对象，通常是落盘的设置。
 * @returns 只含合法键值的新对象；没有合法的就是 `{}`。
 */
export function pickSettings(value) {
  const picked = {};
  if (value === null || typeof value !== "object") return picked;
  for (const key of SETTING_KEYS) {
    if (typeof value[key] === "boolean") picked[key] = value[key];
  }
  return picked;
}

/**
 * 把当前生效的开关压成面板要的形状。
 *
 * @param cfg - 合并后的配置。
 * @returns `{ autoContinue, interruptRecovery }`，缺的按 false 报。
 */
export function settingsSnapshot(cfg) {
  return {
    autoContinue: cfg?.autoContinue === true,
    interruptRecovery: cfg?.interruptRecovery === true,
  };
}
