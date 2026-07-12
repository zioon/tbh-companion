const API_URL = "https://steamcommunity.com/market/priceoverview/?appid=3678970&currency=1&market_hash_name=Minor%20Ruby";

async function main() {
  // 测试 1: 使用 Happy Eyeballs (默认行为，IPv6 优先)
  console.log("=== 测试 1: 默认 (Happy Eyeballs) ===");
  try {
    const res = await fetch(API_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (TBH Companion)" },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    console.log("Status:", res.status);
    console.log("Body:", text.slice(0, 100));
  } catch (err) {
    console.log("Error:", err.message);
    console.log("Code:", err.cause?.code || "N/A");
    if (err.cause?.cause) console.log("Cause chain:", err.cause.cause?.code);
  }

  // 测试 2: 增加超时时间 + curl 一样的 User-Agent
  console.log("\n=== 测试 2: 30s timeout + 完整 User-Agent ===");
  try {
    const res = await fetch(API_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    console.log("Status:", res.status);
    console.log("Body:", text.slice(0, 100));
  } catch (err) {
    console.log("Error:", err.message);
    console.log("Code:", err.cause?.code || "N/A");
  }
}

main().catch(console.error);
