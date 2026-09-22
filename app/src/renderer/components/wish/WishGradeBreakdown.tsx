import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { WishGrade, WishGradeRow } from "../../../../shared/types";
import { PanelSection } from "../../design-system/primitives/PanelSection/PanelSection";
import { gradeColor } from "../../lib/gradeColor";
import { WishGradeBar } from "./WishGradeBar";

/** 百分比显示（1 位小数，与 core 的 share 精度一致）。 */
function fmtShare(share: number): string {
  if (!Number.isFinite(share)) return "0.0%";
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * 品质分布面板：手绘堆叠条 + 逐品质明细表（件数 / 占比）。
 *
 * 分母恒为「产出物品数」（含未知）—— 由核心 `share` 保证；本组件只做展示。
 * 品质名走 `wish` 命名空间的 `grade.*` 键（与 8 个桶一一对应）。
 */
export const WishGradeBreakdown = memo(function WishGradeBreakdown({
  rows,
  itemCountTotal,
}: {
  rows: WishGradeRow[];
  /** 产出物品总数（用于标题的「合计 N 件」）。 */
  itemCountTotal: number;
}) {
  const { t } = useTranslation("wish");

  const gradeLabel = (grade: WishGrade): string => t(`grade.${grade}` as const);

  return (
    <PanelSection title={t("grades.title")} boxed>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex flex-col gap-1.5">
          <WishGradeBar rows={rows} title={t("grades.title")} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
            {rows
              .filter((r) => r.count > 0)
              .map((r) => (
                <span key={r.grade} className="inline-flex items-center gap-1">
                  <span
                    className="size-[9px] shrink-0 rounded-full"
                    style={{ background: gradeColor(r.grade) }}
                    aria-hidden
                  />
                  {gradeLabel(r.grade)}
                </span>
              ))}
          </div>
        </div>

        {itemCountTotal === 0 ? (
          <p className="m-0 text-[13px] text-muted">{t("grades.empty")}</p>
        ) : (
          <table className="m-0 w-full border-collapse text-[13px]">
            <tbody>
              {rows.map((r) => (
                <tr key={r.grade} className="align-baseline">
                  <td className="py-1">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-[9px] shrink-0 rounded-full"
                        style={{ background: gradeColor(r.grade) }}
                        aria-hidden
                      />
                      <span style={{ color: gradeColor(r.grade) }} className="font-medium">
                        {gradeLabel(r.grade)}
                      </span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1 text-right tabular-nums">{r.count}</td>
                  <td className="w-16 whitespace-nowrap py-1 text-right text-muted tabular-nums">
                    {fmtShare(r.share)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="border-t border-border pt-1 text-right text-[11px] text-muted">
          {t("grades.total", { count: itemCountTotal })}
        </div>
      </div>
    </PanelSection>
  );
});
