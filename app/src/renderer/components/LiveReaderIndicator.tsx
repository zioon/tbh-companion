import { useTranslation } from "react-i18next";
import { useLiveMemoryStatus } from "../lib/useLiveMemory";
import { Badge } from "../design-system/primitives/Badge/Badge";

/**
 * Small, unobtrusive live-reader status chip for the app toolbar. Hidden when
 * the reader is off (default) so there is no visual noise; shows the reader
 * state once the worker is running.
 *
 * Uses useLiveMemoryStatus (low-frequency, state-change only) instead of
 * useLiveMemory to avoid subscribing to the 25 Hz snapshot stream.
 */
export function LiveReaderIndicator() {
  const { t } = useTranslation("common");
  const status = useLiveMemoryStatus();

  // Show nothing while the reader isn't running (off, stopped, not yet started).
  if (!status?.running) return null;

  if (status.attached && status.scanning) {
    return (
      <Badge variant="warning" className="self-center">
        {t("liveReader.scanning")}
      </Badge>
    );
  }

  if (status.attached && status.supported) {
    return (
      <Badge variant="success" className="self-center">
        {t("liveReader.live")}
      </Badge>
    );
  }

  if (status.attached && !status.supported) {
    return (
      <span className="self-center" title={status.note ?? t("liveReader.unsupportedTitle")}>
        <Badge variant="info">{t("liveReader.unsupported")}</Badge>
      </span>
    );
  }

  // Running but game process not found yet — retry loop is active.
  return (
    <Badge variant="muted" className="self-center">
      {t("liveReader.waitingForGame")}
    </Badge>
  );
}
