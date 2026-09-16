import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useStats } from "../lib/useStats";
import { HintBanner } from "../design-system/primitives/HintBanner/HintBanner";
import { PanelSection } from "../design-system/primitives/PanelSection/PanelSection";
import { Button } from "../design-system/primitives/Button/Button";
import { reportIpcError } from "../lib/reportError";
import { useLookupCatalog } from "../lib/useLookupCatalog";
import { gradeColor } from "../lib/gradeColor";
import { gradeLabel } from "../lib/itemLabels";
import type { RecordLogEntry, RecordLogPage, RecordLogSourceFit } from "../../../shared/types";

/**
 * Pagination page size — matches the stats push window (`recentWindow`), so
 * page 0 (the live window) and page 1 (first fetched page) tile the archive
 * without gaps or overlap.
 */
const PAGE_SIZE = 200;

/** `<color=#RRGGBB>…</color>` wrapper the game uses to tint item names. */
const COLOR_TAG_RE = /<color=\s*#([0-9a-fA-F]{6})>([\s\S]*?)<\/color>/g;
/** Any other rich-text tag (Unity-style `<b>`, `<size>`, …). */
const OTHER_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

/**
 * Render a game "获得记录" line exactly as the in-game UI does: colour-tagged
 * spans keep their rarity tint, every other rich-text tag is stripped. Unknown
 * or unparseable lines still render their plain text, so nothing is lost.
 */
function renderRichMessage(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(COLOR_TAG_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const plain = text.slice(last, m.index).replace(OTHER_TAG_RE, "");
      if (plain) nodes.push(plain);
    }
    nodes.push(
      <span key={m.index} style={{ color: `#${m[1].toUpperCase()}` }}>
        {m[2]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const plain = text.slice(last).replace(OTHER_TAG_RE, "");
    if (plain) nodes.push(plain);
  }
  return nodes;
}

/** Fallback for legacy entries that predate `acquireRaw` persistence. */
function structuredFallback(e: RecordLogEntry): string {
  const base = e.acquireName ?? "?";
  return e.acquireCount && e.acquireCount > 1 ? `${base} ×${e.acquireCount}` : base;
}

/**
 * Wall-clock stamp (with date) for the moment the line was recorded. The game's
 * own `acquireTime` is `[HH:MM]` WITHOUT a date, so across days/sessions it
 * cannot tell how recent a line is — showing the real timestamp makes "newest
 * on top" obvious even when the game clock wrapped.
 */
function fmtWall(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${MM}/${DD} ${hh}:${mm}`;
}

/** DEV-only: wall clock with seconds, for the freshness readout below. */
function fmtWallSec(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * DEV-only "now", ticking once a second so the freshness readout below updates.
 * The interval is only created in dev builds — production renders keep the
 * initial value and never subscribe.
 */
function useNowSeconds(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ---------------------------------------------------------------------------
// Source-fit presentation. The main process fits every visible acquire line
// against the three event buckets (chest drops / box opens / stage clears —
// see `core/recordLogFit.ts`); fitted rows get a game-mode badge and a row
// tint, and both the mode and the quality colour are filterable below.
// ---------------------------------------------------------------------------

/** Chest-category hues — aligned with the app's softened grade palette. */
const CHEST_COLORS: Record<string, string> = {
  common: "#c9ccd2",
  rare: "#4aa3ff",
  act: "#dc90df",
  plagueCommon: "#8fd862",
  plagueRare: "#5cd2d6",
  plagueAct: "#8fd862",
};
const CLEAR_COLOR = "#dfc149";
const PLAGUE_COLOR = CHEST_COLORS.plagueCommon;
/** Hero-event tint — the game colours hero lines (被击败/阵亡) purple. */
const HERO_COLOR = "#7030A5";
/** Synthesis lines have no fixed in-game tint — neutral muted dot. */
const SYNTH_COLOR = "#8b93a7";

/** Unfitted-line text rules (renderer-side; only for the category filter). */
const SYNTH_RE = /消耗.*获得|^制作结果|^祈愿结果/;
const HERO_RE = /被击败|阵亡|升级|复活|觉醒|英雄/;

/** Canonical grade order (COMMON → COSMIC) for quality-chip sorting. */
const GRADE_ORDER: readonly string[] = [
  "COMMON",
  "UNCOMMON",
  "RARE",
  "LEGENDARY",
  "IMMORTAL",
  "ARCANA",
  "BEYOND",
  "CELESTIAL",
  "DIVINE",
  "COSMIC",
];

/** Sort key: grades in canonical order first, unmapped grades last. */
function gradeOrderIndex(grade: string | null): number {
  if (!grade) return GRADE_ORDER.length;
  const i = GRADE_ORDER.indexOf(grade);
  return i === -1 ? GRADE_ORDER.length : i;
}

/** Coarse filter buckets over the fit source (hero/synth = renderer text rules). */
type CatFilter =
  | "all"
  | "chestCommon"
  | "chestRare"
  | "chestAct"
  | "chestPlague"
  | "open"
  | "clear"
  | "hero"
  | "synth"
  | "none";

/** i18n key of each filter chip's label. */
const CAT_CHIP_KEYS: Record<CatFilter, string> = {
  all: "filterAll",
  chestCommon: "fitChestCommon",
  chestRare: "fitChestRare",
  chestAct: "fitChestAct",
  chestPlague: "fitChestPlague",
  open: "fitOpen",
  clear: "fitClear",
  hero: "fitHero",
  synth: "fitSynth",
  none: "fitNone",
};

/** Chip dot colour of each filter bucket (chips for colourless buckets omit it). */
const CAT_CHIP_COLORS: Partial<Record<CatFilter, string>> = {
  chestCommon: CHEST_COLORS.common,
  chestRare: CHEST_COLORS.rare,
  chestAct: CHEST_COLORS.act,
  chestPlague: PLAGUE_COLOR,
  clear: CLEAR_COLOR,
  hero: HERO_COLOR,
  synth: SYNTH_COLOR,
};

/** Badge text for a fitted line (exact mode, not the coarse filter bucket). */
function badgeLabel(fit: RecordLogSourceFit, t: TFunction): string {
  // Separator comes from i18n so CJK badges stay compact ("开箱·传奇") while
  // English keeps spaced middots ("Open · Legendary") — matching the chest
  // badges, whose wording already embeds the dot.
  const sep = t("sep");
  if (fit.source === "chest") {
    const c = fit.chestCategory ?? "common";
    return t(`fitChest${c[0]!.toUpperCase()}${c.slice(1)}`);
  }
  if (fit.source === "open") {
    return fit.grade ? `${t("fitOpen")}${sep}${gradeLabel(fit.grade, t)}` : t("fitOpen");
  }
  return fit.stageLabel ? `${t("fitClear")}${sep}${fit.stageLabel}` : t("fitClear");
}

/** Everything the row rendering needs, derived once per stats push. */
interface FitRow {
  e: RecordLogEntry;
  fit: RecordLogSourceFit | null;
  /** Coarse category bucket (the filter dimension). */
  cat: CatFilter;
  /** Quality colour: the line's own rich-text tint, else the open's grade hue. */
  quality: string | null;
  /** Quality grade when resolvable (open fit, or catalog lookup by item name). */
  grade: string | null;
  /** Row tint: chest → chest hue, open → grade hue, clear → gold, unfitted → null. */
  color: string | null;
}

function deriveRow(
  e: RecordLogEntry,
  sources: Record<string, RecordLogSourceFit>,
  nameToGrade: Map<string, string>,
): FitRow {
  const fit = sources[String(e.seq)] ?? null;
  let cat: CatFilter;
  let color: string | null;
  let grade: string | null = null;
  if (!fit) {
    // 未命中三桶拟合的行按文本特征细分（仅影响分类筛选，不加徽章/染色）：
    // 合成 = 消耗…获得 / 制作结果 / 祈愿结果；英雄 = 被击败 / 阵亡 / 升级 等。
    const raw = e.acquireRaw ?? "";
    if (SYNTH_RE.test(raw)) cat = "synth";
    else if (HERO_RE.test(raw)) cat = "hero";
    else cat = "none";
    color = null;
  } else if (fit.source === "open") {
    cat = "open";
    color = gradeColor(fit.grade ?? "UNKNOWN");
    grade = fit.grade ?? null;
  } else if (fit.source === "clear") {
    cat = "clear";
    color = CLEAR_COLOR;
  } else {
    const c = fit.chestCategory ?? "common";
    if (c.startsWith("plague")) {
      cat = "chestPlague";
    } else {
      cat = `chest${c[0]!.toUpperCase()}${c.slice(1)}` as CatFilter;
    }
    color = CHEST_COLORS[c] ?? null;
  }
  let quality: string | null;
  if (e.acquireColor) {
    quality = e.acquireColor.toUpperCase();
    // The game's rich-text tint carries no grade name — look it up from the
    // catalog by the line's item name so quality chips can read "传奇"
    // instead of "#D7D7D7". Open-fit rows already know their grade.
    grade = grade ?? nameToGrade.get(e.acquireName ?? "") ?? null;
  } else {
    quality = fit?.source === "open" && fit.grade ? gradeColor(fit.grade).toUpperCase() : null;
  }
  return { e, fit, cat, quality, color, grade };
}

/** One quality filter chip: the colour to filter by plus a readable label. */
interface QualityChip {
  color: string;
  label: string;
}

/**
 * The record panel, embedded at the bottom of the Live tab (it used to be its
 * own "log" tab). Page 0 renders the live stats window and refreshes with
 * every push; pages ≥ 1 are static archive slices fetched over IPC — same
 * series, same per-page source fit, so badges and filters look identical
 * whether a page arrives live or fetched.
 */
export function RecordLog() {
  const { t } = useTranslation("recordlog");
  const stats = useStats();
  const recordLog = stats?.recordLog;
  const catalog = useLookupCatalog();
  const now = useNowSeconds();
  const [cat, setCat] = useState<CatFilter>("all");
  const [quality, setQuality] = useState<string | null>(null);
  // Pagination: 0 = live stats window (auto-refreshing); ≥ 1 = static archive
  // pages walked backwards in time. The selection persists across pushes.
  const [page, setPage] = useState(0);
  const [archived, setArchived] = useState<RecordLogPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);

  // Fetch an older archive page over IPC whenever the page index leaves the
  // live window. The previous page's data stays on screen until the new slice
  // arrives (no flicker); errors surface via the shared IPC reporter.
  useEffect(() => {
    if (page <= 0) {
      setArchived(null);
      return;
    }
    let cancelled = false;
    setPageLoading(true);
    window.tbh
      .getRecordLogPage(page, PAGE_SIZE)
      .then((p) => {
        if (!cancelled) setArchived(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) reportIpcError(err);
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  // Archive total: live from the stats push on page 0, from the fetched page
  // otherwise (same tracker counter, so the page bar never jumps mid-paging).
  const total = page === 0 ? (recordLog?.total ?? 0) : (archived?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 记录面板完全复刻游戏内「获得记录」界面：数据只来自游戏内存中的完整
  // 获得记录环形区（worker 独立通道初次全量 + 定期增量），不掺入任何
  // 由事件桶合成的掉落/开箱/通关记录。分类徽章/染色只是把每行与三个
  // 事件桶（GetBox 宝箱 / GetItemWithBoxOpen 开箱 / StageClear 通关）
  // 的时间拟合结果标注在旁边，数据本身不变。防御性按 seq 降序（最新
  // 在顶）——游戏内时间无日期，不能用于排序。
  const entries = useMemo(() => {
    const list = page === 0 ? (recordLog?.entries ?? []) : (archived?.entries ?? []);
    return list.filter((e) => e.kind === "acquire").sort((a, b) => b.seq - a.seq);
  }, [recordLog, archived, page]);
  const sources = useMemo(
    () => (page === 0 ? (recordLog?.sources ?? {}) : (archived?.sources ?? {})),
    [recordLog, archived, page],
  );

  // 图鉴目录 → 物品名到品质等级的反查表（本地化名 + 英文原名双键）。
  // 同名键保留首个（目录顺序稳定），避免同名异物之间抖动。目录未就绪时
  // 为空表，品质 chips 退回色值标签，不影响筛选功能。
  const nameToGrade = useMemo(() => {
    const map = new Map<string, string>();
    if (!catalog) return map;
    for (const item of catalog) {
      if (item.grade) {
        if (item.name && !map.has(item.name)) map.set(item.name, item.grade);
        if (item.sourceName && !map.has(item.sourceName)) map.set(item.sourceName, item.grade);
      }
    }
    return map;
  }, [catalog]);

  const rows = useMemo(
    () => entries.map((e) => deriveRow(e, sources, nameToGrade)),
    [entries, sources, nameToGrade],
  );

  // Quality chips: aggregate by colour (the filter value stays the colour so
  // switching labels never breaks saved state), label each colour with the
  // most common resolvable grade, and order chips COMMON → COSMIC (unknown
  // colours last, stable by first appearance).
  const qualityChips = useMemo<QualityChip[]>(() => {
    const order: string[] = [];
    const gradeCounts = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!r.quality) continue;
      if (!gradeCounts.has(r.quality)) {
        gradeCounts.set(r.quality, new Map());
        order.push(r.quality);
      }
      if (r.grade) {
        const counts = gradeCounts.get(r.quality)!;
        counts.set(r.grade, (counts.get(r.grade) ?? 0) + 1);
      }
    }
    return (
      order
        .map((color) => {
          let best: string | null = null;
          let bestN = 0;
          for (const [g, n] of gradeCounts.get(color)!) {
            if (n > bestN) {
              best = g;
              bestN = n;
            }
          }
          return { color, grade: best };
        })
        // 品质筛选只保留能反查到品质等级的色——通关/宝箱/英雄/合成行自带的
        // 游戏杂色（紫=英雄、金=通关、蓝/灰/红=宝箱…）不再是"品质"选项。
        .filter(({ grade }) => grade !== null)
        .sort(
          (a, b) =>
            gradeOrderIndex(a.grade) - gradeOrderIndex(b.grade) ||
            order.indexOf(a.color) - order.indexOf(b.color),
        )
        .map(({ color, grade }) => ({ color, label: grade ? gradeLabel(grade, t) : color }))
    );
  }, [rows, t]);

  // 若当前选中的品质色已被移出 chips（数据刷新后不再是品质色），自动视为
  // 未选中，避免筛选项消失后无法取消。
  const activeQuality = useMemo(
    () => (quality !== null && qualityChips.some((c) => c.color === quality) ? quality : null),
    [quality, qualityChips],
  );

  // Coarse categories present — the chips only offer what the window contains.
  const catChips = useMemo(() => {
    const present = new Set<CatFilter>(rows.map((r) => r.cat));
    const order: CatFilter[] = [
      "chestCommon",
      "chestRare",
      "chestAct",
      "chestPlague",
      "open",
      "clear",
      "hero",
      "synth",
      "none",
    ];
    return order.filter((c) => present.has(c));
  }, [rows]);

  const visible = rows.filter((r) => {
    if (cat !== "all" && r.cat !== cat) return false;
    if (activeQuality !== null && r.quality !== activeQuality) return false;
    return true;
  });

  return (
    <PanelSection title={t("title")} boxed contentClassName="flex flex-col gap-2 p-2.5">
      <p className="m-0 text-[13px] leading-snug text-muted">{t("intro")}</p>

      {rows.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[11px] text-muted">{t("filterCategory")}</span>
            <Chip active={cat === "all"} onClick={() => setCat("all")} label={t("filterAll")} />
            {catChips.map((c) => (
              <Chip
                key={c}
                active={cat === c}
                onClick={() => setCat(cat === c ? "all" : c)}
                label={t(CAT_CHIP_KEYS[c])}
                color={CAT_CHIP_COLORS[c]}
              />
            ))}
          </div>
          {qualityChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-muted">{t("filterQuality")}</span>
              {qualityChips.map((chip) => (
                <Chip
                  key={chip.color}
                  active={activeQuality === chip.color}
                  onClick={() => setQuality(activeQuality === chip.color ? null : chip.color)}
                  label={chip.label}
                  color={chip.color}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {import.meta.env.DEV && (
        <p className="m-0 text-[11px] text-muted">
          dbg: page={page}/{totalPages} total={total} shown={visible.length} topSeq=
          {rows[0]?.e.seq} topAcq={rows[0]?.e.acquireTime ?? "—"} topWall=
          {rows[0] ? fmtWallSec(rows[0].e.wallTime) : "—"} now={fmtWallSec(now)} age=
          {rows[0] ? `${Math.max(0, Math.round(now - rows[0].e.wallTime))}s` : "—"}
        </p>
      )}

      {visible.length === 0 ? (
        <HintBanner>{rows.length === 0 ? t("empty") : t("filteredEmpty")}</HintBanner>
      ) : (
        // Max-height keeps the embedded panel compact inside the Live tab; the
        // list scrolls in place exactly like it did as a standalone tab.
        <ol className="m-0 max-h-[420px] list-none space-y-1 overflow-auto rounded p-1">
          {visible.map(({ e, fit, color }) => {
            const badge = fit ? badgeLabel(fit, t) : null;
            return (
              <li
                key={e.seq}
                className="flex items-baseline gap-2 rounded border-l-2 px-1 py-0.5 text-sm hover:bg-card"
                style={{ borderLeftColor: color ?? "transparent" }}
              >
                <span className="shrink-0 tabular-nums text-xs text-muted">
                  {fmtWall(e.wallTime)}
                </span>
                <span className="shrink-0 tabular-nums text-xs text-muted/70">
                  {e.acquireTime ?? "—"}
                </span>
                {badge && color && (
                  <span
                    className="shrink-0 whitespace-nowrap rounded px-1 text-[10px] leading-4"
                    style={{ color, backgroundColor: `${color}1f` }}
                  >
                    {badge}
                  </span>
                )}
                <span className="min-w-0 break-words">
                  {renderRichMessage(e.acquireRaw ?? structuredFallback(e))}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            size="sm"
            disabled={page === 0 || pageLoading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            {t("pageNewer")}
          </Button>
          <span className="tabular-nums text-xs text-muted">
            {t("pageOf", { page: page + 1, total: totalPages })}
            {pageLoading ? ` · ${t("pageLoading")}` : ""}
          </span>
          <div className="flex items-center gap-2">
            {page > 0 && (
              <Button size="sm" disabled={pageLoading} onClick={() => setPage(0)}>
                {t("pageLatest")}
              </Button>
            )}
            <Button
              size="sm"
              disabled={page >= totalPages - 1 || pageLoading}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            >
              {t("pageOlder")}
            </Button>
          </div>
        </div>
      )}
    </PanelSection>
  );
}

/** Small filter chip: a label with an optional colour dot, toggled by the caller. */
function Chip({
  active,
  onClick,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-transparent bg-muted text-bg"
          : "border-border text-muted hover:bg-muted/50"
      }`}
    >
      {color && (
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      {label}
    </button>
  );
}
