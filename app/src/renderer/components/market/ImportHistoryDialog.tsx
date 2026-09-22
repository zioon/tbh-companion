import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { STEAM_CURRENCIES } from "../../../core/steamPrice";
import type { AnalyzeMarketVolumeBackupResult } from "../../../../shared/types";
import { Button } from "../../design-system/primitives/Button/Button";
import { Dialog } from "../../design-system/primitives/Dialog/Dialog";
import { DialogTitle } from "../../design-system/primitives/Dialog/DialogParts";
import { Select } from "../../design-system/primitives/Select/Select";

/** 币种下拉里「自动探测」选项的哨兵值（主进程按 `"auto"` 走三级币种解析）。 */
export const IMPORT_CURRENCY_AUTO = "auto";

/**
 * 交易页「导入历史数据」第二步的确认弹窗。
 *
 * 展示备份摘要（物品种数 / 价格历史点数 / 时间范围）与**探测到的备份币种**，让用户
 * 确认或改选币种后融合导入。备份币种决定换算比例：以 `auto` 提交时主进程会用三级
 * 解析（顶层字段 → 采样推断 → 按备份价格历史与 USD 价格参考比对自动探测）。
 */
export function ImportHistoryDialog({
  summary,
  busy,
  onConfirm,
  onCancel,
}: {
  /** `analyzeMarketVolumeBackup()` 返回的摘要（仅在 ok=true 时渲染本组件）。 */
  summary: AnalyzeMarketVolumeBackupResult;
  busy?: boolean;
  /** 用户确认导入，回传其选择的备份币种 ISO 或 {@link IMPORT_CURRENCY_AUTO}。 */
  onConfirm: (sourceCurrency: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("market");
  const detected = summary.detectedCurrency ?? null;
  const locked = summary.baseCurrencyFile === true;
  const [choice, setChoice] = useState<string>(locked ? "USD" : IMPORT_CURRENCY_AUTO);

  const options = useMemo(() => {
    const autoLabel = detected
      ? t("trading.importSourceAuto", { currency: detected })
      : t("trading.importSourceAutoUnknown");
    const auto = [{ value: IMPORT_CURRENCY_AUTO, label: autoLabel }];
    const currencies = STEAM_CURRENCIES.map((c) => ({
      value: c.iso,
      label: `${c.iso} - ${c.label}`,
    }));
    return locked ? currencies.filter((c) => c.value === "USD") : [...auto, ...currencies];
  }, [detected, locked, t]);

  const range = useMemo(() => {
    const fmt = (ts: number | null | undefined) =>
      typeof ts === "number" && Number.isFinite(ts) ? new Date(ts * 1000).toLocaleString() : "—";
    if (summary.oldestTs == null && summary.newestTs == null) return null;
    return t("trading.importSummaryRange", {
      from: fmt(summary.oldestTs),
      to: fmt(summary.newestTs),
    });
  }, [summary.oldestTs, summary.newestTs, t]);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <div className="flex flex-col gap-3">
        <DialogTitle className="m-0 text-base font-semibold">
          {t("trading.importTitle")}
        </DialogTitle>

        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          {summary.fileName ? (
            <>
              <dt className="m-0 text-muted">{t("trading.importFileLabel")}</dt>
              <dd className="m-0 min-w-0 truncate text-fg" title={summary.fileName}>
                {summary.fileName}
              </dd>
            </>
          ) : null}
          <dt className="m-0 text-muted">{t("trading.importSummaryItems")}</dt>
          <dd className="m-0 text-fg">{summary.itemCount ?? 0}</dd>
          <dt className="m-0 text-muted">{t("trading.importSummaryPoints")}</dt>
          <dd className="m-0 text-fg">
            {summary.priceHashCount ?? 0} / {summary.pricePointCount ?? 0}
          </dd>
          {range ? (
            <>
              <dt className="m-0 text-muted">{t("trading.importSummaryRangeLabel")}</dt>
              <dd className="m-0 text-fg">{range}</dd>
            </>
          ) : null}
        </dl>

        <Select
          label={t("trading.importSourceCurrency")}
          options={options}
          value={choice}
          onValueChange={(next) => setChoice(String(next))}
          disabled={busy || locked}
        />

        {locked ? (
          <p className="m-0 text-[12px] text-muted">{t("trading.importCurrencyLocked")}</p>
        ) : null}
        {!locked && choice === IMPORT_CURRENCY_AUTO && !detected ? (
          <p className="m-0 text-[12px] text-danger">{t("trading.importCurrencyUnknown")}</p>
        ) : null}
        {!locked && detected && choice === IMPORT_CURRENCY_AUTO && summary.detection ? (
          <p className="m-0 text-[12px] text-muted">
            {t("trading.importDetectBasis", {
              count: summary.detection.samples,
              method:
                summary.detection.method === "usdHistory"
                  ? t("trading.importDetectByHistory")
                  : t("trading.importDetectBySnapshot"),
            })}
          </p>
        ) : null}

        <p className="m-0 text-[13px] text-muted">{t("trading.importMergeNotice")}</p>

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t("trading.importCancel")}
          </Button>
          <Button size="sm" onClick={() => onConfirm(choice)} disabled={busy}>
            {t("trading.importConfirmButton")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
