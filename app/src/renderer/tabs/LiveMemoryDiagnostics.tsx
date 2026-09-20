import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AcquireRingView } from "../../../shared/types";
import { useLiveMemory } from "../lib/useLiveMemory";
import { useStats } from "../lib/useStats";
import { liveReaderState } from "../../core/liveMemory/status";
import { fmtCompact } from "../lib/format";
import { TabPage } from "../design-system/primitives/TabPage/TabPage";
import { TabHeader } from "../design-system/primitives/TabHeader/TabHeader";

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-1 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function StatHealth({
  label,
  value,
  live,
  fallback,
}: {
  label: string;
  value: unknown;
  live: string;
  fallback: string;
}) {
  const ok = value !== null && value !== undefined;
  return (
    <div className="flex justify-between gap-4 border-b border-border py-1 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className={ok ? "text-accent tabular-nums" : "text-gold tabular-nums"}>
        {ok ? live : fallback}
      </span>
    </div>
  );
}

/**
 * Raw "获得记录" ring viewer. Shows EVERY slot of the game's record ring in
 * absolute array order — slot index, in-game `[HH:MM]` stamp and full text —
 * together with the reader's mapping diagnostics.
 *
 * Deliberately untranslated: this is a developer tool that never ships in the
 * production tab bar (see AppTabBar), and adding keys to only one locale would
 * break the locale-parity test.
 *
 * Why absolute slots matter: the reader walks the ring through a counter-derived
 * map, and the counter is known to over-lead the slot writes. When that map is
 * shifted by a constant, every index resolves to a row a fixed number of
 * appends away from the one it claims, and the reader reports "the newest entry
 * is hours old" while the ring actually holds current rows. Only the array
 * itself can settle it — hence the `derivedBase` row (`(counter - fill) mod
 * capacity`, exact even when the ring is saturated) next to the `sessionBase`
 * the reader is actually using.
 */
function AcquireRingViewer() {
  const [snap, setSnap] = useState<AcquireRingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState<"near" | "all">("near");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await window.tbh.getAcquireRing();
      if (v == null) setErr("读取失败（游戏未运行 / 偏移缺失 / worker 无响应）");
      setSnap(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const headMin = snap?.head?.stampMin ?? null;
  const rows = useMemo(() => {
    if (!snap) return [];
    return snap.slots.filter((s) => {
      if (query && !(s.message ?? "").toLowerCase().includes(query.toLowerCase())) return false;
      if (scope === "all" || headMin == null || s.time == null) return true;
      const [h, m] = s.time.split(":").map(Number);
      const d = Math.abs(h * 60 + m - headMin) % 1440;
      return (d > 720 ? 1440 - d : d) <= 60;
    });
  }, [snap, scope, query, headMin]);

  return (
    <section className="mt-6 w-full">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <p className="m-0 text-[11px] font-medium uppercase tracking-wide text-muted">
          原始游戏日志（整圈全量）
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="rounded border border-border px-2 py-0.5 text-[12px] hover:bg-muted/10 disabled:opacity-50"
        >
          {busy ? "读取中…" : "刷新"}
        </button>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "near" | "all")}
          className="rounded border border-border bg-transparent px-2 py-0.5 text-[12px]"
        >
          <option value="near">仅写入头附近（±1 小时）</option>
          <option value="all">全部槽位</option>
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选内容…"
          className="rounded border border-border bg-transparent px-2 py-0.5 text-[12px]"
        />
        {snap ? (
          <span className="text-[12px] text-muted">
            显示 {rows.length} / 已提交 {snap.slots.length} 槽
          </span>
        ) : null}
      </div>

      {err ? <p className="m-0 text-[13px] text-gold">{err}</p> : null}

      {snap ? (
        <>
          <div className="mb-3 grid max-w-3xl grid-cols-1 gap-x-6 sm:grid-cols-2">
            <Row label="计数器（+0x1C）" value={snap.counter} />
            <Row label="列表长度 fill（+0x18）" value={snap.fill ?? "—"} />
            <Row label="数组声明长度" value={snap.arrayLen ?? "—"} />
            <Row label="容量常量" value={snap.capacity} />
            <Row label="最新条目下标（列表末尾）" value={snap.pinSlot ?? "—"} />
            <Row label="已投递身份数" value={snap.deliveredCount} />
            <Row
              label="写入头（最新内容所在槽）"
              value={
                snap.head
                  ? `槽 ${snap.head.slot} @ ${snap.head.stamp}（滞后 ${snap.head.lagMin} 分）`
                  : "—"
              }
            />
            <Row
              label="墙钟（比较基准）"
              value={`${String(Math.floor(snap.wallMin / 60)).padStart(2, "0")}:${String(snap.wallMin % 60).padStart(2, "0")}`}
            />
          </div>

          <div className="max-h-[60vh] overflow-auto rounded border border-border">
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-background">
                <tr className="text-left text-muted">
                  <th className="w-16 border-b border-border px-2 py-1 font-medium">槽位</th>
                  <th className="w-16 border-b border-border px-2 py-1 font-medium">时间</th>
                  <th className="border-b border-border px-2 py-1 font-medium">内容</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.slot} className="align-top">
                    <td className="border-b border-border px-2 py-0.5 tabular-nums">{s.slot}</td>
                    <td className="border-b border-border px-2 py-0.5 tabular-nums">
                      {s.time ?? "—"}
                    </td>
                    <td className="border-b border-border px-2 py-0.5">
                      {s.message ?? "（空/未写入）"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * Dev-only diagnostics for the live-memory reader: attach state, detected
 * version, cadence source, last read cost, snapshot age, and per-stat health.
 * Gated to dev builds in AppTabBar — not shipped in the production tab bar.
 */ export function LiveMemoryDiagnostics() {
  const { t } = useTranslation("liveMemory");
  const { snapshot, status } = useLiveMemory();
  const stats = useStats();
  const state = liveReaderState(status, Boolean(status?.running));
  const lastReadAt = snapshot
    ? new Date(snapshot.at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "—";
  const dash = "—";

  return (
    <TabPage>
      <TabHeader title={t("diagnostics.tabTitle")} intro={t("diagnostics.intro")} />
      <div className="max-w-md space-y-4">
        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            {t("diagnostics.sectionReader")}
          </p>
          <Row label={t("diagnostics.readerState")} value={state} />
          <Row label={t("diagnostics.running")} value={String(status?.running ?? false)} />
          <Row label={t("diagnostics.attached")} value={String(status?.attached ?? false)} />
          <Row label={t("diagnostics.pid")} value={status?.pid ?? dash} />
          <Row label={t("diagnostics.gameVersion")} value={status?.gameVersion ?? dash} />
          <Row label={t("diagnostics.supported")} value={String(status?.supported ?? false)} />
          {status?.note ? <Row label={t("diagnostics.note")} value={status.note} /> : null}
          <Row label={t("diagnostics.source")} value={snapshot?.source ?? dash} />
          <Row label={t("diagnostics.lastReadMs")} value={snapshot?.readMs ?? dash} />
          <Row label={t("diagnostics.lastReadAt")} value={lastReadAt} />
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            {t("diagnostics.sectionLiveValues")}
          </p>
          <StatHealth
            label={t("diagnostics.gold")}
            value={snapshot?.gold}
            live={t("diagnostics.live")}
            fallback={t("diagnostics.fallback")}
          />
          <Row
            label={t("diagnostics.currentGold")}
            value={snapshot?.gold != null ? fmtCompact(snapshot.gold) : dash}
          />
          {stats ? (
            <>
              <Row
                label={t("diagnostics.trackerXpHr")}
                value={`${fmtCompact(stats.rollingRate)}/hr`}
              />
              <Row
                label={t("diagnostics.trackerGoldHr")}
                value={`${fmtCompact(stats.goldRate)}/hr`}
              />
              <Row label={t("diagnostics.sessionXp")} value={fmtCompact(stats.cumulativeGained)} />
              <Row
                label={t("diagnostics.sessionXpHr")}
                value={`${fmtCompact(stats.sessionRate)}/hr`}
              />
            </>
          ) : null}
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            {t("diagnostics.sectionHeroes")}
          </p>
          <StatHealth
            label={t("diagnostics.heroesLabel")}
            value={snapshot?.heroes?.length ? snapshot.heroes.length : null}
            live={t("diagnostics.live")}
            fallback={t("diagnostics.fallback")}
          />
          {snapshot?.heroes == null && snapshot?.heroesStatus ? (
            <Row label={t("diagnostics.heroesReason")} value={snapshot.heroesStatus} />
          ) : null}
          {snapshot?.heroes && snapshot.heroes.length > 0 ? (
            <div className="mt-1 space-y-0">
              {snapshot.heroes.map((h) => (
                <Row
                  key={h.heroKey}
                  label={t("diagnostics.heroWithLevel", {
                    name: h.name ?? String(h.heroKey),
                    level: h.level,
                  })}
                  value={fmtCompact(h.exp)}
                />
              ))}
            </div>
          ) : (
            <Row label={t("diagnostics.party")} value={dash} />
          )}
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            {t("diagnostics.sectionPerStatHealth")}
          </p>
          <Row label={t("diagnostics.stageKey")} value={snapshot?.stageKey ?? dash} />
          <Row label={t("diagnostics.stageWave")} value={snapshot?.stageWave ?? dash} />
          <StatHealth
            label={t("diagnostics.chestLog")}
            value={snapshot?.chestDrops}
            live={t("diagnostics.live")}
            fallback={t("diagnostics.fallback")}
          />
          {snapshot?.chestDrops == null && snapshot?.chestDropsStatus ? (
            <Row label={t("diagnostics.heroesReason")} value={snapshot.chestDropsStatus} />
          ) : null}
          <Row
            label={t("diagnostics.newChestDropsTick")}
            value={snapshot?.chestDrops != null ? String(snapshot.chestDrops.length) : dash}
          />
          <StatHealth
            label={t("diagnostics.inventoryLabel")}
            value={snapshot?.inventoryItems?.length ? snapshot.inventoryItems.length : null}
            live={t("diagnostics.live")}
            fallback={t("diagnostics.fallback")}
          />
          {snapshot?.inventoryItems == null && snapshot?.inventoryItemsStatus ? (
            <Row label={t("diagnostics.heroesReason")} value={snapshot.inventoryItemsStatus} />
          ) : null}
          <Row
            label={t("diagnostics.inventoryItems")}
            value={snapshot?.inventoryItems != null ? String(snapshot.inventoryItems.length) : dash}
          />
          <StatHealth
            label={t("diagnostics.petsLabel")}
            value={snapshot?.petData?.length ? snapshot.petData.length : null}
            live={t("diagnostics.live")}
            fallback={t("diagnostics.fallback")}
          />
          {snapshot?.petData == null && snapshot?.petDataStatus ? (
            <Row label={t("diagnostics.heroesReason")} value={snapshot.petDataStatus} />
          ) : null}
          <Row
            label={t("diagnostics.petsCount")}
            value={snapshot?.petData != null ? String(snapshot.petData.length) : dash}
          />
        </section>

        {stats ? (
          <section>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              {t("diagnostics.sectionChestDrops")}
            </p>
            <Row label={t("diagnostics.common")} value={String(stats.chestDrops.commonTotal)} />
            <Row label={t("diagnostics.stageBoss")} value={String(stats.chestDrops.rareTotal)} />
            <Row label={t("diagnostics.combined")} value={String(stats.chestDrops.combinedTotal)} />
          </section>
        ) : null}

        {stats ? (
          <section>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              {t("diagnostics.sectionDps")}
            </p>
            <StatHealth
              label={t("diagnostics.monsterHp")}
              value={
                snapshot?.monsterHp != null
                  ? snapshot.monsterHp.length > 0
                    ? snapshot.monsterHp.length
                    : 0
                  : null
              }
              live={t("diagnostics.live")}
              fallback={t("diagnostics.fallback")}
            />
            <Row
              label={t("diagnostics.aliveMonsters")}
              value={snapshot?.monsterHp != null ? String(snapshot.monsterHp.length) : dash}
            />
            <Row label={t("diagnostics.mobsKilledMap")} value={String(stats.mapMobsKilled)} />
            <Row label={t("diagnostics.damageMap")} value={fmtCompact(stats.mapDamage)} />
            <Row
              label={t("diagnostics.mobsKilledSession")}
              value={String(stats.sessionMobsKilled)}
            />
            <Row label={t("diagnostics.damageSession")} value={fmtCompact(stats.sessionDamage)} />
            <Row label={t("diagnostics.dps5s")} value={String(stats.dps.toFixed(1))} />
          </section>
        ) : null}

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            {t("diagnostics.sectionOffsetExtractor")}
          </p>
          <Row label={t("diagnostics.offsetSource")} value={status?.offsetHealth?.source ?? dash} />
          {status?.offsetHealth?.fallbackFromVersion ? (
            <Row
              label={t("diagnostics.fallbackFromVersion")}
              value={`v${status.offsetHealth.fallbackFromVersion}`}
            />
          ) : null}
          <Row
            label={t("diagnostics.extractAttempts")}
            value={
              status?.offsetHealth?.extractionAttempts != null
                ? String(status.offsetHealth.extractionAttempts)
                : dash
            }
          />
          <Row
            label={t("diagnostics.statusLabel")}
            value={
              status?.supported
                ? t("diagnostics.active")
                : (status?.note ?? t("diagnostics.unavailable"))
            }
          />
          <Row
            label={t("diagnostics.offsetsComplete")}
            value={
              status?.offsetHealth
                ? status.offsetHealth.complete
                  ? t("diagnostics.allMapped")
                  : t("diagnostics.missingCount", { count: status.offsetHealth.missing.length })
                : dash
            }
          />
          {status?.offsetHealth && !status.offsetHealth.complete ? (
            <Row
              label={t("diagnostics.awaitingDerivation")}
              value={status.offsetHealth.missing.join(", ")}
            />
          ) : null}
        </section>
      </div>

      <AcquireRingViewer />
    </TabPage>
  );
}
