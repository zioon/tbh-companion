import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { WishBreakdownRow } from "../../../../shared/types";
import { PanelSection } from "../../design-system/primitives/PanelSection/PanelSection";
import { gradeColor } from "../../lib/gradeColor";

/** 单品的占比显示（1 位小数；与 core `share` 精度一致）。 */
function fmtShare(share: number): string {
  if (!Number.isFinite(share)) return "0.0%";
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * 单品产出排行：按累计件数倒序（核心已排序；并列时名称升序）。
 *
 * P0 无 itemKey，按「去标签纯物品名」聚合。每行左侧色点表示该物品的
 * 代表品质（核心取最高频，并列取首个），并以该品质色高亮名称。
 */
export const WishItemRanking = memo(function WishItemRanking({
  rows,
}: {
  rows: WishBreakdownRow[];
}) {
  const { t } = useTranslation("wish");

  return (
    <PanelSection title={t("ranking.title")} boxed>
      <div className="flex flex-col p-3">
        {rows.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{t("ranking.empty")}</p>
        ) : (
          <table className="m-0 w-full border-collapse text-[13px]">
            <tbody>
              {rows.map((r, i) => {
                const color = gradeColor(r.grade);
                return (
                  <tr key={`${r.name}-${i}`} className="align-baseline">
                    <td className="truncate py-1">
                      <span
                        className="inline-flex items-center gap-1.5 font-medium"
                        style={{ color }}
                        title={r.name}
                      >
                        <span
                          className="size-[9px] shrink-0 rounded-full"
                          style={{ background: color }}
                          aria-hidden
                        />
                        <span className="min-w-0 truncate">{r.name}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums">
                      {t("ranking.countLabel", { count: r.count })}
                    </td>
                    <td className="w-16 whitespace-nowrap py-1 pl-3 text-right text-muted tabular-nums">
                      {fmtShare(r.share)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </PanelSection>
  );
});
