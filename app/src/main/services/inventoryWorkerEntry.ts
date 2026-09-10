// Inventory-resolve utilityProcess entry point.
//
// Runs in a SEPARATE OS process so the 10万件-items `resolveInventory` work
// never blocks the Electron main thread (P1-6). The actual resolve logic lives
// in `inventoryWorkerProtocol.ts` (pure handlers); this file only wires
// `parentPort` ↔ handlers and forwards errors back to the host logger.
//
// Lifecycle mirrors `liveMemory/worker.ts`:
//   - parentPort receives JSON-serializable inbound messages
//   - host owns spawn / kill; on "stop" we exit(0) so the OS reclaims the
//     process (no lingering memory after InventoryService.dispose)

import {
  handleInit,
  handleResolve,
  type InventoryWorkerInbound,
  type InventoryWorkerOutbound,
  type InventoryWorkerState,
} from "./inventoryWorkerProtocol";

// `utilityProcess` exposes `process.parentPort` only inside the forked child.
// Outside that environment (e.g. when imported by vitest) the global has no
// parentPort — guard with optional chaining so the module is safe to import
// from tests.
const parentPort = (
  process as unknown as {
    parentPort?: {
      postMessage: (m: InventoryWorkerOutbound) => void;
      on: (e: "message", cb: (evt: unknown) => void) => void;
    };
  }
).parentPort;

let state: InventoryWorkerState | null = null;

function post(msg: InventoryWorkerOutbound): void {
  parentPort?.postMessage(msg);
}

parentPort?.on("message", (evt: unknown) => {
  // utilityProcess 的 parentPort 遵循 MessagePort API：监听器收到的是事件
  // 对象，真实载荷在 `data` 字段上。直接当载荷用会让 msg.type 永远 undefined
  // —— init/ready 握手曾因此静默失败（worker 路径从未启用，全部回退到主
  // 线程同步 resolve），"stop" 也同样失效（仅靠宿主 kill() 兜底）。
  const msg = (
    evt != null && typeof evt === "object" && "data" in evt ? (evt as { data: unknown }).data : evt
  ) as InventoryWorkerInbound;
  if (msg.type === "init") {
    state = handleInit(state, msg);
    post({ type: "ready" });
    return;
  }
  if (msg.type === "resolve") {
    try {
      const resolved = handleResolve(state, msg);
      post({ type: "resolve", id: msg.id, resolved });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      post({ type: "resolve", id: msg.id, error: message });
    }
    return;
  }
  if (msg.type === "stop") {
    // Synchronous exit — pending postMessage calls have already been flushed
    // by the time this is received (the host sends "stop" after awaiting
    // any in-flight resolve).
    process.exit(0);
  }
});

// Surface worker crashes to the host log instead of dying silently — the
// host's exit handler will fall back to the synchronous resolve path so the
// user never loses inventory updates while the worker restarts.
process.on("uncaughtException", (err) => {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  post({ type: "log", message: `uncaughtException: ${message}` });
});

process.on("unhandledRejection", (reason) => {
  const message =
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
  post({ type: "log", message: `unhandledRejection: ${message}` });
});
