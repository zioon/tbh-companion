import type { ReactNode } from "react";
import { useLiveMemory } from "../lib/useLiveMemory";
import { useStats } from "../lib/useStats";
import { liveReaderState } from "../../core/liveMemory/status";
import { heroName } from "../../core/heroes";
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

function StatHealth({ label, value }: { label: string; value: unknown }) {
  const ok = value !== null && value !== undefined;
  return (
    <div className="flex justify-between gap-4 border-b border-border py-1 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className={ok ? "text-accent tabular-nums" : "text-gold tabular-nums"}>
        {ok ? "✓ live" : "— fallback"}
      </span>
    </div>
  );
}

/**
 * Dev-only diagnostics for the live-memory reader: attach state, detected
 * version, cadence source, last read cost, snapshot age, and per-stat health.
 * Gated to dev builds in AppTabBar — not shipped in the production tab bar.
 */
export function LiveMemoryDiagnostics() {
  const { snapshot, status } = useLiveMemory();
  const stats = useStats();
  const state = liveReaderState(status, Boolean(status?.running));
  const lastReadAt = snapshot ? new Date(snapshot.at).toLocaleTimeString() : "—";

  return (
    <TabPage>
      <TabHeader
        title="Live memory (debug)"
        intro="Dev-only diagnostics for the read-only live memory reader."
      />
      <div className="max-w-md space-y-4">
        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Reader</p>
          <Row label="Reader state" value={state} />
          <Row label="Running" value={String(status?.running ?? false)} />
          <Row label="Attached" value={String(status?.attached ?? false)} />
          <Row label="PID" value={status?.pid ?? "—"} />
          <Row label="Game version" value={status?.gameVersion ?? "—"} />
          <Row label="Supported" value={String(status?.supported ?? false)} />
          {status?.note ? <Row label="Note" value={status.note} /> : null}
          <Row label="Source" value={snapshot?.source ?? "—"} />
          <Row label="Last read (ms)" value={snapshot?.readMs ?? "—"} />
          <Row label="Last read at" value={lastReadAt} />
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Live values
          </p>
          <StatHealth label="Gold" value={snapshot?.gold} />
          <Row
            label="Current gold"
            value={snapshot?.gold != null ? fmtCompact(snapshot.gold) : "—"}
          />
          {stats ? (
            <>
              <Row label="Tracker XP/hr" value={`${fmtCompact(stats.rollingRate)}/hr`} />
              <Row label="Tracker gold/hr" value={`${fmtCompact(stats.goldRate)}/hr`} />
              <Row label="Session XP" value={fmtCompact(stats.cumulativeGained)} />
              <Row label="Session XP/hr" value={`${fmtCompact(stats.sessionRate)}/hr`} />
            </>
          ) : null}
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Heroes (live exp)
          </p>
          <StatHealth
            label="Heroes"
            value={snapshot?.heroes?.length ? snapshot.heroes.length : null}
          />
          {snapshot?.heroes == null && snapshot?.heroesStatus ? (
            <Row label="↳ reason" value={snapshot.heroesStatus} />
          ) : null}
          {snapshot?.heroes && snapshot.heroes.length > 0 ? (
            <div className="mt-1 space-y-0">
              {snapshot.heroes.map((h) => (
                <Row
                  key={h.heroKey}
                  label={`${heroName(String(h.heroKey))} (Lv ${h.level})`}
                  value={fmtCompact(h.exp)}
                />
              ))}
            </div>
          ) : (
            <Row label="Party" value="—" />
          )}
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Per-stat health
          </p>
          <Row label="Stage key" value={snapshot?.stageKey ?? "—"} />
          <Row label="Stage wave" value={snapshot?.stageWave ?? "—"} />
          <StatHealth label="Chest log" value={snapshot?.chestDrops} />
          {snapshot?.chestDrops == null && snapshot?.chestDropsStatus ? (
            <Row label="↳ reason" value={snapshot.chestDropsStatus} />
          ) : null}
          <Row
            label="New chest drops (tick)"
            value={snapshot?.chestDrops != null ? String(snapshot.chestDrops.length) : "—"}
          />
          <StatHealth
            label="Inventory"
            value={snapshot?.inventoryItems?.length ? snapshot.inventoryItems.length : null}
          />
          {snapshot?.inventoryItems == null && snapshot?.inventoryItemsStatus ? (
            <Row label="↳ reason" value={snapshot.inventoryItemsStatus} />
          ) : null}
          <Row
            label="Inventory items"
            value={snapshot?.inventoryItems != null ? String(snapshot.inventoryItems.length) : "—"}
          />
          <StatHealth
            label="Pets"
            value={snapshot?.petData?.length ? snapshot.petData.length : null}
          />
          {snapshot?.petData == null && snapshot?.petDataStatus ? (
            <Row label="↳ reason" value={snapshot.petDataStatus} />
          ) : null}
          <Row
            label="Pets count"
            value={snapshot?.petData != null ? String(snapshot.petData.length) : "—"}
          />
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Box queue (stargaze)
          </p>
          <StatHealth
            label="Box queue"
            value={
              snapshot?.boxQueue != null
                ? snapshot.boxQueue.common.length +
                  snapshot.boxQueue.rare.length +
                  snapshot.boxQueue.act.length
                : null
            }
          />
          {snapshot?.boxQueue == null && snapshot?.boxQueueStatus ? (
            <Row label="↳ reason" value={snapshot.boxQueueStatus} />
          ) : null}
          {snapshot?.boxQueue != null ? (
            <>
              <Row label="Common" value={String(snapshot.boxQueue.common.length)} />
              <Row label="Rare" value={String(snapshot.boxQueue.rare.length)} />
              <Row label="Act" value={String(snapshot.boxQueue.act.length)} />
            </>
          ) : null}
        </section>

        {stats ? (
          <section>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Chest drops (per type)
            </p>
            <Row label="Common" value={String(stats.chestDrops.commonTotal)} />
            <Row label="Stage boss" value={String(stats.chestDrops.rareTotal)} />
            <Row label="Combined" value={String(stats.chestDrops.combinedTotal)} />
          </section>
        ) : null}

        {stats ? (
          <section>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              DPS / Damage / Mobs
            </p>
            <StatHealth
              label="Monster HP"
              value={
                snapshot?.monsterHp != null
                  ? snapshot.monsterHp.length > 0
                    ? snapshot.monsterHp.length
                    : 0
                  : null
              }
            />
            <Row
              label="Alive monsters"
              value={snapshot?.monsterHp != null ? String(snapshot.monsterHp.length) : "—"}
            />
            <Row label="Mobs killed (map)" value={String(stats.mapMobsKilled)} />
            <Row label="Damage (map)" value={fmtCompact(stats.mapDamage)} />
            <Row label="Mobs killed (session)" value={String(stats.sessionMobsKilled)} />
            <Row label="Damage (session)" value={fmtCompact(stats.sessionDamage)} />
            <Row label="DPS (5s window)" value={String(stats.dps.toFixed(1))} />
          </section>
        ) : null}

        <section>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Offset extractor (self-healing)
          </p>
          <Row label="Offset source" value={status?.offsetHealth?.source ?? "—"} />
          <Row
            label="Extract attempts"
            value={
              status?.offsetHealth?.extractionAttempts != null
                ? String(status.offsetHealth.extractionAttempts)
                : "—"
            }
          />
          <Row
            label="Status"
            value={status?.supported ? "active" : (status?.note ?? "unavailable")}
          />
          <Row
            label="Offsets complete"
            value={
              status?.offsetHealth
                ? status.offsetHealth.complete
                  ? "✓ all mapped"
                  : `${status.offsetHealth.missing.length} missing`
                : "—"
            }
          />
          {status?.offsetHealth && !status.offsetHealth.complete ? (
            <Row label="Awaiting derivation" value={status.offsetHealth.missing.join(", ")} />
          ) : null}
        </section>
      </div>
    </TabPage>
  );
}
