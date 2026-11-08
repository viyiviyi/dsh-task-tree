/**
 * 笔记：跟工作有关、但不属于任何一条需求的事实与偏好。
 *
 * **跟着会话走**，不设全局层、不跨会话带——用户开新会话就不管旧会话了，这是设计不是缺陷。
 * 偏好是"对产出的要求"，不是"关于用户的知识"，所以写进这里就够，不必另立体系。
 *
 * 纯逻辑模块：不碰 DSH、不碰磁盘。
 *
 * ## 为什么笔记要有 `key` 和 `rev`
 *
 * 折叠会把一段过程收成一条通告，通告里要带上"这段里动过的笔记"。于是同一条笔记可能：
 * 先在较早的通告里出现（rev 1），后来又被改过（rev 2），两份通告都还在上下文里。
 * 给每条笔记一个**短名字**和一个**修订号**，再在静态提示词里写死一句"同一名字以修订号大的
 * 为准"，模型就不会拿旧值当新值。
 *
 * `seq` 记的是写这条笔记那一刻会话表层的末尾节点，折叠时靠它判断"这条笔记是不是落在
 * 这个区间里"。
 *
 * @module dsh-tree-task-flow/notes
 */

/** 一条笔记的形状。 */
export function makeNote(input, now = Date.now()) {
  return {
    key: String(input?.key ?? "").trim(),
    text: String(input?.text ?? "").trim(),
    rev: 1,
    at: now,
    seq: typeof input?.seq === "number" ? input.seq : null,
  };
}

/**
 * 读出来的笔记表补齐成当前形状。坏文件、缺字段一律当空，不让它拖垮会话。
 *
 * @param state - 磁盘上读到的对象，可能是 null。
 * @returns `{ version, items, updatedAt }`。
 */
export function normalizeNotes(state) {
  if (state === null || typeof state !== "object") {
    return { version: 1, items: [], updatedAt: null };
  }
  const items = Array.isArray(state.items)
    ? state.items
        .filter((item) => item !== null && typeof item === "object")
        .map((item) => ({
          key: String(item.key ?? "").trim(),
          text: String(item.text ?? ""),
          rev: Number.isFinite(item.rev) ? item.rev : 1,
          at: Number.isFinite(item.at) ? item.at : null,
          seq: Number.isFinite(item.seq) ? item.seq : null,
        }))
        .filter((item) => item.key !== "")
    : [];
  return {
    version: 1,
    items,
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : null,
  };
}

/**
 * 写一条笔记：**同名就覆盖、修订号 +1**，不同名就新增。
 *
 * 当场返回结果——`tree_task_note` 的返回直接用它，不用等折叠。
 *
 * @param state - 笔记表（会被就地修改）。
 * @param input - `{ key, text, seq? }`。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, note?, created? }`。
 */
export function upsertNote(state, input, now = Date.now()) {
  const key = String(input?.key ?? "").trim();
  const text = String(input?.text ?? "").trim();
  if (key === "") return { ok: false, reason: "笔记要有一个短名字（key），以后按它找" };
  if (text === "") return { ok: false, reason: "笔记正文不能为空" };

  const existing = state.items.find((item) => item.key === key);
  if (existing === undefined) {
    const note = makeNote({ key, text, seq: input?.seq }, now);
    state.items.push(note);
    state.updatedAt = now;
    return { ok: true, note, created: true };
  }

  existing.text = text;
  existing.rev += 1;
  existing.at = now;
  if (typeof input?.seq === "number") existing.seq = input.seq;
  state.updatedAt = now;
  return { ok: true, note: existing, created: false };
}

/**
 * 查笔记：不给条件就是全部，给了就在名字与正文里找。
 *
 * @param state - 笔记表。
 * @param query - 关键词（不分大小写）。
 * @returns 笔记数组，按最后修改时间倒序。
 */
export function findNotes(state, query) {
  const word = String(query ?? "").trim().toLowerCase();
  const items = word === ""
    ? [...state.items]
    : state.items.filter(
        (item) =>
          item.key.toLowerCase().includes(word) || item.text.toLowerCase().includes(word),
      );
  return items.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
}

/**
 * 某个表层区间里的笔记：`seq` 落在 `(from, to]` 里的那几条。
 *
 * 折叠时用它决定"这段通告要带哪些笔记"。没有 `seq` 的老笔记（迁移前写的）一律算进来——
 * 宁可多带一条，也不能让笔记跟着被收走的过程一起消失。
 *
 * @param state - 笔记表。
 * @param from - 区间起点 seq（不含）。
 * @param to - 区间终点 seq（含）。
 * @returns 笔记数组，按写入顺序。
 */
export function notesInRange(state, from, to) {
  return state.items
    .filter((item) => item.seq === null || (item.seq > from && item.seq <= to))
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
}

/**
 * 把笔记渲染成通告里那一段。
 *
 * 形状是**固定且可再解析的**：一行 `· 名字 (r修订号)：正文`。二次折叠时靠它把上一层通告里的
 * 笔记捡回来，所以别随手改格式（`parseNoteLines` 认的就是它）。
 *
 * @param items - 笔记数组。
 * @returns 多行文本；没有笔记时是空串。
 */
export function renderNoteLines(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map((item) => `· ${item.key} (r${item.rev})：${oneLine(item.text)}`).join("\n");
}

/**
 * 从一段通告正文里把笔记捡回来。
 *
 * @param text - 通告正文。
 * @returns 笔记数组 `{ key, rev, text }`。
 */
export function parseNoteLines(text) {
  const rows = [];
  const pattern = /^· (.+?) \(r(\d+)\)：(.*)$/u;
  for (const line of String(text ?? "").split("\n")) {
    const match = pattern.exec(line.trim());
    if (match === null) continue;
    rows.push({ key: match[1], rev: Number(match[2]), text: match[3] });
  }
  return rows;
}

/**
 * 正文压成一行：通告里每条笔记只占一行，换行会把它拆成两条，再解析就错位了。
 *
 * @param text - 原文。
 * @returns 单行文本。
 */
function oneLine(text) {
  return String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
}
