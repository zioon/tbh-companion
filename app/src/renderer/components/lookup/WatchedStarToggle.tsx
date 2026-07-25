import { memo } from "react";
import { LuStar } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { useWatchedHashesSet, toggleWatchedHash } from "../../lib/useWatchedHashes";
import { reportIpcError } from "../../lib/reportError";

/**
 * Star toggle for a Lookup item's `market_hash_name`. Sits in the ItemCard
 * header next to the price chip. Clicking adds/removes the hash from
 * `config.lookupPricePolling.watchedHashes`, which controls whether the
 * polling service always re-fetches this item's price (regardless of
 * ownership or threshold).
 *
 * Stops click propagation so it doesn't trigger the parent Card's `onSelect`.
 * Reads the watched set via {@link useWatchedHashesSet} (module-level
 * singleton; only re-renders when the set content actually changes, not on
 * every polling progress tick).
 */
export const WatchedStarToggle = memo(function WatchedStarToggle({ hash }: { hash: string }) {
  const { t } = useTranslation("lookup");
  const watched = useWatchedHashesSet();
  if (!hash) return null;
  const isWatched = watched.has(hash);

  async function onClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await toggleWatchedHash(hash);
    } catch (err) {
      reportIpcError(err, "WatchedStarToggle:onClick");
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => void onClick(e)}
      aria-pressed={isWatched}
      aria-label={
        isWatched ? t("watched.unwatchAria") : t("watched.watchAria")
      }
      title={
        isWatched ? t("watched.unwatchTitle") : t("watched.watchTitle")
      }
      className={cn(
        "inline-flex size-5 items-center justify-center rounded-sm transition-colors",
        isWatched
          ? "text-amber-400 hover:text-amber-500"
          : "text-amber-400/40 hover:text-amber-400",
      )}
    >
      <LuStar
        className={cn("size-4", isWatched && "fill-current")}
        aria-hidden
      />
    </button>
  );
});
