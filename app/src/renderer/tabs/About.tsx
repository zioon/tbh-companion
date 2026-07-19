import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SiBuymeacoffee, SiDiscord, SiGithub } from "react-icons/si";
import type { UpdateStatus } from "../../../shared/types";
import { useUpdate } from "../lib/useUpdate";
import { reportIpcError } from "../lib/reportError";
import { Button, ButtonLink } from "../design-system/primitives/Button/Button";
import { ExternalLink } from "../components/ui/ExternalLink";
import { ProgressBar } from "../design-system/primitives/ProgressBar/ProgressBar";
import { Section } from "../design-system/primitives/Section/Section";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { BUYMEACOFFEE_URL, DISCORD_URL, GITHUB_REPO, githubReleaseUrl } from "../lib/externalLinks";

function fmtBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusMessage(
  t: (key: string, opts?: Record<string, unknown>) => string,
  status: UpdateStatus,
): string | null {
  switch (status.phase) {
    case "disabled":
      return t("updateDisabled");
    case "checking":
      return t("updateChecking");
    case "not-available":
      return t("updateNotAvailable");
    case "available":
      return status.availableVersion
        ? t("updateAvailableWithVersion", { version: status.availableVersion })
        : t("updateAvailableGeneric");
    case "downloading":
      return t("updateDownloading");
    case "ready":
      return status.availableVersion
        ? t("updateReadyWithVersion", { version: status.availableVersion })
        : t("updateReadyGeneric");
    case "error":
      return status.error ?? t("updateErrorFallback");
    default:
      return null;
  }
}

export function About() {
  const status = useUpdate();
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation("about");

  async function onCheck() {
    setBusy(true);
    try {
      await window.tbh.checkForUpdates();
    } catch (err) {
      reportIpcError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onDownload() {
    setBusy(true);
    try {
      await window.tbh.downloadUpdate();
    } catch (err) {
      reportIpcError(err);
    } finally {
      setBusy(false);
    }
  }

  function onInstall() {
    void window.tbh.quitAndInstall().catch(reportIpcError);
  }

  const phase = status?.phase ?? "idle";
  const isDisabled = phase === "disabled";
  const isChecking = phase === "checking" || busy;
  const canCheck = !isDisabled && !isChecking && phase !== "downloading" && phase !== "ready";
  const canDownload = phase === "available" && !busy;
  const canInstall = phase === "ready";
  const percent = status?.percent !== undefined ? Math.min(100, Math.round(status.percent)) : 0;
  const message = status ? statusMessage(t, status) : null;
  const showReleaseLink = status?.availableVersion && (phase === "available" || phase === "ready");

  return (
    <TabPage>
      <TabHeader title={t("title")} intro={t("intro")} />

      <div className="flex flex-col gap-3.5">
        <Section title={t("versionSection")}>
          <p className="m-0">
            <strong>v{status?.currentVersion ?? "…"}</strong>
          </p>
          <p className="m-0 flex flex-wrap items-center gap-2 text-xs">
            <ButtonLink href={GITHUB_REPO} size="sm">
              <SiGithub className="size-3.5" aria-hidden />
              <span>GitHub</span>
            </ButtonLink>
            <ButtonLink href={DISCORD_URL} size="sm">
              <SiDiscord className="size-3.5" aria-hidden />
              <span>Discord</span>
            </ButtonLink>
            <ButtonLink
              href={BUYMEACOFFEE_URL}
              size="sm"
              className="border-gold/60 text-gold hover:border-gold"
            >
              <SiBuymeacoffee className="size-3.5" aria-hidden />
              <span>{t("supportButtonLabel")}</span>
            </ButtonLink>
          </p>
          <p className="m-0 max-w-2xl text-xs text-muted">{t("notAffiliated")}</p>
        </Section>

        {!isDisabled && (
          <Section title={t("updatesSection")} className="max-w-md">
            {message && (
              <p className={`m-0 ${phase === "error" ? "text-accent" : "text-muted"}`}>{message}</p>
            )}

            {phase === "downloading" && (
              <ProgressBar
                percent={percent}
                label={
                  <span className="text-xs text-muted">
                    {percent}%
                    {status?.transferred && status?.total
                      ? ` — ${fmtBytes(status.transferred)} / ${fmtBytes(status.total)}`
                      : ""}
                  </span>
                }
              />
            )}

            {showReleaseLink && (
              <p className="m-0 text-xs">
                <ExternalLink href={githubReleaseUrl(status.availableVersion!)}>
                  {t("releaseOnGithub", { version: status.availableVersion })}
                </ExternalLink>
              </p>
            )}

            <div className="mt-1 flex flex-wrap gap-2">
              {canCheck && (
                <Button variant="primary" disabled={isChecking} onClick={() => void onCheck()}>
                  {isChecking ? t("checking") : t("checkForUpdates")}
                </Button>
              )}
              {canDownload && (
                <Button variant="primary" onClick={() => void onDownload()}>
                  {t("downloadUpdate")}
                </Button>
              )}
              {canInstall && (
                <Button variant="primary" onClick={onInstall}>
                  {t("restartToInstall")}
                </Button>
              )}
            </div>

            {canInstall && <p className="m-0 text-xs text-muted">{t("restartHint")}</p>}

            {phase === "idle" && <p className="m-0 text-xs text-muted">{t("idleHint")}</p>}
          </Section>
        )}
      </div>
    </TabPage>
  );
}
