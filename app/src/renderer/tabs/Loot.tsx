import { useState } from "react";
import { useLoot } from "../lib/useLoot";
import { Button } from "../design-system/primitives/Button/Button";
import { Dialog } from "../design-system/primitives/Dialog/Dialog";
import { DialogClose, DialogTitle } from "../design-system/primitives/Dialog/DialogParts";
import { HintBanner } from "../design-system/primitives/HintBanner/HintBanner";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { LootBoxSection } from "../components/loot/LootBoxSection";

export function Loot() {
  const { boxOpens, resetBox, resetAll, reclassifyItem } = useLoot();
  const [confirmingAll, setConfirmingAll] = useState(false);

  return (
    <TabPage>
      <TabHeader
        title="Loot"
        intro="Live box-opening outcomes, aggregated by chest type and level."
      >
        {boxOpens.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setConfirmingAll(true)}>
            Reset all
          </Button>
        )}
      </TabHeader>

      {boxOpens.length === 0 ? (
        <HintBanner>
          No boxes opened yet this session. Open a chest in-game with the live reader running to see
          recorded loot here.
        </HintBanner>
      ) : (
        <div className="flex flex-col gap-3">
          {boxOpens.map((stats) => (
            <LootBoxSection
              key={stats.boxKey}
              stats={stats}
              onReset={resetBox}
              onReclassify={reclassifyItem}
            />
          ))}
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
    </TabPage>
  );
}
