import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  startTransition,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { PriceStatus, PriceProgress } from "../../../shared/types";
import { formatPriceRefreshMessage } from "../lib/formatPriceRefreshMessage";
import { handleNotificationSoundPayload } from "../lib/notificationSounds";
import { reportIpcError } from "../lib/reportError";

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
  // Keep the latest t in a ref so the long-lived IPC subscription always uses
  // the current language without re-subscribing on every language change.
  // Sync in a passive effect — writing refs during render is forbidden by
  // react-hooks/refs.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
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
                formatPriceRefreshMessage(tRef.current, {
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
  }, []);

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
