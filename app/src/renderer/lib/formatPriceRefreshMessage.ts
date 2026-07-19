import type { TFunction } from "i18next";
import type { PriceRefreshResult, PriceRefreshSummary } from "../../../shared/types";

type RefreshMessageInput = Pick<
  PriceRefreshResult,
  "ok" | "priced" | "skipped" | "failed" | "stopped" | "error" | "noop" | "queued"
> & {
  ownedTargets?: number;
};

export function formatPriceRefreshMessage(
  t: TFunction<"market">,
  input: RefreshMessageInput,
): string {
  if (input.queued) {
    return t("refreshMessage.queued");
  }

  if (input.ownedTargets === 0) {
    return t("refreshMessage.noInventory");
  }

  if (input.noop) {
    const n = input.skipped;
    return n === 1 ? t("refreshMessage.noopOne") : t("refreshMessage.noop", { count: n });
  }

  if (!input.ok) {
    if (input.error === "already running") {
      return t("refreshMessage.alreadyRunning");
    }
    return input.error
      ? t("refreshMessage.failed", { error: input.error })
      : t("refreshMessage.failedUnknown");
  }

  const stopMsg =
    input.stopped === "cancelled"
      ? t("refreshMessage.cancelled")
      : input.stopped === "rate-limited"
        ? t("refreshMessage.rateLimited")
        : "";
  return t("refreshMessage.success", {
    priced: input.priced,
    skipped: input.skipped,
    failed: input.failed,
    stopMsg,
  });
}

export function formatPriceRefreshSummary(
  t: TFunction<"market">,
  result: PriceRefreshSummary,
): string {
  return formatPriceRefreshMessage(t, { ok: true, ...result });
}
