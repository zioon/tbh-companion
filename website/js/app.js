/* TBH Companion web tool — shell behaviour.
 *
 * Everything here works WITHOUT a save file:
 *   ./data/gamedata.json  unpacked catalog (required)
 *   ./data/prices.json    Steam listed-price snapshot (optional; staged by
 *                         .github/workflows/pages.yml from the rolling
 *                         `lookup-prices` release, rebuilt every 6h)
 *
 * Only the Save Analysis view needs a save — it decrypts locally in the
 * browser (./inspector/) and never uploads anything. Its sample preview is
 * clearly labelled as sample data.
 *
 * Market hashes must match app/src/core/marketName.ts exactly, otherwise the
 * catalog and the snapshot stop lining up:
 *   materials -> the item name
 *   gear      -> "<name> (<Grade>) A", priced only at Legendary and above
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------- tokens

  /** Ascending rarity, mirrors app/src/core/grades.ts GRADE_ORDER. */
  const GRADE_ORDER = [
    "COMMON",
    "UNCOMMON",
    "RARE",
    "LEGENDARY",
    "IMMORTAL",
    "ARCANA",
    "BEYOND",
    "CELESTIAL",
    "DIVINE",
    "COSMIC",
  ];

  /** Mirrors app/src/renderer/lib/gradeColor.ts so both surfaces agree. */
  const GRADE_COLOR = {
    COMMON: "#c9ccd2",
    UNCOMMON: "#8fd862",
    RARE: "#4aa3ff",
    LEGENDARY: "#dfc149",
    IMMORTAL: "#dd6c5f",
    ARCANA: "#dc90df",
    BEYOND: "#dd5f9e",
    CELESTIAL: "#5cd2d6",
    DIVINE: "#e3dbb5",
    COSMIC: "#e574e7",
    UNKNOWN: "#6b7280",
  };

  const TYPE_LABEL = { GEAR: "GEAR", MATERIAL: "MATERIAL", STAGEBOX: "STAGEBOX" };

  const APP_ID = 3678970;
  const PAGE_SIZE = 24;
  const MIN_PRICEABLE_GEAR_RANK = GRADE_ORDER.indexOf("LEGENDARY");

  const SAMPLE_ANALYSIS = {
    kpis: [
      { label: "XP PER HOUR", value: "1.24M", delta: "+6.2%", deltaClass: "good", sub: "经验 · 每小时" },
      { label: "GOLD PER HOUR", value: "38.4K", delta: "+2.1%", deltaClass: "good", sub: "金币 · 每小时" },
      { label: "INVENTORY VALUE", value: "¥1,284.50", delta: "+3.4%", deltaClass: "good", sub: "背包估值 · Steam 中位价" },
      { label: "CHESTS READY", value: "2", delta: "of 5 stages", deltaClass: "", sub: "宝箱可开 · 冷却已结束" },
    ],
    rates: [
      ["Knight", 42, "412K", "12.8K"],
      ["Ranger", 38, "336K", "9.6K"],
      ["Sorcerer", 35, "268K", "8.1K"],
      ["Priest", 31, "142K", "5.2K"],
      ["Hunter", 27, "64K", "1.8K"],
      ["Slayer", 24, "38K", "0.9K"],
    ],
    chests: [
      { name: "Stage 03 · Plague Fruit", count: "READY", pct: 100, ready: true },
      { name: "Stage 07", count: "12m 30s", pct: 64 },
      { name: "Stage 11", count: "28m 04s", pct: 28 },
    ],
    drops: [
      ["Minor Ruby × 3", "Stage 03"],
      ["Pearl", "Stage 12"],
      ["Obsidian Shard × 2", "Stage 07"],
    ],
    session: [
      ["时长 Duration", "2h 14m"],
      ["掉落记录 Drops", "1,284"],
      ["升级 Level ups", "6"],
    ],
    xpTrend: [0.62, 0.72, 0.55, 0.8, 0.85, 0.7, 0.92, 0.86],
    xpPeak: "peak 1.42M",
    xpAvg: "avg 1.18M",
  };

  // --------------------------------------------------------------- helpers

  const $ = (sel, root = document) => root.querySelector(sel);

  function show(node, on) {
    if (node) node.style.display = on ? "" : "none";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const gradeRank = (grade) => GRADE_ORDER.indexOf(String(grade || "").toUpperCase());
  const isPriceableGrade = (grade) => gradeRank(grade) >= MIN_PRICEABLE_GEAR_RANK;
  const gradeTitle = (grade) => (grade ? grade[0] + grade.slice(1).toLowerCase() : grade);
  const gradeColor = (grade) => GRADE_COLOR[grade] || GRADE_COLOR.UNKNOWN;
  const isPlaceholder = (name) => String(name || "").startsWith("ItemName_");

  /** catalog item -> Steam market_hash_name, or null when not priceable. */
  function marketHashName(item) {
    if (!item || !item.marketTradable) return null;
    if (isPlaceholder(item.name)) return null;
    if (item.type === "MATERIAL") return item.name;
    if (item.type === "GEAR" && isPriceableGrade(item.grade)) {
      return `${item.name} (${gradeTitle(item.grade)}) A`;
    }
    return null;
  }

  const listingUrl = (hash) => `https://steamcommunity.com/market/listings/${APP_ID}/${encodeURIComponent(hash)}`;

  function relTime(iso) {
    if (!iso) return "—";
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return "—";
    const min = Math.round(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hours = Math.round(min / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function gradeChip(grade) {
    const chip = el("span", "grade-chip");
    const dot = el("i");
    dot.style.background = gradeColor(grade);
    chip.append(dot, el("span", null, grade || "—"));
    return chip;
  }

  function sparkline(samples, width, height, color) {
    const step = width / (samples.length - 1);
    const points = samples.map((v, i) => [i * step, height - 6 - v * (height - 14)]);
    const line = points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("fill", "none");
    svg.innerHTML =
      `<path d="M${line} ${width} ${height} 0 ${height}Z" fill="${color}" fill-opacity="0.12"/>` +
      `<path d="M${line}" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    return svg;
  }

  function kpiCard(item) {
    const card = el("div", "card kpi");
    card.append(el("p", "kpi-label", item.label));
    const row = el("div", "kpi-value-row");
    const value = el("span", "kpi-value", item.value);
    if (item.valueClass) value.classList.add(item.valueClass);
    row.append(value);
    if (item.delta) row.append(el("span", `kpi-delta ${item.deltaClass || ""}`.trim(), item.delta));
    card.append(row, el("p", "kpi-sub", item.sub));
    return card;
  }

  // ------------------------------------------------------------------ state

  const store = {
    items: [],
    prices: null, // { prices, fetchedUtc, generatedUtc, fx, baseCurrency }
    fx: null,
    catalogReady: false,
  };

  const dataView = { type: "ALL", grade: "ALL", query: "", tradableOnly: false, shown: PAGE_SIZE, selected: null };
  const marketView = { grade: "ALL", query: "", sort: "price-desc", shown: PAGE_SIZE };

  const priceable = () => store.items.filter((it) => marketHashName(it) != null);

  /** Lowest listing in CNY, plus the raw USD value; null when unpriced. */
  function priceOf(item) {
    const snap = store.prices;
    if (!snap) return null;
    const hash = marketHashName(item);
    if (!hash) return null;
    const usd = snap.prices ? snap.prices[hash] : null;
    if (typeof usd !== "number") return null;
    const rate = store.fx && store.fx.CNY ? store.fx.CNY : null;
    return { usd, cny: rate ? usd * rate : null, rate };
  }

  function money(value) {
    if (value == null) return "—";
    const symbol = value.cny != null ? "¥" : "$";
    const amount = value.cny != null ? value.cny : value.usd;
    return `${symbol}${amount.toFixed(2)}`;
  }

  // ------------------------------------------------------------- game data

  function gradedOptions(select, label) {
    const grades = GRADE_ORDER.filter((g) => store.items.some((it) => it.grade === g));
    const extras = Array.from(new Set(store.items.map((it) => it.grade).filter((g) => g && !grades.includes(g))));
    select.textContent = "";
    const all = document.createElement("option");
    all.value = "ALL";
    all.textContent = label;
    select.append(all);
    grades.concat(extras).forEach((g) => {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      select.append(opt);
    });
  }

  function filteredDataItems() {
    const q = dataView.query.trim().toLowerCase();
    return store.items.filter((it) => {
      if (dataView.type !== "ALL" && it.type !== dataView.type) return false;
      if (dataView.grade !== "ALL" && it.grade !== dataView.grade) return false;
      if (dataView.tradableOnly && !it.marketTradable) return false;
      if (q && !String(it.name).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderDetail() {
    const host = $("#item-detail");
    host.textContent = "";
    const it = dataView.selected;
    if (!it) {
      host.append(el("p", "kpi-sub", "Select an item to inspect its unpacked record."));
      return;
    }

    const color = gradeColor(it.grade);
    const icon = el("div", "detail-icon");
    icon.style.background = `${color}22`;
    icon.innerHTML = `<svg viewBox="0 0 24 24" stroke="${color}"><path d="M6 3h12l4 6-10 12L2 9l4-6Z"/><path d="M2 9h20M9 3l-1.5 6L12 21M15 3l1.5 6L12 21"/></svg>`;
    host.append(icon);

    const name = el("div", "detail-name");
    name.append(el("h2", null, it.name));
    if (it.grade) {
      const tag = el("span", "tag", it.grade);
      tag.style.background = `${color}22`;
      tag.style.color = color;
      name.append(tag);
    }
    host.append(name);

    const hash = marketHashName(it);
    const price = priceOf(it);
    const specs = el("div", "spec");
    [
      ["GRADE", it.grade || "—"],
      ["TYPE", TYPE_LABEL[it.type] || it.type || "—"],
      ["GEAR TYPE", it.gearType || "—"],
      ["LEVEL", it.level == null ? "—" : String(it.level)],
      ["MARKET TRADABLE", it.marketTradable ? "Yes" : "No"],
      ["LOWEST LISTING", price ? money(price) : hash ? "no listing" : "—"],
    ].forEach(([k, v]) => {
      const row = el("div", "spec-row");
      row.append(el("span", "k", k), el("span", "v", String(v)));
      specs.append(row);
    });
    host.append(specs);

    if (hash) {
      host.append(el("div", "divider"));
      const head = el("div", "sub-head");
      head.style.padding = "0";
      head.append(el("span", null, "Market hash · 上架名"));
      host.append(head);
      const chips = el("div", "chips");
      chips.append(el("span", "chip", hash));
      host.append(chips);
      const link = el("a", "link", "在 Steam 市场查看 →");
      link.href = listingUrl(hash);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      host.append(link);
    }
  }

  function renderDataGrid() {
    const grid = $("#item-grid");
    const matches = filteredDataItems();
    grid.textContent = "";

    if (!matches.length) {
      grid.append(el("p", "kpi-sub", "没有匹配的物品 · No items match these filters."));
    }

    matches.slice(0, dataView.shown).forEach((it) => {
      const card = el("button", "item");
      card.type = "button";
      if (dataView.selected && dataView.selected.id === it.id) card.classList.add("is-on");
      const swatch = el("span", "item-swatch");
      swatch.style.background = gradeColor(it.grade);
      card.append(swatch, el("span", "item-name", it.name));
      const meta = [it.grade || "—", TYPE_LABEL[it.type] || it.type || "—"];
      if (it.level != null) meta.push(`Lv ${it.level}`);
      card.append(el("span", "item-meta", meta.join(" · ")));
      card.addEventListener("click", () => {
        dataView.selected = it;
        renderDataGrid();
        renderDetail();
      });
      grid.append(card);
    });

    $("#item-count").textContent = `${matches.length.toLocaleString()} results`;
    $("#item-page").textContent = `Showing ${Math.min(dataView.shown, matches.length).toLocaleString()} of ${matches.length.toLocaleString()} items`;
    show($("#btn-more-items"), dataView.shown < matches.length);
  }

  // ---------------------------------------------------------------- market

  function marketItems() {
    const q = marketView.query.trim().toLowerCase();
    const rows = priceable().filter((it) => {
      if (marketView.grade !== "ALL" && it.grade !== marketView.grade) return false;
      if (q && !String(it.name).toLowerCase().includes(q)) return false;
      return true;
    });

    const sorters = {
      "price-desc": (a, b) => priceRank(b) - priceRank(a),
      "price-asc": (a, b) => priceRank(a) - priceRank(b),
      grade: (a, b) => gradeRank(b.grade) - gradeRank(a.grade) || String(a.name).localeCompare(String(b.name)),
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
    };
    const priceRank = (it) => {
      const p = priceOf(it);
      return p ? p.usd : -1;
    };
    return rows.sort(sorters[marketView.sort] || sorters["price-desc"]);
  }

  function renderMarket() {
    const rows = marketItems();
    renderMarketKpis();
    renderMarketBoard(rows);
    renderCoverage();
    renderCatalogCard();
  }

  function renderMarketKpis() {
    const host = $("#market-kpis");
    host.textContent = "";
    const all = priceable();
    const priced = all.filter((it) => priceOf(it));
    const ranked = priced.slice().sort((a, b) => priceOf(a).usd - priceOf(b).usd);
    const cheapest = ranked[0];
    const snap = store.prices;

    const cards = [
      {
        label: "MARKET ITEMS",
        value: all.length.toLocaleString(),
        delta: `of ${store.items.length.toLocaleString()}`,
        sub: "可交易物品 · 材料 + 传说及以上装备",
      },
      {
        label: "PRICED ITEMS",
        value: priced.length.toLocaleString(),
        delta: all.length ? `${Math.round((priced.length / all.length) * 100)}% covered` : "—",
        sub: "快照中有挂单价的物品",
      },
      cheapest
        ? {
            label: "LOWEST LISTING",
            value: money(priceOf(cheapest)),
            delta: cheapest.name,
            sub: "当前最低挂单价",
          }
        : {
            label: "LOWEST LISTING",
            value: "—",
            delta: snap ? "no listings" : "snapshot pending",
            sub: "当前最低挂单价",
          },
      {
        label: "SNAPSHOT",
        value: snap && snap.generatedUtc ? relTime(snap.generatedUtc) : "pending",
        delta: snap && store.fx && store.fx.CNY ? `1 USD = ¥${store.fx.CNY.toFixed(2)}` : "base USD",
        sub: "价格快照 · lookup-prices 每 6 小时重建",
      },
    ];

    cards.forEach((c) => host.append(kpiCard(c)));
  }

  function renderMarketBoard(rows) {
    const board = $("#market-board");
    board.textContent = "";

    const head = el("div", "tr thead");
    [["Item", "td fill"], ["Grade", "td w-110"], ["Type", "td w-110"], ["Lowest ¥", "td num w-160"], ["Updated", "td num w-140"]].forEach(
      ([label, cls]) => head.append(el("div", cls, label)),
    );
    board.append(head);

    if (!rows.length) {
      board.append(el("div", "tr", "No market items match these filters."));
      return;
    }

    rows.slice(0, marketView.shown).forEach((it) => {
      const hash = marketHashName(it);
      const price = priceOf(it);
      const row = el("div", "tr");

      const nameCell = el("div", "td name td fill");
      const line = el("div", "swatch-line");
      const swatch = el("span", "swatch-8");
      swatch.style.background = gradeColor(it.grade);
      const link = el("a", null, it.name);
      link.href = listingUrl(hash);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      line.append(swatch, link);
      nameCell.append(line);
      row.append(nameCell);

      const gradeCell = el("div", "td w-110");
      gradeCell.append(gradeChip(it.grade));
      row.append(gradeCell);

      row.append(el("div", "td w-110 mono", TYPE_LABEL[it.type] || it.type || "—"));

      const priceCell = el("div", "td num w-160", price ? money(price) : "no listing");
      priceCell.style.color = price ? "var(--gold)" : "var(--t3)";
      row.append(priceCell);

      const fetched = store.prices && store.prices.fetchedUtc ? store.prices.fetchedUtc[hash] : null;
      row.append(el("div", "td num w-140", fetched ? relTime(fetched) : "—"));

      board.append(row);
    });

    $("#market-count").textContent = `${rows.length.toLocaleString()} items`;
    $("#market-page").textContent = `Showing ${Math.min(marketView.shown, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} market items`;
    show($("#btn-more-market"), marketView.shown < rows.length);
  }

  function renderCoverage() {
    const host = $("#coverage-card");
    host.textContent = "";
    const withPrices = Boolean(store.prices);

    const head = el("div", "card-head card-head-flush");
    head.append(el("h2", "card-title", withPrices ? "Price coverage by grade" : "Market items by grade"));
    head.append(el("span", "card-title-cn", withPrices ? "各稀有度报价覆盖" : "各稀有度可交易数"));
    head.append(el("span", "mono", withPrices ? "snapshot" : "catalog"));
    host.append(head);

    const list = el("div", "cov");
    GRADE_ORDER.forEach((grade) => {
      const items = priceable().filter((it) => it.grade === grade);
      if (!items.length) return;
      const priced = items.filter((it) => priceOf(it)).length;
      // Without a snapshot every bar would read 0%, which looks broken — show
      // the real catalog share instead so the card still carries information.
      const pct = withPrices ? Math.round((priced / items.length) * 100) : 100;

      const row = el("div", "cov-row");
      row.append(el("span", "cov-name", grade));
      const bar = el("div", "bar cov-bar");
      const fill = el("div", "bar-fill");
      fill.style.width = `${pct}%`;
      fill.style.background = gradeColor(grade);
      bar.append(fill);
      row.append(bar);
      row.append(
        el("span", "cov-count", withPrices ? `${priced} / ${items.length}` : `${items.length} items`),
      );
      list.append(row);
    });
    host.append(list);
  }

  function renderCatalogCard() {
    const host = $("#catalog-card");
    host.textContent = "";
    const head = el("div", "card-head card-head-flush");
    head.append(el("h2", "card-title", "Catalog"));
    head.append(el("span", "card-title-cn", "目录构成"));
    host.append(head);

    const counts = (type) => {
      const items = store.items.filter((it) => it.type === type);
      return { total: items.length, tradable: items.filter((it) => it.marketTradable).length };
    };

    const list = el("div", "cov");
    ["MATERIAL", "GEAR", "STAGEBOX"].forEach((type) => {
      const { total, tradable } = counts(type);
      if (!total) return;
      const row = el("div", "cat-row");
      const name = el("span", "name");
      name.append(el("span", null, TYPE_LABEL[type]));
      name.append(el("span", "chip", `${tradable} tradable`));
      row.append(name, el("span", "v", total.toLocaleString()));
      list.append(row);
    });
    host.append(list);
  }

  function renderBanner() {
    const banner = $("#market-banner");
    banner.textContent = "";
    if (store.prices) {
      show(banner, false);
      return;
    }
    banner.classList.add("is-warn");
    banner.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';
    const text = el("span", "grow");
    text.append(
      document.createTextNode(
        "价格快照尚未生成，价格列暂缺；下面仍列出全部可交易物品。快照由 GitHub Actions 每 6 小时重建一次（本次已触发）。",
      ),
    );
    const link = el("a", null, "查看工作流 →");
    link.href = "https://github.com/zioon/tbh-companion/actions/workflows/lookup-prices.yml";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    text.append(link);
    banner.append(text);
    show(banner, true);
  }

  function refreshSnapshotPill() {
    const pill = $("#snapshot-pill");
    const dot = $("#snapshot-dot");
    const side = $("#side-snapshot");
    if (store.prices && store.prices.generatedUtc) {
      const text = `snapshot ${relTime(store.prices.generatedUtc)} · ${store.prices.baseCurrency || "USD"}`;
      pill.textContent = text;
      if (side) side.textContent = text;
      dot.classList.remove("dot-idle");
    } else {
      pill.textContent = "snapshot pending";
      if (side) side.textContent = "snapshot pending";
      dot.classList.add("dot-idle");
    }
  }

  // -------------------------------------------------------------- analysis

  function renderAnalysis(host) {
    host.textContent = "";

    const kpis = el("div", "kpi-row");
    SAMPLE_ANALYSIS.kpis.forEach((k) => kpis.append(kpiCard(k)));
    host.append(kpis);

    const main = el("div", "main-row");

    const rates = el("div", "card card-col");
    const ratesHead = el("div", "card-head");
    ratesHead.append(el("h2", "card-title", "Hero rates"));
    ratesHead.append(el("span", "card-title-cn", "英雄速率"));
    ratesHead.append(el("span", "mono", "sample data · 示例数据"));
    rates.append(ratesHead, el("div", "divider"));

    const table = el("div", "table");
    const thead = el("div", "tr thead");
    [["Hero", "td fill"], ["Lv", "td num w-58"], ["XP / h", "td num w-120"], ["Gold / h", "td num w-120"]].forEach(
      ([label, cls]) => thead.append(el("div", cls, label)),
    );
    table.append(thead);
    SAMPLE_ANALYSIS.rates.forEach(([name, lv, xp, gold]) => {
      const row = el("div", "tr");
      row.append(el("div", "td name td fill", name));
      row.append(el("div", "td num w-58", String(lv)));
      row.append(el("div", "td num w-120", xp));
      const goldCell = el("div", "td num w-120", gold);
      goldCell.style.color = "var(--gold)";
      row.append(goldCell);
      table.append(row);
    });
    rates.append(table, el("div", "divider"));

    const dropsHead = el("div", "sub-head");
    dropsHead.append(el("span", null, "Recent drops"), el("span", null, "最近掉落"));
    rates.append(dropsHead);
    const drops = el("div", "drops");
    SAMPLE_ANALYSIS.drops.forEach(([name, stage]) => {
      const row = el("div", "drop-row");
      row.append(el("span", null, name), el("span", "stage", stage));
      drops.append(row);
    });
    rates.append(drops);
    main.append(rates);

    const rail = el("div", "side-col");

    const chests = el("div", "card");
    const chestHead = el("div", "card-head card-head-flush");
    chestHead.append(el("h2", "card-title", "Chest timers"));
    chestHead.append(el("span", "card-title-cn", "宝箱冷却"));
    chestHead.append(el("span", "mono", "2 / 5"));
    chests.append(chestHead);
    SAMPLE_ANALYSIS.chests.forEach((c) => {
      const wrap = el("div", `timer${c.ready ? " is-ready" : ""}`);
      const top = el("div", "timer-top");
      top.append(el("span", "timer-name", c.name), el("span", "timer-count", c.count));
      const bar = el("div", "bar");
      const fill = el("div", "bar-fill");
      fill.style.width = `${c.pct}%`;
      if (!c.ready) fill.classList.add("cooling");
      bar.append(fill);
      wrap.append(top, bar);
      chests.append(wrap);
    });
    rail.append(chests);

    const trend = el("div", "card");
    const trendHead = el("div", "card-head card-head-flush");
    trendHead.append(el("h2", "card-title", "XP · last 30 min"));
    trendHead.append(el("span", "card-title-cn", "近 30 分钟"));
    trend.append(trendHead);
    const trendSvg = sparkline(SAMPLE_ANALYSIS.xpTrend, 264, 44, "#5AD17A");
    trendSvg.classList.add("spark");
    trend.append(trendSvg);
    const trendFoot = el("div", "foot-line");
    trendFoot.append(el("span", null, SAMPLE_ANALYSIS.xpPeak), el("span", null, SAMPLE_ANALYSIS.xpAvg));
    trend.append(trendFoot);
    rail.append(trend);

    const session = el("div", "card");
    const sessionHead = el("div", "card-head card-head-flush");
    sessionHead.append(el("h2", "card-title", "Session"));
    sessionHead.append(el("span", "card-title-cn", "本次会话"));
    session.append(sessionHead);
    const rows = el("div", "rows");
    SAMPLE_ANALYSIS.session.forEach(([k, v]) => {
      const row = el("div", "row-kv");
      row.append(el("span", "k", k), el("span", "v", v));
      rows.append(row);
    });
    session.append(rows);
    rail.append(session);

    main.append(rail);
    host.append(main);
  }

  function loadSample() {
    const host = $("#analysis-loaded");
    if (!host.dataset.rendered) {
      renderAnalysis(host);
      host.dataset.rendered = "1";
    }
    show($("#dropzone"), false);
    show(host, true);
    show($("#btn-reset"), true);
    $("#save-pill-text").textContent = "sample dataset · 示例数据";
    $("#save-pill .dot").classList.remove("dot-idle");
  }

  function resetAnalysis() {
    show($("#analysis-loaded"), false);
    show($("#dropzone"), true);
    show($("#btn-reset"), false);
    $("#save-pill-text").textContent = "no save loaded";
    $("#save-pill .dot").classList.add("dot-idle");
  }

  // ----------------------------------------------------------------- wiring

  function switchView(name) {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  }

  function initLanguage() {
    const root = document.documentElement;
    document.querySelectorAll(".lang-cell").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cn = btn.dataset.lang === "cn";
        root.classList.toggle("lang-cn", cn);
        root.setAttribute("lang", cn ? "zh-CN" : "en");
        document.querySelectorAll(".lang-cell").forEach((b) => b.classList.toggle("is-on", b === btn));
      });
    });
  }

  function initNavigation() {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });
    document.querySelectorAll("[data-goto]").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.goto));
    });
  }

  function initDataControls() {
    document.querySelectorAll(".seg-cell").forEach((btn) => {
      btn.addEventListener("click", () => {
        dataView.type = btn.dataset.type;
        dataView.shown = PAGE_SIZE;
        document.querySelectorAll(".seg-cell").forEach((b) => b.classList.toggle("is-on", b === btn));
        renderDataGrid();
      });
    });

    $("#item-search").addEventListener("input", (e) => {
      dataView.query = e.target.value;
      dataView.shown = PAGE_SIZE;
      renderDataGrid();
    });

    $("#rarity-filter").addEventListener("change", (e) => {
      dataView.grade = e.target.value;
      dataView.shown = PAGE_SIZE;
      renderDataGrid();
    });

    $("#tradable-only").addEventListener("change", (e) => {
      dataView.tradableOnly = e.target.checked;
      dataView.shown = PAGE_SIZE;
      renderDataGrid();
    });

    $("#btn-more-items").addEventListener("click", () => {
      dataView.shown += PAGE_SIZE;
      renderDataGrid();
    });

    $("#btn-export-json").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(filteredDataItems(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tbh-items.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function initMarketControls() {
    $("#market-search").addEventListener("input", (e) => {
      marketView.query = e.target.value;
      marketView.shown = PAGE_SIZE;
      renderMarketBoard(marketItems());
    });

    $("#market-grade").addEventListener("change", (e) => {
      marketView.grade = e.target.value;
      marketView.shown = PAGE_SIZE;
      renderMarketBoard(marketItems());
    });

    $("#market-sort").addEventListener("change", (e) => {
      marketView.sort = e.target.value;
      marketView.shown = PAGE_SIZE;
      renderMarketBoard(marketItems());
    });

    $("#btn-more-market").addEventListener("click", () => {
      marketView.shown += PAGE_SIZE;
      renderMarketBoard(marketItems());
    });

    $("#btn-refresh-prices").addEventListener("click", async () => {
      $("#snapshot-pill").textContent = "refreshing…";
      await loadPrices(true);
      renderMarket();
      renderBanner();
      refreshSnapshotPill();
      renderDetail();
    });
  }

  function initAnalysis() {
    const zone = $("#dropzone");
    const notice = el("p", "dz-hint");
    notice.style.color = "var(--accent)";

    ["dragenter", "dragover"].forEach((type) =>
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.classList.add("is-over");
      }),
    );
    ["dragleave", "drop"].forEach((type) => zone.addEventListener(type, () => zone.classList.remove("is-over")));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const kb = Math.max(1, Math.round(file.size / 1024));
      notice.textContent = `已识别 ${file.name}（${kb} KB）。本页是界面预览，实际解密请打开存档浏览器。`;
      const anchor = $(".dz-alt");
      if (!notice.isConnected) zone.insertBefore(notice, anchor);
      show(notice, true);
    });

    $("#btn-sample").addEventListener("click", loadSample);
    $("#btn-reset").addEventListener("click", resetAnalysis);
  }

  // ------------------------------------------------------------------- boot

  async function loadCatalog() {
    const res = await fetch("./data/gamedata.json", { cache: "force-cache" });
    if (!res.ok) throw new Error(`gamedata HTTP ${res.status}`);
    const json = await res.json();
    store.items = Array.isArray(json.items) ? json.items : [];

    const label = `v${json.gameVersion || "—"} · ${store.items.length.toLocaleString()} items`;
    $("#data-version").textContent = label;
    $("#side-version").textContent = label;

    gradedOptions($("#rarity-filter"), "所有稀有度 · All grades");
    gradedOptions($("#market-grade"), "所有稀有度 · All grades");

    dataView.selected = store.items[0] || null;
    store.catalogReady = true;
  }

  async function loadPrices(force) {
    try {
      const res = await fetch("./data/prices.json", force ? { cache: "reload" } : { cache: "no-cache" });
      if (!res.ok) throw new Error(`prices HTTP ${res.status}`);
      const json = await res.json();
      store.prices = json;
      store.fx = json.fx || null;
      return true;
    } catch {
      store.prices = null;
      store.fx = null;
      return false;
    }
  }

  async function boot() {
    initLanguage();
    initNavigation();
    initDataControls();
    initMarketControls();
    initAnalysis();

    try {
      await loadCatalog();
      await loadPrices(false);

      renderDataGrid();
      renderDetail();
      renderMarket();
      renderBanner();
      refreshSnapshotPill();
    } catch (err) {
      const message = `Could not load the unpacked catalog (${err.message}). Serve this page over HTTP — e.g. python -m http.server — then reload.`;
      $("#data-version").textContent = "catalog unavailable";
      $("#item-grid").append(el("p", "kpi-sub", message));
      $("#market-kpis").append(el("p", "kpi-sub", message));
    }
  }

  boot();
})();
