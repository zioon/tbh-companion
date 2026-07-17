import { Dialog } from "../../design-system/primitives/Dialog/Dialog";
import { DialogTitle } from "../../design-system/primitives/Dialog/DialogParts";
import { Button } from "../../design-system/primitives/Button/Button";
import type { BoxCategory } from "../../../../shared/types";

/**
 * Modal prompting the user to pick a chest category for unclassified loot
 * when the auto-classify queue couldn't match the open event to a prior drop.
 *
 * The user picks one of three categories; the level is inferred from the
 * current stage in the main process. Closing the dialog without picking
 * leaves items in unclassified — the user can still reclassify them manually
 * on the Loot tab.
 */
export function ClassifyPromptDialog({
  open,
  itemCount,
  onClose,
  onResolve,
}: {
  open: boolean;
  itemCount: number;
  onClose: () => void;
  onResolve: (category: BoxCategory) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <div className="flex flex-col gap-3">
        <DialogTitle className="m-0 text-base font-semibold">
          Classify unclassified loot
        </DialogTitle>
        <p className="m-0 text-sm text-muted">
          {itemCount} {itemCount === 1 ? "item needs" : "items need"} classification. Pick a chest
          category — the level is inferred from your current stage. You can adjust the level later
          on the Loot tab.
        </p>
        <div className="grid grid-cols-3 gap-2">
          <Button variant="ghost" onClick={() => onResolve("common")}>
            Common
          </Button>
          <Button variant="ghost" onClick={() => onResolve("rare")}>
            Stage boss
          </Button>
          <Button variant="ghost" onClick={() => onResolve("act")}>
            Act boss
          </Button>
        </div>
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
