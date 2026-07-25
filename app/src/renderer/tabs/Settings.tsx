import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { STEAM_CURRENCIES } from "../../core/steamPrice";
import type {
  NotificationKindId,
  NotificationKindPreference,
} from "../../../shared/notificationCatalog";
import { APP_LANGUAGES, LANGUAGE_DISPLAY_NAMES, type AppLanguage } from "../../../shared/language";
import type { AppConfig, AppDataClearTarget, AppDataPaths } from "../../../shared/types";
import { reportIpcError } from "../lib/reportError";
import { cn } from "../lib/cn";
import { changeRendererLanguage } from "../i18n";
import { Accordion } from "../design-system/primitives/Accordion/Accordion";
import { NotificationSoundAccordion } from "../components/NotificationKindRow";
import { LiveMemorySettings } from "../components/LiveMemorySettings";
import { CatalogRefreshButton } from "../components/CatalogRefreshButton";
import { Button } from "../design-system/primitives/Button/Button";
import { Card } from "../design-system/primitives/Card/Card";
import { Checkbox } from "../design-system/primitives/Checkbox/Checkbox";
import { Slider } from "../design-system/primitives/Slider/Slider";
import { Field } from "../design-system/primitives/Field/Field";
import { NumberInput } from "../design-system/primitives/NumberField/NumberField";
import { Section } from "../design-system/primitives/Section/Section";
import { Select } from "../design-system/primitives/Select/Select";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { useTbhContext } from "../context/tbhContext";

const CLEAR_ACTION_TARGETS: AppDataClearTarget[] = [
  "prices",
  "lookup-prices",
  "box-timers",
  "session",
  "all-except-config",
];

type SettingsPatch = Omit<AppConfig, "es3Password">;

function CacheActionRow({
  title,
  detail,
  missingHint,
  variant = "default",
  disabled,
  busy,
  onClear,
  clearLabel,
  clearingLabel,
}: {
  title: string;
  detail: string;
  missingHint?: string;
  variant?: "default" | "danger";
  disabled?: boolean;
  busy?: boolean;
  onClear: () => void;
  clearLabel: string;
  clearingLabel: string;
}) {
  return (
    <Card padding="compact" className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-[13px] font-semibold">{title}</strong>
        <span className="text-xs text-muted">{detail}</span>
        {missingHint ? <span className="text-xs text-muted">{missingHint}</span> : null}
      </div>
      <Button variant={variant} className="shrink-0" disabled={disabled} onClick={onClear}>
        {busy ? clearingLabel : clearLabel}
      </Button>
    </Card>
  );
}

export function Settings() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [dataPaths, setDataPaths] = useState<AppDataPaths | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState<AppDataClearTarget | null>(null);
  const [clearLogsBusy, setClearLogsBusy] = useState(false);
  const pendingVolumeRef = useRef<number | null>(null);
  const volumeSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingThresholdRef = useRef<number | null>(null);
  const thresholdSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { catalogStatus, refreshCatalog } = useTbhContext();
  const { t: tSettings } = useTranslation("settings");

  async function changeLanguage(next: AppLanguage): Promise<void> {
    // For "game" we need the main-process-resolved language (read from the
    // game's registry) before we can switch the renderer's i18n. savePartial
    // triggers applyConfigPatch → onLanguageChanged → main changeLanguage +
    // rebuildTrayMenu; the main process re-reads the registry there. We then
    // re-fetch the config (now carrying resolvedLanguage) and switch the
    // renderer.
    if (next === "game") {
      await savePartial({ language: next }, undefined, { silent: true });
      // Re-fetch config to pick up the main-process-injected resolvedLanguage.
      if (typeof window.tbh?.getConfig === "function") {
        try {
          const fresh = await window.tbh.getConfig();
          await changeRendererLanguage(next, fresh.resolvedLanguage);
        } catch (err) {
          reportIpcError(err);
        }
      }
      return;
    }
    // Persist first so the main process applies the new language to
    // LocaleCatalog (LookupService.setLocaleCatalog) BEFORE we switch the
    // renderer's i18next. useLookupCatalog subscribes to i18next's
    // `languageChanged` event and re-fetches `getLookupCatalog()` immediately
    // — if we switch the renderer first, the fetch arrives at the main process
    // before reloadLocaleCatalog() runs, and the renderer receives item names
    // in the OLD language (then never re-fetches, since the event only fires
    // once). Waiting for savePartial adds one IPC round-trip (~10ms) but
    // guarantees catalog consistency.
    await savePartial({ language: next }, undefined, { silent: true });
    await changeRendererLanguage(next);
  }

  async function refreshDataPaths(): Promise<void> {
    if (typeof window.tbh?.getDataPaths !== "function") return;
    try {
      setDataPaths(await window.tbh.getDataPaths());
    } catch (err) {
      reportIpcError(err);
    }
  }

  useEffect(() => {
    if (typeof window.tbh?.getConfig !== "function") {
      setLoadError(tSettings("settingsApiNotLoaded"));
      return;
    }
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((c) => {
        if (!mounted) return;
        setCfg(c);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        reportIpcError(err);
        const text = err instanceof Error ? err.message : tSettings("loadErrorDefault");
        setLoadError(text);
      });
    void refreshDataPaths().then(() => {
      if (!mounted) return;
    });
    return () => {
      mounted = false;
    };
  }, [tSettings]);

  async function savePartial(
    patch: Partial<SettingsPatch>,
    successMessage?: string,
    options?: { silent?: boolean },
  ): Promise<AppConfig | null> {
    if (!cfg) return null;
    const prev = cfg;
    setCfg({ ...prev, ...patch });
    if (!options?.silent) setSaveBusy(true);
    setMessage(null);
    try {
      const saved = await window.tbh.saveConfig(patch);
      setCfg(saved);
      if (successMessage) setMessage(successMessage);
      return saved;
    } catch (err) {
      reportIpcError(err);
      setCfg(prev);
      setMessage(tSettings("messages.failedToSave"));
      return null;
    } finally {
      if (!options?.silent) setSaveBusy(false);
    }
  }

  function flushVolumeSave(): void {
    if (volumeSaveTimerRef.current) {
      clearTimeout(volumeSaveTimerRef.current);
      volumeSaveTimerRef.current = null;
    }
    const value = pendingVolumeRef.current;
    if (value === null) return;
    pendingVolumeRef.current = null;
    void savePartial({ notificationVolume: value }, undefined, { silent: true });
  }

  function scheduleVolumeSave(value: number): void {
    pendingVolumeRef.current = value;
    if (volumeSaveTimerRef.current) clearTimeout(volumeSaveTimerRef.current);
    volumeSaveTimerRef.current = setTimeout(flushVolumeSave, 300);
  }

  function flushThresholdSave(): void {
    if (thresholdSaveTimerRef.current) {
      clearTimeout(thresholdSaveTimerRef.current);
      thresholdSaveTimerRef.current = null;
    }
    const value = pendingThresholdRef.current;
    if (value === null) return;
    pendingThresholdRef.current = null;
    void savePartial({ inventoryAlmostFullThresholdPercent: value }, undefined, { silent: true });
  }

  function scheduleThresholdSave(value: number): void {
    pendingThresholdRef.current = value;
    if (thresholdSaveTimerRef.current) clearTimeout(thresholdSaveTimerRef.current);
    thresholdSaveTimerRef.current = setTimeout(flushThresholdSave, 300);
  }

  useEffect(
    () => () => {
      if (volumeSaveTimerRef.current) {
        clearTimeout(volumeSaveTimerRef.current);
        volumeSaveTimerRef.current = null;
      }
      const value = pendingVolumeRef.current;
      if (value !== null) {
        pendingVolumeRef.current = null;
        if (typeof window.tbh?.saveConfig === "function") {
          void window.tbh.saveConfig({ notificationVolume: value });
        }
      }
      if (thresholdSaveTimerRef.current) {
        clearTimeout(thresholdSaveTimerRef.current);
        thresholdSaveTimerRef.current = null;
      }
      const thresholdValue = pendingThresholdRef.current;
      if (thresholdValue !== null) {
        pendingThresholdRef.current = null;
        if (typeof window.tbh?.saveConfig === "function") {
          void window.tbh.saveConfig({ inventoryAlmostFullThresholdPercent: thresholdValue });
        }
      }
    },
    [],
  );

  if (loadError) {
    return (
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-lg font-semibold">{tSettings("tabTitle")}</h1>
        <p className="m-0 text-muted">{loadError}</p>
      </div>
    );
  }

  if (!cfg) {
    return (
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-lg font-semibold">{tSettings("tabTitle")}</h1>
        <p className="m-0 text-muted">{tSettings("loading")}</p>
      </div>
    );
  }

  async function onBrowseSave() {
    if (typeof window.tbh?.pickSaveFile !== "function") {
      setMessage(tSettings("saveFile.savePickerNotLoaded"));
      return;
    }
    setBrowseBusy(true);
    setMessage(null);
    try {
      const path = await window.tbh.pickSaveFile();
      if (path) await savePartial({ savePath: path }, tSettings("saveFile.savePathUpdated"));
    } catch (err) {
      reportIpcError(err);
      setMessage(tSettings("saveFile.couldNotOpenPicker"));
    } finally {
      setBrowseBusy(false);
    }
  }

  async function onClearDiagnosticLogs() {
    if (typeof window.tbh?.clearDiagnosticLogs !== "function") {
      setMessage(tSettings("messages.diagnosticsApiNotLoaded"));
      return;
    }
    if (!window.confirm(tSettings("advanced.clearDiagnosticLogsConfirm"))) {
      return;
    }

    setClearLogsBusy(true);
    setMessage(null);
    try {
      const result = await window.tbh.clearDiagnosticLogs();
      if (!result.ok) {
        setMessage(result.error ?? tSettings("messages.couldNotClearLogs"));
        return;
      }
      await refreshDataPaths();
      const count = result.cleared.length;
      setMessage(
        count > 0
          ? count === 1
            ? tSettings("messages.clearedFilesOne")
            : tSettings("messages.clearedFilesOther", { count })
          : tSettings("messages.nothingToClearLogs"),
      );
    } catch (err) {
      reportIpcError(err, "settings-clear-logs");
      setMessage(tSettings("messages.couldNotClearLogs"));
    } finally {
      setClearLogsBusy(false);
    }
  }

  async function onClearCache(target: AppDataClearTarget, confirmText: string) {
    if (typeof window.tbh?.clearAppData !== "function") {
      setMessage(tSettings("messages.clearCacheApiNotLoaded"));
      return;
    }
    if (!window.confirm(confirmText)) return;

    setClearBusy(target);
    setMessage(null);
    try {
      const result = await window.tbh.clearAppData(target);
      if (!result.ok) {
        setMessage(result.error ?? tSettings("messages.couldNotClearCache"));
        return;
      }
      await refreshDataPaths();
      const count = result.cleared.length;
      setMessage(
        count > 0
          ? count === 1
            ? tSettings("messages.clearedFilesOne")
            : tSettings("messages.clearedFilesOther", { count })
          : tSettings("messages.nothingToClear"),
      );
    } catch (err) {
      reportIpcError(err);
      setMessage(tSettings("messages.couldNotClearCache"));
    } finally {
      setClearBusy(null);
    }
  }

  function pathEntryExists(target: AppDataClearTarget): boolean {
    if (!dataPaths) return false;
    if (target === "session" || target === "all-except-config") return true;
    return dataPaths.entries.find((e) => e.id === target)?.exists ?? false;
  }

  function showMissingHint(target: AppDataClearTarget): boolean {
    if (!dataPaths || target === "session" || target === "all-except-config") return false;
    return !pathEntryExists(target);
  }

  return (
    <TabPage>
      <TabHeader title={tSettings("tabTitle")} intro={tSettings("intro")} />

      <div className="flex max-w-md flex-col gap-3.5">
        <Section title={tSettings("language.label")}>
          <Field label={tSettings("language.label")}>
            <Select
              value={cfg.language}
              disabled={saveBusy}
              onValueChange={(value) => void changeLanguage(value as AppLanguage)}
              options={[
                { value: "auto", label: tSettings("language.auto") },
                { value: "game", label: tSettings("language.game") },
                ...APP_LANGUAGES.map((lang) => ({
                  value: lang,
                  label: LANGUAGE_DISPLAY_NAMES[lang],
                })),
              ]}
            />
          </Field>
          <p className="m-0 text-xs text-muted">{tSettings("language.restartHint")}</p>
        </Section>

        <Section title={tSettings("saveFile.sectionTitle")}>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted">{tSettings("saveFile.currentSaveFile")}</span>
            <code className="break-all rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted">
              {cfg.savePath}
            </code>
            <Button disabled={browseBusy || saveBusy} onClick={() => void onBrowseSave()}>
              {browseBusy ? tSettings("saveFile.opening") : tSettings("saveFile.browse")}
            </Button>
          </div>
        </Section>

        <Section title={tSettings("savePolling.sectionTitle")}>
          <div className="flex flex-col gap-3">
            <Field label={tSettings("savePolling.pollInterval")}>
              <NumberInput
                min={1}
                defaultValue={cfg.pollIntervalSeconds}
                key={`poll-${cfg.pollIntervalSeconds}`}
                disabled={saveBusy}
                onBlur={(e) => {
                  const value = Math.max(1, Number(e.target.value) || 1);
                  if (value === cfg.pollIntervalSeconds) return;
                  void savePartial({ pollIntervalSeconds: value });
                }}
              />
            </Field>

            <Field
              label={tSettings("savePolling.rollingWindow")}
              hint={tSettings("savePolling.rollingWindowHint")}
            >
              <NumberInput
                min={1}
                defaultValue={cfg.rollingWindowMinutes}
                key={`rolling-${cfg.rollingWindowMinutes}`}
                disabled={saveBusy}
                onBlur={(e) => {
                  const value = Math.max(1, Number(e.target.value) || 1);
                  if (value === cfg.rollingWindowMinutes) return;
                  if (!window.confirm(tSettings("savePolling.rollingWindowConfirm"))) {
                    e.target.value = String(cfg.rollingWindowMinutes);
                    return;
                  }
                  void savePartial(
                    { rollingWindowMinutes: value },
                    tSettings("savePolling.rollingWindowSuccess"),
                  );
                }}
              />
            </Field>

            <Checkbox
              label={tSettings("savePolling.logHistoryCsv")}
              checked={cfg.logHistoryCsv}
              disabled={saveBusy}
              onCheckedChange={(checked) => void savePartial({ logHistoryCsv: checked })}
            />
          </div>
        </Section>

        <LiveMemorySettings
          prefs={cfg.liveMemory}
          disabled={saveBusy}
          onChange={(next) => void savePartial({ liveMemory: next })}
        />

        <Section title={tSettings("steamMarket.sectionTitle")}>
          <Field label={tSettings("steamMarket.marketCurrency")}>
            <Select
              value={cfg.currency}
              disabled={saveBusy}
              onValueChange={(value) => void savePartial({ currency: String(value) })}
              options={STEAM_CURRENCIES.map((c) => ({
                value: c.iso,
                label: `${c.iso} - ${c.label}`,
              }))}
            />
          </Field>

          <div className="mt-4 flex flex-col gap-3 border-t border-border/40 pt-4">
            <div className="flex flex-col gap-1">
              <strong className="text-[13px] font-semibold">
                {tSettings("steamMarket.polling.sectionTitle")}
              </strong>
              <span className="text-xs text-muted">{tSettings("steamMarket.polling.intro")}</span>
            </div>

            <Checkbox
              label={tSettings("steamMarket.polling.enable")}
              checked={cfg.lookupPricePolling.enabled}
              disabled={saveBusy}
              onCheckedChange={(checked) =>
                void savePartial({
                  lookupPricePolling: { ...cfg.lookupPricePolling, enabled: checked },
                })
              }
            />

            <Field
              label={tSettings("steamMarket.polling.intervalMinutes")}
              hint={tSettings("steamMarket.polling.intervalMinutesHint")}
            >
              <NumberInput
                min={5}
                max={60}
                defaultValue={cfg.lookupPricePolling.intervalMinutes}
                key={`polling-interval-${cfg.lookupPricePolling.intervalMinutes}`}
                disabled={saveBusy || !cfg.lookupPricePolling.enabled}
                onBlur={(e) => {
                  const value = Math.min(60, Math.max(5, Number(e.target.value) || 5));
                  if (value === cfg.lookupPricePolling.intervalMinutes) return;
                  void savePartial({
                    lookupPricePolling: { ...cfg.lookupPricePolling, intervalMinutes: value },
                  });
                }}
              />
            </Field>

            <Field
              label={tSettings("steamMarket.polling.thresholdUsd")}
              hint={tSettings("steamMarket.polling.thresholdUsdHint")}
            >
              <NumberInput
                min={0}
                step={0.5}
                defaultValue={cfg.lookupPricePolling.thresholdUsd}
                key={`polling-threshold-${cfg.lookupPricePolling.thresholdUsd}`}
                disabled={saveBusy || !cfg.lookupPricePolling.enabled}
                onBlur={(e) => {
                  const value = Math.max(0, Number(e.target.value) || 0);
                  if (value === cfg.lookupPricePolling.thresholdUsd) return;
                  void savePartial({
                    lookupPricePolling: { ...cfg.lookupPricePolling, thresholdUsd: value },
                  });
                }}
              />
            </Field>

            <Field
              label={tSettings("steamMarket.polling.watchedHashes")}
              hint={tSettings("steamMarket.polling.watchedHashesHint")}
            >
              <textarea
                className="min-h-[80px] w-full resize-y rounded border border-border/50 bg-input px-2 py-1.5 font-mono text-xs"
                placeholder={tSettings("steamMarket.polling.watchedHashesPlaceholder")}
                defaultValue={cfg.lookupPricePolling.watchedHashes.join("\n")}
                disabled={saveBusy || !cfg.lookupPricePolling.enabled}
                onBlur={(e) => {
                  const next = e.target.value
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                  const prev = cfg.lookupPricePolling.watchedHashes;
                  // 顺序无关比较：两边都是去重去空后的集合
                  const same = next.length === prev.length && next.every((h) => prev.includes(h));
                  if (same) return;
                  void savePartial({
                    lookupPricePolling: { ...cfg.lookupPricePolling, watchedHashes: next },
                  });
                }}
              />
            </Field>
          </div>
        </Section>

        <Section title={tSettings("notifications.sectionTitle")}>
          <p className="m-0 text-xs text-muted">{tSettings("notifications.intro")}</p>
          <div className="flex flex-col gap-3">
            <Checkbox
              label={tSettings("notifications.enable")}
              checked={cfg.notificationsEnabled}
              disabled={saveBusy}
              onCheckedChange={(checked) => void savePartial({ notificationsEnabled: checked })}
            />

            <div className="flex flex-col gap-1">
              <Checkbox
                label={tSettings("notifications.notifyOnUpdate")}
                checked={cfg.notifyOnUpdateAvailable}
                disabled={!cfg.notificationsEnabled || saveBusy}
                onCheckedChange={(checked) =>
                  void savePartial({ notifyOnUpdateAvailable: checked })
                }
              />
              <span
                className={cn(
                  "min-h-[1.125rem] text-xs text-muted",
                  cfg.notificationsEnabled && "invisible",
                )}
              >
                {tSettings("notifications.enableFirst")}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <Slider
                min={0}
                max={100}
                step={1}
                value={cfg.notificationVolume}
                disabled={!cfg.notificationsEnabled}
                label={tSettings("notifications.soundVolume")}
                formatValue={(n) => `${n}%`}
                onValueChange={(value) => {
                  setCfg({ ...cfg, notificationVolume: value });
                  scheduleVolumeSave(value);
                }}
                onPointerUp={flushVolumeSave}
                onBlur={flushVolumeSave}
              />
              <span className="min-h-[2.5rem] text-xs text-muted">
                {!cfg.notificationsEnabled
                  ? tSettings("notifications.enableFirst")
                  : tSettings("notifications.soundVolumeHint")}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <Slider
                min={50}
                max={100}
                step={1}
                value={cfg.inventoryAlmostFullThresholdPercent}
                disabled={!cfg.notificationsEnabled || saveBusy}
                label={tSettings("notifications.inventoryThreshold")}
                formatValue={(n) => `${n}%`}
                onValueChange={(value) => {
                  setCfg({ ...cfg, inventoryAlmostFullThresholdPercent: value });
                  scheduleThresholdSave(value);
                }}
                onPointerUp={flushThresholdSave}
                onBlur={flushThresholdSave}
              />
              <span className="min-h-[2.5rem] text-xs text-muted">
                {!cfg.notificationsEnabled
                  ? tSettings("notifications.enableFirst")
                  : tSettings("notifications.inventoryThresholdHint")}
              </span>
            </div>

            <Accordion variant="panel" title={tSettings("notifications.soundsAccordion")}>
              <NotificationSoundAccordion
                prefs={cfg.notificationPrefs}
                disabled={!cfg.notificationsEnabled}
                saveBusy={saveBusy}
                notificationVolume={cfg.notificationVolume}
                onKindChange={(kindId: NotificationKindId, next: NotificationKindPreference) =>
                  void savePartial({
                    notificationPrefs: {
                      ...cfg.notificationPrefs,
                      [kindId]: next,
                    },
                  })
                }
              />
            </Accordion>
          </div>
        </Section>

        <Section title={tSettings("windowTray.sectionTitle")}>
          <div className="flex flex-col gap-3">
            <Checkbox
              label={tSettings("windowTray.keepOnTopMain")}
              checked={cfg.topmost.main}
              disabled={saveBusy}
              onCheckedChange={(checked) =>
                void savePartial({ topmost: { ...cfg.topmost, main: checked } })
              }
            />
            <Checkbox
              label={tSettings("windowTray.keepOnTopOverlay")}
              checked={cfg.topmost.overlay}
              disabled={saveBusy}
              onCheckedChange={(checked) =>
                void savePartial({ topmost: { ...cfg.topmost, overlay: checked } })
              }
            />
            <Checkbox
              label={tSettings("windowTray.keepOnTopBoxTracker")}
              checked={cfg.topmost.boxTracker}
              disabled={saveBusy}
              onCheckedChange={(checked) =>
                void savePartial({ topmost: { ...cfg.topmost, boxTracker: checked } })
              }
            />
            <p className="m-0 text-xs text-muted">
              <Trans i18nKey="settings:windowTray.trayHint" components={{ strong: <strong /> }} />
            </p>
          </div>
        </Section>

        <Accordion variant="panel" title={tSettings("advanced.accordionTitle")}>
          <Section title={tSettings("advanced.diagnosticsTitle")}>
            <p className="m-0 text-xs text-muted">{tSettings("advanced.diagnosticsIntro")}</p>
            {dataPaths ? (
              <p className="m-0 text-xs text-muted">
                <span>{tSettings("advanced.logFileLabel")}</span>{" "}
                <code className="break-all">{dataPaths.diagnosticLogPath}</code>
              </p>
            ) : (
              <p className="m-0 text-xs text-muted">{tSettings("advanced.loadingLogPath")}</p>
            )}
            <CacheActionRow
              title={tSettings("advanced.clearDiagnosticLogsTitle")}
              detail={tSettings("advanced.clearDiagnosticLogsDetail")}
              clearLabel={tSettings("cacheAction.clear")}
              clearingLabel={tSettings("cacheAction.clearing")}
              disabled={
                clearLogsBusy ||
                Boolean(clearBusy) ||
                !dataPaths?.entries.find((e) => e.id === "diagnostic-log")?.exists
              }
              busy={clearLogsBusy}
              onClear={() => void onClearDiagnosticLogs()}
            />
          </Section>

          <Section title={tSettings("advanced.dataCacheTitle")}>
            <p className="m-0 text-xs text-muted">
              <Trans i18nKey="settings:advanced.dataCacheIntro" components={{ code: <code /> }} />
            </p>
            {dataPaths ? (
              <p className="m-0 text-xs text-muted">
                <span>{tSettings("advanced.folderLabel")}</span>{" "}
                <code className="break-all">{dataPaths.userDataDir}</code>
              </p>
            ) : (
              <p className="m-0 text-xs text-muted">{tSettings("advanced.loadingCachePaths")}</p>
            )}

            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {CLEAR_ACTION_TARGETS.map((target) => {
                const hasData = pathEntryExists(target);
                const isBusy = clearBusy === target;
                const isDanger = target === "all-except-config";
                return (
                  <li key={target} className="list-none">
                    <CacheActionRow
                      title={tSettings(`clearActions.${target}.label`)}
                      detail={tSettings(`clearActions.${target}.detail`)}
                      missingHint={
                        showMissingHint(target) ? tSettings("advanced.nothingCached") : undefined
                      }
                      variant={isDanger ? "danger" : "default"}
                      clearLabel={tSettings("cacheAction.clear")}
                      clearingLabel={tSettings("cacheAction.clearing")}
                      disabled={Boolean(clearBusy) || !hasData}
                      busy={isBusy}
                      onClear={() =>
                        void onClearCache(target, tSettings(`clearActions.${target}.confirm`))
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </Section>
        </Accordion>

        <Section title={tSettings("itemCatalog.sectionTitle")}>
          <p className="m-0 text-xs text-muted">
            {catalogStatus?.catalogVersion
              ? tSettings("itemCatalog.catalogVersion", { version: catalogStatus.catalogVersion })
              : tSettings("itemCatalog.catalogVersionUnknown")}
            {catalogStatus?.gameVersion
              ? tSettings("itemCatalog.gameVersionSuffix", { version: catalogStatus.gameVersion })
              : ""}
            {catalogStatus?.stale ? tSettings("itemCatalog.outdatedSuffix") : ""}
          </p>
          <p className="m-0 text-xs text-muted">
            {tSettings("itemCatalog.itemsLoaded", {
              count: catalogStatus?.itemCount ?? 0,
              source: catalogStatus?.source ?? tSettings("itemCatalog.sourceBundled"),
            })}
          </p>
          <CatalogRefreshButton status={catalogStatus} onRefresh={refreshCatalog} />
        </Section>

        <Section title={tSettings("itemCatalog.installPathSectionTitle")}>
          <Field
            label={tSettings("itemCatalog.installPathLabel")}
            hint={tSettings("itemCatalog.installPathHint")}
          >
            <input
              type="text"
              key={`game-install-${cfg?.gameInstallDir ?? ""}`}
              defaultValue={cfg?.gameInstallDir ?? ""}
              disabled={saveBusy}
              placeholder={tSettings("itemCatalog.installPathPlaceholder")}
              aria-label={tSettings("itemCatalog.installPathLabel")}
              onBlur={(e) => {
                const value = e.target.value.trim();
                const current = cfg?.gameInstallDir?.trim() ?? "";
                if (value === current) return;
                void savePartial(
                  { gameInstallDir: value },
                  value
                    ? tSettings("itemCatalog.installPathSaved")
                    : tSettings("itemCatalog.installPathCleared"),
                );
              }}
              className="min-w-0 rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] text-fg placeholder:text-muted/60 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ideal/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </Field>
        </Section>

        {message && <p className="m-0 text-[13px] text-accent">{message}</p>}
      </div>
    </TabPage>
  );
}
