/**
 * 需求与任务的渲染：给 `tree_task_*` 工具用的几种输出，统一为 YAML。
 *
 * 统一 YAML 的目的是**让模型一眼看出返回的是什么**：`requirements:` 下面是需求列表，
 * `requirement:` 下面是单条需求，`added_tasks:` 下面是这次新增的任务。同一段文字出现在
 * 不同调用里，靠顶层键区分，不靠句子猜。
 *
 * 两个原则：
 *
 * 1. **不截断**。给了正文就整段输出——截掉半句等于没交付。
 * 2. **可解析**。标量按需加引号，多行文本用块标量 `|`，不产生歧义。
 *
 * @module dsh-tree-task-flow/render
 */

import { STATUS } from "./plan.js";
import {
  REQUIREMENT_STATUS,
  currentVersion,
  isDraft,
  isOpenRequirement,
  missingPrerequisites,
  progressOf,
} from "./requirement.js";

/** 状态的显示名。 */
export function statusLabel(requirement) {
  if (isDraft(requirement)) return "草稿";
  if (requirement.status === REQUIREMENT_STATUS.DONE) return "已完成";
  if (requirement.status === REQUIREMENT_STATUS.DROPPED) return "已放弃";
  return "进行中";
}

/** 一个 YAML 缩进层。 */
const INDENT = "  ";

function pad(depth) {
  return INDENT.repeat(depth);
}

/**
 * 单行标量是否可以直接裸写。
 *
 * 裸写只放过「汉字、字母、数字与常见中文标点」的短句；其余一律加双引号，
 * 免得 `:`、`#`、行首的 `-` 之类让 YAML 解析走样。
 *
 * @param text - 单行文本。
 * @returns 可裸写为 true。
 */
function plainSafe(text) {
  if (text === "" || text !== text.trim()) return false;
  if (text.includes("\n") || text.includes("\t")) return false;
  if (/[:#\\[\]{}&*!|>'"%@`]/u.test(text)) return false;
  if (/^[-?,\s]/u.test(text)) return false;
  if (/^[\d.+-]/u.test(text)) return false;
  return /^[\p{L}\p{N}_./()（）·「」《》、，。；！？—\s-]+$/u.test(text);
}

/**
 * 单行标量的写法。
 *
 * @param text - 文本。
 * @returns YAML 标量。
 */
function scalar(text) {
  const value = String(text ?? "");
  if (value === "") return '""';
  return plainSafe(value) ? value : JSON.stringify(value);
}

/**
 * 追加一个字段；多行文本走块标量，空值写空对象。
 *
 * @param lines - 输出行数组。
 * @param depth - 字段本身的缩进层数。
 * @param key - 键名。
 * @param value - 值；`undefined` / `null` 表示不输出这个字段。
 */
function field(lines, depth, key, value) {
  if (value === undefined || value === null) return;
  const text = String(value);
  const at = `${pad(depth)}${key}:`;
  if (text === "") {
    lines.push(`${at} ""`);
    return;
  }
  if (text.includes("\n")) {
    const rows = text.replace(/\r\n?/gu, "\n").split("\n");
    while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
    lines.push(`${at} |`);
    for (const row of rows) lines.push(row === "" ? "" : `${pad(depth + 1)}${row}`);
    return;
  }
  lines.push(`${at} ${scalar(text)}`);
}

/**
 * 一个列表键：空列表写 `[]`，否则逐项输出。
 *
 * @param lines - 输出行数组。
 * @param depth - 列表键的缩进层数。
 * @param key - 键名。
 * @param size - 项数。
 * @returns 有项时为 true，调用方接着往 `depth + 1` 层写 `- ` 开头的项。
 */
function listKey(lines, depth, key, size) {
  if (size === 0) {
    lines.push(`${pad(depth)}${key}: []`);
    return false;
  }
  lines.push(`${pad(depth)}${key}:`);
  return true;
}

/**
 * 任务或步骤的状态名。
 *
 * @param node - 任务 / 步骤。
 * @returns 状态名。
 */
function nodeStatus(node) {
  if (node.status === STATUS.DONE) return "已完成";
  if (node.status === STATUS.DROPPED) return "已放弃";
  return "未完成";
}

/**
 * 一条任务（连同它的步骤）的 YAML 行。
 *
 * @param task - 任务。
 * @param depth - `- ` 这一项所在的缩进层数。
 * @returns 行数组。
 */
function taskEntry(task, depth) {
  const out = [];
  const here = `${pad(depth)}- id: ${scalar(task.id)}`;
  const inner = pad(depth + 1);
  out.push(here);
  out.push(`${inner}status: ${nodeStatus(task)}`);
  out.push(`${inner}title: ${scalar(task.title ?? "")}`);
  field(out, depth + 1, "result", task.result?.text);
  const steps = task.steps ?? [];
  if (listKey(out, depth + 1, "steps", steps.length)) {
    for (const step of steps) {
      out.push(`${inner}  - id: ${scalar(step.id)}`);
      out.push(`${inner}    status: ${nodeStatus(step)}`);
      out.push(`${inner}    title: ${scalar(step.title ?? "")}`);
      field(out, depth + 3, "result", step.result?.text);
    }
  }
  return out;
}

/**
 * 一条需求在列表里的 YAML 行。
 *
 * @param plan - 计划树。
 * @param requirement - 需求。
 * @param current - 是不是当前进行中的那一条。
 * @param depth - `- ` 这一项所在的缩进层数。
 * @returns 行数组。
 */
function requirementEntry(plan, requirement, current, depth) {
  const out = [];
  const inner = pad(depth + 1);
  out.push(`${pad(depth)}- id: ${scalar(requirement.id)}`);
  out.push(`${inner}status: ${statusLabel(requirement)}`);
  out.push(`${inner}title: ${scalar(requirement.title || "（还没有标题）")}`);
  field(out, depth + 1, "intro", requirement.intro);
  if (current) out.push(`${inner}current: true`);
  const missing = missingPrerequisites(plan, requirement);
  if (listKey(out, depth + 1, "missing_prerequisites", missing.length)) {
    for (const item of missing) {
      out.push(`${inner}  - ${scalar(`${item.id}（${missingLabel(item.state)}）`)}`);
    }
  }
  if (requirement.pending !== null) {
    field(out, depth + 1, "pending_change", requirement.pending.change || "（未说明改了什么）");
  }
  const rows = progressOf(requirement);
  if (listKey(out, depth + 1, "tasks", rows.length)) {
    for (const { task, steps } of rows) {
      out.push(`${inner}  - id: ${scalar(task.id)}`);
      out.push(`${inner}    status: ${nodeStatus(task)}`);
      out.push(`${inner}    title: ${scalar(task.title ?? "")}`);
      if (listKey(out, depth + 3, "steps", steps.length)) {
        for (const step of steps) {
          out.push(`${pad(depth + 4)}- id: ${scalar(step.id)}`);
          out.push(`${pad(depth + 5)}status: ${nodeStatus(step)}`);
          out.push(`${pad(depth + 5)}title: ${scalar(step.title ?? "")}`);
        }
      }
    }
  }
  return out;
}

/**
 * 列表：活跃（展开当前那一条）、已归档、草稿。
 *
 * @param plan - 计划树。
 * @param rows - 行数据：`{ active, archived, drafts }`。
 * @param active - 当前进行中的需求（打 `current: true`）。
 * @returns YAML 文本。
 */
export function renderList(plan, rows, active) {
  const lines = ["requirements:"];
  const total = rows.active.length + rows.archived.length + rows.drafts.length;
  if (total === 0) {
    lines.push("  active: []");
    lines.push("  archived: []");
    lines.push("  drafts: []");
    return lines.join("\n");
  }

  if (listKey(lines, 1, "active", rows.active.length)) {
    for (const requirement of rows.active) {
      const here = active !== null && active.id === requirement.id;
      lines.push(...requirementEntry(plan, requirement, here, 2));
    }
  }

  if (listKey(lines, 1, "archived", rows.archived.length)) {
    for (const requirement of rows.archived) {
      lines.push(...requirementEntry(plan, requirement, false, 2));
    }
  }

  if (listKey(lines, 1, "drafts", rows.drafts.length)) {
    for (const requirement of rows.drafts) {
      const inner = pad(2);
      lines.push(`${inner}- id: ${scalar(requirement.id)}`);
      lines.push(`${inner}  title: ${scalar(requirement.title || "（还没有标题）")}`);
      lines.push(`${inner}  next: tree_task_requirement action=confirm`);
    }
  }

  return lines.join("\n");
}

/**
 * 「简」版列表：只给活跃需求的编号、状态、标题。
 *
 * 给**需求完成**那一刻用——那一下上下文被整条折掉，返回里要能一眼看出还剩哪几条。
 *
 * @param rows - 行数据：`{ active }`。
 * @param active - 当前进行中的需求（打 `current: true`）。
 * @returns YAML 文本。
 */
export function renderBriefList(rows, active) {
  const lines = ["requirements:"];
  if (!listKey(lines, 1, "active", rows.active.length)) return lines.join("\n");
  for (const requirement of rows.active) {
    const inner = pad(2);
    const here = active !== null && active.id === requirement.id;
    lines.push(`${inner}- id: ${scalar(requirement.id)}`);
    lines.push(`${inner}  status: ${statusLabel(requirement)}`);
    lines.push(`${inner}  title: ${scalar(requirement.title || "（还没有标题）")}`);
    if (here) lines.push(`${inner}  current: true`);
  }
  return lines.join("\n");
}

/** 前置状态的短说法。 */
function missingLabel(state) {
  if (state === "open") return "未完成";
  if (state === "dropped") return "已放弃";
  if (state === "missing") return "已删除";
  return state;
}

/**
 * 需求的详情。
 *
 * `sections` 决定给哪些节：`detail`（简介 + 详情）、`versions`、`tasks`。
 * 默认给 `detail` 与 `tasks`。
 *
 * @param plan - 计划树。
 * @param requirement - 需求。
 * @param sections - 要的节名数组。
 * @returns YAML 文本。
 */
export function renderDetail(plan, requirement, sections) {
  const wanted = new Set(Array.isArray(sections) && sections.length > 0 ? sections : ["detail", "tasks"]);
  const lines = ["requirement:"];

  lines.push(`${pad(1)}id: ${scalar(requirement.id)}`);
  lines.push(`${pad(1)}title: ${scalar(requirement.title || "（还没有标题）")}`);
  lines.push(`${pad(1)}status: ${statusLabel(requirement)}`);
  if (!isDraft(requirement)) lines.push(`${pad(1)}version: ${currentVersion(requirement)}`);
  if (requirement.archived === true) lines.push(`${pad(1)}archived: true`);

  if (wanted.has("detail")) {
    field(lines, 1, "intro", requirement.intro);
    const ids = requirement.prerequisites ?? [];
    if (listKey(lines, 1, "prerequisites", ids.length)) {
      for (const id of ids) {
        const missing = new Map(missingPrerequisites(plan, requirement).map((item) => [item.id, item.state]));
        lines.push(`${pad(2)}- ${scalar(missing.has(id) ? `${id}（${missingLabel(missing.get(id))}）` : id)}`);
      }
    }
    field(lines, 1, "detail", requirement.detail);
  }

  if (requirement.pending !== null) {
    lines.push(`${pad(1)}pending_change:`);
    if (requirement.pending.title !== requirement.title) {
      field(lines, 2, "title", requirement.pending.title);
    }
    if (requirement.pending.intro !== requirement.intro) {
      field(lines, 2, "intro", requirement.pending.intro);
    }
    if (requirement.pending.detail !== requirement.detail) {
      lines.push(`${pad(2)}detail_changed: true`);
    }
    field(lines, 2, "question", requirement.pending.question);
  }

  if (wanted.has("versions")) {
    const versions = requirement.versions ?? [];
    if (listKey(lines, 1, "versions", versions.length)) {
      for (const version of versions) {
        const who = version.by === "user" ? "用户" : version.by === "ai" ? "AI" : "迁移";
        lines.push(`${pad(2)}- n: ${version.n}`);
        lines.push(`${pad(3)}by: ${who}`);
        field(lines, 3, "change", version.change);
      }
    }
  }

  if (wanted.has("tasks")) {
    const tasks = requirement.tasks ?? [];
    if (listKey(lines, 1, "tasks", tasks.length)) {
      for (const task of tasks) lines.push(...taskEntry(task, 2));
    }
  }

  field(lines, 1, "result", requirement.result?.text);

  return lines.join("\n");
}

/**
 * 这次新增的任务或步骤。
 *
 * @param nodes - `addChildren()` 报回来的新节点。
 * @param level - 父节点层级：`goal`（新增任务是 `added_tasks`）或 `task`（新增步骤是 `added_steps`）。
 * @returns YAML 文本。
 */
export function renderAdded(nodes, level) {
  const lines = [`added_${level === "goal" ? "tasks" : "steps"}:`];
  for (const node of nodes) {
    lines.push(`  - id: ${scalar(node.id)}`);
    lines.push(`    title: ${scalar(node.title ?? "")}`);
  }
  return lines.join("\n");
}

/**
 * 笔记列表。
 *
 * @param items - 笔记数组（已按需要筛过）。
 * @param query - 用过的关键词，拼在抬头里。
 * @returns 多行文本。
 */
export function renderNotes(items, query) {
  if (items.length === 0) {
    return String(query ?? "").trim() === ""
      ? "这个会话还没有笔记。写一条用 tree_task_note：给 key 和 text。"
      : `没有找到包含「${query}」的笔记。`;
  }
  const head = String(query ?? "").trim() === "" ? `笔记 ${items.length} 条` : `包含「${query}」的笔记 ${items.length} 条`;
  const lines = [head];
  for (const item of items) {
    lines.push(`- **${item.key}** (r${item.rev})：${item.text}`);
  }
  return lines.join("\n");
}

/**
 * 一条完成通告用到的提示拼装：下一步 + 那几行提示。
 *
 * @param next - 下一步那句话。
 * @param hints - 提示行数组。
 * @returns 文本。
 */
export function composeReply(next, hints) {
  const lines = [next];
  for (const hint of hints ?? []) lines.push(hint);
  return lines.join("\n");
}

/** 需求是否还开着（列表里要展开的那一条只可能是它）。 */
export function isLive(requirement) {
  return isOpenRequirement(requirement) || isDraft(requirement);
}
