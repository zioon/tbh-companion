import dns from "dns";

// 测试 DNS 解析返回的 IP 地址
dns.resolve("steamcommunity.com", (err, addresses) => {
  console.log("DNS A records (IPv4):", addresses);
});

dns.resolve6("steamcommunity.com", (err, addresses) => {
  console.log("DNS AAAA records (IPv6):", err ? err.message : addresses);
});

// 使用 ipv4first 策略测试 fetch
dns.setDefaultResultOrder("ipv4first");

const API_URL = "https://steamcommunity.com/market/priceoverview/?appid=3678970&currency=1&market_hash_name=Minor%20Ruby";

async function main() {
  console.log("\n=== 使用 ipv4first 测试 fetch ===");
  try {
    const res = await fetch(API_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (TBH Companion)" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    console.log("Status:", res.status);
    console.log("Body:", text.slice(0, 100));
  } catch (err) {
    console.log("Error:", err.message);
    console.log("Cause:", err.cause?.code || err.cause?.message || "N/A");
  }
}

main().catch(console.error);
