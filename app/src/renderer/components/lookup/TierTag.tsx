import { useTranslation } from "react-i18next";
import { gradeForTier } from "../../../core/grades";
import { gradeColor } from "../../lib/gradeColor";

/** Small tier badge prefixing a material outcome line (e.g. "T7"), colored by its grade. */
export function TierTag({ tier }: { tier: number }) {
  const { t } = useTranslation("lookup");
  const color = gradeColor(gradeForTier(tier));
  return (
    <span
      className="shrink-0 rounded border bg-card px-1 text-[10px] font-semibold"
      style={{ color, borderColor: color }}
    >
      {t("tierTag", { tier })}
    </span>
  );
}
