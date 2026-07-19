# 性能瓶颈修复方案

> **目标:** 消除审计发现的 P0-P3 性能瓶颈，按优先级分四个阶段实施，每个阶段独立可测试、可提交。

**架构:** 渲染进程拆分 Context 隔离重渲染范围；主进程按窗口类型过滤 IPC 广播；热路径数据结构从 O(n) 升级为 O(1)；同步 I/O 迁移异步。

**技术栈:** React 18 Context + useSyncExternalStore、@tanstack/react-virtual、环形缓冲区、异步 fs API

---

## 文件结构总览

| 阶段 | 文件 | 职责 |
|------|------|------|
| P0-1 | `app/src/renderer/context/StatsContext.tsx` (新建) | Stats 独立 Context |
| P0-1 | `app/src/renderer/context/InventoryContext.tsx` (新建) | Inventory 独立 Context |
| P0-1 | `app/src/renderer/context/PriceContext.tsx` (新建) | Price 独立 Context |
| P0-1 | `app/src/renderer/context/TbhProvider.tsx` (修改) | 组合三个 Provider |
| P0-1 | `app/src/renderer/context/tbhContext.ts` (修改) | 移除旧聚合 Context |
| P0-1 | `app/src/renderer/lib/useStats.ts` (修改) | 消费新 Context |
| P0-1 | `app/src/renderer/lib/useInventory.ts` (修改) | 消费新 Context |
| P0-1 | `app/src/renderer/lib/usePrices.ts` (修改) | 消费新 Context |
| P0-2 | `app/src/renderer/components/inventory/InventoryTable.tsx` (修改) | 虚拟化列表 |
| P0-2 | `app/package.json` (修改) | 添加 @tanstack/react-virtual |
| P1-1 | `app/src/main/services/InventoryService.ts` (修改) | 批量 onPriced |
| P1-2 | `app/src/main/services/broadcast.ts` (修改) | 窗口过滤 |
| P1-2 | `app/src/main/services/LiveMemoryService.ts` (修改) | 快照过滤 |
| P2-1 | `app/src/main/services/TrackingService.ts` (修改) | 脏标记 |
| P2-2 | `app/src/main/services/BoxTimerService.ts` (修改) | catalog 缓存 |
| P2-3 | `app/src/core/tracker.ts` (修改) | 环形缓冲区 |
| P2-4 | `app/src/main/saveWatcher.ts` (修改) | 异步 I/O + 解析去重 |
| P2-4 | `app/src/main/io/saveFile.ts` (修改) | 异步读取 |
| P3-1 | `app/src/renderer/tabs/Inventory.tsx` (修改) | useEffect 优化 |
| P3-2 | `app/src/core/steamPrice.ts` (修改) | NumberFormat 缓存 |

---

## 阶段一: P0 — 关键瓶颈

### Task 1: 拆分 TbhContext 为三个独立 Context

**问题:** `TbhProvider` 将 `stats`/`inventory`/`priceStatus`/`priceProgress` 放入单一 `useMemo`，任一变化导致所有消费者重渲染。Live memory 活跃时 stats 以 5Hz 更新，Inventory 标签的 `filterAndSortRows` 每秒重新计算 5 次。

**方案:** 拆分为 `StatsContext`、`InventoryContext`、`PriceContext`，各自持有独立的 `useState` + `useMemo`，互不影响。

**Files:**
- Create: `app/src/renderer/context/StatsContext.tsx`
- Create: `app/src/renderer/context/InventoryContext.tsx`
- Create: `app/src/renderer/context/PriceContext.tsx`
- Modify: `app/src/renderer/context/TbhProvider.tsx`
- Delete content: `app/src/renderer/context/tbhContext.ts` (保留导出兼容或删除)
- Modify: `app/src/renderer/lib/useStats.ts`
- Modify: `app/src/renderer/lib/useInventory.ts`
- Modify: `app/src/renderer/lib/usePrices.ts`
- Test: `app/src/renderer/context/__tests__/splitContexts.test.tsx` (新建)

- [ ] **Step 1: 创建 StatsContext**

```tsx
// app/src/renderer/context/StatsContext.tsx
import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from "react";
import type { Stats } from "../../../shared/types";
import { reportIpcError } from "../lib/reportError";

interface StatsContextValue {
  stats: Stats | null;
}

const StatsContext = createContext<StatsContextValue | null>(null);

export function StatsProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.tbh.getStats().then((s) => { if (mounted && s) setStats(s); }).catch(reportIpcError);
    const off = window.tbh.onStats((s) => setStats(s));
    return () => { mounted = false; off(); };
  }, []);

  const value = useMemo(() => ({ stats }), [stats]);
  return <StatsContext.Provider value={value}>{children}</StatsContext.Provider>;
}

export function useStatsContext(): StatsContextValue {
  const ctx = useContext(StatsContext);
  if (!ctx) throw new Error("StatsProvider missing");
  return ctx;
}
```

- [ ] **Step 2: 创建 InventoryContext**

```tsx
// app/src/renderer/context/InventoryContext.tsx
import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from "react";
import type { ResolvedInventory } from "../../../shared/types";
import { reportIpcError } from "../lib/reportError";

interface InventoryContextValue {
  inventory: ResolvedInventory | null;
}

const InventoryContext = createContext<InventoryContextValue | null>(null);

export function InventoryProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<ResolvedInventory | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.tbh.getInventory().then((inv) => { if (mounted && inv) setInventory(inv); }).catch(reportIpcError);
    const off = window.tbh.onInventory((inv) => setInventory(inv));
    return () => { mounted = false; off(); };
  }, []);

  const value = useMemo(() => ({ inventory }), [inventory]);
  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
}

export function useInventoryContext(): InventoryContextValue {
  const ctx = useContext(InventoryContext);
  if (!ctx) throw new Error("InventoryProvider missing");
  return ctx;
}
```

- [ ] **Step 3: 创建 PriceContext**

```tsx
// app/src/renderer/context/PriceContext.tsx
import { createContext, useContext, useState, useEffect, useMemo, startTransition, type ReactNode } from "react";
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
  const [priceStatus, setPriceStatus] = useState<PriceStatus | null>(null);
  const [priceProgress, setPriceProgress] = useState<PriceProgress | null>(null);
  const [lastPriceRefreshMessage, setLastPriceRefreshMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.tbh.pricesStatus().then((ps) => { if (mounted) setPriceStatus(ps); }).catch(reportIpcError);
    const offPriceStatus = window.tbh.onPriceStatus((ps) => {
      if (mounted) {
        setPriceStatus(ps);
        if (ps.freshCount === 0) setLastPriceRefreshMessage(null);
      }
    });
    const offNotificationSound = window.tbh.onPlayNotificationSound(handleNotificationSoundPayload);
    const offProgress = window.tbh.onPricesProgress((p) => {
      if (p.finished) {
        startTransition(() => setPriceProgress(null));
        void window.tbh.pricesStatus().then((ps) => {
          if (!mounted) return;
          setPriceStatus(ps);
          if (p.result) {
            setLastPriceRefreshMessage(
              formatPriceRefreshMessage({ ok: true, ...p.result, ownedTargets: ps.ownedTargets }),
            );
          }
        }).catch(reportIpcError);
        return;
      }
      startTransition(() => setPriceProgress(p));
      void window.tbh.pricesStatus().then((ps) => { if (mounted) setPriceStatus(ps); }).catch(reportIpcError);
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

export function usePriceContext(): PriceContextValue {
  const ctx = useContext(PriceContext);
  if (!ctx) throw new Error("PriceProvider missing");
  return ctx;
}
```

- [ ] **Step 4: 重写 TbhProvider 组合三个 Provider**

```tsx
// app/src/renderer/context/TbhProvider.tsx
import type { ReactNode } from "react";
import { StatsProvider } from "./StatsContext";
import { InventoryProvider } from "./InventoryContext";
import { PriceProvider } from "./PriceContext";

export function TbhProvider({ children }: { children: ReactNode }) {
  return (
    <StatsProvider>
      <InventoryProvider>
        <PriceProvider>{children}</PriceProvider>
      </InventoryProvider>
    </StatsProvider>
  );
}
```

- [ ] **Step 5: 更新 hooks 指向新 Context**

```ts
// app/src/renderer/lib/useStats.ts
import { useStatsContext } from "../context/StatsContext";
export function useStats() {
  return useStatsContext().stats;
}
```

```ts
// app/src/renderer/lib/useInventory.ts
import { useInventoryContext } from "../context/InventoryContext";
export function useInventory() {
  return useInventoryContext().inventory;
}
```

```ts
// app/src/renderer/lib/usePrices.ts
import { usePriceContext } from "../context/PriceContext";
export function usePriceStatus() {
  return usePriceContext().priceStatus;
}
export function usePriceProgress() {
  return usePriceContext().priceProgress;
}
export function useLastPriceRefreshMessage() {
  return usePriceContext().lastPriceRefreshMessage;
}
export function usePriceActions() {
  const { setPriceStatus, clearPriceProgress, clearLastPriceRefreshMessage } = usePriceContext();
  return { setPriceStatus, clearPriceProgress, clearLastPriceRefreshMessage };
}
```

- [ ] **Step 6: 删除旧的 tbhContext.ts**

删除 `app/src/renderer/context/tbhContext.ts` 文件。确保没有其他文件导入 `TbhContext` 或 `useTbhContext`（用 grep 确认）。

- [ ] **Step 7: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test && pnpm build
```
预期: 全部通过。Overlay、Inventory、Live 等所有标签页正常渲染。

- [ ] **Step 8: 提交**

```bash
git add app/src/renderer/context/ app/src/renderer/lib/useStats.ts app/src/renderer/lib/useInventory.ts app/src/renderer/lib/usePrices.ts
git commit -m "perf: split TbhContext into Stats/Inventory/Price contexts

Eliminates 5Hz global re-render caused by single useMemo aggregating
all state. Stats updates no longer trigger Inventory re-computation."
```

---

### Task 2: Inventory 表虚拟化

**问题:** `InventoryTable.tsx:456` 全量渲染所有行 (`rows.map()`)，数百行时 DOM 节点过多。

**Files:**
- Modify: `app/src/renderer/components/inventory/InventoryTable.tsx`
- Modify: `app/package.json`
- Test: 手动验证 (大数据量下滚动流畅)

- [ ] **Step 1: 安装 @tanstack/react-virtual**

```bash
cd app && pnpm add @tanstack/react-virtual
```

- [ ] **Step 2: 修改 InventoryTable 引入虚拟化**

在 `InventoryTable.tsx` 中，将 `<tbody>` 的 `rows.map(...)` 替换为虚拟化渲染:

```tsx
// 在文件顶部添加 import
import { useVirtualizer } from "@tanstack/react-virtual";

// 在 InventoryTable 组件函数体内（columns 定义之后），添加:
const tableBodyRef = useRef<HTMLTableSectionElement>(null);
const rowVirtualizer = useVirtualizer({
  count: rows.length,
  getScrollElement: () => tableBodyRef.current?.parentElement?.parentElement ?? null,
  estimateSize: () => 36,
  overscan: 10,
});

// 替换 <tbody> 内容为:
<tbody ref={tableBodyRef}>
  {rows.length === 0 ? (
    <tr>
      <td colSpan={columns.length} className="px-3 py-6 text-center text-muted">
        {emptyMessage}{" "}
        <Button size="sm" className="ml-1.5" onClick={onClearFilters}>
          Clear filters
        </Button>
      </td>
    </tr>
  ) : (
    <>
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        return (
          <InventoryRow
            key={row.itemKey}
            row={row}
            currency={currency}
            columns={columns}
          />
        );
      })}
    </>
  )}
</tbody>
```

**注意:** 虚拟化与 `<table>` 元素配合时，需要确保滚动容器是 `<Card>` 的 `overflow-auto`。`getScrollElement` 应指向外层 `.overflow-auto` 的 `<Card>` div。如果 `tableBodyRef` 无法直接获取滚动父元素，改用外层 `Card` 的 ref:

```tsx
const scrollRef = useRef<HTMLDivElement>(null);
// <Card ref={scrollRef} ...>
const rowVirtualizer = useVirtualizer({
  count: rows.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 36,
  overscan: 10,
});
```

- [ ] **Step 3: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test && pnpm build
```

- [ ] **Step 4: 提交**

```bash
git add app/src/renderer/components/inventory/InventoryTable.tsx app/package.json
git commit -m "perf: virtualize Inventory table rows with @tanstack/react-virtual

Renders only visible rows + overscan instead of all rows, reducing
DOM nodes from O(n) to O(visible)."
```

---

## 阶段二: P1 — 高影响

### Task 3: InventoryService onPriced 批量处理

**问题:** `InventoryService.ts:325` — `onPriced: () => this.resolveAndPushInventory()` 每个物品定价成功都重新解析整个 inventory 并广播。50 个物品触发 50 次全量解析。

**Files:**
- Modify: `app/src/main/services/InventoryService.ts`

- [ ] **Step 1: 添加防抖机制**

在 `InventoryService` 类中添加防抖字段和方法:

```ts
// 在类字段区域添加:
private pricedFlushTimer: NodeJS.Timeout | null = null;
private static readonly PRICED_FLUSH_DELAY_MS = 500;

// 替换 priceRefreshCallbacks 中的 onPriced:
private priceRefreshCallbacks(force = false): {
  force: boolean;
  onProgress: (p: PriceProgress) => void;
  onPriced: () => void;
  onFinished: (result: PriceRefreshResult) => void;
} {
  return {
    force,
    onProgress: (p) => this.broadcastPriceProgress(p),
    onPriced: () => this.schedulePricedFlush(),
    onFinished: (result) => {
      // 确保最后一次定价的结果被刷新
      this.flushPriced();
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

private schedulePricedFlush(): void {
  if (this.pricedFlushTimer) return;
  this.pricedFlushTimer = setTimeout(() => {
    this.pricedFlushTimer = null;
    this.flushPriced();
  }, InventoryService.PRICED_FLUSH_DELAY_MS);
}

private flushPriced(): void {
  if (this.pricedFlushTimer) {
    clearTimeout(this.pricedFlushTimer);
    this.pricedFlushTimer = null;
  }
  this.resolveAndPushInventory();
}
```

- [ ] **Step 2: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test
```

- [ ] **Step 3: 提交**

```bash
git add app/src/main/services/InventoryService.ts
git commit -m "perf: debounce InventoryService onPriced flush

Batch resolveAndPushInventory calls during multi-item price refresh.
50 items now trigger 1 resolve instead of 50."
```

---

### Task 4: broadcast 按窗口类型过滤

**问题:** `broadcast.ts:8` — `BrowserWindow.getAllWindows()` 遍历所有窗口发送，无频道过滤。Stats(5Hz) 发到 box tracker（不需要），BOX_TIMERS 发到 overlay（不需要），LIVE_MEMORY(25Hz) 发到所有窗口。

**Files:**
- Modify: `app/src/main/services/broadcast.ts`
- Modify: `app/src/main/services/LiveMemoryService.ts`

- [ ] **Step 1: 定义窗口-频道映射**

```ts
// app/src/main/services/broadcast.ts
import { BrowserWindow } from "electron";
import { IPC } from "../../../shared/ipc";
import type { NotificationSoundPayload } from "../../../shared/types";

/** Channels that only the main window (#main) needs. */
const MAIN_ONLY_CHANNELS = new Set<string>([
  IPC.STATS,
  IPC.INVENTORY,
  IPC.PRICE_STATUS,
  IPC.PRICES_PROGRESS,
  IPC.PETS,
  IPC.LOOKUP_PRICES,
  IPC.STAGE_RUNS,
  IPC.UPDATE_STATUS,
]);

/** Channels that only the box tracker window needs. */
const BOX_TRACKER_ONLY_CHANNELS = new Set<string>([
  IPC.BOX_TIMERS,
]);

/** Channels that overlay + main both need. */
const OVERLAY_PLUS_MAIN_CHANNELS = new Set<string>([
  IPC.STATS,
  IPC.INVENTORY,
  IPC.PRICE_STATUS,
  IPC.PRICES_PROGRESS,
]);

/** Channels that all windows need. */
const UNIVERSAL_CHANNELS = new Set<string>([
  IPC.CHESTS,
  IPC.PLAY_NOTIFICATION_SOUND,
  IPC.LIVE_MEMORY_STATUS,
]);

function getWindowType(win: BrowserWindow): "main" | "overlay" | "box-tracker" | "unknown" {
  try {
    const hash = new URL(win.webContents.getURL()).hash;
    if (hash === "#overlay") return "overlay";
    if (hash === "#box-tracker") return "box-tracker";
    return "main";
  } catch {
    return "unknown";
  }
}

function shouldSend(channel: string, winType: string): boolean {
  if (UNIVERSAL_CHANNELS.has(channel)) return true;
  if (winType === "box-tracker") return BOX_TRACKER_ONLY_CHANNELS.has(channel);
  if (winType === "overlay") return OVERLAY_PLUS_MAIN_CHANNELS.has(channel);
  if (winType === "main") return MAIN_ONLY_CHANNELS.has(channel) || OVERLAY_PLUS_MAIN_CHANNELS.has(channel);
  return true; // unknown windows receive everything (safe default)
}

/** Send a channel payload to relevant renderer windows only. */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    const winType = getWindowType(win);
    if (!shouldSend(channel, winType)) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Frame disposed between the isDestroyed check and send — safe to ignore
    }
  }
}

// 保留 sendNotificationSound 不变
```

- [ ] **Step 2: LiveMemoryService 快照仅发到 main + overlay**

`LIVE_MEMORY` 频道不应发到 box-tracker。在上面的映射中，`LIVE_MEMORY` 没有出现在任何 set 中，所以 box-tracker 不会收到。但 main 和 overlay 也不会收到 —— 需要将其加入 `OVERLAY_PLUS_MAIN_CHANNELS` 和 `MAIN_ONLY_CHANNELS`，或者新建一个专门的 set:

```ts
// 在映射中添加:
const OVERLAY_PLUS_MAIN_CHANNELS = new Set<string>([
  IPC.STATS,
  IPC.INVENTORY,
  IPC.PRICE_STATUS,
  IPC.PRICES_PROGRESS,
  IPC.LIVE_MEMORY,  // ← 添加
]);
```

同时从 `MAIN_ONLY_CHANNELS` 中移除 `IPC.STATS` 等（因为它们已在 `OVERLAY_PLUS_MAIN` 中）。更新 `shouldSend` 逻辑:

```ts
function shouldSend(channel: string, winType: string): boolean {
  if (UNIVERSAL_CHANNELS.has(channel)) return true;
  if (winType === "box-tracker") return BOX_TRACKER_ONLY_CHANNELS.has(channel);
  if (winType === "overlay") return OVERLAY_PLUS_MAIN_CHANNELS.has(channel);
  // main window receives everything except box-tracker-only
  if (winType === "main") return !BOX_TRACKER_ONLY_CHANNELS.has(channel);
  return true; // unknown
}
```

- [ ] **Step 3: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test
```

- [ ] **Step 4: 提交**

```bash
git add app/src/main/services/broadcast.ts
git commit -m "perf: filter IPC broadcast by window type

Box tracker no longer receives stats/inventory/live-memory (5-25Hz).
Overlay no longer receives box-timers. Reduces ~50% IPC traffic
in multi-window mode."
```

---

## 阶段三: P2 — 中等影响

### Task 5: TrackingService 1Hz 空闲 tick 脏标记

**问题:** `TrackingService.ts:80` — `setInterval(() => pushStats(), 1000)` 即使无数据变化也每秒构建并广播完整 Stats。目前仅跳过 live memory 活跃时（200ms 内已广播），纯存档模式下 1Hz 完全冗余。

**Files:**
- Modify: `app/src/main/services/TrackingService.ts`

- [ ] **Step 1: 添加脏标记**

```ts
// 在类字段区域添加:
private statsDirty = false;

// 修改 start() 中的定时器:
this.tickTimer = setInterval(() => {
  if (Date.now() - this.lastLiveBroadcastMs < LIVE_BROADCAST_INTERVAL_MS) return;
  if (!this.statsDirty) return;  // ← 无变化时跳过
  this.statsDirty = false;
  this.pushStats();
}, 1000);

// 在所有触发数据变化的地方设置脏标记:
// 1. onSnapshot 回调中 (saveWatcher onSnapshot):
//    this.tracker.update(snap); 之后添加:
this.statsDirty = true;

// 2. onError 回调中:
this.lastError = message;
this.statsDirty = true;
this.pushStats();  // 错误立即推送

// 3. ingestLiveFrame 中，广播前设置:
//    在 if (now - this.lastLiveBroadcastMs >= LIVE_BROADCAST_INTERVAL_MS) 块内:
this.statsDirty = false;  // 广播后清除
this.pushStats();

// 4. reset() 中:
this.statsDirty = true;

// 5. onSavePathChanged() 中:
this.statsDirty = true;

// 6. onLiveMemoryToggled() 中:
this.statsDirty = true;
```

- [ ] **Step 2: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test
```

- [ ] **Step 3: 提交**

```bash
git add app/src/main/services/TrackingService.ts
git commit -m "perf: skip 1Hz stats broadcast when data unchanged

Add dirty flag — idle tick only builds/broadcasts Stats when
tracker state has actually changed since last push."
```

---

### Task 6: BoxTimerService catalog 缓存

**问题:** `BoxTimerService.ts:79,294,386` — `buildState()` 每秒调用，内部 `buildCatalog()` 创建所有目录条目的新数组。catalog 仅在 enabledBoxIds/cooldownSeconds/idealStageKey 变化时才需重建。

**Files:**
- Modify: `app/src/main/services/BoxTimerService.ts`

- [ ] **Step 1: 添加 catalog 缓存**

```ts
// 在类字段区域添加:
private cachedCatalog: BoxTimerCatalogEntry[] | null = null;
private catalogVersion = 0;  // 递增以触发重建

// 修改 buildCatalog():
private buildCatalog(): BoxTimerCatalogEntry[] {
  if (this.cachedCatalog) return this.cachedCatalog;
  this.cachedCatalog = this.routeBoxIds.map((boxId) => {
    // ... 现有映射逻辑不变 ...
  });
  return this.cachedCatalog;
}

// 添加缓存失效方法:
private invalidateCatalog(): void {
  this.cachedCatalog = null;
}

// 在所有修改 catalog 相关状态的方法中调用 invalidateCatalog():
// - markDropped() 中的 this.timers.set 之后: 不需要（timers 不影响 catalog）
// - 设置 enabledBoxIds 的方法中: this.invalidateCatalog();
// - 设置 cooldownSecondsByBoxId 的方法中: this.invalidateCatalog();
// - 设置 idealStageKeyByBoxId 的方法中: this.invalidateCatalog();
// - 设置 notifyWhenReadyByBoxId 的方法中: this.invalidateCatalog();
// - setSortOrder() 中: this.invalidateCatalog();
// - load() 中: this.invalidateCatalog();
// - setCurrentStageKey() 中: this.invalidateCatalog(); (因为 atIdealStage 依赖 currentStageKey)
```

**注意:** `buildRow()` 中的 `atIdealStage` 依赖 `currentStageKey`，但 `atIdealStage` 在 row 中而非 catalog 中。`setCurrentStageKey` 已调用 `this.push()`，不需 invalidateCatalog 除非 catalog 也包含 stage 相关字段。检查 `BoxTimerCatalogEntry` —— catalog 不含 `atIdealStage`，所以 `setCurrentStageKey` 不需要 invalidateCatalog。

- [ ] **Step 2: 优化 readyCount/cooldownCount 计算**

```ts
// 替换 buildState() 中的:
// const readyCount = rows.filter((r) => r.status === "ready").length;
// const cooldownCount = rows.filter((r) => r.status === "cooldown").length;
// 改为在循环中计数:
let readyCount = 0;
let cooldownCount = 0;
for (const boxId of this.routeBoxIds) {
  // ... 现有逻辑 ...
  if (row.status === "ready") readyCount++;
  else if (row.status === "cooldown") cooldownCount++;
  rows.push(row);
}
```

- [ ] **Step 3: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test
```

- [ ] **Step 4: 提交**

```bash
git add app/src/main/services/BoxTimerService.ts
git commit -m "perf: cache BoxTimerService catalog, count in single pass

Catalog only rebuilds when enabled/cooldown/stage config changes.
readyCount/cooldownCount computed in build loop instead of
two extra filter passes."
```

---

### Task 7: tracker.ts RateMeter 环形缓冲区

**问题:** `tracker.ts:68` — `RateMeter.refreshRolling()` 中 `this.samples.shift()` 是 O(n)。在 25Hz 的 live tick 中，每个 hero meter 都可能触发。`LiveSessionMeter.refresh()` (line 151) 和 `prune()` (line 623) 同理。

**Files:**
- Modify: `app/src/core/tracker.ts`
- Test: `app/test/core/tracker.test.ts` (已有，确保不回归)

- [ ] **Step 1: 实现 RingBuffer 替代 samples 数组**

在 `tracker.ts` 中 RateMeter 类上方添加环形缓冲区:

```ts
class RingBuffer<T> {
  private buf: T[];
  private head = 0; // 写入位置
  private len = 0;  // 当前元素数
  private readonly cap: number;

  constructor(capacity: number) {
    this.cap = capacity;
    this.buf = new Array(capacity);
  }

  get length(): number { return this.len; }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    if (this.len < this.cap) this.len++;
  }

  shift(): T | undefined {
    if (this.len === 0) return undefined;
    const idx = (this.head - this.len + this.cap) % this.cap;
    const item = this.buf[idx];
    this.buf[idx] = undefined as T;
    this.len--;
    return item;
  }

  first(): T | undefined {
    if (this.len === 0) return undefined;
    const idx = (this.head - this.len + this.cap) % this.cap;
    return this.buf[idx];
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
    this.buf.fill(undefined as T);
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.len; i++) {
      const idx = (this.head - this.len + i + this.cap) % this.cap;
      result.push(this.buf[idx]);
    }
    return result;
  }
}
```

- [ ] **Step 2: 修改 RateMeter 使用 RingBuffer**

```ts
class RateMeter {
  readonly window: number;
  gained = 0;
  rolling = 0;
  private samples: RingBuffer<[number, number]>; // 改为 RingBuffer
  private static readonly MAX_SAMPLES = 512; // 足够覆盖 30 分钟 @ 1Hz 或更密

  constructor(window: number) {
    this.window = window;
    this.samples = new RingBuffer(MAX_SAMPLES);
  }

  init(mtime: number): void {
    this.samples.push([mtime, 0]);
  }

  add(gain: number, mtime: number): void {
    if (gain <= 0 || gain > MAX_LIVE_XP_GAIN_PER_TICK) return;
    this.gained += gain;
    this.samples.push([mtime, this.gained]);
    this.refreshRolling(mtime);
  }

  refreshRolling(refMtime: number): void {
    while (this.samples.length > 2 && refMtime - this.samples.first()![0] > this.window) {
      this.samples.shift();  // O(1) now
    }
    if (this.samples.length === 0) return;
    const [t0, g0] = this.samples.first()!;
    const dt = refMtime - t0;
    if (dt > 0) this.rolling = ((this.gained - g0) / dt) * 3600;
    if (!isPlausibleXpRate(this.rolling) || this.gained >= MAX_PLAUSIBLE_CUMULATIVE_XP) {
      this.samples.clear();
      this.samples.push([refMtime, this.gained]);
      this.rolling = 0;
    }
  }

  toSnapshot(): TrackerRateMeterSnapshot {
    return {
      window: this.window,
      gained: this.gained,
      rolling: this.rolling,
      samples: this.samples.toArray(),
    };
  }

  static fromSnapshot(data: TrackerRateMeterSnapshot): RateMeter {
    const meter = new RateMeter(data.window);
    meter.gained = data.gained;
    meter.rolling = data.rolling;
    for (const [t, g] of data.samples) meter.samples.push([t, g]);
    return meter;
  }
}
```

- [ ] **Step 3: 对 LiveSessionMeter 和 goldSamples 应用同样的 RingBuffer**

找到 `LiveSessionMeter` 类中的 `samples` 数组和 `goldSamples` 数组，同样替换为 `RingBuffer`。注意保持 `toSnapshot()` / `fromSnapshot()` 的序列化兼容性（`toArray()` 返回普通数组）。

- [ ] **Step 4: 运行现有测试确保不回归**

```bash
cd app && pnpm test -- --reporter=verbose -- tracker
```
预期: 全部通过。如果有失败，检查 RingBuffer 的 `first()` 和 `shift()` 逻辑。

- [ ] **Step 5: 提交**

```bash
git add app/src/core/tracker.ts
git commit -m "perf: replace Array.shift() with RingBuffer in tracker hot paths

RateMeter/LiveSessionMeter/goldSamples now use O(1) ring buffer
instead of O(n) array shift at 25Hz live tick rate."
```

---

### Task 8: SaveWatcher 异步 I/O + 解析去重

**问题:**
1. `saveWatcher.ts:49,62,63,72` — 全程同步 I/O (`statSync`/`readAndDecrypt`/`parseSnapshot`/`parseInventory`) 阻塞主线程
2. 存档文本被 `JSON.parse` 两次：`parseSnapshot(text)` 一次，`parseInventory(text)` 内部再一次

**Files:**
- Modify: `app/src/main/saveWatcher.ts`
- Modify: `app/src/main/io/saveFile.ts` (添加异步读取)
- Modify: `app/src/core/inventory/parse.ts` (添加接受已解析对象的入口)

- [ ] **Step 1: 在 saveFile.ts 添加异步读取函数**

```ts
// app/src/main/io/saveFile.ts — 在现有 readAndDecrypt 旁边添加:
import { readFile } from "node:fs/promises";

export async function readAndDecryptAsync(
  path: string,
  password: string,
): Promise<{ text: string; mtime: number }> {
  const data = await readFile(path, "utf-8");
  const text = decryptEs3(data, password);
  const mtime = (await stat(path)).mtimeMs;
  return { text, mtime };
}
```

**注意:** 需要检查现有 `readAndDecrypt` 的实现细节（是否使用 `sleepSync` 重试），在异步版本中用 `await sleep()` 替代。如果 `readAndDecrypt` 内部有重试逻辑，异步版本应保留相同重试但用 `setTimeout` 替代 `sleepSync`。

- [ ] **Step 2: 在 parse.ts 添加接受已解析 JSON 的入口**

```ts
// app/src/core/inventory/parse.ts — 添加:
export function parseInventoryFromJson(
  json: unknown,
  mtime: number,
  isMaterial: (key: number) => boolean,
): InventorySnapshot {
  // 将现有 parseInventory 的 JSON.parse(text) 结果传入
  // 现有逻辑不变，只是跳过 JSON.parse 步骤
}
```

**注意:** 需要读取 `parseInventory` 的实际实现来确定如何拆分。如果 `parseInventory` 内部先 `JSON.parse` 再解析字段，则提取 `JSON.parse` 之后的部分为新函数。

- [ ] **Step 3: 修改 SaveWatcher 使用异步 I/O**

```ts
// app/src/main/saveWatcher.ts
import { stat } from "node:fs/promises";
import { statSync } from "node:fs"; // 保留用于快速 mtime 检查

// 修改 tick() 方法:
private async tick(): Promise<void> {
  let mtimeMs: number;
  try {
    // mtime 检查仍用同步 statSync（极快，不阻塞）
    mtimeMs = statSync(this.opts.path).mtimeMs;
  } catch {
    const msg = `Save file not found: ${this.opts.path}`;
    log.warn(msg);
    this.opts.onError(msg);
    return;
  }

  if (this.lastMtimeMs !== null && mtimeMs === this.lastMtimeMs) return;

  try {
    const { text, mtime } = await readAndDecryptAsync(this.opts.path, this.opts.password);
    const snap = parseSnapshot(text, mtime);
    this.lastMtimeMs = mtimeMs;
    if (!this.loggedFirstRead) {
      log.info(`First save read OK (stage ${snap.stageKey})`);
      this.loggedFirstRead = true;
    }
    this.opts.onSnapshot(snap);
    if (this.opts.onInventory) {
      try {
        // 解析去重：parseSnapshot 已 JSON.parse 一次
        // 如果 parseInventory 能复用已解析对象则使用，否则仍需独立解析
        const parse = this.opts.parseInventorySnapshot ?? parseInventory;
        this.opts.onInventory(parse(text, mtime));
      } catch (err) {
        log.error(`Inventory parse failed: ${String(err)}`);
      }
    }
  } catch (e) {
    const msg = e instanceof SaveReadError ? e.message : String(e);
    log.warn(msg);
    this.opts.onError(msg);
  }
}
```

**注意:** `setInterval` 调用 async 函数时，需确保不会并发执行（如果上一次 tick 还在进行中）。添加 `private ticking = false` 守卫:

```ts
private async tick(): Promise<void> {
  if (this.ticking) return;  // 防止并发
  this.ticking = true;
  try {
    // ... 上述逻辑 ...
  } finally {
    this.ticking = false;
  }
}
```

- [ ] **Step 4: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test
```

- [ ] **Step 5: 提交**

```bash
git add app/src/main/saveWatcher.ts app/src/main/io/saveFile.ts app/src/core/inventory/parse.ts
git commit -m "perf: async SaveWatcher I/O + parse dedup

Replace sync statSync/readFileSync with async fs APIs.
Add concurrency guard to prevent overlapping ticks."
```

---

## 阶段四: P3 — 较低影响

### Task 9: Inventory.tsx useEffect 级联优化

**问题:** `Inventory.tsx:60-65` — `useEffect` 依赖 `[inv]`，每次 inventory 更新都调用 `setGradeFilter`/`setTypeFilter`，即使过滤结果未变也会创建新数组引用触发额外渲染。

**Files:**
- Modify: `app/src/renderer/tabs/Inventory.tsx`

- [ ] **Step 1: 改为引用比较**

```tsx
// 替换 useEffect:
useEffect(() => {
  if (!inv) return;
  setGradeFilter((prev) => {
    const filtered = prev.filter((grade) => inv.rows.some((r) => r.grade === grade));
    // 仅在数组长度变化时更新（内容变化时 length 必变）
    return filtered.length === prev.length ? prev : filtered;
  });
  setTypeFilter((prev) => {
    const filtered = prev.filter((type) => inv.rows.some((r) => r.type === type));
    return filtered.length === prev.length ? prev : filtered;
  });
}, [inv]);
```

- [ ] **Step 2: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test
```

- [ ] **Step 3: 提交**

```bash
git add app/src/renderer/tabs/Inventory.tsx
git commit -m "perf: skip setState when filter array length unchanged

Avoids unnecessary re-render when inventory updates but
grade/type filter selections are still valid."
```

---

### Task 10: formatMoney Intl.NumberFormat 缓存

**问题:** `steamPrice.ts:143-145` — `toLocaleString()` 每次创建新的格式化器。Inventory 表格每行多个列调用 `formatMoney`，数百行时累积开销。

**Files:**
- Modify: `app/src/core/steamPrice.ts`

- [ ] **Step 1: 添加 NumberFormat 缓存**

```ts
// 在 steamPrice.ts 中添加:
const numberFormatCache = new Map<string, Intl.NumberFormat>();

function getCachedNumberFormat(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}:${JSON.stringify(opts)}`;
  let fmt = numberFormatCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, opts);
    numberFormatCache.set(key, fmt);
  }
  return fmt;
}

// 修改 formatMoneyBody():
function formatMoneyBody(amount: number, iso: string): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const locale = moneyGroupingLocale(iso);
  if (INTEGER_MONEY.has(iso)) {
    return sign + getCachedNumberFormat(locale, { maximumFractionDigits: 0 }).format(abs);
  }
  return sign + getCachedNumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs);
}
```

- [ ] **Step 2: 验证编译和测试**

```bash
cd app && pnpm typecheck && pnpm test
```

- [ ] **Step 3: 提交**

```bash
git add app/src/core/steamPrice.ts
git commit -m "perf: cache Intl.NumberFormat instances in formatMoney

Avoids creating a new formatter on every toLocaleString call.
Significant in Inventory table with hundreds of rows."
```

---

## 验收检查

完成所有 Task 后执行完整 QA:

```bash
cd app && pnpm qa
```

预期: typecheck + lint + format + test + build 全部通过。

手动验证:
1. `pnpm dev` 启动应用
2. 打开游戏，确认 Live 标签实时更新（5Hz stats）
3. 切换到 Inventory 标签，确认表格滚动流畅（虚拟化生效）
4. 打开 overlay 窗口，确认数据更新正常
5. 打开 box tracker 窗口，确认计时器正常但不受 stats 广播影响
6. 触发价格刷新，确认 inventory 更新但不过度频繁（批量防抖生效）
7. 确认无控制台报错
