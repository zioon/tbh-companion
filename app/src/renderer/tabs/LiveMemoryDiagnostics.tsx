import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
 * Dev-only diagnostics for the live-memory reader: attach state, detected
 * version, cadence source, last read cost, snapshot age, and per-stat health.
 * Gated to dev builds in AppTabBar — not shipped in the production tab bar.
 */
export function LiveMemoryDiagnostics() {
  const { t } = useTranslation("liveMemory");
  const { snapshot, status } = useLiveMemory();
  const stats = useStats();
  const state = liveReaderState(status, Boolean(status?.running));
  const lastReadAt = snapshot ? new Date(snapshot.at).toLocaleTimeString() : "—";
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
                    name: heroName(String(h.heroKey)),
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
    </TabPage>
  );
}
