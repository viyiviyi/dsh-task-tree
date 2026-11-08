/**
 * 需求的渲染：给 `tree_task_status` 用的几种输出。
 *
 * 与 `lib/plan.js` 里那套「目标 / 任务 / 子任务」的树渲染分开：那是给**面板与旧调用点**用的，
 * 这一套说的是「需求」的语言——列表一行一条、详情分节、只展开当前进行中的那一条。
 *
 * 两个原则：
 *
 * 1. **常驻开销要小**。列表一行 = 编号 + 状态 + 标题 + 简介，别的一个字都不带；
 *    版本、任务结果、笔记这些要主动查才给。
 * 2. **不截断**。给了正文就整段输出——截掉半句等于没交付（与 tree_task_done 的 result 同一个理由）。
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
  return "未完成";
}

/** 任务 / 步骤的勾选标记，写法与 plan.js 保持一致。 */
function mark(node) {
  if (node.status === STATUS.DONE) return "[x]";
  if (node.status === STATUS.DROPPED) return "[-]";
  return "[ ]";
}

/** 缩进。 */
const INDENT = "  ";

/**
 * 把多行文本作为一条列表项的续行挂上去。
 *
 * @param lines - 输出行数组。
 * @param pad - 缩进。
 * @param text - 正文。
 */
function appendBlock(lines, pad, text) {
  for (const row of String(text ?? "").replace(/\r\n?/gu, "\n").split("\n")) {
    lines.push(row === "" ? "" : `${pad}${row}`);
  }
}

/**
 * 列表。
 *
 * @param plan - 计划。
 * @param rows - 行数据：`{ active, archived, drafts }`。
 * @param active - 当前进行中的需求（展开那一条）。
 * @returns 多行 Markdown。
 */
export function renderList(plan, rows, active) {
  const lines = [];
  const counts = `活跃 ${rows.active.length} 条 · 已归档 ${rows.archived.length} 条 · 草稿 ${rows.drafts.length} 条`;
  lines.push(`需求列表（${counts}）`);
  lines.push("");

  if (rows.active.length === 0 && rows.archived.length === 0 && rows.drafts.length === 0) {
    lines.push("这个会话还没有任何需求。用户说一句要做什么，先用 tree_task_create 记成草稿，沟通清楚后确认。");
    return lines.join("\n");
  }

  for (const requirement of rows.active) {
    const here = active !== null && active.id === requirement.id;
    lines.push(`- ${listLineBody(requirement)}${here ? " ← 当前" : ""}`);
    if (requirement.intro) appendBlock(lines, `${INDENT}`, requirement.intro);
    const missing = missingPrerequisites(plan, requirement);
    if (missing.length > 0) {
      lines.push(
        `${INDENT}缺前置：${missing.map((item) => `${item.id}（${missingLabel(item.state)}）`).join("、")}`,
      );
    }
    if (requirement.pending !== null) {
      lines.push(`${INDENT}待确认变动：${requirement.pending.change || "（未说明改了什么）"}`);
    }
    if (here) appendProgress(lines, requirement);
  }

  if (rows.archived.length > 0) {
    lines.push("");
    lines.push("已归档（不占常驻，可按编号查）：");
    for (const requirement of rows.archived) {
      lines.push(`- ${listLineBody(requirement)}`);
    }
  }

  if (rows.drafts.length > 0) {
    lines.push("");
    lines.push("草稿（还没跟用户确认，不算真需求）：");
    for (const requirement of rows.drafts) {
      lines.push(
        `- ${requirement.id} ${requirement.title || "（还没有标题）"} — 确认它用 tree_task_requirement action=confirm`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * 「简」版列表：一条需求一行，不带简介、不带进度。
 *
 * 给**需求完成**那一刻用——那一下上下文被整条折掉，返回里要能一眼看出还剩哪几条。
 *
 * @param rows - 行数据：`{ active, archived, drafts }`。
 * @param active - 当前进行中的需求（打「当前」标记）。
 * @returns 多行 Markdown。
 */
export function renderBriefList(rows, active) {
  const counts = `活跃 ${rows.active.length} 条 · 已归档 ${rows.archived.length} 条 · 草稿 ${rows.drafts.length} 条`;
  const lines = [`需求列表（${counts}）`];
  if (rows.active.length === 0) {
    lines.push("");
    lines.push("没有活跃需求了。");
    return lines.join("\n");
  }
  for (const requirement of rows.active) {
    const here = active !== null && active.id === requirement.id;
    lines.push(`- ${listLineBody(requirement)}${here ? " ← 当前" : ""}`);
  }
  return lines.join("\n");
}

/**
 * 一行需求去掉勾选框之后的内容（勾选框由调用方拼）。
 *
 * @param requirement - 需求。
 * @returns 文本。
 */
function listLineBody(requirement) {
  const bits = [`**${requirement.id}** · ${statusLabel(requirement)}`, requirement.title || "（还没有标题）"];
  if (requirement.archived === true) bits.push("【已归档】");
  return bits.join(" ");
}

/** 前置状态的短说法。 */
function missingLabel(state) {
  if (state === "open") return "未完成";
  if (state === "dropped") return "已放弃";
  if (state === "missing") return "已删除";
  return state;
}

/**
 * 展开一条需求的进度：一级任务、二级步骤。
 *
 * @param lines - 输出行数组。
 * @param requirement - 需求。
 */
function appendProgress(lines, requirement) {
  const rows = progressOf(requirement);
  if (rows.length === 0) {
    lines.push(`${INDENT}还没有任务，用 tree_task_plan 给它拆任务。`);
    return;
  }
  for (const { task, steps } of rows) {
    lines.push(`${INDENT}- ${mark(task)} ${task.title}`);
    for (const step of steps) {
      lines.push(`${INDENT}${INDENT}- ${mark(step)} ${step.title}`);
    }
  }
}

/**
 * 前置那一行：满足的只写编号，没满足的在编号后面标状态。
 *
 * 不能"列出全部编号"再另起一句"缺谁"——那会把同一个编号说两遍
 * （`g-x（缺 g-x（未完成））`），实测在真会话里就这么显示过。
 *
 * @param plan - 计划。
 * @param requirement - 需求。
 * @returns 一行文本。
 */
function prerequisiteLine(plan, requirement) {
  const ids = requirement.prerequisites ?? [];
  if (ids.length === 0) return "无";
  const missing = new Map(missingPrerequisites(plan, requirement).map((item) => [item.id, item.state]));
  return ids.map((id) => (missing.has(id) ? `${id}（${missingLabel(missing.get(id))}）` : id)).join("、");
}

/**
 * 需求详情。
 *
 * `sections` 决定给哪些节：`detail`（简介 + 详情）、`versions`、`tasks`（任务与结果）、
 * `notes` 由调用方另外拼。默认给 `detail` 与 `tasks`。
 *
 * @param plan - 计划。
 * @param requirement - 需求。
 * @param sections - 要的节名数组。
 * @returns 多行 Markdown。
 */
export function renderDetail(plan, requirement, sections) {
  const wanted = new Set(Array.isArray(sections) && sections.length > 0 ? sections : ["detail", "tasks"]);
  const lines = [];

  const head = [`## ${requirement.id} · ${requirement.title || "（还没有标题）"}`];
  const meta = [statusLabel(requirement)];
  if (requirement.archived === true) meta.push("已归档");
  // 草稿还没有版本历史，写 v0 只会让人以为出错了。
  if (!isDraft(requirement)) meta.push(`v${currentVersion(requirement)}`);
  head.push(meta.join(" · "));
  lines.push(head.join(" "));
  lines.push("");

  if (wanted.has("detail")) {
    if (requirement.intro) lines.push(`**简介**：${requirement.intro}`);
    lines.push(`**前置**：${prerequisiteLine(plan, requirement)}`);
    if (requirement.detail) {
      lines.push("");
      lines.push("**详情**：");
      lines.push(requirement.detail);
    }
  }

  if (requirement.pending !== null) {
    lines.push("");
    lines.push("**等确认的变动**（用户提交的暂定版本）：");
    if (requirement.pending.title !== requirement.title) lines.push(`- 标题：${requirement.pending.title}`);
    if (requirement.pending.intro !== requirement.intro) lines.push(`- 简介：${requirement.pending.intro}`);
    if (requirement.pending.detail !== requirement.detail) lines.push(`- 详情有改动`);
    if (requirement.pending.question) lines.push(`- 上次问到：${requirement.pending.question}`);
  }

  if (wanted.has("versions")) {
    lines.push("");
    lines.push("**版本历史**：");
    for (const version of requirement.versions ?? []) {
      const who = version.by === "user" ? "用户" : version.by === "ai" ? "AI" : "迁移";
      lines.push(`- v${version.n}（${who}）：${version.change}`);
    }
  }

  if (wanted.has("tasks")) {
    lines.push("");
    lines.push("**任务**：");
    const tasks = requirement.tasks ?? [];
    if (tasks.length === 0) {
      lines.push("- 还没有任务，用 tree_task_plan 拆");
    }
    for (const task of tasks) {
      lines.push(`- ${mark(task)} ${task.title} \`${task.id}\``);
      for (const step of task.steps ?? []) {
        lines.push(`${INDENT}- ${mark(step)} ${step.title} \`${step.id}\``);
      }
      if (task.result?.text) {
        lines.push(`${INDENT}**结果**：`);
        appendBlock(lines, `${INDENT}${INDENT}`, task.result.text);
      }
    }
  }

  if (requirement.result?.text) {
    lines.push("");
    lines.push("**总结**：");
    lines.push(requirement.result.text);
  }

  return lines.join("\n");
}

/**
 * 笔记列表。
 *
 * @param items - 笔记数组（已按需要筛过）。
 * @param query - 用过的关键词，拼在抬头里。
 * @returns 多行 Markdown。
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
