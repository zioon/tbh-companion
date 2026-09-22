// 祈愿行识别 —— 从游戏「获得记录」acquire 行中识别 `LogMessage_OfferingResult`
// （祈愿结果）行，并结构化解析出产出物品。
//
// 为什么不能只靠 `/^祈愿结果/`：`TrackingService.ingestAcquireBatch` 是**数据
// 入口**，只按 zh-CN 前缀判定会让非中文客户端完全丢失祈愿数据。因此本模块
// 采用「多语言前缀白名单 + 严格结构兜底 + 排除表」三层判定，并遵守
// **宁可漏、不可错** 的原则 —— 非祈愿行必须零误判，因为错归会污染品质分布
// 与单品榜。
//
// 纯函数：无 electron / node:fs / fetch / React 依赖，可单测。

import { gradeFromAcquireColor, parseAcquireMessage } from "./acquireLog";
import type { WishGrade } from "../../shared/types";

export type { AcquireItem } from "./acquireLog";

/** 一条祈愿行解析出的产出物品。 */
export interface WishLineItem {
  /** 去富文本标签后的纯物品名。 */
  name: string;
  /** `<color=#RRGGBB>` 品质色（无则 undefined）。 */
  color?: string;
  /** 件数（>=1，缺省 1）。 */
  count: number;
  /** 品质：由 gradeFromAcquireColor(color) 映射，无法映射一律 "UNKNOWN"。 */
  grade: WishGrade;
}

/**
 * 祈愿结果行的前缀白名单（已归一化：去空白 + 小写）。
 *
 * 覆盖四种客户端语言：
 *   - zh-CN：`祈愿结果`
 *   - zh-Hant / ja：`祈願結果`
 *   - en：`Offering result` → `offeringresult`
 *   - ko：`기원 결과` → `기원결과`
 */
const WISH_PREFIX_WHITELIST: readonly string[] = [
  "祈愿结果", // zh-CN
  "祈願結果", // zh-Hant / ja
  "offeringresult", // en
  "기원결과", // ko
];

/**
 * 其他已知「结果类」前缀的排除表 —— 任何命中即判 false。
 *
 * 这些前缀与祈愿结果行共用「XX结果：获得 YYY」的结构，只靠结构无法区分，
 * 必须显式排除，否则制作 / 合成 / 炼金行会被误归入祈愿。
 */
const EXCLUDE_PREFIXES: readonly string[] = [
  "制作结果",
  "合成结果",
  "炼金结果",
  "装饰结果",
  "雕刻结果",
  "铭文结果",
  "铭刻结果",
  "提取结果",
  "改造结果",
  "精炼结果",
  "craftingresult",
  "synthesisresult",
  "alchemyresult",
  "extractionresult",
  "inscriptionresult",
  "engravingresult",
  "refineryresult",
];

/** 「获得」动词（用于结构兜底与名称抽取）。 */
const GAIN_VERBS: readonly string[] = ["获得", "獲得", "obtained", "획득"];

/** 富文本物品标签：`<color=#RRGGBB>…</color>`。 */
const COLOR_TAG_RE = /<color=\s*#[0-9a-fA-F]{6}>([\s\S]*?)<\/color>/i;

/** 任意富文本标签。 */
const ANY_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

/** 尾部标点（中英文句号 / 分号），用于件数抽取前剥离。 */
const TRAILING_PUNCT_RE = /[\s。.;；]+$/;

/**
 * 件数后缀：**必须**显式带 `x` / `X` 前缀（`x5` / `X 5`），行尾、标点已剥离。
 *
 * 为什么不用裸行尾数字（`\d{1,5}$`）：物品名本身可能以数字结尾（如
 * `纪念币2024` / `礼盒 2024`）。剥标签后名称里的数字会暴露到行尾，被误当件数
 * 吞掉，既虚增 `itemCount`（违反 PRD §5.1「缺省 1」），又截断 name。真实归档
 * 证据（`docs/findings/record-log-audit-2026-09-15.md`）显示祈愿行恒为单件形态
 * （`祈愿结果：获得 神秘手套`），多件形态为 `x5` / `X 5` —— 裸行尾数字从来不是
 * 可信的件数来源，故收紧为「宁可少算，不虚增产出」。
 */
const WISH_COUNT_RE = /\b[xX]\s*(\d{1,5})\s*$/;

/** 前缀 / 正文分隔符（半角或全角冒号、句号）—— 用于前缀归一化。 */
const SEP_RE = /[:：。]/;

/**
 * 严格「前缀分隔符」—— 仅冒号（半/全角）。
 *
 * 结构兜底用它区分「<结果前缀>：<获得动词> <物品>」（祈愿模板恒为冒号）与
 * 普通 `获得了<color>X</color>。` 行（以句号结尾、无冒号）。若把句号也算作
 * 前缀分隔符，普通获得行会被误判为祈愿行 —— 违反零误判护栏。
 */
const COLON_RE = /[:：]/;

/**
 * 归一化前缀：取首个冒号（半/全角）或句号之前的内容，去除空白并小写化。
 * 找不到分隔符时返回整行的归一化结果。
 */
function normalizePrefix(rawMessage: string): string {
  const trimmed = (rawMessage ?? "").trim();
  if (!trimmed) return "";
  const sepIdx = trimmed.search(SEP_RE);
  const prefix = sepIdx >= 0 ? trimmed.slice(0, sepIdx) : trimmed;
  return prefix.replace(/\s+/g, "").toLowerCase();
}

/** 去除所有富文本标签并折叠空白（用于结构判断）。 */
function normalizeBody(rawMessage: string): string {
  return (rawMessage ?? "").replace(ANY_TAG_RE, "").replace(/\s+/g, " ").trim();
}

/** 是否含有前缀分隔符（仅冒号）—— 祈愿模板恒有「前缀：…」。 */
function hasPrefixSeparator(rawMessage: string): boolean {
  return COLON_RE.test((rawMessage ?? "").trim());
}

/** 前缀是否属于已知的「其他结果」排除表。 */
function isExcludedPrefix(prefix: string): boolean {
  if (!prefix) return false;
  return EXCLUDE_PREFIXES.some((bad) => prefix.includes(bad));
}

/** 前缀是否命中祈愿白名单（前缀以白名单之一开头即算命中）。 */
function isWhitelistedPrefix(prefix: string): boolean {
  if (!prefix) return false;
  return WISH_PREFIX_WHITELIST.some((ok) => prefix.startsWith(ok));
}

/**
 * 一条 acquire 行是否为「祈愿结果」行。
 *
 * 判定流程（见架构设计 §5.3）：
 *   1) 排除表优先级最高：前缀命中任何其他结果前缀 → false。
 *   2) 前缀命中白名单 → true。
 *   3) 前缀未命中：严格结构兜底 —— 行内同时具备 (a) **前缀分隔符**
 *      （`：`/`:`，祈愿模板恒为「前缀：动词 物品」）、(b) 富文本物品标签、
 *      (c) 「获得」动词 → true。
 *   4) 其余一律 false（宁可漏，不可错）。
 *
 * 注意：第 3 步要求「前缀分隔符」是零误判的关键 —— 普通 `获得了<color>X</color>`
 * 行没有前缀分隔符，因此不会被结构兜底误判为祈愿行。
 *
 * **已知理论窗口（有意接受，QA 2026-09-22 复核）**：结构兜底对「**未知前缀 +
 * 冒号 + 获得动词 + 富文本**」判真 —— 例如 `任务完成：获得了<color=#D7D7D7>永恒之弓</color>。`
 * 会被误判为祈愿行。架构设计 §5.3 明确把结构兜底作为「容忍未知语言客户端」的
 * **有意设计**并接受该风险；现有排除表已覆盖已知的其他「结果类」前缀，且真实
 * 归档样本中**无实证命中**该窗口。若强行收紧为纯白名单，将牺牲未知语言的容错性
 * （非中文客户端会完全丢失祈愿数据），代价大于收益，故本轮保留此窗口。若后续
 * 出现实证误报，优先扩充 `EXCLUDE_PREFIXES` 而非移除兜底。
 */
export function isWishLine(rawMessage: string): boolean {
  const trimmed = (rawMessage ?? "").trim();
  if (!trimmed) return false;

  const prefix = normalizePrefix(trimmed);
  // 排除表优先级最高：任何其他结果前缀一律判假，即使结构兜底会命中。
  if (isExcludedPrefix(prefix)) return false;

  if (isWhitelistedPrefix(prefix)) return true;

  // 结构兜底：白名单未命中时，仅当「有前缀分隔符 + 富文本物品 + 获得动词」
  // 三条件全部满足才判真。这是为了容忍未知语言前缀，同时保持严格。
  const body = normalizeBody(trimmed).toLowerCase();
  const hasSeparator = hasPrefixSeparator(trimmed);
  const hasRichItem = COLOR_TAG_RE.test(trimmed);
  const hasGainVerb = GAIN_VERBS.some((v) => body.includes(v));
  return hasSeparator && hasRichItem && hasGainVerb;
}

/**
 * 从祈愿行抽取件数。先剥掉尾部标点（祈愿模板恒以 `。` 收尾），再匹配
 * `x5` / `X 5` / `5` 形式的行尾数量后缀；无后缀返回 1。**不臆测**：非数字
 * 结尾一律按 1 计（宁可少算，不虚增产出）。
 */
function extractCount(rawMessage: string): number {
  const body = (rawMessage ?? "").replace(ANY_TAG_RE, "").replace(TRAILING_PUNCT_RE, "");
  const m = body.match(WISH_COUNT_RE);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 从祈愿行正文中抽取物品名（无颜色标签时的路径）。
 *
 * 步骤：去标签 → 跳过前缀分隔符及其之前 → 去掉一个前导「获得」动词 →
 * 去掉尾部标点与数量后缀。抽取失败（结果为空）返回空串。
 */
function extractNameFromBody(rawMessage: string): string {
  const body = (rawMessage ?? "").replace(ANY_TAG_RE, "").trim();
  const sepIdx = body.search(SEP_RE);
  let rest = sepIdx >= 0 ? body.slice(sepIdx + 1) : body;
  // 去掉一个前导「获得」动词（大小写不敏感，容忍前导空白）。
  rest = rest.replace(/^\s*/, "");
  const lower = rest.toLowerCase();
  for (const verb of GAIN_VERBS) {
    if (lower.startsWith(verb.toLowerCase())) {
      rest = rest.slice(verb.length);
      break;
    }
  }
  // 去掉尾部标点（中英文句号 / 分号）与数量后缀（**仅** `x3` / `X 3` 形式）。
  // 与 `extractCount` 保持一致：不剥裸行尾数字，否则 `物品2024` 会被截断成
  // `物品`（物品名尾部数字是名称的一部分，不是件数）。
  rest = rest.replace(/[\s。.;；]+$/, "").replace(/\b[xX]\s*\d{1,5}\s*$/, "");
  return rest.trim();
}

/**
 * 从祈愿行解析出产出物品（复用 parseAcquireMessage 的颜色 / 数量能力，
 * 并为无颜色行单独抽取名称）。
 *
 * 返回 null 的情况：
 *   - 不是祈愿行（isWishLine 为假）；
 *   - 无法解析出名称。
 *
 * 品质由 `gradeFromAcquireColor(color)` 映射，**无法映射一律 UNKNOWN，
 * 绝不猜测**。件数缺省 1。
 */
export function parseWishLine(rawMessage: string): WishLineItem | null {
  if (!isWishLine(rawMessage)) return null;

  const parsed = parseAcquireMessage(rawMessage);

  // 件数：`parseAcquireMessage` 的 COUNT_RE 以 `$` 结尾，而祈愿模板恒以句号
  // （`。` / `.`）收尾，导致 `… x5。` 无法命中。故先剥掉尾部标点再独立抽取，
  // 与 acquireLog 的 `x\s*\d` / `\d` 规则保持一致（宁可少算，不臆测）。
  const count = extractCount(rawMessage);

  const mapped = gradeFromAcquireColor(parsed.color);
  const grade: WishGrade = (mapped as WishGrade | null) ?? "UNKNOWN";

  // 有颜色标签：parseAcquireMessage 已从 `<color>` 内抽出纯物品名。
  // 无颜色：parseAcquireMessage 的 name 会退化为整行原文，故单独从正文抽取。
  const name = parsed.color
    ? parsed.name.replace(ANY_TAG_RE, "").trim()
    : extractNameFromBody(rawMessage);
  if (!name) return null;

  return {
    name,
    color: parsed.color,
    count,
    grade,
  };
}
