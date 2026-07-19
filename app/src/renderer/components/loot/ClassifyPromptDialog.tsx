import { useTranslation } from "react-i18next";
import { Dialog } from "../../design-system/primitives/Dialog/Dialog";
import { DialogTitle } from "../../design-system/primitives/Dialog/DialogParts";
import { Button } from "../../design-system/primitives/Button/Button";
import type { BoxCategory } from "../../../../shared/types";

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
  const { t } = useTranslation("loot");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <div className="flex flex-col gap-3">
        <DialogTitle className="m-0 text-base font-semibold">
          {t("classifyPrompt.title")}
        </DialogTitle>
        <p className="m-0 text-sm text-muted">
          {itemCount === 1
            ? t("classifyPrompt.bodyOne", { count: itemCount })
            : t("classifyPrompt.bodyOther", { count: itemCount })}
        </p>
        <div className="grid grid-cols-3 gap-2">
          <Button variant="ghost" onClick={() => onResolve("common")}>
            {t("classifyPrompt.common")}
          </Button>
          <Button variant="ghost" onClick={() => onResolve("rare")}>
            {t("classifyPrompt.stageBoss")}
          </Button>
          <Button variant="ghost" onClick={() => onResolve("act")}>
            {t("classifyPrompt.actBoss")}
          </Button>
        </div>
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("classifyPrompt.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
