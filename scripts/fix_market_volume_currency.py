#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""market_volume_history.json 价格历史币种修复（同 hash 自参照回算）。

背景（2026-09 实测事故）：`MarketVolumeService.calibrateHistoryToBase` 在
`price_prefix` 判定失败时（如 `¥` 同时对应 JPY/CNY）会**原值放行**，于是人民币
被当作 USD 写进标着 `"currency": "USD"` 的文件。展示层再乘一次汇率 =>
交易额与价格线高估约 6.7 倍。

## 为什么用「同 hash 自参照」判定币种

直觉做法是拿`lookup_prices.prices`（**当前** USD 快照）去除历史价，反查 fx 表。
**这条路是错的**，实测会把真USD 数据判成 AUD：

| 月份 | 隐含量纲(对当前快照) | 反查结果 | 真实币种 |
|---|---|---|---|
| 2026-07 | 1.021 | USD | USD |
| 2026-08 | 1.432 | **AUD**（relErr 恰好 0.0000） | **USD** |
| 2026-09 | 7.000 | CNY | CNY |

「当前价」与「历史价」之间的价格漂移本身就污染了比值——8 月某些物品相对当前价
偏高 43%，恰好落到 AUD=1.4324上。**参照源必须是同期数据，不是当前快照。**

正确做法：对每个 hash，取其在**两个时间窗**内的价格中位数，求比值。同一物品在
同期同币种下比值恒为 1，跨币种时比值就是汇率。用它做全局标定：

    基准窗= 2026-08（实测为USD），目标窗 = 2026-09 及之后
    ## 判定方法：逐月独立定锚（不预设基准月）

判据是**本机目标货币价格缓存** `prices.<CUR>.json`—— 缓存里的成交中位价与
pricehistory 的价格**同源、同区域、同币种**，因此没有「历史价 vs 当前价」的时间
漂移。对**每个月**独立求 `该月价格中位 ÷ 本地货币中位`：

| 比值 | 判定 |
|---|---|
| 落在 0.65 ~ 1.55 | 该月数据**就是**目标货币 → 除以汇率回算 |
| ≈ 1 / unitsPerUsd | 该月数据**已是**基准货币 → 原样保留 |
| 其余（含 v1 混杂数据） | **判不出 → 丢弃该月**，不猜 |

**为什么不用更顺手的两条路（都实测失败过）**：

1. 拿 `lookup_prices.prices`（**当前** USD 快照）当参照 —— 价格漂移本身污染比值，
   实测把 2026-08 的真USD 数据判成 **AUD**（relErr 恰好 0.0000）。
2. 用「相对某个基准月的同 hash 比值」定标 —— 隐含「基准月币种正确」的假设，
   而基准月本身正是待判定的对象，循环论证。

交叉验证：脚本会额外打印「相对基准月的同 hash 比值」作为**第二意见**，与定锚
结论不一致的月份会打 `⚠`，供人工复核。

用法：
    python scripts/fix_market_volume_currency.py                # dry-run，只报告
    python scripts/fix_market_volume_currency.py --apply         # 写回（自动备份）
    python scripts/fix_market_volume_currency.py --apply --assume-currency CNY
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import statistics
import sys
from collections import defaultdict
from pathlib import Path

USER_DATA = Path.home() / "AppData" / "Roaming" / "tbh-companion"
HISTORY_FILE = USER_DATA / "market_volume_history.json"
LOOKUP_FILE = USER_DATA / "lookup_prices.json"

# 相对误差容差。判定「是否已是基准货币」用严格值（0.10），避免 USD(1.0) 被
# EUR(0.89)/CHF(0.83) 这类邻近币种捕获。
TOL_STRICT = 0.10
# 判定「是哪个非 USD 币种」用较宽值：CNY 6.69 与 HKD 7.85 量级接近，
# 真实数据有价格漂移，需要容忍小幅偏差。
TOL_LOOSE = 0.20


def _to_dt(ts) -> dt.datetime:
    if isinstance(ts, (int, float)):
        seconds = ts / 1000 if ts > 1e11 else ts
        return dt.datetime.fromtimestamp(seconds, dt.UTC)
    return dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))


def month_of(ts) -> str:
    return _to_dt(ts).strftime("%Y-%m")


def day_of(ts) -> str:
    return _to_dt(ts).strftime("%Y-%m-%d")


def median_price(points: list[dict], month: str) -> float | None:
    """该 hash 在指定月份内有成交量的点的价格中位数。"""
    values = [
        p["price"]
        for p in points
        if p.get("volume", 0) > 0 and isinstance(p.get("price"), (int, float)) and month_of(p["timestamp"]) == month
    ]
    return statistics.median(values) if values else None


def median_price_by_day(points: list[dict], day: str) -> float | None:
    values = [
        p["price"]
        for p in points
        if p.get("volume", 0) > 0 and isinstance(p.get("price"), (int, float)) and day_of(p["timestamp"]) == day
    ]
    return statistics.median(values) if values else None


def classify(implied: float, fx: dict[str, float]) -> tuple[str | None, float]:
    """把「隐含 unitsPerUsd」映射到币种。返回 (ISO 或 None, relErr)。"""
    if implied <= 0:
        return None, float("inf")
    best = min(
        ((abs(v - implied) / implied, k) for k, v in fx.items() if v > 0),
        key=lambda kv: kv[0],
        default=None,
    )
    if best is None:
        return None, float("inf")
    err, code = best
    tol = TOL_STRICT if code == "USD" else TOL_LOOSE
    return (code if err <= tol else None), err


def anchor_month(
    price_history: dict[str, list], local_prices: dict[str, dict], month: str, fx: dict[str, float]
) -> tuple[float, int] | None:
    """用**本机目标货币价格缓存**（`prices.<CUR>.json`）对**某一个月**独立定锚。

    这是最可靠的判据：缓存里的成交中位价与 pricehistory 的价格**同源、同区域、
    同币种**，不存在「历史价 vs 当前价」的时间漂移，也不需要假设任何基准月。

    返回 `(该月价格中位 / 本地货币中位 的中位数, 样本数)`：
    - ≈ 1.0→ 该月数据**就是**目标货币（本机 CNY）；
    - ≈ 1/unitsPerUsd → 该月数据**已是**基准货币（USD）。

    判据只认「接近 1」与「接近 1/fx」两个窗口，落在两者之间/之外一律判不出——
    宁可丢弃也不猜（5-6 月实测锚值 25.8/17.9 即属此类，是 v1 时期的混杂数据）。
    """
    ratios: list[float] = []
    for h, points in price_history.items():
        entry = local_prices.get(h)
        local = entry.get("median") if isinstance(entry, dict) else None
        if not isinstance(local, (int, float)) or local <= 0:
            continue
        med = median_price(points, month)
        if med and med > 0:
            ratios.append(med / local)
    if not ratios:
        return None
    return statistics.median(ratios), len(ratios)


def anchor_month_by_day(
    price_history: dict[str, list], local_prices: dict[str, dict], day: str
) -> float | None:
    """按天定锚：某一天内各hash 的价格中位 / 本地货币中位 的中位数。"""
    ratios: list[float] = []
    for h, points in price_history.items():
        entry = local_prices.get(h)
        local = entry.get("median") if isinstance(entry, dict) else None
        if not isinstance(local, (int, float)) or local <= 0:
            continue
        med = median_price_by_day(points, day)
        if med and med > 0:
            ratios.append(med / local)
    return statistics.median(ratios) if ratios else None


def anchor_verdict(
    ratio: float, anchor_code: str, fx: dict[str, float]
) -> tuple[str | None, str]:
    """把定锚比值翻译成币种判定，并给出人类可读的依据。"""
    units = fx.get(anchor_code)
    if units is None:
        return None, f"fx 表无 {anchor_code}"
    # 窗口 1：与本地货币几乎相等 → 就是本地货币。
    if 0.65 <= ratio <= 1.55:
        return anchor_code, f"≈1.0 → 本地货币({anchor_code})"
    # 窗口 2：差恰好一个汇率 → 已是基准货币。
    if abs(ratio * units - 1.0) <= 0.35:
        return "USD", f"≈1/{units:.4f} → 已是基准货币(USD)"
    return None, f"既非≈1.0 也非≈1/{units:.4f} → 判不出"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写回（默认 dry-run）")
    ap.add_argument("--base-month", default="2026-08", help="基准月（实测为 USD 口径）")
    ap.add_argument(
        "--local-currency",
        default="CNY",
        help="本机显示货币（用于读取 prices.<CUR>.json 做独立定锚）",
    )
    ap.add_argument(
        "--no-day-refine",
        dest="day_refine",
        action="store_false",
        help="不做日粒度精修（默认开启，用于捕捉月内币种切换）",
    )
    ap.add_argument(
        "--assume-currency",
        default=None,
        help="对「定锚判不出」的月份强制按此ISO 币种回算（默认不覆盖，直接丢弃）",
    )
    args = ap.parse_args()

    if not HISTORY_FILE.exists():
        print(f"[x] 找不到 {HISTORY_FILE}")
        return 1

    doc = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    lookup = json.loads(LOOKUP_FILE.read_text(encoding="utf-8"))
    fx = {k.upper(): float(v) for k, v in (lookup.get("fx") or {}).items() if v}
    price_history: dict[str, list] = doc.get("priceHistory") or {}

    if not price_history:
        print("[x] priceHistory 为空，无需修复")
        return 1

    # 收集每个 hash 逐月的价格中位数
    monthly: dict[str, dict[str, float]] = defaultdict(dict)
    for h, points in price_history.items():
        for month in sorted({month_of(p["timestamp"]) for p in points}):
            med = median_price(points, month)
            if med and med > 0:
                monthly[h][month] = med

    all_months = sorted({m for per in monthly.values() for m in per})
    print(f"文件: {HISTORY_FILE}")
    print(f"顶层 currency={doc.get('currency')!r} version={doc.get('version')}")
    print(f"hash数={len(price_history)}  月份={all_months}  fx币种数={len(fx)}\n")

    # 逐月独立定锚（不预设基准月）
    # 唯一可信的判据是「本机目标货币价格缓存」：它与 pricehistory 同源同币种，
    # 没有时间漂移。之前用「当前 USD 快照」或「固定基准月」都会误判。
    local_cache_path = USER_DATA / f"prices.{args.local_currency}.json"
    local_prices: dict[str, dict] = {}
    if local_cache_path.exists():
        try:
            local_prices = (
                json.loads(local_cache_path.read_text(encoding="utf-8")).get("prices") or {}
            )
        except Exception:  # noqa: BLE001 - 缓存损坏不应中断修复
            local_prices = {}
    anchor_code = args.local_currency

    print(f"逐月独立定锚（参照=prices.{anchor_code}.json，fx 币种数={len(fx)}）")
    print(f"{'月份':<10}{'锚样本':>7}{'锚比值':>9}  {'判定':<6}依据")
    print("-" * 72)

    month_currency: dict[str, str | None] = {}
    # 日粒度判定（仅在月内检出币种切换时填充），回算时优先于月判定。
    day_currency_map: dict[str, str | None] = {}
    for month in all_months:
        res = anchor_month(price_history, local_prices, month, fx) if local_prices else None
        if res is None:
            month_currency[month] = None
            print(f"{month:<10}{0:>7}{'-':>9}  {'?':<6}无本地缓存样本 → 判不出")
            continue
        ratio, n_anchor = res
        currency, why = anchor_verdict(ratio, anchor_code, fx)
        month_currency[month] = currency
        if currency == "USD":
            action = "原样保留"
        elif currency:
            action = f"除以 {fx[currency]:.4f} 回算"
        else:
            action = "丢弃该月（不猜）"
        print(
            f"{month:<10}{n_anchor:>7}{ratio:>9.3f}  {str(currency or '?'):<6}"
            f"{why} → {action}"
        )

    # ---- 日粒度精修：月内出现币种切换时按天再判定一次 ----
    # 实测污染起点是 2026-08-23 而非 9 月：8 月整月锚值0.116（USD）会把 8-23 之后
    # 那两万多个人民币点一并当成 USD 留下（占残留可疑点的绝大多数）。故对「月内
    # 锚值可能混合」的月份按天细分。
    if args.day_refine:
        print("\n日粒度精修（月内可能存在币种切换的月份）")
        for month, month_verdict in list(month_currency.items()):
            days = sorted({day_of(p["timestamp"]) for pts in price_history.values() for p in pts
                           if day_of(p["timestamp"]).startswith(month)})
            if len(days) < 5:
                continue
            per_day_ratio: dict[str, float] = {}
            for day in days:
                res = anchor_month_by_day(price_history, local_prices, day)
                if res is not None:
                    per_day_ratio[day] = res
            verdicts = {d: anchor_verdict(r, anchor_code, fx)[0] for d, r in per_day_ratio.items()}
            distinct = {v for v in verdicts.values() if v is not None}
            if len(distinct) <= 1:
                continue  # 该月币种一致，无需细分
            print(f"  {month}：月判={month_verdict}，日判出现 {sorted(distinct)} → 按天细分")
            for day in days:
                v = verdicts.get(day)
                month_currency_day = v if v is not None else month_verdict
                day_currency_map[day] = month_currency_day

    # 交叉验证：与「同 hash 相对基准月」的自参照比值对照，两者应指向同一币种。
    # 不一致会打 ⚠，作为人工复核信号。
    base = args.base_month
    if base and base in all_months:
        print(f"\n交叉验证（相对基准月 {base} 的同 hash 比值，仅作第二意见）")
        for month in all_months:
            if month == base:
                continue
            ratios = [
                monthly[h][month] / monthly[h][base]
                for h in monthly
                if month in monthly[h] and base in monthly[h] and monthly[h][base] > 0
            ]
            if not ratios:
                continue
            implied = statistics.median(ratios)
            guess, _ = classify(implied, fx)
            final = month_currency.get(month)
            agree = guess == final or final is None or guess is None
            print(
                f"  {month:<10}比值={implied:>9.4f}  fx反查={str(guess or '?'):<6}"
                f"定锚={str(final or '?'):<6}{'' if agree or final else '⚠ 不一致，请复核'}"
            )

    if args.assume_currency:
        forced = args.assume_currency.upper()
        if forced not in fx:
            print(f"\n[x] --assume-currency {forced} 不在 fx 表中，忽略该覆盖")
        else:
            for month, currency in month_currency.items():
                if currency is None:
                    month_currency[month] = forced
                    print(f"  [覆盖] {month} 定锚判不出 → 强制按 {forced} 回算")

    # ---- 执行回算 ----
    changed = 0
    dropped = 0
    for h, points in list(price_history.items()):
        kept: list = []
        for p in points:
            day = day_of(p["timestamp"])
            # 日判定优先（能捕捉月内币种切换，如 2026-08-23），否则回退月判定。
            currency = day_currency_map.get(day)
            if currency is None:
                currency = month_currency.get(month_of(p["timestamp"]))
            if currency is None:
                dropped += 1  # 判不出 → 丢弃该点，不猜
                continue
            if currency == "USD":
                kept.append(p)
                continue
            np = dict(p)
            np["price"] = p["price"] / fx[currency]
            kept.append(np)
            changed += 1
        if kept:
            price_history[h] = kept
        else:
            del price_history[h]

    # historyHourly 是 priceHistory 的派生物，须同步回算，否则总额与走势不一致。
    hourly_changed = 0
    for hpt in doc.get("historyHourly") or []:
        hour = hpt.get("hour", 0)
        currency = day_currency_map.get(day_of(hour)) or month_currency.get(month_of(hour))
        if currency in (None, "USD"):
            continue
        scale = fx[currency]
        hpt["total"] = hpt["total"] / scale
        if isinstance(hpt.get("byCategory"), dict):
            hpt["byCategory"] = {k: v / scale for k, v in hpt["byCategory"].items()}
        hourly_changed += 1

    # samples 自带 currency 字段（recordVolume 写入时已记录），按它回算。
    samples_changed = 0
    for s in doc.get("samples") or []:
        code = str(s.get("currency") or "").upper()
        if code and code != "USD" and code in fx:
            scale = fx[code]
            s["total"] = s["total"] / scale
            if isinstance(s.get("byCategory"), dict):
                s["byCategory"] = {k: v / scale for k, v in s["byCategory"].items()}
            s["currency"] = "USD"
            samples_changed += 1

    doc["priceHistory"] = price_history
    doc["currency"] = "USD"
    doc["version"] = 2

    print()
    print(f"回算价格点 = {changed}    丢弃不可信点 = {dropped}")
    print(f"回算走势点 = {hourly_changed}    回算采样 = {samples_changed}")
    print(f"保留 hash = {len(price_history)}")

    if not args.apply:
        print("\n[dry-run] 未写回。确认无误后加 --apply")
        return 0

    backup = HISTORY_FILE.with_suffix(".json.bak-currency-fix")
    shutil.copy2(HISTORY_FILE, backup)
    HISTORY_FILE.write_text(
        json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"\n[ok] 已写回，原文件备份在 {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())