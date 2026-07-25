import {
  loadLookupItems,
  loadLookupSources,
  loadOfferings,
  loadSynthesisModel,
} from "../../core/lookup/catalog";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../core/localeCatalog";
import { gameItemName } from "../../core/gamedata";
import type {
  LookupItem,
  LookupSources,
  OfferingsModel,
  SynthesisModel,
} from "../../../shared/types";

export class LookupService {
  private readonly sourceItems: LookupItem[] = loadLookupItems();
  private readonly sources: LookupSources = loadLookupSources();
  private readonly synthesisModel: SynthesisModel = loadSynthesisModel();
  private readonly offerings: OfferingsModel = loadOfferings();
  /**
   * LocaleCatalog for item display name localization. Defaults to
   * {@link emptyLocaleCatalog} (no localization — returns source English
   * names); swapped via {@link setLocaleCatalog} when the user changes
   * language. When non-empty, {@link getCatalog} returns items with
   * localized `name` via {@link gameItemName}.
   */
  private localeCatalog: LocaleCatalog = emptyLocaleCatalog();
  /** Cached localized items; invalidated on {@link setLocaleCatalog}. */
  private localizedItemsCache: LookupItem[] | null = null;

  getCatalog(): LookupItem[] {
    if (this.localizedItemsCache == null) {
      this.localizedItemsCache = this.sourceItems.map((item) => {
        const localizedName = gameItemName(item, this.localeCatalog);
        if (localizedName !== item.name) {
          // Preserve the English source name so marketHashName() can still
          // derive the English Steam market_hash_name — Steam hashes are
          // always English, and the price snapshot is keyed by them. Without
          // this, switching to Chinese (e.g. "Copper Coin" → "铜币") would
          // make the localized name miss every snapshot entry.
          return { ...item, name: localizedName, sourceName: item.name };
        }
        return item;
      });
    }
    return this.localizedItemsCache;
  }

  getSources(): LookupSources {
    return this.sources;
  }

  getSynthesisModel(): SynthesisModel {
    return this.synthesisModel;
  }

  getOfferings(): OfferingsModel {
    return this.offerings;
  }

  /**
   * Swap the LocaleCatalog used for item display name localization. Called
   * by appState when the user changes language. Invalidates the localized
   * items cache so the next {@link getCatalog} call re-localizes.
   */
  setLocaleCatalog(catalog: LocaleCatalog): void {
    this.localeCatalog = catalog;
    this.localizedItemsCache = null;
  }
}
