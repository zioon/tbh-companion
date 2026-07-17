import { useState } from "react";
import type { BoxCategory } from "../../../shared/types";
import { useLoot } from "../lib/useLoot";
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

const CATEGORY_LABELS: Record<BoxCategory, string> = {
  common: "Common",
  rare: "Stage boss",
  act: "Act boss",
  unclassified: "Unclassified",
};

function categoryLabel(category: BoxCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

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
  const [confirmingAll, setConfirmingAll] = useState(false);

  return (
    <TabPage>
      <TabHeader
        title="Loot"
        intro="Live box-opening outcomes, aggregated by chest type and level."
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {autoClassifyEnabled && (
          <div className="flex items-center gap-3 rounded border border-border bg-panel px-3 py-1.5 text-xs">
            <span className="font-medium text-text">Queue: {autoClassifyState.totalQueued}</span>
            {autoClassifyState.byCategory.map((row) => (
              <span key={row.category} className="text-muted">
                <span className="font-medium text-text">{row.count}</span>{" "}
                {categoryLabel(row.category)}
                {row.nextAutoOpenInMs != null && (
                  <span className="ml-1 text-muted">({formatCountdown(row.nextAutoOpenInMs)})</span>
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
          {autoClassifyEnabled && <LootQueueList items={autoClassifyState.items} />}
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
