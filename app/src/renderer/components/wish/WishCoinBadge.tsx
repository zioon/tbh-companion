import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { WishCoinAttribution } from "../../../../shared/types";
import { gradeColor } from "../../lib/gradeColor";
import { candidateNames } from "../../lib/wishCoin";

/** coinKey → 硬币元数据解析器（与 `useWish().coinResolver` 同型）。 */
type CoinResolver = (
  coinKey: number,
) => { coinKey: number; name: string; grade: string; iconPath: string } | undefined;

/**
 * 硬币归因徽章（Wish v2，P1-1 可视化）。
 *
 * 四档置信度呈现（视觉诚实，见 PRD §Q1）：
 *  - `observed`（实证）：**实线**描边 + 硬币名 + 品质色，tooltip 说明帧差分依据；
 *  - `manual`（手工）：硬币名 + 品质色 + 「手工」小标，tooltip 说明为用户手工指定；
 *  - `inferred`（候选）：**虚线**描边 + 「候选」标签，tooltip 列出候选硬币 + 池概率；
 *  - `unknown`（未知）：灰色「未知」占位（**绝不伪造 coinKey**，I7）。
 *
 * `manual` 与 `observed` 同用品质色（同样是**唯一确定**的 coinKey），但额外打上
 * 「手工」标记 —— 用户需能一眼分辨哪些归属是自己指定的、哪些是实证得出的。
 *
 * 纯展示、无状态；`React.memo` 在归因引用稳定时跳过重渲染。
 */
export const WishCoinBadge = memo(function WishCoinBadge({
  coin,
  resolveCoin,
}: {
  coin: WishCoinAttribution | undefined;
  resolveCoin: CoinResolver;
}) {
  const { t } = useTranslation("wish");
  const attribution: WishCoinAttribution = coin ?? {
    confidence: "unknown",
    coinKey: null,
    candidates: [],
  };

  if (attribution.confidence === "observed" && attribution.coinKey != null) {
    const meta = resolveCoin(attribution.coinKey);
    const color = gradeColor(meta?.grade ?? "UNKNOWN");
    const name = meta?.name ?? `#${attribution.coinKey}`;
    return (
      <span
        className="inline-flex items-center gap-1.5 whitespace-nowrap"
        title={t("confidence.observedTooltip")}
        data-confidence="observed"
        data-coin-key={attribution.coinKey}
      >
        <span
          className="size-[9px] shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden
        />
        <span className="min-w-0 truncate font-medium" style={{ color }}>
          {name}
        </span>
      </span>
    );
  }

  if (attribution.confidence === "manual" && attribution.coinKey != null) {
    const meta = resolveCoin(attribution.coinKey);
    const color = gradeColor(meta?.grade ?? "UNKNOWN");
    const name = meta?.name ?? `#${attribution.coinKey}`;
    return (
      <span
        className="inline-flex items-center gap-1.5 whitespace-nowrap"
        title={t("confidence.manualTooltip")}
        data-confidence="manual"
        data-coin-key={attribution.coinKey}
      >
        <span
          className="size-[9px] shrink-0 rounded-full ring-2 ring-current/25"
          style={{ background: color, color }}
          aria-hidden
        />
        <span className="min-w-0 truncate font-medium" style={{ color }}>
          {name}
        </span>
        <span className="shrink-0 rounded-sm border border-border px-1 text-[10px] leading-tight text-muted">
          {t("confidence.manual")}
        </span>
      </span>
    );
  }

  if (attribution.confidence === "inferred" && attribution.candidates.length > 0) {
    const named = candidateNames(attribution.candidates, (k) => resolveCoin(k)?.name);
    const tooltip = `${t("confidence.inferredTooltip")}\n${named
      .map((c) =>
        t("confidence.candidateTooltip", { coin: c.name, pct: `${(c.poolPct * 100).toFixed(1)}%` }),
      )
      .join("\n")}`;
    return (
      <span
        className="inline-flex items-center gap-1.5 whitespace-nowrap"
        title={tooltip}
        data-confidence="inferred"
        data-candidate-count={attribution.candidates.length}
      >
        <span
          className="size-[9px] shrink-0 rounded-full border border-dashed border-muted"
          aria-hidden
        />
        <span className="min-w-0 truncate text-muted">{t("confidence.inferred")}</span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted"
      title={t("confidence.unknown")}
      data-confidence="unknown"
    >
      <span className="min-w-0 truncate">—</span>
    </span>
  );
});
