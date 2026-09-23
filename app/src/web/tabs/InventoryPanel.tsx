// Web shell: Inventory page.
//
// Reuses the desktop `Inventory` tab verbatim (search / filter / sort / column
// picker) once a save is loaded. With no save it shows a readable empty state
// instead of the table — the contract requires the save-driven pages to degrade
// gracefully, never to blank out or crash. Decryption / password errors surface
// as the shim's classified `runtime.error` text.

import { useTranslation } from "react-i18next";
import { Inventory } from "../../renderer/tabs/Inventory";
import { Button } from "../../renderer/design-system/primitives/Button/Button";
import { Card } from "../../renderer/design-system/primitives/Card/Card";
import { TabPage } from "../../renderer/design-system/primitives/TabPage/TabPage";
import { clearWebSave } from "../webTbhApi";
import { useWebRuntime } from "../lib/useWebRuntime";
import { ChooseSaveButton } from "../components/SavePicker";
import type { WebTabId } from "../webTabs";

export function InventoryPanel({ onNavigate }: { onNavigate: (tab: WebTabId) => void }) {
  const { t } = useTranslation("web");
  const runtime = useWebRuntime();

  if (!runtime.inventory) {
    return (
      <TabPage>
        {runtime.error ? (
          <Card className="border-danger/40 bg-danger/5">
            <p className="m-0 mb-1 text-sm font-semibold text-danger">{t("home.saveError")}</p>
            <p className="m-0 whitespace-pre-line text-xs leading-relaxed text-muted">
              {runtime.error}
            </p>
          </Card>
        ) : null}

        <Card>
          <p className="m-0 mb-1 text-sm font-semibold text-fg">{t("inventoryEmpty.title")}</p>
          <p className="m-0 text-xs leading-relaxed text-muted">{t("inventoryEmpty.body")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ChooseSaveButton label={t("home.choose")} variant="primary" size="sm" />
            <Button variant="ghost" size="sm" onClick={() => onNavigate("home")}>
              {t("inventoryEmpty.goHome")}
            </Button>
          </div>
        </Card>
      </TabPage>
    );
  }

  return (
    <TabPage>
      <Card padding="compact" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold text-fg">{runtime.fileName}</span>
        {runtime.analyze ? (
          <span className="text-muted">
            {t("home.loadedSummary", {
              items: runtime.analyze.stats.itemCount.toLocaleString(),
              chests: runtime.analyze.stats.chestCount.toLocaleString(),
            })}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <ChooseSaveButton size="sm" />
          <Button variant="ghost" size="sm" onClick={() => clearWebSave()}>
            {t("clear")}
          </Button>
        </span>
      </Card>

      <Inventory />
    </TabPage>
  );
}
