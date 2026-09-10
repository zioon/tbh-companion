import { existsSync } from "node:fs";
import {
  loadLookupItems,
  loadLookupSources,
  loadOfferings,
  loadSynthesisModel,
} from "../../core/lookup/catalog";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../core/localeCatalog";
import { gameItemName, type GameItem } from "../../core/gamedata";
import { bundledDataCandidates } from "../../core/bundledData";
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

  /**
   * Merge game-catalog (gamedata) items into the lookup directory so every
   * 1.2.2 item the bundled `lookup_items.json` lacks (new materials/gear, e.g.
   * "Coin", "Arcane Ore") can be searched in Lookup and shows a localized name
   * in Inventory/Loot. Only non-stagebox playable items (`GEAR`/`MATERIAL`)
   * are added; ids already present in the bundled lookup are left untouched so
   * rich market metadata (iconPath, stats, sources) is not clobbered.
   *
   * Re-inject via `setupCatalogLookup` (appState) after any catalog refresh —
   * `getCatalog()` re-localizes the merged rows on demand. Idempotent.
   */
  setGameData(items: GameItem[]): void {
    const present = new Set(this.sourceItems.map((it) => it.id));
    // v1.2.2 lists some gear/coins as multiple ItemKeys sharing the same
    // name+grade (affix-rolled variants, tradable/non-tradable copies). They
    // share one Steam market hash and would show as duplicates — or, for
    // MATERIAL copies without a catalog entry, as an "Unknown" category
    // (materialType=null). Skip any item already represented by the same
    // (type, name, grade).
    const variantKeys = new Set(this.sourceItems.map((it) => `${it.type}|${it.name}|${it.grade}`));
    for (const gameItem of items) {
      if (present.has(gameItem.id)) continue;
      const type = gameItem.type.toUpperCase();
      if (type !== "GEAR" && type !== "MATERIAL") continue;
      const variantKey = `${type}|${gameItem.name}|${gameItem.grade}`;
      if (variantKeys.has(variantKey)) continue;
      const lookupItem = this.toLookupItem(gameItem);
      if (lookupItem == null) continue;
      // Materials: point at the exported item icon if it ships (assetProtocol
      // serves data/icons/item-<id>.png). Gears use `<gearType>-<id>.png`.
      // Both are looked up via the same bundled-candidates logic assetProtocol
      // uses, so no broken icon references; missing icons → renderer grade dot.
      const iconName =
        lookupItem.type === "MATERIAL"
          ? `item-${lookupItem.id}`
          : lookupItem.gearType
            ? `${lookupItem.gearType.toLowerCase()}-${lookupItem.id}`
            : null;
      if (iconName != null) {
        const icon = bundledDataCandidates(`icons/${iconName}.png`);
        if (icon.some((p) => existsSync(p))) lookupItem.iconPath = iconName;
      }
      this.sourceItems.push(lookupItem);
      present.add(gameItem.id);
      variantKeys.add(variantKey);
    }
    this.localizedItemsCache = null;
  }

  /** Shape a gamedata item into a nullable `LookupItem` (non GEAR/MATERIAL → null). */
  private toLookupItem(gameItem: GameItem): LookupItem | null {
    const type = gameItem.type.toUpperCase();
    if (type !== "GEAR" && type !== "MATERIAL") return null;
    return {
      id: gameItem.id,
      name: gameItem.name,
      grade: gameItem.grade,
      type,
      gearType: gameItem.gearType ?? null,
      gearGroup: null,
      materialType: null,
      level: gameItem.level,
      iconPath: "",
      marketTradable: gameItem.marketTradable,
    };
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
