import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import {
  formatMaterialOutcome,
  resonanceConditionText,
  uniqueModLabel,
} from "../../lib/itemLabels";
import type {
  LookupItem,
  LookupMaterialOutcome,
  LookupReliquaryInfo,
  LookupResonance,
} from "../../../../shared/types";

/**
 * v1.3.0 圣物（RELIC_*）/ 圣物匣（RELIQUARY）信息面板。
 *
 * 圣物系不在 `GearInfoData` 里，所以没有 base/inherent/unique 三段结构：
 *   - 圣物：一条**区间**固有词条（抽取时 roll）+ 可能的附加效果
 *   - 圣物匣：从词条池 roll N 条 + 拥有的槽位 + 共鸣（条件 → 效果）
 *
 * 词条区间复用 {@link formatMaterialOutcome}（与材料的 outcome 同形状）。
 */

function OutcomeRows({
  outcomes,
  emptyLabel,
}: {
  outcomes: LookupMaterialOutcome[];
  emptyLabel?: string;
}) {
  const { t } = useTranslation("lookup");
  if (outcomes.length === 0) {
    return emptyLabel ? <p className="m-0 text-[13px] text-muted">{emptyLabel}</p> : null;
  }
  return (
    <ul className="m-0 list-none divide-y divide-border/50 overflow-hidden rounded-md bg-panel/50 text-[13px] text-ideal">
      {outcomes.map((o, i) => (
        <li key={`${o.stat}-${o.mod}-${i}`} className="px-2.5 py-1.5 leading-snug">
          {formatMaterialOutcome(o, t)}
        </li>
      ))}
    </ul>
  );
}

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-fg/60">{title}</p>
      {children}
    </div>
  );
}

/** 一条共鸣：条件 + 效果文案。 */
function ResonanceRow({ resonance }: { resonance: LookupResonance }) {
  const { t } = useTranslation("lookup");
  const effect = resonance.effect;
  // UniqueMod 型走既有的 uniqueModLabel 通道（模板 + 参数填充）；
  // PartyMod 型用游戏自己的 PartyMod_<name> 文案。
  const text = uniqueModLabel(effect.mod, effect.text, t, effect.params);
  return (
    <li className="px-2.5 py-1.5 leading-snug">
      <span className="text-muted">
        {t("relic.conditionLabel")}: {resonanceConditionText(resonance.condition, t)}
      </span>
      <span className="text-fg"> — {text}</span>
    </li>
  );
}

export function RelicPanel({ item }: { item: LookupItem }) {
  const { t } = useTranslation("lookup");
  const relic = item.relic;
  const reliquary: LookupReliquaryInfo | undefined = item.reliquary;
  if (!relic && !reliquary) return null;

  const attunement = item.attunement;

  return (
    <div className="flex flex-col gap-3">
      {relic ? (
        <>
          {relic.relicType ? (
            <p className="m-0 text-[13px] text-muted">
              {t("relic.typeLabel")}:{" "}
              <span className="text-fg">
                {t(`common:labels.types.RELIC_${relic.relicType.toUpperCase()}`)}
              </span>
            </p>
          ) : null}
          {relic.inherent ? (
            <Panel title={t("relic.inherentLabel")}>
              <OutcomeRows outcomes={[relic.inherent]} />
            </Panel>
          ) : null}
          {relic.additionalMod ? (
            <Panel title={t("relic.additionalLabel")}>
              <p className="m-0 text-[13px] text-gold">
                {t(`common:labels.relicAdditional.${relic.additionalMod}`)}
              </p>
            </Panel>
          ) : null}
        </>
      ) : null}

      {reliquary ? (
        <>
          {reliquary.inherentPool && reliquary.inherentPool.length > 0 ? (
            <Panel title={t("relic.poolLabel")}>
              <p className="m-0 text-[13px] text-muted">
                {t("relic.poolHint", {
                  count: reliquary.inherentStatCount ?? 0,
                  total: reliquary.inherentPool.length,
                })}
              </p>
              <OutcomeRows outcomes={reliquary.inherentPool} />
            </Panel>
          ) : null}
          {reliquary.slotIndexes && reliquary.slotIndexes.length > 0 ? (
            <Panel title={t("relic.slotsLabel")}>
              <p className="m-0 text-[13px] text-fg">
                {t("relic.slotsValue", { count: reliquary.slotIndexes.length })}
              </p>
            </Panel>
          ) : null}
          {reliquary.resonances && reliquary.resonances.length > 0 ? (
            <Panel title={t("relic.resonanceLabel")}>
              <ul className="m-0 list-none divide-y divide-border/50 overflow-hidden rounded-md bg-panel/50 text-[13px]">
                {reliquary.resonances.map((r) => (
                  <ResonanceRow key={r.key} resonance={r} />
                ))}
              </ul>
            </Panel>
          ) : null}
        </>
      ) : null}

      {attunement ? (
        <Panel title={t("relic.attunementLabel")}>
          <p className="m-0 text-[13px] text-muted">
            {t("relic.attunementValue", {
              base: attunement.baseCost.toLocaleString(),
              increase: attunement.costIncrease.toLocaleString(),
              max: attunement.maxCount,
            })}
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
