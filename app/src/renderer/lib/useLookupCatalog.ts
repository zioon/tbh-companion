import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LookupItem } from "../../../shared/types";
import { reportIpcError } from "./reportError";

/**
 * Bundled item catalog. Fetched once on mount, then re-fetched whenever the
 * UI language changes so `LookupService.getCatalog()` can return items with
 * localized `name` (the main process applies `gameItemName` based on the
 * current LocaleCatalog).
 */
export function useLookupCatalog(): LookupItem[] | null {
  const [items, setItems] = useState<LookupItem[] | null>(null);
  const { i18n } = useTranslation();

  useEffect(() => {
    let mounted = true;
    const fetch = () => {
      void window.tbh
        .getLookupCatalog()
        .then((catalog) => {
          if (mounted) setItems(catalog);
        })
        .catch(reportIpcError);
    };
    fetch();
    const onLangChanged = () => fetch();
    i18n.on("languageChanged", onLangChanged);
    return () => {
      mounted = false;
      i18n.off("languageChanged", onLangChanged);
    };
  }, [i18n]);

  return items;
}
