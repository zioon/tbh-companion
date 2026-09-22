/* TBH Companion web tool — shell behaviour.
 *
 * Mirrors the desktop app's five user-facing tabs:
 *   Home · Inventory · Chests · Lookup · Trading
 *
 * Data files (all same-origin, no save file required):
 *   ./data/gamedata.json     unpacked item catalog      (1,954 items)
 *   ./data/stage_boxes.json  chest catalog + drop stages (140 boxes)
 *   ./data/prices.json       Steam listed-price snapshot (staged by CI)
 *
 * Inventory and the Home live stats are save-derived — the desktop app reads
 * the .es3 on a timer. The web build cannot touch the disk, so those two show
 * a correctly-shaped sample set, clearly labelled, until the real decrypted
 * save is wired in (./inspector/ does that decryption today).
 *
 * Market hashes must match app/src/core/marketName.ts exactly:
 *   materials -> the item name
 *   gear      -> "<name> (<Grade>) A", priced only at Legendary and above
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------- tokens

  /** Ascending rarity, mirrors app/src/core/grades.ts GRADE_ORDER. */
  const GRADE_ORDER = ["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "IMMORTAL", "ARCANA", "BEYOND", "CELESTIAL", "DIVINE", "COSMIC"];

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

  /** Mirrors inventory.json `location`. */
  const LOCATION_LABEL = {
    inventory: "Inv",
    stash: "St",
    trading: "Tr",
    equipped: "Eq",
  };
  const LOCATIONS = ["inventory", "stash", "trading", "equipped"];

  /** Mirrors app/src/core/heroes.ts HERO_NAMES. */
  const HEROES = [
    ["Knight", 101],
    ["Ranger", 201],
    ["Sorcerer", 301],
    ["Priest", 401],
    ["Hunter", 501],
    ["Slayer", 601],
  ];

  const APP_ID = 3678970;
  const SAVE_PATH = "%USERPROFILE%\\AppData\\LocalLow\\TesseractStudio\\TaskBarHero\\";
  const PAGE_SIZE = 24;
  const MIN_PRICEABLE_GEAR_RANK = GRADE_ORDER.indexOf("LEGENDARY");

  const SAMPLE_HOME = {
    kpis: [
      { label: "XP / HR", value: "1.24M", delta: "+6.2%", deltaClass: "good", sub: "经验 / 小时" },
      { label: "GOLD / HR", value: "38.4K", delta: "+2.1%", deltaClass: "good", sub: "金币 / 小时" },
      { label: "SESSION XP", value: "2.78M", delta: "2h 14m", deltaClass: "", sub: "本次会话经验" },
      { label: "SESSION GOLD", value: "86.1K", delta: "+12 lv", deltaClass: "good", sub: "本次会话金币" },
    ],
    rates: [
      ["Knight", 42, "412K", "8.2M", "19h 40m"],
      ["Ranger", 38, "336K", "6.1M", "18h 05m"],
      ["Sorcerer", 35, "268K", "5.4M", "20h 10m"],
      ["Priest", 31, "142K", "2.9M", "20h 25m"],
      ["Hunter", 27, "64K", "1.1M", "17h 10m"],
      ["Slayer", 24, "38K", "0.7M", "18h 25m"],
    ],
    history: [
      ["14:02:11", "+186K", "Stage 03"],
      ["13:58:40", "+174K", "Stage 03"],
      ["13:55:02", "+191K", "Stage 03"],
      ["13:51:33", "+168K", "Stage 07"],
    ],
  };

  // --------------------------------------------------------------- helpers

  const $ = (sel, root = document) => root.querySelector(sel);

  /** Show/hide without fighting the stylesheet's `display` values.
   *  The `hidden` attribute has to be cleared too: `[hidden]{display:none!important}`
   *  outranks an inline `display:""`, so setting the style alone never reveals it. */
  function show(node, on) {
    if (!node) return;
    node.hidden = !on;
    node.style.display = on ? "" : "none";
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
    if (item.type === "GEAR" && isPriceableGrade(item.grade)) return `${item.name} (${gradeTitle(item.grade)}) A`;
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

  function fillTable(table, columns, rows) {
    table.textContent = "";
    const head = el("div", "tr thead");
    columns.forEach(([label, cls]) => head.append(el("div", cls, label)));
    table.append(head);
    if (!rows.length) {
      table.append(el("div", "tr", "No rows match these filters."));
      return;
    }
    rows.forEach((cells) => {
      const row = el("div", "tr");
      cells.forEach(({ node, cls, color }) => {
        const cell = cls === null ? node : el("div", cls);
        if (cls !== null) cell.append(node);
        if (color) cell.style.color = color;
        row.append(cell);
      });
      table.append(row);
    });
  }

  // ------------------------------------------------------------------ state

  const store = { items: [], chests: [], chestMeta: null, prices: null, fx: null, sample: false };

  const lookupView = { type: "ALL", grade: "ALL", query: "", tradableOnly: false, shown: PAGE_SIZE, selected: null };
  const tradingView = { grade: "ALL", query: "", sort: "price-desc", shown: PAGE_SIZE };
  const invView = { grade: "ALL", type: "ALL", location: "ALL", query: "", tradableOnly: false, shown: PAGE_SIZE };
  const chestView = { grade: "ALL", level: "ALL", query: "", shown: PAGE_SIZE };

  const priceable = () => store.items.filter((it) => marketHashName(it) != null);

  function priceOf(item) {
    if (!store.prices) return null;
    const hash = marketHashName(item);
    if (!hash) return null;
    const usd = store.prices.prices ? store.prices.prices[hash] : null;
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

  // ------------------------------------------------------------- Home view

  /** Sample inventory rows, derived from the real catalog (deterministic). */
  function sampleInventory() {
    const buckets = {};
    const picked = [];
    for (const it of store.items) {
      if (it.type !== "MATERIAL" && it.type !== "GEAR") continue;
      if (!it.grade) continue;
      const bucket = (buckets[it.grade] = buckets[it.grade] || { MATERIAL: 0, GEAR: 0 });
      const cap = it.type === "MATERIAL" ? 2 : 1;
      if (bucket[it.type] >= cap) continue;
      bucket[it.type] += 1;
      picked.push(it);
      if (picked.length >= 18) break;
    }
    return picked.map((item, i) => ({
      item,
      count: 1 + ((i * 7) % 24),
      location: LOCATIONS[i % LOCATIONS.length],
    }));
  }

  function sampleChests() {
    const picked = store.chests.filter((c) => c.tracker && c.tracker.canonical).slice(0, 5);
    return picked.map((c, i) => ({ chest: c, count: 1 + ((i * 3) % 9) }));
  }

  function renderHome(host) {
    host.textContent = "";

    const status = el("div", "card");
    const statusHead = el("div", "card-head card-head-flush");
    statusHead.append(el("h2", "card-title", "Save status"));
    statusHead.append(el("span", "card-title-cn", "存档状态"));
    statusHead.append(el("span", "mono", "sample dataset · 示例数据"));
    status.append(statusHead);
    const statusRows = el("div", "rows");
    [
      ["Save file", "save.es3 · 1.21 MB"],
      ["Save written", "2m ago"],
      ["Path", SAVE_PATH],
      ["Mode", "Sample — the web build does not read your disk"],
    ].forEach(([k, v]) => {
      const row = el("div", "row-kv");
      row.append(el("span", "k", k));
      const val = el("span", "v", v);
      if (k === "Path") val.style.fontSize = "10px";
      row.append(val);
      statusRows.append(row);
    });
    status.append(statusRows);
    host.append(status);

    const kpis = el("div", "kpi-row");
    SAMPLE_HOME.kpis.forEach((k) => kpis.append(kpiCard(k)));
    host.append(kpis);

    const main = el("div", "main-row");

    const rates = el("div", "card card-col");
    const ratesHead = el("div", "card-head");
    ratesHead.append(el("h2", "card-title", "Heroes"));
    ratesHead.append(el("span", "card-title-cn", "英雄"));
    ratesHead.append(el("span", "mono", "rate · remaining · eta"));
    rates.append(ratesHead, el("div", "divider"));
    const heroTable = el("div", "table");
    fillTable(
      heroTable,
      [
        ["Name", "td fill"],
        ["Lv", "td num w-58"],
        ["Rate", "td num w-110"],
        ["Remaining", "td num w-110"],
        ["ETA", "td num w-110"],
      ],
      SAMPLE_HOME.rates.map(([name, lv, rate, remaining, eta]) => [
        { node: el("span", null, name), cls: "td name td fill" },
        { node: el("span", null, String(lv)), cls: "td num w-58" },
        { node: el("span", null, rate), cls: "td num w-110" },
        { node: el("span", null, remaining), cls: "td num w-110" },
        { node: el("span", null, eta), cls: "td num w-110" },
      ]),
    );
    rates.append(heroTable);
    main.append(rates);

    const rail = el("div", "side-col");

    const history = el("div", "card");
    const historyHead = el("div", "card-head card-head-flush");
    historyHead.append(el("h2", "card-title", "History"));
    historyHead.append(el("span", "card-title-cn", "经验变化"));
    history.append(historyHead);
    const historyRows = el("div", "drops");
    SAMPLE_HOME.history.forEach(([time, xp, stage]) => {
      const row = el("div", "drop-row");
      row.style.padding = "0";
      row.append(el("span", "mono", time), el("span", "mono", xp), el("span", "stage", stage));
      historyRows.append(row);
    });
    history.append(historyRows);
    rail.append(history);

    const pathCard = el("div", "card");
    const pathHead = el("div", "card-head card-head-flush");
    pathHead.append(el("h2", "card-title", "Save path"));
    pathHead.append(el("span", "card-title-cn", "存档路径"));
    pathCard.append(pathHead);
    const pathBlock = el("div", "pathblock");
    pathBlock.append(el("span", "mono", SAVE_PATH));
    pathCard.append(pathBlock);
    pathCard.append(
      el("p", "kpi-sub", "桌面版按存档写入时间刷新；网页版需你手动选文件后在浏览器内解密。"),
    );
    rail.append(pathCard);

    main.append(rail);
    host.append(main);
  }

  // -------------------------------------------------------- Inventory view

  function invRows() {
    const q = invView.query.trim().toLowerCase();
    return sampleInventory().filter(({ item, location }) => {
      if (invView.grade !== "ALL" && item.grade !== invView.grade) return false;
      if (invView.type !== "ALL" && item.type !== invView.type) return false;
      if (invView.location !== "ALL" && location !== invView.location) return false;
      if (invView.tradableOnly && !item.marketTradable) return false;
      if (q && !String(item.name).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderInventory() {
    if (!store.sample) {
      show($("#inventory-body"), false);
      show($("#inventory-empty"), true);
      $("#inv-source").textContent = "no save";
      $("#inv-dot").classList.add("dot-idle");
      return;
    }
    show($("#inventory-empty"), false);
    show($("#inventory-body"), true);
    $("#inv-source").textContent = "sample dataset · 示例数据";
    $("#inv-dot").classList.remove("dot-idle");

    const rows = invRows();

    let listValue = 0;
    let priced = 0;
    let units = 0;
    rows.forEach(({ item, count }) => {
      const p = priceOf(item);
      units += count;
      if (p) {
        priced += 1;
        const per = p.cny != null ? p.cny : p.usd;
        listValue += per * count;
      }
    });

    const summary = $("#inv-summary");
    summary.textContent = "";
    const currency = store.fx && store.fx.CNY ? "¥" : "$";
    [
      { label: "ITEMS", value: rows.length.toLocaleString(), delta: `${units.toLocaleString()} units`, sub: "物品行数 / 总件数" },
      { label: "PRICED", value: priced.toLocaleString(), delta: `of ${rows.length}`, sub: "有 Steam 挂单价的物品" },
      { label: "MARKET VALUE", value: `${currency}${listValue.toFixed(2)}`, delta: "list value", sub: "按挂单价计算的总值" },
      { label: "SOURCES", value: `${new Set(rows.map((r) => r.location)).size}`, delta: "locations", sub: "背包 / 仓库 / 交易栏 / 已装备" },
    ].forEach((k) => summary.append(kpiCard(k)));

    const table = $("#inv-table");
    fillTable(
      table,
      [
        ["Name", "td fill"],
        ["Grade", "td w-110"],
        ["Lv", "td num w-58"],
        ["Count", "td num w-70"],
        ["Location", "td w-110"],
        ["Market price", "td num w-140"],
        ["Market total", "td num w-150"],
      ],
      rows.slice(0, invView.shown).map(({ item, count, location }) => {
        const p = priceOf(item);
        const per = p ? (p.cny != null ? p.cny : p.usd) : null;
        return [
          { node: el("span", null, item.name), cls: "td name td fill" },
          { node: gradeChip(item.grade), cls: "td w-110" },
          { node: el("span", null, item.level == null ? "—" : String(item.level)), cls: "td num w-58" },
          { node: el("span", null, `×${count}`), cls: "td num w-70" },
          { node: el("span", null, LOCATION_LABEL[location] || "?"), cls: "td w-110" },
          {
            node: el("span", null, per == null ? "—" : `${currency}${per.toFixed(2)}`),
            cls: "td num w-140",
            color: per == null ? "var(--t3)" : undefined,
          },
          {
            node: el("span", null, per == null ? "—" : `${currency}${(per * count).toFixed(2)}`),
            cls: "td num w-150",
            color: per == null ? "var(--t3)" : "var(--gold)",
          },
        ];
      }),
    );

    $("#inv-count").textContent = `${rows.length} items`;
    $("#inv-page").textContent = `Showing ${Math.min(invView.shown, rows.length)} of ${rows.length} rows`;
    show($("#btn-more-inv"), invView.shown < rows.length);
  }

  // ----------------------------------------------------------- Chests view

  function chestRows() {
    const q = chestView.query.trim().toLowerCase();
    return store.chests.filter((c) => {
      if (chestView.grade !== "ALL" && c.grade !== chestView.grade) return false;
      if (chestView.level !== "ALL" && String(c.level) !== chestView.level) return false;
      if (q && !String(c.name).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderChests() {
    const all = store.chests;
    const obtainable = all.filter((c) => c.obtainable);
    const levels = new Set(all.map((c) => c.level).filter((l) => l != null));
    const cooldownSeconds = store.chestMeta ? store.chestMeta.defaultCooldownSeconds : null;

    if (cooldownSeconds != null) {
      $("#chest-cooldown").textContent = `cooldown ${Math.round(cooldownSeconds / 60)} min`;
    }

    const held = store.sample ? sampleChests() : [];
    const heldUnits = held.reduce((sum, h) => sum + h.count, 0);

    const kpis = $("#chest-kpis");
    kpis.textContent = "";
    [
      { label: "CHEST CATALOG", value: all.length.toLocaleString(), delta: `${obtainable.length} obtainable`, sub: "宝箱图鉴条目" },
      { label: "LEVELS", value: String(levels.size), delta: "distinct", sub: "掉落等级数" },
      {
        label: "DEFAULT COOLDOWN",
        value: cooldownSeconds != null ? `${Math.round(cooldownSeconds / 60)}m` : "—",
        delta: "per chest",
        sub: "默认冷却（可由符文缩短）",
      },
      store.sample
        ? { label: "HELD CHESTS", value: heldUnits.toLocaleString(), delta: `${held.length} kinds`, sub: "存档中持有的宝箱" }
        : { label: "HELD CHESTS", value: "—", delta: "needs a save", sub: "需要存档才能统计" },
    ].forEach((k) => kpis.append(kpiCard(k)));

    fillTable(
      $("#chest-table"),
      [
        ["Chest", "td fill"],
        ["Grade", "td w-120"],
        ["Lv", "td num w-70"],
        ["Drops at", "td fill"],
        store.sample ? ["Held", "td num w-80"] : ["Held", "td num w-80"],
      ],
      chestRows()
        .slice(0, chestView.shown)
        .map((c) => {
          const heldCount = held.find((h) => h.chest.id === c.id);
          const cells = [
            { node: el("span", null, c.name), cls: "td name td fill" },
            { node: gradeChip(c.grade), cls: "td w-120" },
            { node: el("span", null, c.level == null ? "—" : String(c.level)), cls: "td num w-70" },
            {
              node: el("span", "mono", (c.tracker && c.tracker.dropStageRangeLabel) || "—"),
              cls: "td fill",
            },
            {
              node: el("span", null, heldCount ? `×${heldCount.count}` : "—"),
              cls: "td num w-80",
              color: heldCount ? "var(--accent)" : "var(--t3)",
            },
          ];
          return cells;
        }),
    );

    const rows = chestRows();
    $("#chest-count").textContent = `${rows.length} chests`;
    $("#chest-page").textContent = `Showing ${Math.min(chestView.shown, rows.length)} of ${rows.length} chests · ${store.sample ? "held counts are sample data" : "held counts need a save"}`;
    show($("#btn-more-chest"), chestView.shown < rows.length);
    $("#chest-source").textContent = store.sample ? "sample dataset · 示例数据" : "catalog only · 仅目录";
    if (store.sample) $("#chest-dot").classList.remove("dot-idle");
    else $("#chest-dot").classList.add("dot-idle");
  }

  // ----------------------------------------------------------- Lookup view

  function filledGrades(select, label) {
    const present = new Set(store.items.map((it) => it.grade).filter(Boolean));
    const grades = GRADE_ORDER.filter((g) => present.has(g));
    const extras = Array.from(present).filter((g) => !grades.includes(g));
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

  function lookupRows() {
    const q = lookupView.query.trim().toLowerCase();
    return store.items.filter((it) => {
      if (lookupView.type !== "ALL" && it.type !== lookupView.type) return false;
      if (lookupView.grade !== "ALL" && it.grade !== lookupView.grade) return false;
      if (lookupView.tradableOnly && !it.marketTradable) return false;
      if (q && !String(it.name).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderLookupDetail() {
    const host = $("#item-detail");
    host.textContent = "";
    const it = lookupView.selected;
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
      ["TYPE", it.type || "—"],
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

  function renderLookupGrid() {
    const grid = $("#item-grid");
    const matches = lookupRows();
    grid.textContent = "";

    if (!matches.length) grid.append(el("p", "kpi-sub", "没有匹配的物品 · No items match these filters."));

    matches.slice(0, lookupView.shown).forEach((it) => {
      const card = el("button", "item");
      card.type = "button";
      if (lookupView.selected && lookupView.selected.id === it.id) card.classList.add("is-on");
      const swatch = el("span", "item-swatch");
      swatch.style.background = gradeColor(it.grade);
      card.append(swatch, el("span", "item-name", it.name));
      const meta = [it.grade || "—", it.type || "—"];
      if (it.level != null) meta.push(`Lv ${it.level}`);
      card.append(el("span", "item-meta", meta.join(" · ")));
      card.addEventListener("click", () => {
        lookupView.selected = it;
        renderLookupGrid();
        renderLookupDetail();
      });
      grid.append(card);
    });

    $("#item-count").textContent = `${matches.length.toLocaleString()} results`;
    $("#item-page").textContent = `Showing ${Math.min(lookupView.shown, matches.length).toLocaleString()} of ${matches.length.toLocaleString()} items`;
    show($("#btn-more-items"), lookupView.shown < matches.length);
  }

  // ---------------------------------------------------------- Trading view

  function tradingRows() {
    const q = tradingView.query.trim().toLowerCase();
    const priceRank = (it) => {
      const p = priceOf(it);
      return p ? p.usd : -1;
    };
    const sorters = {
      "price-desc": (a, b) => priceRank(b) - priceRank(a),
      "price-asc": (a, b) => priceRank(a) - priceRank(b),
      grade: (a, b) => gradeRank(b.grade) - gradeRank(a.grade) || String(a.name).localeCompare(String(b.name)),
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
    };
    return priceable()
      .filter((it) => {
        if (tradingView.grade !== "ALL" && it.grade !== tradingView.grade) return false;
        if (q && !String(it.name).toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(sorters[tradingView.sort] || sorters["price-desc"]);
  }

  function renderTrading() {
    const rows = tradingRows();
    renderTradingKpis();
    renderTradingBoard(rows);
    renderCoverage();
    renderCatalogCard();
  }

  function renderTradingKpis() {
    const host = $("#market-kpis");
    host.textContent = "";
    const all = priceable();
    const priced = all.filter((it) => priceOf(it));
    const ranked = priced.slice().sort((a, b) => priceOf(a).usd - priceOf(b).usd);
    const cheapest = ranked[0];
    const snap = store.prices;

    [
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
        ? { label: "LOWEST LISTING", value: money(priceOf(cheapest)), delta: cheapest.name, sub: "当前最低挂单价" }
        : { label: "LOWEST LISTING", value: "—", delta: snap ? "no listings" : "snapshot pending", sub: "当前最低挂单价" },
      {
        label: "SNAPSHOT",
        value: snap && snap.generatedUtc ? relTime(snap.generatedUtc) : "pending",
        delta: store.fx && store.fx.CNY ? `1 USD = ¥${store.fx.CNY.toFixed(2)}` : "base USD",
        sub: "价格快照 · lookup-prices 每 6 小时重建",
      },
    ].forEach((c) => host.append(kpiCard(c)));
  }

  function renderTradingBoard(rows) {
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

    rows.slice(0, tradingView.shown).forEach((it) => {
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
      row.append(el("div", "td w-110 mono", it.type || "—"));

      const priceCell = el("div", "td num w-160", price ? money(price) : "no listing");
      priceCell.style.color = price ? "var(--gold)" : "var(--t3)";
      row.append(priceCell);

      const fetched = store.prices && store.prices.fetchedUtc ? store.prices.fetchedUtc[hash] : null;
      row.append(el("div", "td num w-140", fetched ? relTime(fetched) : "—"));
      board.append(row);
    });

    $("#market-count").textContent = `${rows.length.toLocaleString()} items`;
    $("#market-page").textContent = `Showing ${Math.min(tradingView.shown, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} market items`;
    show($("#btn-more-market"), tradingView.shown < rows.length);
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
      const pct = withPrices ? Math.round((priced / items.length) * 100) : 100;
      const row = el("div", "cov-row");
      row.append(el("span", "cov-name", grade));
      const bar = el("div", "bar cov-bar");
      const fill = el("div", "bar-fill");
      fill.style.width = `${pct}%`;
      fill.style.background = gradeColor(grade);
      bar.append(fill);
      row.append(bar);
      row.append(el("span", "cov-count", withPrices ? `${priced} / ${items.length}` : `${items.length} items`));
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

    const list = el("div", "cov");
    ["MATERIAL", "GEAR", "STAGEBOX"].forEach((type) => {
      const items = store.items.filter((it) => it.type === type);
      if (!items.length) return;
      const tradable = items.filter((it) => it.marketTradable).length;
      const row = el("div", "cat-row");
      const name = el("span", "name");
      name.append(el("span", null, type));
      name.append(el("span", "chip", `${tradable} tradable`));
      row.append(name, el("span", "v", items.length.toLocaleString()));
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
      document.createTextNode("价格快照尚未生成，价格列暂缺；下面仍列出全部可交易物品。快照由 GitHub Actions 每 6 小时重建。"),
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
    const text = store.prices && store.prices.generatedUtc ? `snapshot ${relTime(store.prices.generatedUtc)}` : "snapshot pending";
    $("#snapshot-pill").textContent = text;
    $("#side-snapshot").textContent = text;
    $("#snapshot-dot").classList.toggle("dot-idle", !store.prices);
  }

  // ----------------------------------------------------------------- wiring

  function switchView(name) {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  }

  function setSample(on) {
    store.sample = on;
    show($("#home-empty"), !on);
    show($("#home-loaded"), on);
    show($("#btn-reset"), on);
    $("#save-pill-text").textContent = on ? "sample dataset · 示例数据" : "no save loaded";
    $("#save-pill .dot").classList.toggle("dot-idle", !on);

    if (on) {
      const host = $("#home-loaded");
      if (!host.dataset.rendered) {
        renderHome(host);
        host.dataset.rendered = "1";
      }
    }
    renderInventory();
    renderChests();
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

  function initLookupControls() {
    document.querySelectorAll(".seg-cell").forEach((btn) => {
      btn.addEventListener("click", () => {
        lookupView.type = btn.dataset.type;
        lookupView.shown = PAGE_SIZE;
        document.querySelectorAll(".seg-cell").forEach((b) => b.classList.toggle("is-on", b === btn));
        renderLookupGrid();
      });
    });
    $("#item-search").addEventListener("input", (e) => {
      lookupView.query = e.target.value;
      lookupView.shown = PAGE_SIZE;
      renderLookupGrid();
    });
    $("#rarity-filter").addEventListener("change", (e) => {
      lookupView.grade = e.target.value;
      lookupView.shown = PAGE_SIZE;
      renderLookupGrid();
    });
    $("#tradable-only").addEventListener("change", (e) => {
      lookupView.tradableOnly = e.target.checked;
      lookupView.shown = PAGE_SIZE;
      renderLookupGrid();
    });
    $("#btn-more-items").addEventListener("click", () => {
      lookupView.shown += PAGE_SIZE;
      renderLookupGrid();
    });
    $("#btn-export-json").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(lookupRows(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tbh-items.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function initInventoryControls() {
    $("#inv-search").addEventListener("input", (e) => {
      invView.query = e.target.value;
      invView.shown = PAGE_SIZE;
      renderInventory();
    });
    $("#inv-grade").addEventListener("change", (e) => {
      invView.grade = e.target.value;
      renderInventory();
    });
    $("#inv-type").addEventListener("change", (e) => {
      invView.type = e.target.value;
      renderInventory();
    });
    $("#inv-location").addEventListener("change", (e) => {
      invView.location = e.target.value;
      renderInventory();
    });
    $("#inv-tradable").addEventListener("change", (e) => {
      invView.tradableOnly = e.target.checked;
      renderInventory();
    });
    $("#btn-more-inv").addEventListener("click", () => {
      invView.shown += PAGE_SIZE;
      renderInventory();
    });
    $("#btn-sample-inv").addEventListener("click", () => {
      switchView("home");
      setSample(true);
    });
    $("#btn-export-inventory").addEventListener("click", () => {
      const rows = invRows().map(({ item, count, location }) => {
        const p = priceOf(item);
        return { name: item.name, grade: item.grade, type: item.type, level: item.level, count, location, lowestUsd: p ? p.usd : null };
      });
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tbh-inventory.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function initChestControls() {
    $("#chest-search").addEventListener("input", (e) => {
      chestView.query = e.target.value;
      chestView.shown = PAGE_SIZE;
      renderChests();
    });
    $("#chest-grade").addEventListener("change", (e) => {
      chestView.grade = e.target.value;
      chestView.shown = PAGE_SIZE;
      renderChests();
    });
    $("#chest-level").addEventListener("change", (e) => {
      chestView.level = e.target.value;
      chestView.shown = PAGE_SIZE;
      renderChests();
    });
    $("#btn-more-chest").addEventListener("click", () => {
      chestView.shown += PAGE_SIZE;
      renderChests();
    });
  }

  function initTradingControls() {
    $("#market-search").addEventListener("input", (e) => {
      tradingView.query = e.target.value;
      tradingView.shown = PAGE_SIZE;
      renderTradingBoard(tradingRows());
    });
    $("#market-grade").addEventListener("change", (e) => {
      tradingView.grade = e.target.value;
      tradingView.shown = PAGE_SIZE;
      renderTradingBoard(tradingRows());
    });
    $("#market-sort").addEventListener("change", (e) => {
      tradingView.sort = e.target.value;
      tradingView.shown = PAGE_SIZE;
      renderTradingBoard(tradingRows());
    });
    $("#btn-more-market").addEventListener("click", () => {
      tradingView.shown += PAGE_SIZE;
      renderTradingBoard(tradingRows());
    });
    $("#btn-refresh-prices").addEventListener("click", async () => {
      $("#snapshot-pill").textContent = "refreshing…";
      await loadPrices(true);
      renderTrading();
      renderBanner();
      refreshSnapshotPill();
      renderLookupDetail();
      renderInventory();
      renderChests();
    });
  }

  function initHome() {
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

    $("#btn-sample").addEventListener("click", () => setSample(true));
    $("#btn-reset").addEventListener("click", () => setSample(false));
    $("#btn-copy-path").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(SAVE_PATH);
        $("#btn-copy-path").textContent = "已复制 ✓";
      } catch {
        $("#btn-copy-path").textContent = "复制失败";
      }
    });
  }

  // ------------------------------------------------------------------- boot

  async function loadCatalog() {
    const res = await fetch("./data/gamedata.json", { cache: "force-cache" });
    if (!res.ok) throw new Error(`gamedata HTTP ${res.status}`);
    const json = await res.json();
    store.items = Array.isArray(json.items) ? json.items : [];
    const label = `catalog v${json.gameVersion || "—"} · ${store.items.length.toLocaleString()} items`;
    $("#data-version").textContent = `v${json.gameVersion || "—"} · ${store.items.length.toLocaleString()} items`;
    $("#side-version").textContent = label;
    filledGrades($("#rarity-filter"), "所有稀有度 · All grades");
    filledGrades($("#inv-grade"), "所有稀有度 · All grades");
    filledGrades($("#chest-grade"), "所有稀有度 · All grades");
    lookupView.selected = store.items[0] || null;
    const link = $('[data-goto="lookup"]');
    if (link) link.textContent = `浏览 ${store.items.length.toLocaleString()} 件物品`;
  }

  async function loadChests() {
    const res = await fetch("./data/stage_boxes.json", { cache: "force-cache" });
    if (!res.ok) throw new Error(`stage_boxes HTTP ${res.status}`);
    const json = await res.json();
    store.chests = Array.isArray(json.items) ? json.items : [];
    store.chestMeta = json;
    $("#side-chests").textContent = `${store.chests.length} chests`;

    const levels = Array.from(new Set(store.chests.map((c) => c.level).filter((l) => l != null))).sort((a, b) => a - b);
    const select = $("#chest-level");
    levels.forEach((lv) => {
      const opt = document.createElement("option");
      opt.value = String(lv);
      opt.textContent = `Lv ${lv}`;
      select.append(opt);
    });
    const link = $('[data-goto="chests"]');
    if (link) link.textContent = `查看 ${store.chests.length} 个宝箱`;
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
    initLookupControls();
    initInventoryControls();
    initChestControls();
    initTradingControls();
    initHome();

    try {
      await loadCatalog();
      await loadChests();
      await loadPrices(false);

      renderLookupGrid();
      renderLookupDetail();
      renderTrading();
      renderBanner();
      refreshSnapshotPill();
      setSample(false);
    } catch (err) {
      const message = `Could not load the bundled data (${err.message}). Serve this page over HTTP — e.g. python -m http.server — then reload.`;
      $("#data-version").textContent = "catalog unavailable";
      $("#item-grid").append(el("p", "kpi-sub", message));
      $("#chest-table").append(el("p", "kpi-sub", message));
    }
  }

  boot();
})();
