import { useTranslation } from "react-i18next";
import { usePriceProgress, usePriceStatus } from "../../lib/usePrices";
import { Button } from "../../design-system/primitives/Button/Button";
import { HintBanner } from "../../design-system/primitives/HintBanner/HintBanner";
import { ProgressBar } from "../../design-system/primitives/ProgressBar/ProgressBar";

function progressLabel(
  t: ReturnType<typeof useTranslation<"market">>["t"],
  progress: NonNullable<ReturnType<typeof usePriceProgress>>,
): string {
  if (progress.current) {
    return t("progress.label", {
      done: progress.done,
      total: progress.total,
      priced: progress.priced,
      failed: progress.failed,
      current: progress.current,
    });
  }
  return t("progress.labelStarting", {
    done: progress.done,
    total: progress.total,
    priced: progress.priced,
    failed: progress.failed,
  });
}

export function SteamPriceProgress({ variant }: { variant: "banner" | "full" }) {
  const { t } = useTranslation("market");
  const status = usePriceStatus();
  const progress = usePriceProgress();
  const running = status?.running ?? false;

  if (!running) return null;

  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const stopButton = (
    <Button
      size="sm"
      variant="danger"
      className={variant === "banner" ? "ml-1.5" : undefined}
      onClick={() => window.tbh.cancelPrices()}
    >
      {t("progress.stop")}
    </Button>
  );

  if (variant === "banner") {
    const bannerProgress = progress
      ? t("progress.bannerProgress", {
          done: progress.done,
          total: progress.total,
          priced: progress.priced,
        })
      : t("progress.bannerPending");
    return (
      <HintBanner>
        {t("progress.banner")}
        {bannerProgress}. {stopButton}
        <ProgressBar
          percent={pct}
          label={
            progress?.current ? (
              <span className="mt-1.5 block text-xs text-muted">{progress.current}</span>
            ) : undefined
          }
        />
      </HintBanner>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted">{t("progress.fetching")}</span>
        {stopButton}
      </div>
      <ProgressBar
        percent={pct}
        label={
          <span className="text-xs text-muted">
            {progress ? progressLabel(t, progress) : t("progress.starting")}
          </span>
        }
      />
    </div>
  );
}
