import { useTranslation } from "react-i18next";
import type { WishStats } from "../../../../shared/types";
import { StatCard } from "../../design-system/primitives/StatCard/StatCard";
import { fmtClock } from "../../lib/format";

/** 每小时的速率显示（1 位小数，非有限值回落 0）。 */
function fmtRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.0";
  return value.toFixed(1);
}

/** 平均值显示（1 位小数）。 */
function fmtAvg(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.0";
  return value.toFixed(1);
}

/**
 * 祈愿顶部指标卡组 —— 三个主卡：
 *  1. 祈愿次数（累计为主值，会话 + 速率作副信息）
 *  2. 产出物品数（累计为主值，会话 + 速率作副信息）
 *  3. 最近祈愿（墙钟时刻）
 *
 * 口径说明：`itemsPerOffering` 由核心保证次数为 0 时返回 0（不 NaN）。
 */
export function WishStatCards({ wish }: { wish: WishStats }) {
  const { t } = useTranslation("wish");

  const lastWish = wish.lastWishWallTime;

  return (
    <div className="grid grid-cols-3 items-stretch gap-3 max-[720px]:grid-cols-1">
      <StatCard
        label={t("cards.offerings")}
        value={wish.offeringCountTotal}
        detail={
          <>
            {t("cards.session")} {wish.offeringCountSession}
            {" · "}
            {t("cards.sessionRate")} {fmtRate(wish.offeringPerHour)}
            {" · "}
            {t("cards.recentRate")} {fmtRate(wish.offeringRecentPerHour)}
          </>
        }
      />
      <StatCard
        label={t("cards.items")}
        value={wish.itemCountTotal}
        detail={
          <>
            {t("cards.session")} {wish.itemCountSession}
            {" · "}
            {t("cards.sessionRate")} {fmtRate(wish.itemPerHour)}
            {" · "}
            {t("cards.recentRate")} {fmtRate(wish.itemRecentPerHour)}
          </>
        }
      />
      <StatCard
        label={t("cards.latest")}
        value={lastWish == null ? t("cards.never") : fmtClock(lastWish)}
        detail={
          <>
            {t("cards.perOffering", { value: fmtAvg(wish.itemsPerOffering) })}
            {" · "}
            {t("cards.recentOfferingRate", { value: fmtRate(wish.offeringRecentPerHour) })}
          </>
        }
      />
    </div>
  );
}
