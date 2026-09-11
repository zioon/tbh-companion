import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  startTransition,
  type ReactNode,
} from "react";
import type { PriceStatus, PriceProgress } from "../../../shared/types";
import { formatPriceRefreshMessage } from "../lib/formatPriceRefreshMessage";
import { handleNotificationSoundPayload } from "../lib/notificationSounds";
import { reportIpcError } from "../lib/reportError";
import { useTranslation } from "react-i18next";

interface PriceContextValue {
  priceStatus: PriceStatus | null;
  priceProgress: PriceProgress | null;
  lastPriceRefreshMessage: string | null;
  setPriceStatus: (status: PriceStatus | null) => void;
  clearPriceProgress: () => void;
  clearLastPriceRefreshMessage: () => void;
}

const PriceContext = createContext<PriceContextValue | null>(null);

export function PriceProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("market");
  const [priceStatus, setPriceStatus] = useState<PriceStatus | null>(null);
  const [priceProgress, setPriceProgress] = useState<PriceProgress | null>(null);
  const [lastPriceRefreshMessage, setLastPriceRefreshMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void window.tbh
      .pricesStatus()
      .then((ps) => {
        if (mounted) setPriceStatus(ps);
      })
      .catch(reportIpcError);

    const offPriceStatus = window.tbh.onPriceStatus((ps) => {
      if (mounted) {
        setPriceStatus(ps);
        if (ps.freshCount === 0) {
          setLastPriceRefreshMessage(null);
        }
      }
    });
    const offNotificationSound = window.tbh.onPlayNotificationSound(handleNotificationSoundPayload);
    const offProgress = window.tbh.onPricesProgress((p) => {
      if (p.finished) {
        startTransition(() => setPriceProgress(null));
        void window.tbh
          .pricesStatus()
          .then((ps) => {
            if (!mounted) return;
            setPriceStatus(ps);
            if (p.result) {
              setLastPriceRefreshMessage(
                formatPriceRefreshMessage(t, {
                  ok: true,
                  ...p.result,
                  ownedTargets: ps.ownedTargets,
                }),
              );
            }
          })
          .catch(reportIpcError);
        return;
      }
      // Progress tick: just update progress, don't fetch full status
      startTransition(() => setPriceProgress(p));
    });

    return () => {
      mounted = false;
      offPriceStatus();
      offNotificationSound();
      offProgress();
    };
  }, [t]);

  const value = useMemo(
    () => ({
      priceStatus,
      priceProgress,
      lastPriceRefreshMessage,
      setPriceStatus,
      clearPriceProgress: () => setPriceProgress(null),
      clearLastPriceRefreshMessage: () => setLastPriceRefreshMessage(null),
    }),
    [priceStatus, priceProgress, lastPriceRefreshMessage],
  );
  return <PriceContext.Provider value={value}>{children}</PriceContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook + provider pair is the standard Context pattern
export function usePriceContext(): PriceContextValue {
  const ctx = useContext(PriceContext);
  if (!ctx) throw new Error("PriceProvider missing");
  return ctx;
}
