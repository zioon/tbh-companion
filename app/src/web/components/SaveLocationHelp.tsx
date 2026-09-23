// Web shell: "where is my save file?" helper with a copy-to-clipboard button.
//
// Browsers cannot browse the local filesystem, so this card is how a visitor
// finds the save on disk. Kept in the Home page's empty state AND its loaded
// state (it is still useful after a load).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../renderer/design-system/primitives/Button/Button";
import { Card } from "../../renderer/design-system/primitives/Card/Card";

/** Windows save directory for Task Bar Hero (the game's PlayerPrefs folder). */
export const SAVE_DIR = "%USERPROFILE%\\AppData\\LocalLow\\TesseractStudio\\TaskBarHero\\";
/** Live save file name inside {@link SAVE_DIR}. */
export const SAVE_FILE = "SaveFile_Live.es3";

type CopyStatus = "idle" | "copied" | "failed";

export function SaveLocationHelp() {
  const { t } = useTranslation("web");
  const [status, setStatus] = useState<CopyStatus>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  async function onCopy(): Promise<void> {
    let next: CopyStatus;
    try {
      // `navigator.clipboard` is undefined on insecure origins; guard so the
      // button still reports a readable failure instead of throwing.
      await navigator.clipboard.writeText(SAVE_DIR);
      next = "copied";
    } catch {
      next = "failed";
    }
    setStatus(next);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <Card className="text-xs leading-relaxed text-muted">
      <p className="m-0 mb-1.5 font-semibold text-fg">{t("savePath.title")}</p>
      <p className="m-0">{t("savePath.body", { path: SAVE_DIR, file: SAVE_FILE })} </p>
      <p className="m-0 mt-1.5">
        <code className="break-all rounded bg-panel px-1 py-0.5 text-[11px]">{SAVE_DIR}</code>
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => void onCopy()}>
          {t("savePath.copy")}
        </Button>
        {status !== "idle" ? (
          <span
            className={status === "copied" ? "text-ideal" : "text-danger"}
            role="status"
            aria-live="polite"
          >
            {status === "copied" ? t("savePath.copied") : t("savePath.copyFailed")}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
