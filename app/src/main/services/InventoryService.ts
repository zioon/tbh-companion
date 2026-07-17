import { GameDataProvider } from "../gameDataProvider";
import { SteamMarketProvider } from "../steamMarketProvider";
import { ownedPriceTargets, ownedPriceTargetForItem, parseInventory } from "../../core/inventory";
import { flattenOwnedHashes } from "../../core/inventory/ownedPriceTargets";
import { getTbhMarketFeeRates } from "../../core/steamMarketFeeBundled";
import type { OwnedPriceTarget } from "../../core/inventory/ownedPriceTargets";
import type { GameItem } from "../../core/gamedata";
import type {
  InventorySnapshot,
  ResolvedInventory,
  InventoryPriceInfo,
  PriceProgress,
  PriceStatus,
  PriceRefreshResult,
} from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import { broadcast } from "./broadcast";
import { createLogger } from "../log";
import { InventoryWorker } from "./inventoryWorker";

const log = createLogger("inventory");

export class InventoryService {
  private readonly gameData = new GameDataProvider();
  private market: SteamMarketProvider | null = null;
  private lastInventoryRaw: InventorySnapshot | null = null;
  private lastInventory: ResolvedInventory | null = null;
  private priceRefreshQueued = false;
  private priceRefreshForceQueued = false;
  private priceRefreshPendingTargets: OwnedPriceTarget[] = [];
  private onAlmostFull?: (payload: { used: number; capacity: number }) => void;
  private getAlmostFullThresholdPercent: () => number = () => 90;
  private wasAboveAlmostFullThreshold = false;
  private onInventoryUpdated?: (snap: ResolvedInventory) => void;
  /**
   * P1-6: utility-process host for the heavy `resolveInventory` call. Falls
   * back to the synchronous path (the pre-P1-6 behavior) when the worker is
   * still starting up, has crashed, or is otherwise unavailable — so the UI
   * never loses inventory updates. Owned here so the worker's lifetime matches
   * the service's lifetime.
   */
  private readonly worker = new InventoryWorker(getTbhMarketFeeRates());

  initMarket(currency: string): void {
    this.market = new SteamMarketProvider(currency);
  }

  loadGameData(): void {
    this.gameData.load();
    // Spawn the worker asynchronously. The first `resolveAndPushInventory`
    // below will run on the sync fallback path because `init` hasn't
    // resolved yet — that's intentional, it keeps startup latency low for
    // small inventories and lets the worker take over once ready.
    void this.worker.init(this.gameData.asMap(), getTbhMarketFeeRates()).catch((err) => {
      log.warn(`Inventory worker init failed: ${String(err)}`);
    });
    this.resolveAndPushInventory();
  }

  /**
   * Re-push gameData + feeRates into the running worker without re-spawning.
   * Called after `reloadPriceCache` (cache cleared) or `setCurrency` (currency
   * changed, fee rates unchanged but worker cache for owned hashes may have
   * rotated). Idempotent: a no-op when the worker isn't running.
   */
  private refreshWorkerState(): void {
    if (this.gameData.isLoaded()) {
      void this.worker
        .init(this.gameData.asMap(), getTbhMarketFeeRates())
        .catch((err) => log.warn(`Inventory worker re-init failed: ${String(err)}`));
    }
  }

  /** Stop the worker. Called on app shutdown to release the utility process. */
  async disposeWorker(): Promise<void> {
    await this.worker.stop();
  }

  reloadPriceCache(): void {
    this.market?.reloadFromDisk();
    this.refreshWorkerState();
    this.resolveAndPushInventory();
    this.pushPricesStatus();
  }

  onInventory(snap: InventorySnapshot): void {
    this.lastInventoryRaw = snap;
    this.resolveAndPushInventory();
    void this.ensureOwnedPrices();
    this.checkAlmostFull(snap);
  }

  /** Fires once per rising edge across the configured fill threshold. */
  setOnAlmostFull(
    callback: (payload: { used: number; capacity: number }) => void,
    getThresholdPercent: () => number,
  ): void {
    this.onAlmostFull = callback;
    this.getAlmostFullThresholdPercent = getThresholdPercent;
  }

  /** Subscribe to resolved inventory updates (fires after every broadcast). */
  setOnInventoryUpdated(callback: (snap: ResolvedInventory) => void): void {
    this.onInventoryUpdated = callback;
  }

  /** Expose the game-data catalog (catalog-id → GameItem) for box-open item resolution. */
  getGameDataLookup(): Map<number, GameItem> {
    return this.gameData.asMap();
  }

  /** Expose the GameDataProvider so CatalogRefreshService can reload + query version. */
  getGameData(): GameDataProvider {
    return this.gameData;
  }

  /**
   * Reload gamedata.json (after CatalogRefreshService wrote a fresh copy to
   * userData). Re-inits the inventory worker with the new catalog and re-resolves
   * the current inventory so item names/types update immediately.
   */
  reloadGameData(userDataDir?: string): void {
    this.gameData.reload(userDataDir);
    this.refreshWorkerState();
    this.resolveAndPushInventory();
  }

  private checkAlmostFull(snap: InventorySnapshot): void {
    if (!this.onAlmostFull || snap.inventoryCapacity <= 0) return;
    const thresholdRatio = Math.min(1, Math.max(0, this.getAlmostFullThresholdPercent() / 100));
    const isAbove = snap.inventoryUsed / snap.inventoryCapacity >= thresholdRatio;
    if (isAbove && !this.wasAboveAlmostFullThreshold) {
      this.onAlmostFull({ used: snap.inventoryUsed, capacity: snap.inventoryCapacity });
    }
    this.wasAboveAlmostFullThreshold = isAbove;
  }

  private excludeFromInventoryListing(itemKey: number): boolean {
    return this.gameData.isStageBox(itemKey);
  }

  private currentOwnedPriceTargets(): OwnedPriceTarget[] {
    if (!this.lastInventoryRaw) return [];
    return ownedPriceTargets(
      this.lastInventoryRaw,
      (key) => this.gameData.get(key),
      (key) => this.excludeFromInventoryListing(key),
    );
  }

  private targetKey(target: OwnedPriceTarget): string {
    return target.kind === "material" ? target.hash : (target.candidates[0] ?? "");
  }

  parseFromSave(text: string, mtime: number): InventorySnapshot {
    return parseInventory(text, mtime, (key) => this.gameData.get(key)?.type === "MATERIAL");
  }

  getInventory(): ResolvedInventory | null {
    return this.lastInventory;
  }

  pricesStatus(): PriceStatus {
    if (!this.market) {
      return this.emptyPriceStatus("USD");
    }
    return this.market.status(this.currentOwnedPriceTargets());
  }

  cancelPrices(): void {
    this.market?.cancel();
  }

  setCurrency(iso: string): PriceStatus {
    if (!this.market) {
      log.warn("setCurrency called before initMarket");
      return this.emptyPriceStatus(iso);
    }
    this.market.setCurrency(iso);
    this.resolveAndPushInventory();
    void this.ensureOwnedPrices(true);
    return this.pricesStatus();
  }

  private queuePriceRefresh(force: boolean): PriceRefreshResult & { status: PriceStatus } {
    this.priceRefreshQueued = true;
    if (force) this.priceRefreshForceQueued = true;
    log.info("Price refresh queued (already running)");
    return {
      ...this.queuePriceRefreshResult(),
      status: this.pricesStatus(),
    };
  }

  private queuePriceRefreshResult(): PriceRefreshResult {
    return {
      ok: true,
      priced: 0,
      skipped: 0,
      failed: 0,
      stopped: "completed",
      currency: this.market!.status().currency,
      queued: true,
    };
  }

  async refreshPrices(force?: boolean): Promise<PriceRefreshResult & { status: PriceStatus }> {
    if (!this.market) {
      log.warn("refreshPrices called before initMarket");
      return { ...this.emptyRefreshResult(), status: this.emptyPriceStatus("USD") };
    }
    const wantsForce = Boolean(force);
    if (this.market.status().running) {
      return this.queuePriceRefresh(wantsForce);
    }

    const targets = this.currentOwnedPriceTargets();
    this.market.pruneCacheTargets(targets);

    const result = await this.market.refresh(targets, this.priceRefreshCallbacks(wantsForce));
    this.resolveAndPushInventory();
    const status = this.pricesStatus();
    if (result.ok && !result.queued && !result.noop) {
      log.info(
        `Price refresh ${result.stopped}: priced=${result.priced} failed=${result.failed} skipped=${result.skipped}`,
      );
    } else if (!result.ok) {
      log.warn(`Price refresh failed: ${result.error ?? "unknown"}`);
    }
    return { ...result, status };
  }

  async refreshItemPrices(itemKey: number): Promise<PriceRefreshResult & { status: PriceStatus }> {
    if (!this.market) {
      log.warn("refreshItemPrices called before initMarket");
      return { ...this.emptyRefreshResult(), status: this.emptyPriceStatus("USD") };
    }
    const currency = this.market.status().currency;
    if (!Number.isFinite(itemKey) || itemKey <= 0) {
      return {
        ok: false,
        priced: 0,
        skipped: 0,
        failed: 0,
        stopped: "completed",
        currency,
        error: "invalid item key",
        status: this.pricesStatus(),
      };
    }

    const item = this.gameData.get(itemKey);
    if (!item) {
      return {
        ok: false,
        priced: 0,
        skipped: 0,
        failed: 0,
        stopped: "completed",
        currency,
        error: "unknown item",
        status: this.pricesStatus(),
      };
    }

    const target = ownedPriceTargetForItem(item);
    if (!target) {
      return {
        ok: false,
        priced: 0,
        skipped: 0,
        failed: 0,
        stopped: "completed",
        currency,
        error: "not priceable",
        status: this.pricesStatus(),
      };
    }

    return this.refreshPricesForTargets([target]);
  }

  private async refreshPricesForTargets(
    targets: OwnedPriceTarget[],
  ): Promise<PriceRefreshResult & { status: PriceStatus }> {
    if (this.market!.status().running) {
      for (const target of targets) {
        const key = this.targetKey(target);
        if (!this.priceRefreshPendingTargets.some((t) => this.targetKey(t) === key)) {
          this.priceRefreshPendingTargets.push(target);
        }
      }
      log.info(`Price refresh queued for ${targets.length} item(s) (already running)`);
      return {
        ...this.queuePriceRefreshResult(),
        status: this.pricesStatus(),
      };
    }

    const result = await this.market!.refresh(targets, this.priceRefreshCallbacks(true));
    this.resolveAndPushInventory();
    const status = this.pricesStatus();
    if (result.ok && !result.queued && !result.noop) {
      log.info(
        `Item price refresh ${result.stopped}: priced=${result.priced} failed=${result.failed} skipped=${result.skipped}`,
      );
    } else if (!result.ok) {
      log.warn(`Item price refresh failed: ${result.error ?? "unknown"}`);
    }
    return { ...result, status };
  }

  resolveAndPushInventory(): void {
    if (!this.lastInventoryRaw || !this.market) return;
    const snapshot = this.lastInventoryRaw;
    const priceLookupMap = this.buildOwnedPriceLookupMap();
    const excludeItemKeys = this.collectExcludedItemKeys();

    if (this.worker.isReady()) {
      // Async path: worker handles the heavy resolve. publishResolved runs
      // once the worker posts back. If the worker rejects (crash, timeout),
      // we fall back to the sync path so the broadcast still happens.
      void this.worker
        .resolve(snapshot, priceLookupMap, excludeItemKeys)
        .then((resolved) => this.publishResolved(resolved))
        .catch((err) => {
          log.warn(`worker resolve failed, falling back to sync: ${String(err)}`);
          this.resolveAndPublishSync(snapshot, priceLookupMap, excludeItemKeys);
        });
      return;
    }

    // Sync fallback path: identical to the pre-P1-6 implementation. Kept as
    // the startup path (worker still spawning) and the worker-crash path so
    // `getInventory()` callers always see a fresh value after this returns.
    this.resolveAndPublishSync(snapshot, priceLookupMap, excludeItemKeys);
  }

  /**
   * Build the `Map<hash, InventoryPriceInfo>` payload shipped to the worker.
   * Restricted to owned items' market hash names so we don't ship the entire
   * price cache across IPC — typical inventory has tens of distinct hashes,
   * the cache may have hundreds.
   */
  private buildOwnedPriceLookupMap(): Map<string, InventoryPriceInfo> {
    const map = new Map<string, InventoryPriceInfo>();
    if (!this.market) return map;
    const ownedHashes = flattenOwnedHashes(this.currentOwnedPriceTargets());
    for (const hash of ownedHashes) {
      const info = this.priceLookup(hash);
      if (info) map.set(hash, info);
    }
    return map;
  }

  /** Snapshot of stage-box itemKeys that the listing filter excludes from
   *  rows + composition. Pre-computed per resolve so the worker receives a
   *  flat array (callbacks don't survive IPC). */
  private collectExcludedItemKeys(): number[] {
    if (!this.gameData.isLoaded()) return [];
    const keys: number[] = [];
    for (const itemKey of this.gameData.asMap().keys()) {
      if (this.excludeFromInventoryListing(itemKey)) keys.push(itemKey);
    }
    return keys;
  }

  private resolveAndPublishSync(
    snapshot: InventorySnapshot,
    priceLookupMap: Map<string, InventoryPriceInfo>,
    excludeItemKeys: number[],
  ): void {
    try {
      const resolved = this.worker.resolveSync(snapshot, priceLookupMap, excludeItemKeys);
      this.publishResolved(resolved);
    } catch (err) {
      log.error(`resolveAndPushInventory (sync) failed: ${String(err)}`);
    }
  }

  private publishResolved(resolved: ResolvedInventory): void {
    if (!this.market) return;
    const currency = this.market.status().currency;
    resolved.currency = currency;
    resolved.composition.currency = currency;
    this.lastInventory = resolved;
    broadcast(IPC.INVENTORY, resolved);
    this.onInventoryUpdated?.(resolved);
  }

  async ensureOwnedPrices(force = false): Promise<void> {
    if (!this.lastInventoryRaw || !this.market) return;

    if (this.market.status().running) {
      this.priceRefreshQueued = true;
      if (force) this.priceRefreshForceQueued = true;
      return;
    }

    const targets = this.currentOwnedPriceTargets();

    const pending = this.market.pendingTargets(targets, force);
    if (!force && pending.length === 0) return;

    await this.market.refresh(targets, this.priceRefreshCallbacks(force));
    this.resolveAndPushInventory();
  }

  private drainPriceRefreshQueue(): void {
    if (this.priceRefreshPendingTargets.length > 0) {
      const targets = this.priceRefreshPendingTargets.splice(0);
      void this.refreshPricesForTargets(targets);
      return;
    }
    if (!this.priceRefreshQueued) return;
    const queuedForce = this.priceRefreshForceQueued;
    this.priceRefreshQueued = false;
    this.priceRefreshForceQueued = false;
    void this.ensureOwnedPrices(queuedForce);
  }

  getMarket(): SteamMarketProvider | null {
    return this.market;
  }

  /**
   * Empty `PriceStatus` used when `market` is not yet initialized (e.g. IPC
   * handlers fire before `initMarket`). Keeps the public surface total —
   * callers always get a well-typed response instead of a thrown error.
   */
  private emptyPriceStatus(currency: string): PriceStatus {
    return {
      currency,
      count: 0,
      ownedTargets: 0,
      freshCount: 0,
      staleCount: 0,
      fetchedUtc: null,
      running: false,
    };
  }

  /** Empty `PriceRefreshResult` mirroring `queuePriceRefreshResult` but unqueued. */
  private emptyRefreshResult(): PriceRefreshResult {
    return {
      ok: true,
      priced: 0,
      skipped: 0,
      failed: 0,
      stopped: "completed",
      currency: "USD",
      noop: true,
    };
  }

  private priceLookup(name: string): InventoryPriceInfo | undefined {
    const e = this.market?.get(name);
    if (!e) return undefined;
    return {
      median: e.median,
      lowest: e.lowest,
      rawMedian: e.rawMedian ?? null,
      rawLowest: e.rawLowest ?? (e as { raw?: string | null }).raw ?? null,
      buyOrder: e.buyOrder ?? null,
      rawBuyOrder: e.rawBuyOrder ?? null,
      buyOrderQuantity: e.buyOrderQuantity ?? null,
      buyOrderLevels: e.buyOrderLevels ?? null,
      buyOrderFetched: e.buyOrderFetched === true,
    };
  }

  private broadcastPriceProgress(p: PriceProgress): void {
    broadcast(IPC.PRICES_PROGRESS, p);
  }

  private pushPricesStatus(): void {
    if (!this.market) return;
    broadcast(IPC.PRICE_STATUS, this.pricesStatus());
  }

  private priceRefreshCallbacks(force = false): {
    force: boolean;
    onProgress: (p: PriceProgress) => void;
    onPriced: () => void;
    onFinished: (result: PriceRefreshResult) => void;
  } {
    return {
      force,
      onProgress: (p) => this.broadcastPriceProgress(p),
      onPriced: () => this.resolveAndPushInventory(),
      onFinished: (result) => {
        this.broadcastPriceProgress({
          done: 0,
          total: 0,
          current: "",
          priced: 0,
          failed: 0,
          finished: true,
          result: {
            priced: result.priced,
            skipped: result.skipped,
            failed: result.failed,
            stopped: result.stopped,
            noop: result.noop,
            queued: result.queued,
          },
        });
        this.drainPriceRefreshQueue();
      },
    };
  }
}
