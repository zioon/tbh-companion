import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { WishGrade, WishHistoryEntry } from "../../../../shared/types";
import { Card } from "../../design-system/primitives/Card/Card";
import { fmtClock } from "../../lib/format";
import { gradeColor } from "../../lib/gradeColor";
import { WishCoinBadge } from "./WishCoinBadge";

/** coinKey → 硬币元数据解析器（与 `useWish().coinResolver` 同型）。 */
type CoinResolver = (
  coinKey: number,
) => { coinKey: number; name: string; grade: string; iconPath: string } | undefined;

/**
 * 祈愿历史：倒序（最新在前），一次祈愿事件 = 一行。
 *
 * 用绝对定位的内层实现自滚动（与 `LootRecentDrops` 同一模式）：让本卡在网格
 * 行高计算时不贡献 max-content 高度，行高由相邻卡驱动，内容溢出则内部滚动。
 * 保留原始富文本 `raw` 的时间/名称，颜色由品质映射（无法映射走 UNKNOWN）。
 *
 * Wish v2（P1-4）：新增「硬币」列，展示该行的硬币归因徽章（observed 实线 /
 * inferred 虚线 / unknown 灰占位，见 {@link WishCoinBadge}）。
 */
export const WishHistory = memo(function WishHistory({
  entries,
  resolveCoin,
}: {
  entries: WishHistoryEntry[];
  resolveCoin: CoinResolver;
}) {
  const { t } = useTranslation("wish");

  if (entries.length === 0) return null;

  const gradeLabel = (grade: WishGrade): string => t(`grade.${grade}` as const);

  return (
    <Card padding="none" className="relative overflow-hidden">
      <div className="absolute inset-0 flex flex-col gap-1.5 p-3">
        <div className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">
          {t("history.title")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <table className="m-0 w-full border-collapse text-[13px]">
            <thead className="sticky top-0 bg-card">
              <tr className="text-[11px] uppercase tracking-wide text-muted">
                <th className="px-3 py-1 text-left font-medium">{t("history.columnTime")}</th>
                <th className="px-3 py-1 text-left font-medium">{t("history.columnItem")}</th>
                <th className="px-3 py-1 text-left font-medium">{t("history.columnCoin")}</th>
                <th className="px-3 py-1 text-right font-medium">{t("history.columnGrade")}</th>
                <th className="px-3 py-1 text-right font-medium">{t("history.columnCount")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const color = gradeColor(e.grade);
                return (
                  <tr key={`${e.wallTime}-${e.name}-${i}`} className="align-baseline">
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted tabular-nums">
                      {fmtClock(e.wallTime)}
                    </td>
                    <td className="truncate px-3 py-1.5">
                      <span
                        className="inline-flex items-center gap-1.5 font-medium"
                        style={{ color }}
                        title={e.name}
                      >
                        <span
                          className="size-[9px] shrink-0 rounded-full"
                          style={{ background: color }}
                          aria-hidden
                        />
                        <span className="min-w-0 truncate">
                          {e.name || t("history.unknownItem")}
                        </span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <WishCoinBadge coin={e.coin} resolveCoin={resolveCoin} />
                    </td>
                    <td
                      className="whitespace-nowrap px-3 py-1.5 text-right text-muted"
                      style={{ color }}
                    >
                      {gradeLabel(e.grade)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-muted tabular-nums">
                      {e.count > 1 ? `×${e.count}` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
});
