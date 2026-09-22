// 祈愿记录的长期归档（P1-1）。
//
// 与 `RecordLogService.ts` 同构：启动时一次性 load、改动后防抖 ~2s 落盘。
// 关键差异：`wish_record.json` 承载「累计」口径的长期归档，**不随会话重置清空**
// —— `WishTracker.reset()` 只归零 *Session（会话基线重置），累计与历史保持不变；
// 因此本服务的归档内容天然与会话重置解耦，无需在重置时清空。
//
// 归档的是 `WishTracker.captureSnapshot()` 的累计 + 历史（history 已按
// HISTORY_LIMIT 截断），与 `session_state.json` 里那份「随会话滚动」的快照相互
// 独立：前者是长期账本，后者是崩溃恢复用的会话快照。
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WishTracker } from "../../core/wishTracker";
import type { WishTrackerSnapshot } from "../../../shared/types";
import { WISH_RECORD_FILE } from "./appData";
import { createLogger } from "../log";

const log = createLogger("wishRecord");

/** 归档默认防抖窗口（毫秒）——与 RecordLogService 对齐。 */
const DEFAULT_FLUSH_MS = 2000;

/**
 * `wish_record.json` 的读写器。
 *
 * 生命周期（由 `TrackingService` 驱动）：
 *   1. 构造时 `load()`：若归档存在，则把其累计 / 历史灌入 `WishTracker`；
 *   2. 每次识别到祈愿行后调用 `schedulePersist()`（防抖）；
 *   3. `TrackingService.stop()` / 退出前调用 `flush()` 强制落盘。
 *
 * `resetStorage()` 供设置页「清除 wish-record」使用：删除文件后重置内存。
 */
export class WishRecordService {
  private readonly flushMs: number;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  /** 「最多应用一次」护栏：避免构造期 load() 之外的重复调用覆盖实时数据。 */
  private loadApplied = false;

  constructor(
    private readonly tracker: WishTracker,
    flushMs = DEFAULT_FLUSH_MS,
  ) {
    this.flushMs = flushMs;
    this.load();
  }

  /**
   * 启动时读取 `wish_record.json` 并合并进 tracker。
   *
   * 注意：仅当 tracker 仍为空（全新构造、尚未喂入任何行）时才应用，避免把
   * 磁盘上的旧累计覆盖掉本进程已经累积的实时数据（例如 start() 重入）。
   * `WishTracker.applySnapshot` 本身是幂等覆盖语义，这里额外用 `loadApplied`
   * 做一次「最多应用一次」的护栏。
   */
  load(): void {
    if (this.loadApplied) return;
    this.loadApplied = true;
    const path = this.persistPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as WishTrackerSnapshot;
      this.tracker.applySnapshot(raw);
    } catch (err) {
      log.warn(`Could not read ${WISH_RECORD_FILE}: ${(err as Error).message}`);
    }
  }

  /** 改动后防抖落盘。可在每条祈愿行后安全调用。 */
  schedulePersist(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** 强制把待写入内容落盘（停止 / 退出前调用）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.persist();
  }

  /** 设置页删除 `wish_record.json` 后，丢弃内存里的归档标记。 */
  resetStorage(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
  }

  private persistPath(): string {
    try {
      return join(app.getPath("userData"), WISH_RECORD_FILE);
    } catch {
      return join(process.cwd(), WISH_RECORD_FILE);
    }
  }

  private persist(): void {
    try {
      const path = this.persistPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(this.tracker.captureSnapshot(), null, 2));
    } catch (err) {
      log.warn(`Wish record persist failed: ${(err as Error).message}`);
    }
  }
}
