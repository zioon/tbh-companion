import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildStageBoxCatalog } from "../../core/stageBoxes";
import {
  loadStageBoxCatalogFile,
  loadStageBoxTrackerRoutes,
  resolveTrackedDropBoxIdForStage,
  trackerRoutesById,
  type StageBoxTrackerRoute,
} from "../../core/stageBoxTracker";
import { stageName } from "../../core/stages";
import { emptyLocaleCatalog, type LocaleCatalog } from "../../core/localeCatalog";
import { compareBoxTimerRows, normalizeBoxTrackerSortOrder } from "../../core/boxTrackerSort";
import type {
  BoxTimerCatalogEntry,
  BoxTimerFarmStageOption,
  BoxTimerRow,
  BoxTimerState,
  BoxTrackerSortOrder,
} from "../../../shared/types";
import { IPC } from "../../../shared/ipc";
import { broadcast } from "./broadcast";
import { createLogger } from "../log";
import type { ChestEventPayload } from "./NotificationService";

const log = createLogger("boxTimers");

/**
 * P2-3: named constants for the magic numbers that used to live inline.
 * Documenting the source of each makes future catalog updates auditable.
 */
/** Min cooldown a user can set on a single box, in seconds (1 minute). */
const MIN_COOLDOWN_SECONDS = 60;
/** Max cooldown a user can set on a single box, in seconds (24 hours). */
const MAX_COOLDOWN_SECONDS = 86_400;
/**
 * Default enabled box IDs when no preference is loaded from `box_timers.json`.
 * These are the four stage-boss chest levels the wiki recommends tracking first
 * (one per act's boss); see `data/stage_boxes.json` for the canonical mapping.
 * If the catalog changes, update here — `defaultEnabledIds` filters out ids
 * that no longer exist in `routeById`, so a stale entry is a no-op, not a bug.
 */
const DEFAULT_ENABLED_BOX_IDS: readonly number[] = [920151, 920201, 920301, 920401];
/** Number of boxes to enable when none of `DEFAULT_ENABLED_BOX_IDS` resolve. */
const FALLBACK_ENABLED_COUNT = 4;

interface PersistedTimer {
  boxId: number;
  droppedAtMs: number;
}

interface PersistedFile {
  timers: PersistedTimer[];
  enabledBoxIds?: number[];
  cooldownSecondsByBoxId?: Record<string, number>;
  idealStageKeyByBoxId?: Record<string, number>;
  notifyWhenReadyByBoxId?: Record<string, boolean>;
  sortOrder?: BoxTrackerSortOrder;
}

export class BoxTimerService {
  private readonly catalogFile = loadStageBoxCatalogFile();
  private readonly routes = loadStageBoxTrackerRoutes();
  private readonly routeById = trackerRoutesById(this.routes);
  private readonly boxById = new Map(buildStageBoxCatalog().items.map((b) => [b.id, b]));
  private readonly routeBoxIds: number[];
  private timers = new Map<number, number>();
  private enabledBoxIds = new Set<number>();
  private cooldownSecondsByBoxId = new Map<number, number>();
  private idealStageKeyByBoxId = new Map<number, number>();
  private notifyWhenReadyByBoxId = new Map<number, boolean>();
  private sortOrder: BoxTrackerSortOrder = "cooldown-first";
  private wasOnCooldown = new Map<number, boolean>();
  private onChestReady: ((payload: ChestEventPayload) => void) | null = null;
  private onChestDropped: ((payload: ChestEventPayload) => void) | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private subscribers = 0;
  private currentStageKey = 0;
  /**
   * LocaleCatalog used for stage name localization in buildState /
   * resolveFarmStage. Set once at construction (defaults to
   * emptyLocaleCatalog) and swapped via {@link setLocaleCatalog} when the
   * user changes language. Kept as a field (not threaded through every call)
   * so buildState stays parameterless.
   */
  private localeCatalog: LocaleCatalog = emptyLocaleCatalog();
  /**
   * Set by `buildRow` when a timer expired during the current `buildState`
   * pass. `buildState` flushes it once at the end so N expirations in the same
   * 1Hz tick produce a single `writeFileSync` instead of N.
   */
  private persistDirty = false;
  /**
   * Cached `BoxTimerCatalogEntry[]`. The catalog content only depends on
   * `enabledBoxIds` / `cooldownSecondsByBoxId` / `idealStageKeyByBoxId` /
   * `notifyWhenReadyByBoxId`, all of which change only via explicit setters.
   * `buildState` is called at 1Hz by the tick timer, so without this cache the
   * catalog array (and its per-box `BoxTimerFarmStageOption[]` sub-arrays)
   * would be reallocated every second even while idle. Invalidated by every
   * setter that touches catalog inputs; `buildState` rebuilds lazily.
   */
  private catalogCache: BoxTimerCatalogEntry[] | null = null;

  constructor(initialCatalog: LocaleCatalog = emptyLocaleCatalog()) {
    this.localeCatalog = initialCatalog;
    this.routeBoxIds = [...this.routeById.keys()].sort(
      (a, b) => (this.boxById.get(a)?.level ?? 0) - (this.boxById.get(b)?.level ?? 0) || a - b,
    );
    this.load();
    this.seedWasOnCooldown();
  }

  setCurrentStageKey(key: number): void {
    if (this.currentStageKey === key) return;
    this.currentStageKey = key;
    this.push();
  }

  startTick(): void {
    this.subscribers++;
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.push(), 1000);
  }

  stopTick(): void {
    this.subscribers = Math.max(0, this.subscribers - 1);
    if (this.subscribers > 0 || !this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  getState(): BoxTimerState {
    return this.buildState();
  }

  markDropped(boxId: number): BoxTimerState {
    if (!this.isEnabledRoute(boxId)) return this.buildState();
    this.timers.set(boxId, Date.now());
    const box = this.boxById.get(boxId);
    this.onChestDropped?.({
      boxId,
      name: box?.name ?? `Box ${boxId}`,
      level: box?.level ?? null,
    });
    return this.commitState();
  }

  /** Start cooldown when live memory reports a stage boss chest at `stageKey`. */
  tryMarkDroppedFromLiveStage(stageKey: number): boolean {
    const boxId = resolveTrackedDropBoxIdForStage(
      stageKey,
      this.enabledBoxIds,
      this.routes,
      this.idealStageKeyByBoxId,
    );
    if (boxId == null) {
      // Surface why no reminder fired. autoClassify doesn't depend on
      // enabledBoxIds so its "queued drop" log will appear without a matching
      // boxTimers line whenever the drop's level isn't enabled in the Chests
      // tab — without this diagnostic that looks like a missing reminder.
      const matching = this.routes.filter((r) => r.dropStageKeys.includes(stageKey));
      if (matching.length === 0) {
        log.info(`stage boss drop at stage ${stageKey} matched no tracker route; skipping`);
      } else {
        const detail = matching
          .map((r) => `Lv${r.level}(id=${r.boxId},enabled=${this.enabledBoxIds.has(r.boxId)})`)
          .join(", ");
        log.info(
          `stage boss drop at stage ${stageKey} matched route(s) [${detail}] but none enabled; skipping`,
        );
      }
      return false;
    }
    if (this.isBoxOnCooldown(boxId)) {
      log.info(
        `stage boss drop at stage ${stageKey} -> Lv${this.boxById.get(boxId)?.level ?? "?"} (id=${boxId}) already on cooldown; skipping`,
      );
      return true;
    }

    log.info(
      `Stage boss drop detected from live memory (stage ${stageKey} -> Lv${this.boxById.get(boxId)?.level ?? "?"})`,
    );
    this.markDropped(boxId);
    return true;
  }

  clearTimer(boxId: number): BoxTimerState {
    this.timers.delete(boxId);
    this.wasOnCooldown.delete(boxId);
    return this.commitState();
  }

  setOnChestReady(callback: (payload: ChestEventPayload) => void): void {
    this.onChestReady = callback;
  }

  setOnChestDropped(callback: (payload: ChestEventPayload) => void): void {
    this.onChestDropped = callback;
  }

  setBoxTrackerNotify(boxId: number, enabled: boolean): BoxTimerState {
    if (!this.routeById.has(boxId)) return this.buildState();
    if (enabled) {
      this.notifyWhenReadyByBoxId.delete(boxId);
    } else {
      this.notifyWhenReadyByBoxId.set(boxId, false);
    }
    this.catalogCache = null;
    return this.commitState();
  }

  setSortOrder(sortOrder: BoxTrackerSortOrder): BoxTimerState {
    this.sortOrder = normalizeBoxTrackerSortOrder(sortOrder);
    return this.commitState();
  }

  /**
   * Swap the LocaleCatalog used for stage name localization. Called by
   * appState when the user changes language. Callers should re-emit
   * state via buildState() afterwards.
   */
  setLocaleCatalog(catalog: LocaleCatalog): void {
    this.localeCatalog = catalog;
  }

  setCooldownSeconds(boxId: number, cooldownSeconds: number): BoxTimerState {
    if (!this.routeById.has(boxId)) return this.buildState();
    const seconds = Math.max(
      MIN_COOLDOWN_SECONDS,
      Math.min(MAX_COOLDOWN_SECONDS, Math.round(cooldownSeconds)),
    );
    this.cooldownSecondsByBoxId.set(boxId, seconds);
    this.catalogCache = null;
    return this.commitState();
  }

  clearCooldownOverride(boxId: number): BoxTimerState {
    this.cooldownSecondsByBoxId.delete(boxId);
    this.catalogCache = null;
    return this.commitState();
  }

  setFarmStageKey(boxId: number, stageKey: number): BoxTimerState {
    const route = this.routeById.get(boxId);
    if (!route || !route.dropStageKeys.includes(stageKey)) return this.buildState();
    if (stageKey === route.idealStageKey) {
      this.idealStageKeyByBoxId.delete(boxId);
    } else {
      this.idealStageKeyByBoxId.set(boxId, stageKey);
    }
    this.catalogCache = null;
    return this.commitState();
  }

  clearFarmStageOverride(boxId: number): BoxTimerState {
    this.idealStageKeyByBoxId.delete(boxId);
    this.catalogCache = null;
    return this.commitState();
  }

  /** Replace the visible timer set (e.g. preset chips). */
  setEnabledBoxIds(boxIds: number[]): BoxTimerState {
    const valid = boxIds.filter((id) => this.routeById.has(id));
    this.enabledBoxIds = new Set(valid);
    for (const boxId of [...this.timers.keys()]) {
      if (!this.enabledBoxIds.has(boxId)) this.timers.delete(boxId);
    }
    this.catalogCache = null;
    return this.commitState();
  }

  /** Reset timers and enabled routes after box_timers.json was deleted. */
  resetStorage(): BoxTimerState {
    this.timers.clear();
    this.enabledBoxIds.clear();
    this.cooldownSecondsByBoxId.clear();
    this.idealStageKeyByBoxId.clear();
    this.notifyWhenReadyByBoxId.clear();
    this.sortOrder = "cooldown-first";
    this.wasOnCooldown.clear();
    for (const id of this.defaultEnabledIds()) this.enabledBoxIds.add(id);
    this.catalogCache = null;
    return this.commitState();
  }

  private isEnabledRoute(boxId: number): boolean {
    return this.routeById.has(boxId) && this.enabledBoxIds.has(boxId);
  }

  /** True when the box has a live (unexpired) cooldown timer. */
  private isBoxOnCooldown(boxId: number): boolean {
    const droppedAt = this.timers.get(boxId);
    if (droppedAt === undefined) return false;
    return Date.now() - droppedAt < this.resolveCooldownSeconds(boxId) * 1000;
  }

  private commitState(): BoxTimerState {
    this.persist();
    const state = this.buildState();
    broadcast(IPC.BOX_TIMERS, state);
    return state;
  }

  push(): void {
    broadcast(IPC.BOX_TIMERS, this.buildState());
  }

  private resolveCooldownSeconds(boxId: number): number {
    return this.cooldownSecondsByBoxId.get(boxId) ?? this.catalogFile.defaultCooldownSeconds ?? 720;
  }

  /**
   * Seed `wasOnCooldown` from persisted timers at load time. Boxes whose
   * cooldown has already expired get `false` here — this prevents
   * `buildState` from firing a spurious `onChestReady` on the first tick
   * (it only fires when `prev=true → active=false`, never on `false → false`).
   * Boxes still on cooldown get `true` so the genuine transition later is
   * detected correctly.
   *
   * BoxTimer's restore path is intentionally decoupled from
   * SessionStateService.tryRestoreOnSnapshot: BoxTimer state is durable across
   * sessions (cool-down config, enabled routes) and must not wait for the first
   * save snapshot to load. The mtime continuity check that SessionStateService
   * performs does not apply — `droppedAtMs` is wall-time and self-validating
   * via `isBoxOnCooldown`.
   */
  private seedWasOnCooldown(): void {
    const now = Date.now();
    for (const boxId of this.enabledBoxIds) {
      const droppedAt = this.timers.get(boxId);
      if (droppedAt === undefined) {
        this.wasOnCooldown.set(boxId, false);
        continue;
      }
      const cooldownSeconds = this.resolveCooldownSeconds(boxId);
      const elapsed = (now - droppedAt) / 1000;
      const remaining = Math.max(0, Math.ceil(cooldownSeconds - elapsed));
      this.wasOnCooldown.set(boxId, remaining > 0);
    }
  }

  private resolveNotifyWhenReady(boxId: number): boolean {
    if (!this.enabledBoxIds.has(boxId)) return false;
    const explicit = this.notifyWhenReadyByBoxId.get(boxId);
    return explicit ?? true;
  }

  private resolveFarmStage(boxId: number): {
    key: number;
    label: string;
    defaultKey: number;
    defaultLabel: string;
    isCustom: boolean;
    options: BoxTimerFarmStageOption[];
  } {
    const route = this.routeById.get(boxId);
    const defaultKey = route?.idealStageKey ?? 0;
    const defaultLabel = defaultKey > 0 ? stageName(defaultKey, this.localeCatalog) : "—";
    const override = this.idealStageKeyByBoxId.get(boxId);
    const key = override ?? defaultKey;
    const options = this.buildFarmStageOptions(route);
    return {
      key,
      label: key > 0 ? stageName(key, this.localeCatalog) : "—",
      defaultKey,
      defaultLabel,
      isCustom: override != null,
      options,
    };
  }

  private buildFarmStageOptions(
    route: StageBoxTrackerRoute | undefined,
  ): BoxTimerFarmStageOption[] {
    if (!route) return [];
    const wikiKey = route.idealStageKey;
    return route.dropStageKeys.map((stageKey) => ({
      stageKey,
      label:
        stageKey === wikiKey
          ? `${stageName(stageKey, this.localeCatalog)} (recommended)`
          : stageName(stageKey, this.localeCatalog),
    }));
  }

  private buildCatalog(): BoxTimerCatalogEntry[] {
    return this.routeBoxIds.map((boxId) => {
      const box = this.boxById.get(boxId);
      const route = this.routeById.get(boxId);
      const farm = this.resolveFarmStage(boxId);
      return {
        boxId,
        name: box?.name ?? `Box ${boxId}`,
        level: box?.level ?? null,
        idealStageKey: farm.key,
        idealStageLabel: farm.label,
        defaultIdealStageKey: farm.defaultKey,
        defaultIdealStageLabel: farm.defaultLabel,
        idealStageIsCustom: farm.isCustom,
        farmStageOptions: farm.options,
        dropStageRangeLabel: route?.dropStageRangeLabel ?? "—",
        cooldownSeconds: this.resolveCooldownSeconds(boxId),
        cooldownIsCustom: this.cooldownSecondsByBoxId.has(boxId),
        enabled: this.enabledBoxIds.has(boxId),
        notifyWhenReady: this.resolveNotifyWhenReady(boxId),
      };
    });
  }

  private buildRow(boxId: number, now: number): BoxTimerRow {
    const box = this.boxById.get(boxId);
    const cooldownSeconds = this.resolveCooldownSeconds(boxId);
    const droppedAt = this.timers.get(boxId);
    let remainingSeconds = 0;
    let active = false;
    let progress = 0;

    if (droppedAt !== undefined) {
      const elapsed = (now - droppedAt) / 1000;
      remainingSeconds = Math.max(0, Math.ceil(cooldownSeconds - elapsed));
      active = remainingSeconds > 0;
      progress = Math.min(1, elapsed / cooldownSeconds);
      if (!active) {
        // Defer persist to buildState — multiple timers can expire in the same
        // 1Hz tick and each one used to trigger a separate writeFileSync.
        this.timers.delete(boxId);
        this.persistDirty = true;
      }
    }

    const farm = this.resolveFarmStage(boxId);
    const atIdealStage = farm.key > 0 && this.currentStageKey === farm.key;

    return {
      boxId,
      name: box?.name ?? `Box ${boxId}`,
      level: box?.level ?? null,
      idealStageKey: farm.key,
      idealStageLabel: farm.label,
      cooldownSeconds,
      cooldownIsCustom: this.cooldownSecondsByBoxId.has(boxId),
      active,
      remainingSeconds,
      progress,
      status: active ? "cooldown" : "ready",
      atIdealStage,
    };
  }

  private buildState(): BoxTimerState {
    const now = Date.now();
    const rows: BoxTimerRow[] = [];
    const readyNotifications: ChestEventPayload[] = [];

    for (const boxId of this.routeBoxIds) {
      if (!this.enabledBoxIds.has(boxId)) {
        this.wasOnCooldown.delete(boxId);
        continue;
      }
      const prevOnCooldown = this.wasOnCooldown.get(boxId) ?? false;
      const row = this.buildRow(boxId, now);
      if (prevOnCooldown && !row.active && this.resolveNotifyWhenReady(boxId)) {
        readyNotifications.push({ boxId, name: row.name, level: row.level });
      }
      this.wasOnCooldown.set(boxId, row.active);
      rows.push(row);
    }

    for (const payload of readyNotifications) {
      this.onChestReady?.(payload);
    }

    rows.sort((a, b) => compareBoxTimerRows(a, b, this.sortOrder));

    const readyCount = rows.filter((r) => r.status === "ready").length;
    const cooldownCount = rows.filter((r) => r.status === "cooldown").length;

    // Flush any timer expirations accumulated during this pass in a single
    // write instead of one per expired timer.
    if (this.persistDirty) {
      this.persistDirty = false;
      this.persist();
    }

    return {
      rows,
      catalog: this.getCatalog(),
      enabledCount: this.enabledBoxIds.size,
      readyCount,
      cooldownCount,
      sortOrder: this.sortOrder,
      currentStageKey: this.currentStageKey,
      currentStageLabel: stageName(this.currentStageKey, this.localeCatalog),
      defaultCooldownSeconds: this.catalogFile.defaultCooldownSeconds ?? 720,
    };
  }

  /**
   * Return the cached catalog, rebuilding it lazily if any catalog-affecting
   * setter cleared the cache. The catalog content does not depend on time, so
   * the same array reference can be reused across 1Hz `buildState` calls.
   */
  private getCatalog(): BoxTimerCatalogEntry[] {
    if (this.catalogCache === null) {
      this.catalogCache = this.buildCatalog();
    }
    return this.catalogCache;
  }

  private defaultEnabledIds(): number[] {
    const preferred = [...DEFAULT_ENABLED_BOX_IDS];
    const picked = preferred.filter((id) => this.routeById.has(id));
    return picked.length > 0 ? picked : this.routeBoxIds.slice(0, FALLBACK_ENABLED_COUNT);
  }

  private persistPath(): string {
    try {
      return join(app.getPath("userData"), "box_timers.json");
    } catch {
      return join(process.cwd(), "box_timers.json");
    }
  }

  /**
   * Restore BoxTimer state from `userData/box_timers.json`. Unlike
   * SessionStateService.tryRestoreOnSnapshot, this runs at construction time
   * (app startup) without waiting for the first save snapshot, because
   * cool-down config is durable across sessions. Stale or malformed entries
   * are silently filtered (no `droppedAtMs`, unknown boxId, out-of-range
   * cooldown) rather than discarding the whole file — partial recovery is
   * preferred over no recovery.
   */
  private load(): void {
    const path = this.persistPath();
    if (!existsSync(path)) {
      for (const id of this.defaultEnabledIds()) this.enabledBoxIds.add(id);
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as PersistedFile;
      for (const t of raw.timers ?? []) {
        if (t.boxId && t.droppedAtMs) this.timers.set(t.boxId, t.droppedAtMs);
      }
      for (const [boxId, seconds] of Object.entries(raw.cooldownSecondsByBoxId ?? {})) {
        const id = Number(boxId);
        const secs = Number(seconds);
        // `seconds` is `any` from JSON.parse — guard against string / null /
        // non-finite values that would otherwise land in Map<number, number>.
        if (id > 0 && Number.isFinite(secs) && secs > 0 && this.routeById.has(id)) {
          this.cooldownSecondsByBoxId.set(id, secs);
        }
      }
      for (const [boxId, stageKey] of Object.entries(raw.idealStageKeyByBoxId ?? {})) {
        const id = Number(boxId);
        const key = Number(stageKey);
        const route = this.routeById.get(id);
        if (id > 0 && key > 0 && route?.dropStageKeys.includes(key)) {
          if (key === route.idealStageKey) continue;
          this.idealStageKeyByBoxId.set(id, key);
        }
      }
      for (const [boxId, notify] of Object.entries(raw.notifyWhenReadyByBoxId ?? {})) {
        const id = Number(boxId);
        if (id > 0 && this.routeById.has(id)) {
          this.notifyWhenReadyByBoxId.set(id, Boolean(notify));
        }
      }
      this.sortOrder = normalizeBoxTrackerSortOrder(raw.sortOrder);
      const enabled = raw.enabledBoxIds?.filter((id) => this.routeById.has(id)) ?? [];
      if (enabled.length > 0) {
        for (const id of enabled) this.enabledBoxIds.add(id);
      } else {
        for (const id of this.defaultEnabledIds()) this.enabledBoxIds.add(id);
      }
    } catch {
      for (const id of this.defaultEnabledIds()) this.enabledBoxIds.add(id);
    }
    this.seedWasOnCooldown();
  }

  private persist(): void {
    const path = this.persistPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const timers: PersistedTimer[] = [...this.timers.entries()].map(([boxId, droppedAtMs]) => ({
        boxId,
        droppedAtMs,
      }));
      const cooldownSecondsByBoxId = Object.fromEntries(this.cooldownSecondsByBoxId);
      const idealStageKeyByBoxId = Object.fromEntries(this.idealStageKeyByBoxId);
      const notifyWhenReadyByBoxId = Object.fromEntries(
        [...this.notifyWhenReadyByBoxId.entries()].filter(([, enabled]) => !enabled),
      );
      writeFileSync(
        path,
        JSON.stringify(
          {
            timers,
            enabledBoxIds: [...this.enabledBoxIds],
            cooldownSecondsByBoxId,
            idealStageKeyByBoxId,
            notifyWhenReadyByBoxId,
            sortOrder: this.sortOrder,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      // Persist failures (read-only userData, full disk, path invalid) must
      // not break commitState's in-memory state update + broadcast downstream.
      // The next tick will retry; load() already has its own try/catch.
      log.warn(`BoxTimer persist failed: ${(err as Error).message}`);
    }
  }
}
