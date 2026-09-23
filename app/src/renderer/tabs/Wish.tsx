import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WishGrade } from "../../../shared/types";
import { WISH_COIN_KEYS } from "../../../shared/types";
import { useWish } from "../lib/useWish";
import { useLookupCatalog } from "../lib/useLookupCatalog";
import { Button } from "../design-system/primitives/Button/Button";
import { Dialog } from "../design-system/primitives/Dialog/Dialog";
import { DialogClose, DialogTitle } from "../design-system/primitives/Dialog/DialogParts";
import { HintBanner } from "../design-system/primitives/HintBanner/HintBanner";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { WishStatCards } from "../components/wish/WishStatCards";
import { WishHeldCoins } from "../components/wish/WishHeldCoins";
import { WishRecentResults } from "../components/wish/WishRecentResults";
import { WishCoinGroups } from "../components/wish/WishCoinGroups";
import { WishHistory } from "../components/wish/WishHistory";

/**
 * 祈愿记录页（Wish v2）。
 *
 * 数据源：既有 `Stats.wish`（随 stats 广播下发，无新 IPC / 无新内存读取）。
 * 硬币面板（`WishHeldCoins`）由 renderer 侧 join 背包 + 图鉴派生（W1 定稿，
 * `WishStats` 不含 `heldCoins`）。会话重置复用既有 `IPC.RESET` 通道
 * （`window.tbh.reset()`）—— 与掉落页共享同一重置入口，主进程会同时把祈愿
 * 「会话」计数归零（累计不变）。
 *
 * 布局（自顶向下）：
 *  1. 指标卡组（`WishStatCards`）
 *  2. 两列：背包献祭硬币 / 最近祈愿结果
 *  3. 按硬币分组（全宽）+ 祈愿历史（全宽）
 *
 * 说明：本页已移除 `unavailable` 提示条（P0-2）—— reader 未就绪时由空数据
 * 占位（`noWishesYet`）自然表达，无需单独的不可用横幅。
 *
 * 说明：本页已移除「品质分布」（`WishGradeBreakdown`）与「单品产出排行」
 * （`WishItemRanking`）两块面板 —— 品质 / 单品维度的信息已由「按硬币分组」
 * 内的条目列表承载，保留会与硬币维度重复。
 */
export function Wish() {
  const { t } = useTranslation("wish");
  const {
    wish,
    history,
    recentResults,
    coinGroups,
    unattributed,
    heldCoins,
    coinOverrides,
    setCoinOverride,
    coinResolver,
    hasData,
    resetSession,
  } = useWish();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const catalog = useLookupCatalog();

  // 手工绑定的候选池：全部献祭硬币（图鉴 → 仅硬币子集，id 升序）。
  const coinOptions = useMemo(
    () =>
      (catalog ?? [])
        .filter((item) => WISH_COIN_KEYS.includes(item.id))
        .map((item) => ({
          coinKey: item.id,
          name: item.name,
          grade: (item.grade ?? "UNKNOWN") as WishGrade,
        }))
        .sort((a, b) => a.coinKey - b.coinKey),
    [catalog],
  );

  const handleAssignCoin = useCallback(
    (itemName: string, coinKey: number | null) => {
      void setCoinOverride(itemName, coinKey);
    },
    [setCoinOverride],
  );

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

      <WishStatCards wish={wish} />

      {!hasData ? <HintBanner>{t("noWishesYet")}</HintBanner> : null}

      <div className="grid grid-cols-2 items-stretch gap-3 max-[720px]:grid-cols-1">
        <WishHeldCoins coins={heldCoins} />
        <div className="grid min-h-[260px] grid-cols-1">
          <WishRecentResults rows={recentResults} resolveCoin={coinResolver} />
        </div>
      </div>

      <WishCoinGroups
        groups={coinGroups}
        unattributed={unattributed}
        resolveCoin={coinResolver}
        coinOverrides={coinOverrides}
        coinOptions={coinOptions}
        onAssignCoin={handleAssignCoin}
      />

      {history.length > 0 && (
        <div className="grid min-h-[260px] grid-cols-1">
          <WishHistory entries={history} resolveCoin={coinResolver} />
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
