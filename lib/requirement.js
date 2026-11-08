/**
 * 需求：用户在一个会话里对 AI 提出的要求。**不是一个项目管理对象**——
 * 它记录的是"用户要什么"，不记录"项目长什么样"（见 `docs/09-需求与任务模型.md`）。
 *
 * 纯逻辑模块：不碰 DSH、不碰磁盘。状态由调用方从 store 读出、改完写回。
 *
 * ## 为什么需求直接住在 `plan.goals` 里
 *
 * 需求与原来的「目标」是同一个位置上的东西：都是"一组任务的父节点"。所以需求**就是**
 * 一个加了字段的目标节点，存在 `plan.goals` 里，字段名沿用旧键。这样任务 / 步骤那一层
 * （`findNode`、`addChildren`、`complete`、`dropNode`、`deleteNode`、`activePath`）一个字都不用改，
 * 新旧代码读同一个文件也互不打架。**`goals` 这个键名是历史遗留，指的就是需求。**
 *
 * ## 状态
 *
 * ```
 * draft ──确认──▶ pending ──完成──▶ done
 *                    │                │
 *                    └────放弃───────▶ dropped（划掉，留着可查）
 * ```
 *
 * `pending` 是沿用下来的字面值（旧代码的 `isOpen` 认它），在文档与界面上叫「未完成」。
 *
 * 归档与删除跟上面这条状态线**正交**：归档只是"还占不占活跃列表"，删除是物理摘除。
 *
 * @module dsh-tree-task-flow/requirement
 */

import { STATUS as NODE_STATUS, complete, deleteNode, dropNode, findNode } from "./plan.js";

/** 需求自己的状态取值。前三个与任务节点同名，`draft` 是需求独有的。 */
export const REQUIREMENT_STATUS = {
  /** 草稿：用户建出来 / 用户说了一句，还没被 AI 沟通确认。不进活跃列表。 */
  DRAFT: "draft",
  /** 未完成（沿用旧的 `pending` 字面值）。 */
  OPEN: "pending",
  DONE: "done",
  DROPPED: "dropped",
};

/** 标题与简介的长度上限，单位是**字符**（按码点算，中文一字一个）。超了直接拒绝，不截断。 */
export const LIMITS = { title: 50, intro: 200 };

/** 按码点数字符数。`String#length` 数的是 UTF-16 单元，emoji 会算成两个。 */
export function charCount(text) {
  return Array.from(String(text ?? "")).length;
}

/** 一个需求是不是还开着（未完成、未放弃、已确认）。 */
export function isOpenRequirement(requirement) {
  return requirement?.status === REQUIREMENT_STATUS.OPEN;
}

/** 是不是草稿。 */
export function isDraft(requirement) {
  return requirement?.status === REQUIREMENT_STATUS.DRAFT;
}

/** 已结束（完成或放弃）。 */
export function isClosedRequirement(requirement) {
  return (
    requirement?.status === REQUIREMENT_STATUS.DONE ||
    requirement?.status === REQUIREMENT_STATUS.DROPPED
  );
}

/**
 * 把一条（可能是旧版、或字段不全的）需求补齐成当前形状。
 *
 * **读的时候补，不迁移磁盘上的老文件**——老会话的计划文件保持原样，字段缺什么就在内存里
 * 补什么，写回时自然带上。旧版的目标没有版本历史，这里给它补一条「初始需求」，
 * 版本号 1，`by` 记 `migrated`（界面上区分"这是从老结构来的"）。
 *
 * @param requirement - 需求节点（可以是旧的 goal）。
 * @returns 补齐后的同一个对象（就地修改）。
 */
export function normalizeRequirement(requirement) {
  if (requirement === null || typeof requirement !== "object") return requirement;

  if (typeof requirement.intro !== "string") requirement.intro = "";
  if (requirement.archived !== true) requirement.archived = false;
  if (!Array.isArray(requirement.prerequisites)) requirement.prerequisites = [];
  if (requirement.pending === undefined) requirement.pending = null;

  // 只有**没有** `versions` 字段的记录才是旧版目标。新草稿的 `versions: []` 是有意义的
  // ——它还没被确认过，本来就不该有版本历史。判空数组会凭空给草稿造出一条 v1，
  // 于是第一次确认就变成"v2"。
  if (!Array.isArray(requirement.versions)) {
    requirement.versions = [
      {
        n: 1,
        at: requirement.createdAt ?? null,
        title: requirement.title ?? "",
        intro: requirement.intro,
        detail: requirement.detail ?? "",
        change: "（从旧版目标迁移）",
        by: "migrated",
      },
    ];
  }

  return requirement;
}

/**
 * 校验用户 / AI 交来的需求字段。
 *
 * 超长**不截断**：截断等于悄悄改了用户的需求，宁可让调用方重写一次。返回的是问题清单，
 * 由调用方拼成一句拒绝理由。
 *
 * @param patch - `{ title?, intro?, detail? }` 的任意子集。
 * @returns 问题描述数组；空数组表示没问题。
 */
export function validateFields(patch) {
  const problems = [];

  if (patch?.title !== undefined) {
    if (typeof patch.title !== "string") problems.push("标题必须是字符串");
    else {
      const n = charCount(patch.title.trim());
      if (n === 0) problems.push("标题不能为空");
      else if (n > LIMITS.title) {
        problems.push(`标题 ${n} 字，超过 ${LIMITS.title} 字上限，请精简`);
      }
    }
  }

  if (patch?.intro !== undefined) {
    if (typeof patch.intro !== "string") problems.push("简介必须是字符串");
    else {
      const n = charCount(patch.intro.trim());
      if (n > LIMITS.intro) {
        problems.push(`简介 ${n} 字，超过 ${LIMITS.intro} 字上限，请精简`);
      }
    }
  }

  if (patch?.detail !== undefined && typeof patch.detail !== "string") {
    problems.push("详情必须是字符串");
  }

  return problems;
}

/** 这一版拿去存档的内容快照。 */
function snapshot(requirement) {
  return {
    title: requirement.title,
    intro: requirement.intro,
    detail: requirement.detail,
  };
}

/**
 * 追加一条版本历史，版本号 +1。
 *
 * @param requirement - 需求。
 * @param change - 这次改了什么。
 * @param by - `user` / `ai` / `migrated`。
 * @param now - 时间戳。
 * @returns 新版本对象。
 */
function pushVersion(requirement, change, by, now) {
  const previous = requirement.versions ?? [];
  const n = previous.length === 0 ? 1 : previous[previous.length - 1].n + 1;
  const entry = {
    n,
    at: now,
    ...snapshot(requirement),
    change: String(change ?? "").trim() || "（未说明改了什么）",
    by,
  };
  requirement.versions = [...previous, entry];
  return entry;
}

/** 当前版本号。 */
export function currentVersion(requirement) {
  const versions = requirement?.versions ?? [];
  return versions.length === 0 ? 0 : versions[versions.length - 1].n;
}

/**
 * 分配下一个需求编号。
 *
 * 编号形如 `R1`、`R2`。**删掉的需求不回收它的号**：历史里可能还有别的地方写着 `R3`，
 * 复用一个号会让旧记录指错。所以计数器只增不减，存在 `plan.nextNumber` 上。
 *
 * @param plan - 计划（需求都在 `plan.goals` 里）。
 * @returns 下一个编号数字。
 */
export function nextRequirementNumber(plan) {
  let max = typeof plan?.nextNumber === "number" ? plan.nextNumber - 1 : 0;
  for (const requirement of plan?.goals ?? []) {
    const match = /^R(\d+)$/u.exec(String(requirement?.id ?? ""));
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * 建一条**草稿**需求。
 *
 * 草稿不进活跃列表、不占上下文，只在面板上挂一个「待确认」小格子——等 AI 沟通确认之后
 * 才成为真需求（见 `confirmRequirement`）。三种来源（对话里说、面板上建、用户一口气写全）
 * 走的都是这条路。
 *
 * @param input - `{ title?, intro?, detail?, tasks? }`。只有 `detail` 有可能来自用户原话，
 *   标题与简介通常还是空的，等 AI 沟通后填。
 * @param number - 需求编号数字。
 * @param now - 时间戳。
 * @returns 草稿需求节点。
 */
export function makeDraft(input, number, now = Date.now()) {
  return {
    id: `R${number}`,
    title: String(input?.title ?? "").trim(),
    intro: String(input?.intro ?? "").trim(),
    detail: String(input?.detail ?? ""),
    status: REQUIREMENT_STATUS.DRAFT,
    archived: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    droppedAt: null,
    result: null,
    versions: [],
    pending: null,
    prerequisites: [],
    tasks: Array.isArray(input?.tasks) ? input.tasks : [],
  };
}

/**
 * 往计划里加一条草稿。
 *
 * @param plan - 计划。
 * @param input - 同 `makeDraft`。
 * @param now - 时间戳。
 * @returns 新加的草稿需求。
 */
export function addDraft(plan, input, now = Date.now()) {
  const number = nextRequirementNumber(plan);
  const requirement = makeDraft(input, number, now);
  if (!Array.isArray(plan.goals)) plan.goals = [];
  plan.goals.push(requirement);
  plan.nextNumber = number + 1;
  plan.version = 3;
  plan.updatedAt = now;
  return requirement;
}

/**
 * 按 id 找需求。找不到返回 null。
 *
 * @param plan - 计划。
 * @param id - 需求编号，例如 `R3`。
 * @returns 需求节点或 null。
 */
export function requirementOf(plan, id) {
  const wanted = String(id ?? "").trim();
  if (wanted === "") return null;
  return (plan?.goals ?? []).find((item) => item.id === wanted) ?? null;
}

/**
 * 把草稿确认成正式需求（AI 沟通完之后的那一步）。
 *
 * 确认时把标题 / 简介 / 详情一次写清，并落下 v1 版本历史。用户一口气写全的那种，
 * AI 确认一遍即可转正，不必重复提问。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param patch - `{ title, intro?, detail?, change? }`；`title` 必填。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement?, version? }`。
 */
export function confirmRequirement(plan, id, patch, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };
  if (!isDraft(requirement)) {
    return { ok: false, reason: `${id} 已经是正式需求了，改它请走「变更」` };
  }

  const problems = validateFields(patch);
  if (problems.length > 0) return { ok: false, reason: problems.join("；") };
  // 草稿里已经有标题就沿用——用户在对话里说清、AI 建草稿时已经填过的那种，
  // 确认时再逼着抄一遍标题只是白费一次工具调用（实测被自己绊到过）。
  const title = String(patch?.title ?? "").trim() || String(requirement.title ?? "").trim();
  if (title === "") return { ok: false, reason: "确认成正式需求要给它一个标题" };

  requirement.title = title;
  if (typeof patch?.intro === "string") requirement.intro = patch.intro.trim();
  if (typeof patch?.detail === "string") requirement.detail = patch.detail;
  requirement.status = REQUIREMENT_STATUS.OPEN;
  requirement.updatedAt = now;
  const version = pushVersion(requirement, patch?.change ?? "初始需求", "ai", now);
  plan.updatedAt = now;

  return { ok: true, requirement, version };
}

/**
 * AI 改需求正文：只改给出的字段，需求回到草稿，等确认时才落版本。
 *
 * 草稿也能改：草稿阶段的正文本身就是要反复补充的，确认之前不产生版本。
 * 已确认的需求被改正文后同样回到草稿——正文是用户要什么的那份约定，
 * 改完要再确认一次，版本只在确认时生成，于是版本历史里不存在「没被确认过的一版」。
 *
 * **有一条硬闸门**：需求上有用户提交的暂定版本时，AI 不能直接改正文——那份暂定版本是
 * 基于旧正文写的，AI 先改了正文，用户确认时就会覆盖掉 AI 的改动，或者反过来。所以先
 * `confirmPending` 或 `questionPending`，再改。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param patch - `{ title?, intro?, detail?, change? }`。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement?, changed?, noop? }`。
 */
export function updateByAi(plan, id, patch, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };
  if (isClosedRequirement(requirement)) {
    return { ok: false, reason: `${id} 已经${requirement.status === REQUIREMENT_STATUS.DONE ? "完成" : "放弃"}了，不能改` };
  }
  if (requirement.pending !== null) {
    return {
      ok: false,
      reason: `${id} 有一条用户改动等着你确认（暂定版本），先确认或者退回，再改正文`,
    };
  }

  const problems = validateFields(patch);
  if (problems.length > 0) return { ok: false, reason: problems.join("；") };

  const changed = applyPatch(requirement, patch);
  if (changed.length === 0) {
    // 只给了 `change`：正文没变，但这仍然是一次「把用户的话写进需求」的登记。
    // 没有这条路，"用户说了句继续"就永远满足不了折叠的前提，只能逼模型去改正文。
    // **不升版**：正文没变就没有新版本，版本历史里不该多出一条空变动。
    const note = String(patch?.change ?? "").trim();
    if (note === "") {
      return { ok: false, reason: "没有给出任何要改的字段（title / intro / detail）" };
    }
    requirement.updatedAt = now;
    plan.updatedAt = now;
    return { ok: true, requirement, changed, noop: true };
  }

  // 正文变了就回草稿等确认；版本在 confirm 时落。
  requirement.status = REQUIREMENT_STATUS.DRAFT;
  requirement.updatedAt = now;
  plan.updatedAt = now;
  return { ok: true, requirement, changed };
}

/**
 * 把 patch 里给出的字段写到需求上。
 *
 * @param requirement - 需求。
 * @param patch - `{ title?, intro?, detail? }`。
 * @returns 真正改到的字段名数组。
 */
function applyPatch(requirement, patch) {
  const changed = [];
  if (typeof patch?.title === "string" && patch.title.trim() !== "") {
    requirement.title = patch.title.trim();
    changed.push("title");
  }
  if (typeof patch?.intro === "string") {
    requirement.intro = patch.intro.trim();
    changed.push("intro");
  }
  if (typeof patch?.detail === "string") {
    requirement.detail = patch.detail;
    changed.push("detail");
  }
  return changed;
}

/**
 * 用户改需求：**只生成暂定版本，不动正在生效的正文**。
 *
 * 改的是字，活儿不能跟着抖——所以工作仍按生效版本走，等 AI 确认之后才转正
 * （`confirmPending`）。点「确认变更」这个动作**不唤醒 AI**，AI 下次被唤起时
 * 先看这条待确认。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param patch - `{ title?, intro?, detail?, change? }`。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement?, pending? }`。
 */
export function updateByUser(plan, id, patch, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };
  if (isClosedRequirement(requirement)) {
    return { ok: false, reason: `${id} 已经${requirement.status === REQUIREMENT_STATUS.DONE ? "完成" : "放弃"}了，不能改` };
  }

  const problems = validateFields(patch);
  if (problems.length > 0) return { ok: false, reason: problems.join("；") };

  // 草稿还没有生效版本，用户改了就直接写进草稿正文，不产生暂定版本。
  if (isDraft(requirement)) {
    const changed = applyPatch(requirement, patch);
    if (changed.length === 0) {
      return { ok: false, reason: "没有给出任何要改的字段（title / intro / detail）" };
    }
    requirement.updatedAt = now;
    plan.updatedAt = now;
    return { ok: true, requirement, changed };
  }

  // 暂定版本是**整份快照**：用户在生效版本的基础上改了几处，其余字段保持生效版本的样子。
  const base = requirement.pending ?? snapshot(requirement);
  const merged = {
    title: typeof patch?.title === "string" ? patch.title.trim() : base.title,
    intro: typeof patch?.intro === "string" ? patch.intro.trim() : base.intro,
    detail: typeof patch?.detail === "string" ? patch.detail : base.detail,
  };

  if (
    merged.title === requirement.title &&
    merged.intro === requirement.intro &&
    merged.detail === requirement.detail
  ) {
    // 改回了和生效版本一模一样的内容：撤掉暂定版本，不用等 AI 确认。
    requirement.pending = null;
    requirement.updatedAt = now;
    plan.updatedAt = now;
    return { ok: true, requirement, pending: null, cancelled: true };
  }

  requirement.pending = {
    ...merged,
    change: String(patch?.change ?? "").trim(),
    at: now,
    by: "user",
    question: null,
  };
  requirement.updatedAt = now;
  plan.updatedAt = now;
  return { ok: true, requirement, pending: requirement.pending };
}

/**
 * AI 确认用户提交的暂定版本：正文改成暂定版本的内容，版本 +1。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param change - 这次改了什么；不给就用用户填的那句，再没有就是「用户提出的变更」。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement?, version? }`。
 */
export function confirmPending(plan, id, change, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };

  const pending = requirement.pending;
  if (pending === null) return { ok: false, reason: `${id} 没有等确认的改动` };
  if (isClosedRequirement(requirement)) {
    return { ok: false, reason: `${id} 已经${requirement.status === REQUIREMENT_STATUS.DONE ? "完成" : "放弃"}了，不能再确认改动` };
  }

  requirement.title = pending.title;
  requirement.intro = pending.intro;
  requirement.detail = pending.detail;
  requirement.pending = null;
  requirement.updatedAt = now;

  const text = String(change ?? "").trim() || String(pending.change ?? "").trim() || "用户提出的变更";
  const version = pushVersion(requirement, text, "user", now);
  plan.updatedAt = now;
  return { ok: true, requirement, version };
}

/**
 * AI 认为暂定版本有歧义：**不转正，把疑问记下来**，等用户再改。
 *
 * 这一步存在的理由就是歧义与错别字——用户维护的是"要什么"，他写的那句话 AI 读完
 * 不一定靠得住，所以需求偏移的最后一道闸门在 AI 这一侧。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param question - 要问用户的话（必填，不能空问）。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement?, pending? }`。
 */
export function questionPending(plan, id, question, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };
  if (requirement.pending === null) return { ok: false, reason: `${id} 没有等确认的改动` };

  const text = String(question ?? "").trim();
  if (text === "") return { ok: false, reason: "要问什么得写出来，不能空着退回" };

  requirement.pending.question = text;
  requirement.pending.at = now;
  requirement.updatedAt = now;
  plan.updatedAt = now;
  return { ok: true, requirement, pending: requirement.pending };
}

/**
 * 完成一条需求。
 *
 * 谁来拍板：**AI 觉得完成就完成**，不需要用户点头，工具不拦。完成时提交的那段文字就是
 * 「总结」——它同时是别的需求快速查阅时看到的东西。存储上用的是旧的 `result` 字段
 * （渲染、检查点、折叠都认它），文档里叫总结。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param summary - 总结：做了什么、结论、坑、给后续需求的注意。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement?, events?, hints? }`。
 */
export function completeRequirement(plan, id, summary, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };
  if (isDraft(requirement)) return { ok: false, reason: `${id} 还是草稿，不能完成` };
  if (requirement.pending !== null) {
    return {
      ok: false,
      reason: `${id} 有一条用户改动等着确认，先确认或退回再完成`,
    };
  }

  const done = complete(plan, id, summary, now);
  if (!done.ok) return done;
  requirement.completedAt = now;
  plan.updatedAt = now;
  return { ...done, requirement, hints: completionHints(plan, requirement) };
}

/**
 * 放弃一条需求：划掉、留着可查，它下面的未结束任务一并放弃。
 *
 * 已完成的需求不能放弃——那会毁掉它的总结。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement?, dropped? }`。
 */
export function dropRequirement(plan, id, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };
  if (isDraft(requirement)) {
    // 草稿直接删，不必先放弃一次。
    return { ok: false, reason: `${id} 还是草稿，直接删掉就好` };
  }

  const result = dropNode(plan, id, now);
  if (!result.ok) return result;
  requirement.droppedAt = now;
  plan.updatedAt = now;
  return { ...result, requirement };
}

/**
 * 删除一条需求：物理摘除，不可逆，不看状态——已完成的照样删得掉。
 *
 * 与放弃的区别见 `dropRequirement`：放弃回答"这件事还做不做"，删除是"这条记录不该留在这儿"。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, removed? }`。
 */
export function deleteRequirement(plan, id, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) {
    // 草稿也走这里；`requirementOf` 认的就是 `plan.goals`，草稿同样在里面。
    return { ok: false, reason: `找不到需求 ${id}` };
  }
  return deleteNode(plan, id, now);
}

/**
 * 归档 / 取消归档。
 *
 * 归档是**用户控制固定占用多少的阀门**：从活跃列表消失，查得到，可取消。它跟完成状态
 * 正交——完成过但没归档的需求，仍然在活跃列表里。草稿不能归档（它本来就不在列表里）。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param archived - `true` 归档，`false` 取消归档。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement?, changed? }`。
 */
export function setArchived(plan, id, archived, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };
  if (isDraft(requirement)) {
    return { ok: false, reason: `${id} 还是草稿，草稿本来就不在活跃列表里` };
  }

  const wanted = archived === true;
  const changed = requirement.archived !== wanted;
  requirement.archived = wanted;
  requirement.updatedAt = now;
  plan.updatedAt = now;
  return { ok: true, requirement, changed };
}

/**
 * 设置前置需求。成环直接拒绝——环里的需求永远等不到"前置全部满足"。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @param ids - 前置需求编号数组。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, requirement? }`。
 */
export function setPrerequisites(plan, id, ids, now = Date.now()) {
  const requirement = requirementOf(plan, id);
  if (requirement === null) return { ok: false, reason: `找不到需求 ${id}` };
  if (!Array.isArray(ids)) return { ok: false, reason: "前置需求要给一个编号数组" };

  const wanted = [];
  for (const raw of ids) {
    const target = String(raw ?? "").trim();
    if (target === "") continue;
    if (target === id) return { ok: false, reason: "需求不能把自己当前置" };
    if (requirementOf(plan, target) === null) {
      return { ok: false, reason: `找不到前置需求 ${target}` };
    }
    if (!wanted.includes(target)) wanted.push(target);
  }

  // 探环：从每个要加的前置出发，能走回自己就是环。
  for (const target of wanted) {
    if (reaches(plan, target, id, new Set())) {
      return { ok: false, reason: `前置成环：${target} 已经（直接或间接）依赖 ${id}` };
    }
  }

  requirement.prerequisites = wanted;
  requirement.updatedAt = now;
  plan.updatedAt = now;
  return { ok: true, requirement };
}

/**
 * 从 `from` 沿前置关系往下走，能不能走到 `to`。
 *
 * @param plan - 计划。
 * @param from - 起点需求编号。
 * @param to - 目标需求编号。
 * @param seen - 已访问集合，防死循环。
 * @returns 能走到为 true。
 */
function reaches(plan, from, to, seen) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const requirement = requirementOf(plan, from);
  if (requirement === null) return false;
  return (requirement.prerequisites ?? []).some((id) => reaches(plan, id, to, seen));
}

/**
 * 这条需求还缺哪些前置。
 *
 * `state` 为 `done` 的算满足；`open` 是还没做；`dropped` 是放弃；`missing` 是被删掉了
 * （悬空——不静默当满足，要让调用方说一句）。
 *
 * @param plan - 计划。
 * @param requirement - 需求节点。
 * @returns `[{ id, title, state }]`。
 */
export function missingPrerequisites(plan, requirement) {
  const rows = [];
  for (const id of requirement?.prerequisites ?? []) {
    const target = requirementOf(plan, id);
    if (target === null) {
      rows.push({ id, title: null, state: "missing" });
      continue;
    }
    if (target.status === REQUIREMENT_STATUS.DONE) continue;
    rows.push({
      id,
      title: target.title,
      state: target.status === REQUIREMENT_STATUS.DROPPED ? "dropped" : "open",
    });
  }
  return rows;
}

/**
 * 哪些需求以 `id` 为前置（下游）。
 *
 * @param plan - 计划。
 * @param id - 需求编号。
 * @returns 需求节点数组，按创建顺序。
 */
export function dependentsOf(plan, id) {
  return (plan?.goals ?? []).filter((item) => (item.prerequisites ?? []).includes(id));
}

/**
 * 完成一条需求时给的那几行提示。**只出提示，不改任何状态。**
 *
 * 三件事：
 * 1. 下游已经自报完成的 → 顺序颠倒，建议复核（它是在本需求没做完时完成的）；
 * 2. 下游的前置因为这次完成而全部满足 → 可以开始了；
 * 3. 本需求自己是跳着做的（前置还缺）→ 记一句，不追问；
 * 4. 整个会话的需求都结束了 → 收尾。
 *
 * @param plan - 计划。
 * @param requirement - 刚完成的需求。
 * @returns 提示行数组，可能为空。
 */
export function completionHints(plan, requirement) {
  const hints = [];

  for (const dependent of dependentsOf(plan, requirement.id)) {
    if (dependent.status === REQUIREMENT_STATUS.DONE) {
      hints.push(
        `${dependent.id} 依赖本需求且已自报完成——它是在本需求没做完时完成的，建议回头复核。`,
      );
      continue;
    }
    if (isOpenRequirement(dependent) && missingPrerequisites(plan, dependent).length === 0) {
      hints.push(`${dependent.id} 的前置全部满足，可以开始了。`);
    }
  }

  const missing = missingPrerequisites(plan, requirement);
  if (missing.length > 0) {
    const names = missing.map((item) => `${item.id}（${stateLabel(item.state)}）`).join("、");
    hints.push(`${requirement.id} 的前置仍缺 ${names}，本次是跳着做的。`);
  }

  if ((plan?.goals ?? []).every((item) => isClosedRequirement(item) || isDraft(item))) {
    hints.push("这个会话的需求全部完成。");
  }

  return hints;
}

/** 前置状态的短说法。 */
function stateLabel(state) {
  if (state === "open") return "未完成";
  if (state === "dropped") return "已放弃";
  if (state === "missing") return "已被删除";
  return state;
}

/**
 * 完成一个**任务**时给的那几行提示。
 *
 * @param requirement - 任务所属的需求。
 * @returns 提示行数组，可能为空。
 */
export function taskCompletionHints(requirement) {
  const tasks = requirement?.tasks ?? [];
  if (tasks.length === 0) return [];

  const open = tasks.filter((task) => task.status === NODE_STATUS.PENDING);
  if (open.length === 1) return ["这条需求下还剩 1 个任务。"];
  if (open.length > 1) return [`这条需求下还剩 ${open.length} 个任务。`];
  if (tasks.every((task) => task.status === NODE_STATUS.DONE)) {
    return ["这条需求的任务都完了，可以写总结并完成它。"];
  }
  return [];
}

/**
 * 一条需求"最后动过"的时间。
 *
 * 「当前进行中」是由**最后执行的那个任务**推导出来的，不另存状态——少一个要同步的状态，
 * 就少一类 bug。任务、子任务的完成时间与创建时间都算活动。
 *
 * @param requirement - 需求。
 * @returns 时间戳；从没动过是 0。
 */
export function activityAt(requirement) {
  let at = Number(requirement?.startedAt ?? 0);
  for (const task of requirement?.tasks ?? []) {
    at = Math.max(at, Number(task.completedAt ?? 0), Number(task.createdAt ?? 0));
    for (const step of task.steps ?? []) {
      at = Math.max(at, Number(step.completedAt ?? 0), Number(step.createdAt ?? 0));
    }
  }
  return at;
}

/**
 * 当前进行中的需求（列表里要展开的那一条）。
 *
 * 取**还开着、且没归档**的需求里活动时间最新的那一条；所有需求都没有任务动过时，
 * 退回「最后更新的那一条」。找不到就是 null。
 *
 * 归档的必须排除：它已经不在活跃列表里，选了它就会出现「一条谁也没展开、当前标记
 * 也不见了」的怪象——实测在重启后的真会话里踩到过。
 *
 * @param plan - 计划。
 * @returns 需求节点或 null。
 */
export function activeRequirement(plan) {
  const open = (plan?.goals ?? []).filter(
    (requirement) => isOpenRequirement(requirement) && requirement.archived !== true,
  );
  if (open.length === 0) return null;

  let best = null;
  let bestAt = -1;
  for (const requirement of open) {
    const at = activityAt(requirement);
    if (at > bestAt) {
      best = requirement;
      bestAt = at;
    }
  }
  if (bestAt > 0) return best;

  return open.reduce((a, b) => (Number(b.updatedAt ?? 0) > Number(a.updatedAt ?? 0) ? b : a));
}

/**
 * 活跃列表：**未归档、未删除**的需求，一行一条（草稿不算——它还没被确认过）。
 *
 * 放弃的需求仍然在这里，带着"已放弃"的标记——它回答的是"这件事还做不做"，
 * 不是"还占不占地方"。
 *
 * @param plan - 计划。
 * @returns 行数组 `{ id, title, intro, status, missing, nextTask, pending }`。
 */
export function listActive(plan) {
  return (plan?.goals ?? [])
    .filter((requirement) => !isDraft(requirement) && requirement.archived !== true)
    .map((requirement) => indexRow(plan, requirement));
}

/**
 * 已归档列表。
 *
 * @param plan - 计划。
 * @returns 行数组，同 `listActive`。
 */
export function listArchived(plan) {
  return (plan?.goals ?? [])
    .filter((requirement) => !isDraft(requirement) && requirement.archived === true)
    .map((requirement) => indexRow(plan, requirement));
}

/**
 * 还没被确认的草稿（面板上那个「待确认」小格子）。
 *
 * @param plan - 计划。
 * @returns 草稿需求数组。
 */
export function listDrafts(plan) {
  return (plan?.goals ?? []).filter(isDraft);
}

/**
 * 列表里那一行。
 *
 * @param plan - 计划。
 * @param requirement - 需求。
 * @returns `{ id, title, intro, status, missing, nextTask, pending }`。
 */
function indexRow(plan, requirement) {
  return {
    id: requirement.id,
    title: requirement.title,
    intro: requirement.intro,
    status: requirement.status,
    missing: missingPrerequisites(plan, requirement).map((item) => item.id),
    nextTask: nextTaskOf(requirement),
    // 用真值判断而不是 `!== null`：读进来的对象可能根本没有这个字段（旧数据、
    // 或者调用方手工造的节点），`undefined !== null` 会一路走到 `.change` 上炸掉。
    pending: requirement.pending
      ? requirement.pending.change || "（未说明改了什么）"
      : null,
  };
}

/**
 * 这条需求下一个要做的任务。
 *
 * @param requirement - 需求。
 * @returns 任务节点或 null。
 */
export function nextTaskOf(requirement) {
  return (requirement?.tasks ?? []).find((task) => task.status === NODE_STATUS.PENDING) ?? null;
}

/**
 * 展开一条需求的进度：一级是任务目标，二级是步骤。
 *
 * 列表里只展开**当前进行中**的那一条，所以这个函数只给它用。
 *
 * @param requirement - 需求。
 * @returns `[{ task, steps }]`，`steps` 是该任务下的子任务数组。
 */
export function progressOf(requirement) {
  return (requirement?.tasks ?? []).map((task) => ({ task, steps: task.steps ?? [] }));
}

/**
 * 在计划里定位一个任务所属的需求。
 *
 * @param plan - 计划。
 * @param taskId - 任务或子任务的 id。
 * @returns 需求节点或 null。
 */
export function requirementOfTask(plan, taskId) {
  const found = findNode(plan, taskId);
  return found === null ? null : found.goal;
}
