/**
 * 诊断 Steam API 在 Node.js 环境下的访问问题
 */
const API_URL = "https://steamcommunity.com/market/priceoverview/?appid=3678970&currency=1&market_hash_name=Minor%20Ruby";

async function testFetch() {
  console.log("=== 测试 1: 默认 fetch ===");
  try {
    const res = await fetch(API_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (TBH Companion)" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    console.log("Status:", res.status);
    console.log("Body:", text.slice(0, 200));
  } catch (err) {
    console.log("Error:", err.message);
    console.log("Cause:", err.cause?.message || "N/A");
  }

  console.log("\n=== 测试 2: 强制 IPv4 (--dns-result-order=ipv4first) ===");
  try {
    const res = await fetch(API_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (TBH Companion)" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    console.log("Status:", res.status);
    console.log("Body:", text.slice(0, 200));
  } catch (err) {
    console.log("Error:", err.message);
    console.log("Cause:", err.cause?.message || "N/A");
  }

  console.log("\n=== 测试 3: 不设 timeout ===");
  try {
    const res = await fetch(API_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (TBH Companion)" },
    });
    const text = await res.text();
    console.log("Status:", res.status);
    console.log("Body:", text.slice(0, 200));
  } catch (err) {
    console.log("Error:", err.message);
    console.log("Cause:", err.cause?.code || err.cause?.message || "N/A");
  }
}

testFetch().catch(console.error);
