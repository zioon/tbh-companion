import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLoot } from "../lib/useLoot";
import { useLookupCatalog } from "../lib/useLookupCatalog";
import { useBoxTimers } from "../lib/useBoxTimers";
import { useChests } from "../lib/useChests";
import { useStats } from "../lib/useStats";
import { translateBoxLabel } from "../lib/boxLabel";
import type { LootRingSeconds, LookupItem } from "../../../shared/types";
import { Button } from "../design-system/primitives/Button/Button";
import { Dialog } from "../design-system/primitives/Dialog/Dialog";
import { DialogClose, DialogTitle } from "../design-system/primitives/Dialog/DialogParts";
import { HintBanner } from "../design-system/primitives/HintBanner/HintBanner";
import { Switch } from "../design-system/primitives/Switch/Switch";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { LootBoxSection } from "../components/loot/LootBoxSection";
import { LootRecentDrops } from "../components/loot/LootRecentDrops";
import { LootQueueSlots } from "../components/loot/LootQueueSlots";
import { ClassifyPromptDialog } from "../components/loot/ClassifyPromptDialog";
import { useTbhContext } from "../context/tbhContext";
import { reportIpcError } from "../lib/reportError";

const DEFAULT_RING_SECONDS: LootRingSeconds = { common: 5 * 60, stage: 7 * 60 };

/** Format ms as m:ss, clamping negatives to 0. */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function Loot() {
  const { t } = useTranslation("loot");
  const {
    boxOpens,
    lootStatus,
    currentStageKey,
    recentDrops,
    lastDropWallTimeByCategory,
    resetBox,
    resetAll,
    reclassifyItem,
    autoClassifyEnabled,
    setAutoClassifyEnabled,
    autoClassifyState,
    classifyPrompt,
    resolveClassifyPrompt,
    dismissClassifyPrompt,
  } = useLoot();
  const { catalogStatus } = useTbhContext();
  const [confirmingAll, setConfirmingAll] = useState(false);

  const catalog = useLookupCatalog();
  const itemIndex = useMemo(
    () => new Map((catalog ?? []).map((item: LookupItem) => [item.id, item])),
    [catalog],
  );

  const boxTimers = useBoxTimers();
  // Chest slot state (quantity / capacity / auto-open seconds) for the
  // LootQueueSlots summary. Polled via the chests IPC stream, independent of
  // the 1 Hz autoClassify poll.
  const chests = useChests();
  // Stats provides per-category drop rates (commonPerHour / rarePerHour) used
  // to estimate slot-fill time. `act` has no periodic rate.
  const stats = useStats();
  const dropsPerHour = useMemo(
    () => ({
      common: stats?.chestDrops?.commonPerHour ?? null,
      rare: stats?.chestDrops?.rarePerHour ?? null,
      act: null,
    }),
    [stats?.chestDrops?.commonPerHour, stats?.chestDrops?.rarePerHour],
  );

  const [ringSeconds, setRingSeconds] = useState<LootRingSeconds>(DEFAULT_RING_SECONDS);

  useEffect(() => {
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((cfg) => {
        if (mounted && cfg.lootRingSeconds) setRingSeconds(cfg.lootRingSeconds);
      })
      .catch(reportIpcError);
    return () => {
      mounted = false;
    };
  }, []);

  const updateRingSeconds = useCallback((next: LootRingSeconds): void => {
    setRingSeconds(next);
    void window.tbh.saveConfig({ lootRingSeconds: next }).catch(reportIpcError);
  }, []);

  return (
    <TabPage>
      <TabHeader title={t("tabTitle")} intro={t("intro")} />
      {catalogStatus?.stale && (
        <HintBanner>
          {t("catalogStaleBanner", {
            catalogVersion: catalogStatus.catalogVersion,
            gameVersion: catalogStatus.gameVersion,
          })}
        </HintBanner>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {autoClassifyEnabled && (
          <div className="flex items-center gap-3 rounded border border-border bg-panel px-3 py-1.5 text-xs">
            <span className="font-medium text-text">
              {t("queueCount", { count: autoClassifyState.totalQueued })}
            </span>
            {autoClassifyState.items.slice(0, 3).map((item, i) => (
              <span key={`${item.boxKey}-${item.droppedAtMs}-${i}`} className="text-muted">
                <span className="font-medium text-text">{translateBoxLabel(t, item.boxKey)}</span>
                {item.autoOpenInMs != null && (
                  <span className="ml-1 text-muted">({formatCountdown(item.autoOpenInMs)})</span>
                )}
              </span>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-xs text-muted">
          <Switch
            checked={autoClassifyEnabled}
            onCheckedChange={(c) => void setAutoClassifyEnabled(c)}
            aria-label={t("autoClassifyAria")}
          />
          {t("autoClassifyLabel")}
        </label>
      </div>

      {(autoClassifyEnabled || recentDrops.length > 0) && (
        <div className="grid grid-cols-2 items-stretch gap-3 max-[720px]:grid-cols-1">
          {autoClassifyEnabled && (
            <LootQueueSlots queue={autoClassifyState} chests={chests} dropsPerHour={dropsPerHour} />
          )}
          {recentDrops.length > 0 && <LootRecentDrops drops={recentDrops} itemIndex={itemIndex} />}
        </div>
      )}

      {boxOpens.length === 0 ? (
        <HintBanner>
          {lootStatus ? t("lootUnavailable", { reason: lootStatus }) : t("noBoxesYet")}
        </HintBanner>
      ) : (
        <>
          <div className="grid grid-cols-2 items-start gap-3 max-[720px]:grid-cols-1">
            {boxOpens.map((stats) => (
              <LootBoxSection
                key={stats.boxKey}
                stats={stats}
                currentStageKey={currentStageKey}
                onReset={resetBox}
                onReclassify={reclassifyItem}
                lastDropWallTime={lastDropWallTimeByCategory[stats.category] ?? null}
                itemIndex={itemIndex}
                boxTimers={boxTimers}
                ringSeconds={ringSeconds}
                onUpdateRingSeconds={updateRingSeconds}
                className={stats.category === "unclassified" ? "col-span-2" : undefined}
              />
            ))}
          </div>
        </>
      )}

      {boxOpens.length > 0 && (
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setConfirmingAll(true)}>
            {t("resetAll")}
          </Button>
        </div>
      )}

      {confirmingAll && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmingAll(false);
          }}
        >
          <div className="flex flex-col gap-3">
            <DialogTitle className="m-0 text-base font-semibold">{t("resetAllTitle")}</DialogTitle>
            <p className="m-0 text-sm text-muted">{t("resetAllBody")}</p>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmingAll(false)}>
                {t("cancel")}
              </Button>
              <DialogClose
                render={
                  <Button
                    variant="danger"
                    onClick={() => {
                      void resetAll();
                      setConfirmingAll(false);
                    }}
                  >
                    {t("resetAll")}
                  </Button>
                }
              />
            </div>
          </div>
        </Dialog>
      )}

      <ClassifyPromptDialog
        open={classifyPrompt != null}
        itemCount={classifyPrompt?.itemKeys.length ?? 0}
        onClose={dismissClassifyPrompt}
        onResolve={resolveClassifyPrompt}
      />
    </TabPage>
  );
}
