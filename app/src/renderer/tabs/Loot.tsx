import { useState } from "react";
import { useLoot } from "../lib/useLoot";
import { boxLabel } from "../../core/boxOpenLog";
import { Button } from "../design-system/primitives/Button/Button";
import { Dialog } from "../design-system/primitives/Dialog/Dialog";
import { DialogClose, DialogTitle } from "../design-system/primitives/Dialog/DialogParts";
import { HintBanner } from "../design-system/primitives/HintBanner/HintBanner";
import { Switch } from "../design-system/primitives/Switch/Switch";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { LootBoxSection } from "../components/loot/LootBoxSection";
import { LootRecentDrops } from "../components/loot/LootRecentDrops";
import { LootQueueList } from "../components/loot/LootQueueList";
import { ClassifyPromptDialog } from "../components/loot/ClassifyPromptDialog";
import { useTbhContext } from "../context/tbhContext";

/** Format ms as m:ss, clamping negatives to 0. */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function Loot() {
  const {
    boxOpens,
    lootStatus,
    currentStageKey,
    recentDrops,
    lastDropWallTimeByCategory,
    boxQueueByBoxKey,
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

  return (
    <TabPage>
      <TabHeader
        title="Loot"
        intro="Live box-opening outcomes, aggregated by chest type and level."
      />
      {catalogStatus?.stale && (
        <HintBanner>
          Item catalog may be outdated (catalog v{catalogStatus.catalogVersion}, game v
          {catalogStatus.gameVersion}). Open the Settings tab to refresh.
        </HintBanner>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {autoClassifyEnabled && (
          <div className="flex items-center gap-3 rounded border border-border bg-panel px-3 py-1.5 text-xs">
            <span className="font-medium text-text">Queue: {autoClassifyState.totalQueued}</span>
            {/* Show the next 3 queued chests (queue is already sorted
                head-first by AutoClassifyService). Hides the rest to keep
                the header compact — full list visible in the queue card below. */}
            {autoClassifyState.items.slice(0, 3).map((item, i) => (
              <span key={`${item.boxKey}-${item.droppedAtMs}-${i}`} className="text-muted">
                <span className="font-medium text-text">{boxLabel(item.boxKey)}</span>
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
            aria-label="Auto-classify loot"
          />
          Auto-classify
        </label>
      </div>

      {/* Queue list and recent drops sit side-by-side. Both cards stretch to
          the row's height so the two columns stay visually aligned even when
          one has more rows than the other. */}
      {(autoClassifyEnabled || recentDrops.length > 0) && (
        <div className="grid grid-cols-2 items-stretch gap-3 max-[720px]:grid-cols-1">
          {autoClassifyEnabled && <LootQueueList items={autoClassifyState.items.slice(0, 3)} />}
          {recentDrops.length > 0 && <LootRecentDrops drops={recentDrops} />}
        </div>
      )}

      {boxOpens.length === 0 ? (
        <HintBanner>
          {lootStatus
            ? `Loot tracking unavailable: ${lootStatus}. Open a chest in-game — the reader will re-derive the required offsets and start recording.`
            : "No boxes opened yet this session. Open a chest in-game with the live reader running to see recorded loot here."}
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
                boxQueueItems={boxQueueByBoxKey.get(stats.boxKey)}
                className={stats.category === "unclassified" ? "col-span-2" : undefined}
              />
            ))}
          </div>
        </>
      )}

      {boxOpens.length > 0 && (
        // Reset-all lives at the bottom-right, deliberately away from the
        // top header area so it can't be mis-tapped while interacting with
        // stats. Confirmation dialog gates the destructive action.
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setConfirmingAll(true)}>
            Reset all
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
            <DialogTitle className="m-0 text-base font-semibold">Reset all loot data?</DialogTitle>
            <p className="m-0 text-sm text-muted">
              This clears all recorded box opens for every chest type. The session timer is not
              affected. This cannot be undone.
            </p>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmingAll(false)}>
                Cancel
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
                    Reset all
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
