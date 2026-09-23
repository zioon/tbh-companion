import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { WishHeldCoin } from "../../../../shared/types";
import { PanelSection } from "../../design-system/primitives/PanelSection/PanelSection";
import { gradeColor } from "../../lib/gradeColor";

/**
 * 背包献祭硬币面板（Wish v2，W1 定稿）。
 *
 * 数据由 renderer 侧 join（`useWish().heldCoins` = 背包行 ∩ 硬币闭集 ∩ 图鉴目录），
 * **不**来自 stats（`WishStats` 不含 `heldCoins`）。展示每枚硬币的名称、品质色与
 * 背包持有数量；空背包 / 目录未就绪时显示占位提示。
 */
export const WishHeldCoins = memo(function WishHeldCoins({ coins }: { coins: WishHeldCoin[] }) {
  const { t } = useTranslation("wish");

  return (
    <PanelSection title={t("heldCoins.title")} boxed>
      <div className="flex flex-col p-3">
        {coins.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{t("heldCoins.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {coins.map((c) => {
              const color = gradeColor(c.grade);
              return (
                <li key={c.coinKey} className="flex items-center justify-between gap-2 text-[13px]">
                  <span
                    className="inline-flex min-w-0 items-center gap-1.5 font-medium"
                    style={{ color }}
                    title={c.name}
                  >
                    <span
                      className="size-[9px] shrink-0 rounded-full"
                      style={{ background: color }}
                      aria-hidden
                    />
                    <span className="min-w-0 truncate">{c.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {t("heldCoins.quantity", { count: c.quantity })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {coins.length > 0 && (
          <div className="mt-1 border-t border-border pt-1 text-right text-[11px] text-muted">
            {t("heldCoins.unit", { count: coins.reduce((acc, c) => acc + c.quantity, 0) })}
          </div>
        )}
      </div>
    </PanelSection>
  );
});
