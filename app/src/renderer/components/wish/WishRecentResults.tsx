import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { WishGrade, WishRecentResult } from "../../../../shared/types";
import { Card } from "../../design-system/primitives/Card/Card";
import { fmtClock } from "../../lib/format";
import { gradeColor } from "../../lib/gradeColor";
import { WishCoinBadge } from "./WishCoinBadge";

/** coinKey → 硬币元数据解析器（与 `useWish().coinResolver` 同型）。 */
type CoinResolver = (
  coinKey: number,
) => { coinKey: number; name: string; grade: string; iconPath: string } | undefined;

/**
 * 最近祈愿结果（Wish v2，Q3 定稿）。
 *
 * 取 `wish.recentResults`（核心 `getStats` 由 history 前 20 条派生），一次祈愿
 * 事件 = 一行，含时间 / 物品（品质色）/ 件数 / 硬币归因徽章。自滚动实现与
 * `WishHistory` 同模式（`Card padding="none"` + 内层 `absolute inset-0`）。
 */
export const WishRecentResults = memo(function WishRecentResults({
  rows,
  resolveCoin,
}: {
  rows: WishRecentResult[];
  resolveCoin: CoinResolver;
}) {
  const { t } = useTranslation("wish");

  const gradeLabel = (grade: WishGrade): string => t(`grade.${grade}` as const);

  return (
    <Card padding="none" className="relative overflow-hidden">
      <div className="absolute inset-0 flex flex-col gap-1.5 p-3">
        <div className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">
          {t("recent.title")}
        </div>
        {rows.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{t("recent.empty")}</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <table className="m-0 w-full border-collapse text-[13px]">
              <thead className="sticky top-0 bg-card">
                <tr className="text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-3 py-1 text-left font-medium">{t("recent.columnTime")}</th>
                  <th className="px-3 py-1 text-left font-medium">{t("recent.columnItem")}</th>
                  <th className="px-3 py-1 text-left font-medium">{t("recent.columnCoin")}</th>
                  <th className="px-3 py-1 text-right font-medium">{t("recent.columnCount")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const color = gradeColor(r.grade);
                  return (
                    <tr key={`${r.wallTime}-${r.name}-${i}`} className="align-baseline">
                      <td className="whitespace-nowrap px-3 py-1.5 text-muted tabular-nums">
                        {fmtClock(r.wallTime)}
                      </td>
                      <td className="truncate px-3 py-1.5">
                        <span
                          className="inline-flex items-center gap-1.5 font-medium"
                          style={{ color }}
                          title={`${r.name} · ${gradeLabel(r.grade)}`}
                        >
                          <span
                            className="size-[9px] shrink-0 rounded-full"
                            style={{ background: color }}
                            aria-hidden
                          />
                          <span className="min-w-0 truncate">{r.name}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <WishCoinBadge coin={r.coin} resolveCoin={resolveCoin} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-muted">
                        {r.count > 1 ? t("recent.countLabel", { count: r.count }) : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
});
