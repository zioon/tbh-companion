/**
 * 从 Lookup price snapshot 生成 Market price cache 文件。
 * 
 * 用途：当无法直连 Steam API（steamcommunity.com）时，
 * 用 GitHub Actions 预构建的 Lookup 价格快照来填充市场缓存。
 * 
 * 用法：node scripts/seed-market-prices.mjs
 * 输出：prices.USD.json (放入 Electron userData 目录即可)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");

// ── 读取 Lookup snapshot ──
const snapshotPath = join(appDir, "lookup_prices.json");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));

const { prices: lookupPrices, fx, baseCurrency, generatedUtc } = snapshot;

// ── 生成各币种的 Market cache ──
for (const [currency, rate] of Object.entries(fx)) {
  const cache = {
    currency,
    fetchedUtc: generatedUtc,
    prices: {},
  };

  for (const [itemName, usdPrice] of Object.entries(lookupPrices)) {
    const localPrice = typeof usdPrice === "number" ? Math.round(usdPrice * rate * 100) / 100 : null;
    
    cache.prices[itemName] = {
      lowest: localPrice,
      median: null,
      volume: 0,
      rawLowest: localPrice != null 
        ? formatCurrency(localPrice, currency)
        : null,
      rawMedian: null,
      fetchedUtc: generatedUtc,
      buyOrder: null,
      rawBuyOrder: null,
      buyOrderQuantity: null,
      buyOrderLevels: null,
      buyOrderFetched: false,
      buyOrderCheckUtc: null,
    };
  }

  const outPath = join(appDir, `prices.${currency}.json`);
  writeFileSync(outPath, JSON.stringify(cache, null, 2));
  console.log(`✓ Generated ${outPath} (${Object.keys(cache.prices).length} items, fx=${rate})`);
}

// ── 辅助：格式化金额字符串 ──
function formatCurrency(amount, currency) {
  const symbols = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥",
    BRL: "R$", CAD: "CA$", AUD: "A$", KRW: "₩", INR: "₹",
  };
  const sym = symbols[currency] || currency + " ";
  
  if (["JPY", "KRW"].includes(currency)) {
    return sym + Math.round(amount).toLocaleString("en-US");
  }
  return sym + amount.toFixed(2);
}

console.log("\n✅ Done! Place the generated prices.*.json into the app's userData folder.");
