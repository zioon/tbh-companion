import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WishCoinGroup,
  WishCoinGroupItem,
  WishCoinOverride,
  WishGrade,
  WishUnattributedGroup,
} from "../../../../shared/types";
import { PanelSection } from "../../design-system/primitives/PanelSection/PanelSection";
import { Button } from "../../design-system/primitives/Button/Button";
import { Select, type SelectOption } from "../../design-system/primitives/Select/Select";
import { gradeColor } from "../../lib/gradeColor";
import { candidateNames } from "../../lib/wishCoin";

/** coinKey → 硬币元数据解析器（与 `useWish().coinResolver` 同型）。 */
type CoinResolver = (
  coinKey: number,
) => { coinKey: number; name: string; grade: string; iconPath: string } | undefined;

/** 解除手工绑定的哨兵值（`Select` 的 value 只能是 string | number）。 */
const AUTO_VALUE = "__auto__";

/** 稳定的空默认值（避免每次渲染新建引用导致 useMemo 失效）。 */
const EMPTY_OVERRIDES: WishCoinOverride[] = [];
const EMPTY_COIN_OPTIONS: { coinKey: number; name: string; grade: string }[] = [];

/** 单个归因物品行（名称 / 品质色 / 件数）—— 内容块，由调用方决定 <li>/<div> 外壳。 */
function ItemLineBody({ item }: { item: WishCoinGroupItem }) {
  const color = gradeColor(item.grade);
  return (
    <>
      <span
        className="inline-flex min-w-0 items-center gap-1.5"
        style={{ color }}
        title={item.name}
      >
        <span
          className="size-[9px] shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden
        />
        <span className="min-w-0 truncate">{item.name}</span>
      </span>
      <span className="shrink-0 tabular-nums text-muted">
        {item.count > 1 ? `×${item.count}` : ""}
      </span>
    </>
  );
}

/**
 * 按硬币分组的祈愿产出（Wish v2）。
 *
 * 上半 = `observed` 归因的硬币分组（每枚硬币一张小节：标题「硬币名 · N 次 · M 件」
 * + 产出物品明细）；下半 = 未归因 / 候选分组（`inferred` 显示候选集合 + 池概率，
 * `unknown` 显示中性提示）。**observed 与候选严格分区**，避免把推断当实证（I7）。
 *
 * 手工分类：未归因分区的每一行提供「指定硬币」下拉（候选池 = 全部献祭硬币），
 * 选中即建立 `manual` 绑定；已绑定行显示「改回自动」按钮解除绑定。绑定在
 * renderer 侧幂等再派生（见 `core/wish/coinOverrides.ts`），对已记录历史同样生效。
 */
export const WishCoinGroups = memo(function WishCoinGroups({
  groups,
  unattributed,
  resolveCoin,
  coinOverrides = EMPTY_OVERRIDES,
  coinOptions = EMPTY_COIN_OPTIONS,
  onAssignCoin,
}: {
  groups: WishCoinGroup[];
  unattributed: WishUnattributedGroup;
  resolveCoin: CoinResolver;
  /** 当前生效的手工绑定（缺省 = 无绑定）。 */
  coinOverrides?: WishCoinOverride[];
  /** 可用于绑定的全部献祭硬币（key 升序）；缺省 = 无候选池，只显示自动档。 */
  coinOptions?: { coinKey: number; name: string; grade: string }[];
  /** 手工绑定 / 解除绑定；`coinKey == null` 表示改回自动归因。 */
  onAssignCoin?: (itemName: string, coinKey: number | null) => void;
}) {
  const { t } = useTranslation("wish");

  const gradeLabel = (grade: WishGrade): string => t(`grade.${grade}` as const);

  // itemName → coinKey 的绑定查找表（非数组入参按「无绑定」处理，渲染期绝不抛错）。
  const overrideByName = useMemo(() => {
    const map = new Map<string, number>();
    if (!Array.isArray(coinOverrides)) return map;
    for (const o of coinOverrides) map.set(o.itemName, o.coinKey);
    return map;
  }, [coinOverrides]);

  const selectOptions: SelectOption[] = useMemo(
    () => [
      { value: AUTO_VALUE, label: t("manual.autoOption") },
      ...coinOptions.map((c) => ({ value: c.coinKey, label: c.name })),
    ],
    [coinOptions, t],
  );

  /** 逐行暂存的「待指定硬币」（用户先选、再确认，避免误触落盘）。 */
  const [draft, setDraft] = useState<Record<string, number | typeof AUTO_VALUE>>({});

  const valueFor = useCallback(
    (itemName: string): number | typeof AUTO_VALUE =>
      draft[itemName] ?? overrideByName.get(itemName) ?? AUTO_VALUE,
    [draft, overrideByName],
  );

  const commit = useCallback(
    (itemName: string, value: number | typeof AUTO_VALUE): void => {
      if (!onAssignCoin) return;
      const coinKey = value === AUTO_VALUE ? null : value;
      if (coinKey != null && overrideByName.get(itemName) === coinKey) return;
      onAssignCoin(itemName, coinKey);
      setDraft((prev) => {
        const next = { ...prev };
        delete next[itemName];
        return next;
      });
    },
    [onAssignCoin, overrideByName],
  );

  const candidateLabels = (coinGroup: WishCoinGroupItem): string => {
    const cands = coinGroup.coin?.candidates ?? [];
    if (cands.length === 0) return "";
    return candidateNames(cands, (k) => resolveCoin(k)?.name)
      .map((c) =>
        t("confidence.candidateTooltip", {
          coin: c.name,
          pct: `${(c.poolPct * 100).toFixed(1)}%`,
        }),
      )
      .join(" · ");
  };

  const hasAny = groups.length > 0 || unattributed.items.length > 0;

  return (
    <PanelSection title={t("coinGroups.title")} boxed>
      <div className="flex flex-col gap-3 p-3">
        {!hasAny ? (
          <p className="m-0 text-[13px] text-muted">{t("coinGroups.empty")}</p>
        ) : (
          <>
            {groups.map((g) => {
              const meta = resolveCoin(g.coinKey);
              const color = gradeColor(meta?.grade ?? g.grade);
              const name = meta?.name ?? g.coinName ?? `#${g.coinKey}`;
              return (
                <div key={g.coinKey} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span
                      className="inline-flex items-center gap-1.5 font-semibold"
                      style={{ color }}
                    >
                      <span
                        className="size-[9px] shrink-0 rounded-full"
                        style={{ background: color }}
                        aria-hidden
                      />
                      <span className="min-w-0 truncate">{name}</span>
                      <span className="text-[11px] text-muted">{gradeLabel(g.grade)}</span>
                    </span>
                    <span className="text-[11px] text-muted">
                      {t("coinGroups.subtitle", { offerings: g.offeringCount, items: g.itemCount })}
                    </span>
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                    {g.items.map((item, i) => (
                      <li
                        key={`${g.coinKey}-${item.name}-${i}`}
                        className="flex items-center justify-between gap-2 text-[13px]"
                      >
                        <ItemLineBody item={item} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}

            {unattributed.items.length > 0 && (
              <div className="flex flex-col gap-1.5 border-t border-border pt-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {t("coinGroups.unattributedTitle")}
                </div>
                <p className="m-0 text-[11px] text-muted">{t("coinGroups.unattributedHint")}</p>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {unattributed.items.map((item, i) => {
                    const cands = candidateLabels(item);
                    const value = valueFor(item.name);
                    const bound = overrideByName.get(item.name);
                    const usingDraft = draft[item.name] != null;
                    return (
                      <li key={`un-${item.name}-${i}`} className="flex flex-col gap-0.5">
                        <span className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                          <ItemLineBody item={item} />
                          {onAssignCoin && (
                            <span className="flex shrink-0 items-center gap-1">
                              <Select
                                className="w-36"
                                triggerClassName="py-1 text-xs"
                                options={selectOptions}
                                value={value}
                                onValueChange={(v) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    [item.name]: v === AUTO_VALUE ? AUTO_VALUE : (v as number),
                                  }))
                                }
                                ariaLabel={t("manual.selectAriaLabel", { name: item.name })}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!usingDraft}
                                onClick={() => commit(item.name, value)}
                                aria-label={t("manual.confirmAriaLabel", { name: item.name })}
                              >
                                {t("manual.assign")}
                              </Button>
                              {bound != null && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => commit(item.name, AUTO_VALUE)}
                                  aria-label={t("manual.resetAriaLabel", { name: item.name })}
                                >
                                  {t("manual.resetAuto")}
                                </Button>
                              )}
                            </span>
                          )}
                        </span>
                        {item.coin?.confidence === "manual" && bound != null && (
                          <span className="pl-4 text-[11px] text-muted">
                            {t("manual.boundTo", {
                              coin: resolveCoin(bound)?.name ?? `#${bound}`,
                            })}
                          </span>
                        )}
                        {item.coin?.confidence === "inferred" && cands && (
                          <span className="pl-4 text-[11px] text-muted" title={cands}>
                            {t("confidence.candidatesTitle")}: {cands}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </PanelSection>
  );
});
