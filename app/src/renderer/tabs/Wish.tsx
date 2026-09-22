import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWish } from "../lib/useWish";
import { Button } from "../design-system/primitives/Button/Button";
import { Dialog } from "../design-system/primitives/Dialog/Dialog";
import { DialogClose, DialogTitle } from "../design-system/primitives/Dialog/DialogParts";
import { HintBanner } from "../design-system/primitives/HintBanner/HintBanner";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { WishStatCards } from "../components/wish/WishStatCards";
import { WishGradeBreakdown } from "../components/wish/WishGradeBreakdown";
import { WishItemRanking } from "../components/wish/WishItemRanking";
import { WishHistory } from "../components/wish/WishHistory";

/**
 * 祈愿记录页（P0）。
 *
 * 数据源：既有 `Stats.wish`（随 stats 广播下发，无新 IPC / 无新内存读取）。
 * 会话重置复用既有 `IPC.RESET` 通道（`window.tbh.reset()`）—— 与掉落页共享
 * 同一重置入口，主进程会同时把祈愿「会话」计数归零（累计不变）。
 */
export function Wish() {
  const { t } = useTranslation("wish");
  const { wish, gradeDistribution, breakdown, history, hasData, resetSession } = useWish();
  const [confirmingReset, setConfirmingReset] = useState(false);

  return (
    <TabPage>
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="m-0 text-lg font-semibold">{t("tabTitle")}</h1>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingReset(true)}>
            {t("resetSession")}
          </Button>
        </div>
        <p className="m-0 text-[13px] leading-snug text-muted">{t("intro")}</p>
      </header>

      {wish.readerRequired && <HintBanner>{t("unavailable")}</HintBanner>}

      <WishStatCards wish={wish} />

      {!hasData ? <HintBanner>{t("noWishesYet")}</HintBanner> : null}

      <div className="grid grid-cols-2 items-stretch gap-3 max-[720px]:grid-cols-1">
        <WishGradeBreakdown rows={gradeDistribution} itemCountTotal={wish.itemCountTotal} />
        <WishItemRanking rows={breakdown} />
      </div>

      {history.length > 0 && (
        <div className="grid min-h-[260px] grid-cols-1">
          <WishHistory entries={history} />
        </div>
      )}

      {confirmingReset && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmingReset(false);
          }}
        >
          <div className="flex flex-col gap-3">
            <DialogTitle className="m-0 text-base font-semibold">{t("resetTitle")}</DialogTitle>
            <p className="m-0 text-sm text-muted">{t("resetBody")}</p>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmingReset(false)}>
                {t("cancel")}
              </Button>
              <DialogClose
                render={
                  <Button
                    variant="danger"
                    onClick={() => {
                      void resetSession();
                      setConfirmingReset(false);
                    }}
                  >
                    {t("resetSession")}
                  </Button>
                }
              />
            </div>
          </div>
        </Dialog>
      )}
    </TabPage>
  );
}
