import "dotenv/config";
import axios from "axios";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";

type ChainName = "base" | "optimism";

const RAW_WALLETS = (process.env.WALLETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function parseWallets(raw: string[]): Record<ChainName, string[]> {
  const scoped: Record<ChainName, string[]> = { base: [], optimism: [] };
  for (const entry of raw) {
    const [maybeChain, maybeAddr] = entry.split(":");
    const isOp = maybeChain === "optimism" || maybeChain === "op";
    if (maybeAddr && (maybeChain === "base" || isOp)) {
      scoped[isOp ? "optimism" : "base"].push(maybeAddr);
    } else if (entry) {
      // unscoped -> check both chains
      scoped.base.push(entry);
      scoped.optimism.push(entry);
    }
  }
  return scoped;
}

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

const CHAIN_IDS = {
  base: 8453,
  optimism: 10,
};

// Public RPCs for block timestamp resolution (no key required)
const PUBLIC_RPC = {
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
};

// ---- Year window (default 2025; can be overridden by --year or --start/--end)
let YEAR = 2025 as number;
let START_ISO = `${YEAR}-01-01T00:00:00Z`;
let END_ISO = `${YEAR}-12-31T23:59:59Z`;
let START_TS = Math.floor(new Date(START_ISO).getTime() / 1000);
let END_TS = Math.floor(new Date(END_ISO).getTime() / 1000);

// --- Simple helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, tries = 3, baseMs = 300): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function writeLine(stream: import("node:fs").WriteStream, line: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (stream.write(line + "\n")) resolve();
    else stream.once("drain", resolve);
  });
}

// Generic Etherscan (multichain) paginator — filters by 2025 timestamps
async function fetchEtherscanTxPaged(
  chain: ChainName,
  action: "txlist" | "txlistinternal",
  address: string,
): Promise<any[]> {
  const url = "https://api.etherscan.io/v2/api";
  const chainId = CHAIN_IDS[chain];
  const results: any[] = [];
  const offset = 1000; // page size
  let page = 1;
  while (true) {
    const data = await etherscanGet({
      chainid: chainId,
      module: "account",
      action,
      address,
      page,
      offset,
      sort: "asc",
      apikey: ETHERSCAN_API_KEY,
    });
    if (data?.status !== "1") {
      console.warn(`[warn] Etherscan ${action} ${chain}:${address} page=${page} exited:`, data?.message || data);
      break; // no results or error; exit loop
    }
    const arr: any[] = Array.isArray(data?.result) ? data.result : [];
    if (arr.length === 0) break;

    // Determine if we can early-continue/stop based on timestamps
    const firstTs = Number(arr[0]?.timeStamp || arr[0]?.timestamp || 0);
    const lastTs = Number(arr[arr.length - 1]?.timeStamp || arr[arr.length - 1]?.timestamp || 0);

    // If entire page is before 2025 window, skip and continue
    if (lastTs < START_TS) {
      page += 1;
      continue;
    }
    // If entire page is after 2025 window, we're done (ascending order)
    if (firstTs > END_TS) {
      break;
    }

    for (const t of arr) {
      const ts = Number(t.timeStamp || t.timestamp || 0);
      if (ts >= START_TS && ts <= END_TS) results.push(t);
    }

    if (lastTs > END_TS || arr.length < offset) break; // last page for our window
    page += 1;
  }
  return results;
}

// --- Simple helpers
// Etherscan GET with throttle/backoff (free: 5 rps)
let lastRequestTs = 0;
async function etherscanGet(params: Record<string, any>): Promise<any> {
  const minSpacingMs = 220; // ~4.5 rps
  const now = Date.now();
  const delta = now - lastRequestTs;
  if (delta < minSpacingMs) await sleep(minSpacingMs - delta);
  lastRequestTs = Date.now();

  let retries = 0;
  while (retries < 3) {
    try {
      const { data } = await axios.get("https://api.etherscan.io/v2/api", {
        params,
        timeout: 30000,
      });
      return data;
    } catch (e: any) {
      if (e?.response?.status === 429) {
        retries++;
        const backoff = 500 * Math.pow(2, retries);
        console.warn(`[warn] Etherscan rate limit hit. Retrying in ${backoff}ms...`);
        await sleep(backoff);
      } else {
        throw e;
      }
    }
  }
  throw new Error("Etherscan API failed after multiple retries.");
}

// Throttled CoinGecko GET (free: ~10-30/min)
let lastCgRequestTs = 0;
async function coingeckoGet(url: string): Promise<any> {
  const minSpacingMs = 6000; // 10/min
  const now = Date.now();
  const delta = now - lastCgRequestTs;
  if (delta < minSpacingMs) await sleep(minSpacingMs - delta);
  lastCgRequestTs = Date.now();
  return await withRetry(async () => {
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  }, 3, 600);
}

// Throttled RPC POST
let lastRpcRequestTs = 0;
async function rpcPost(chain: ChainName, method: string, params: any[]): Promise<any> {
  const minSpacingMs = 1000; // 1/sec
  const now = Date.now();
  const delta = now - lastRpcRequestTs;
  if (delta < minSpacingMs) await sleep(minSpacingMs - delta);
  lastRpcRequestTs = Date.now();

  const url = PUBLIC_RPC[chain];
  const { data } = await withRetry(async () => {
    return await axios.post(url, {
      id: 1,
      jsonrpc: "2.0",
      method,
      params,
    }, { timeout: 30000, headers: { "content-type": "application/json" } });
  }, 3, 500);
  return data;
}


// RPC helpers
async function rpcCall(chain: ChainName, method: string, params: any[]): Promise<any> {
  const data = await rpcPost(chain, method, params);
  if (data?.error) throw new Error(String(data?.error?.message || data?.error));
  return data?.result;
}

async function rpcGetLatestBlockNumber(chain: ChainName): Promise<number> {
  const hex = await rpcCall(chain, "eth_blockNumber", []);
  return Number.parseInt(hex, 16);
}

async function rpcGetBlockByNumber(chain: ChainName, num: number): Promise<{ number: number; timestamp: number; }>{
  const hexNum = "0x" + num.toString(16);
  const res = await rpcCall(chain, "eth_getBlockByNumber", [hexNum, false]);
  const ts = Number.parseInt(res?.timestamp || "0x0", 16);
  return { number: num, timestamp: ts };
}

// Binary search for block at/around timestamp
async function resolveBlockAtTime(chain: ChainName, targetTs: number, closest: "before" | "after"): Promise<number> {
  const latest = await rpcGetLatestBlockNumber(chain);
  let low = 0;
  let high = latest;
  while (low < high) {
    const mid = Math.floor((low + high + (closest === "after" ? 1 : 0)) / 2);
    const b = await rpcGetBlockByNumber(chain, mid);
    if (b.timestamp === targetTs) return mid;
    if (b.timestamp < targetTs) low = mid + 1;
    else high = mid - 1;
  }
  // Adjust based on closest
  const bLow = await rpcGetBlockByNumber(chain, low);
  if (closest === "before") {
    if (bLow.timestamp > targetTs && low > 0) return low - 1;
    return low;
  } else {
    if (bLow.timestamp < targetTs) return Math.min(low + 1, latest);
    return low;
  }
}

// Etherscan internal tx with block bounds + pagination + early stop
async function fetchInternalByBlockRange(
  chain: ChainName,
  address: string,
  startBlock: number,
  endBlock: number,
  maxPages: number,
): Promise<any[]> {
  const chainId = CHAIN_IDS[chain];
  const offset = 1000;
  let page = 1;
  const out: any[] = [];
  while (page <= maxPages) {
    const data = await etherscanGet({
      chainid: chainId,
      module: "account",
      action: "txlistinternal",
      address,
      startblock: startBlock,
      endblock: endBlock,
      page,
      offset,
      sort: "asc", // oldest first
      apikey: ETHERSCAN_API_KEY,
    });
    if (data?.status !== "1") break;
    const arr: any[] = Array.isArray(data?.result) ? data.result : [];
    if (arr.length === 0) break;
    // Filter strictly to 2025 timestamps
    for (const t of arr) {
      const ts = Number(t.timeStamp || t.timestamp || 0);
      if (ts >= START_TS && ts <= END_TS) out.push(t);
    }
    if (arr.length < offset) break; // last page
    page += 1;
  }
  return out;
}

// Simple daily ETH/USD price via CoinGecko with on-process cache
const priceCache = new Map<string, number>();
async function getEthUsdOnDate(dateIso: string): Promise<number> {
  const key = dateIso.slice(0, 10);
  if (priceCache.has(key)) return priceCache.get(key)!;
  const d = new Date(dateIso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const dateStr = `${dd}-${mm}-${yyyy}`;
  const url = `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateStr}&localization=false`;
  const data = await coingeckoGet(url);
  const price = data?.market_data?.current_price?.usd;
  if (typeof price !== "number") throw new Error("No ETH/USD price available");
  priceCache.set(key, price);
  return price;
}

function getArg(name: string): string {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] || "";
}

async function fetchEtherscanLatestInternalLimited(
  chain: ChainName,
  address: string,
  limit: number,
  order: "newest" | "oldest" = "newest",
): Promise<any[]> {
  const url = "https://api.etherscan.io/v2/api";
  const chainId = CHAIN_IDS[chain];
  const perPage = Math.max(1, Math.min(1000, limit));
  const collected: any[] = [];
  let page = 1;
  while (collected.length < limit) {
    const data = await etherscanGet({
      chainid: chainId,
      module: "account",
      action: "txlistinternal",
      address,
      page,
      offset: perPage,
      sort: order === "newest" ? "desc" : "asc",
      apikey: ETHERSCAN_API_KEY,
    });
    if (data?.status !== "1") break;
    const arr: any[] = Array.isArray(data?.result) ? data.result : [];
    if (arr.length === 0) break;
    collected.push(...arr);
    if (arr.length < perPage) break;
    page += 1;
  }
  return collected.slice(0, limit);
}

async function main() {
  if (!ETHERSCAN_API_KEY) {
    console.error("Set ETHERSCAN_API_KEY in .env for internal transactions.");
    process.exit(1);
  }
  const scoped = parseWallets(RAW_WALLETS);
  // Optional runtime filters
  const onlyWallet = (getArg("wallet") || process.env.ONLY_WALLET || "").toLowerCase();
  const onlyChainArg = (getArg("chain") || process.env.ONLY_CHAIN || "").toLowerCase();
  const cap = Number(getArg("limit") || process.env.LIMIT || "200000") || 200000;
  const latestMode = (getArg("mode") === "latest") || process.env.LATEST_MODE === "1";
  const orderArg = (getArg("order") || process.env.ORDER || "newest").toLowerCase() as "newest" | "oldest";
  const yearArg = Number(getArg("year") || process.env.YEAR || "0");
  const maxPages = Math.max(1, Number(getArg("maxPages") || process.env.MAX_PAGES || "100") || 100);
  const dryRun = (getArg("dryRun") === "1") || process.env.DRY_RUN === "1";
  const startArg = getArg("start") || process.env.START || "";
  const endArg = getArg("end") || process.env.END || "";
  const chunkDays = Math.max(0, Number(getArg("chunkDays") || process.env.CHUNK_DAYS || "0") || 0);

  // Custom range overrides year if provided
  if (startArg || endArg) {
    const startIso = startArg ? new Date(startArg).toISOString() : START_ISO;
    const endIso = endArg ? new Date(endArg).toISOString() : END_ISO;
    START_ISO = startIso;
    END_ISO = endIso;
    START_TS = Math.floor(new Date(START_ISO).getTime() / 1000);
    END_TS = Math.floor(new Date(END_ISO).getTime() / 1000);
  } else if (Number.isFinite(yearArg) && yearArg > 0) {
    YEAR = yearArg;
    START_ISO = `${YEAR}-01-01T00:00:00Z`;
    END_ISO = `${YEAR}-12-31T23:59:59Z`;
    START_TS = Math.floor(new Date(START_ISO).getTime() / 1000);
    END_TS = Math.floor(new Date(END_ISO).getTime() / 1000);
  }

  if (onlyWallet) {
    for (const c of ["base", "optimism"] as ChainName[]) {
      scoped[c] = scoped[c].filter((a) => a.toLowerCase() === onlyWallet);
    }
  }

  if (onlyChainArg === "base" || onlyChainArg === "optimism") {
    if (onlyChainArg === "base") scoped.optimism = [];
    if (onlyChainArg === "optimism") scoped.base = [];
  }

  if (scoped.base.length + scoped.optimism.length === 0) {
    console.error("Set WALLETS in .env (e.g. base:0x..,op:0x.. or 0x..)");
    process.exit(1);
  }

  const outDir = "csvs";
  let outFile = latestMode
    ? `${outDir}/latest_internal_eth.csv`
    : `${outDir}/${YEAR}_internal_eth.csv`;
  if (!latestMode && (startArg || endArg)) {
    const s = START_ISO.slice(0, 10);
    const e = END_ISO.slice(0, 10);
    outFile = `${outDir}/${s}_to_${e}_internal_eth.csv`;
  }
  await mkdir(outDir, { recursive: true });

  const header = [
    "date_iso",
    "chain",
    "wallet",
    "hash",
    "from",
    "to",
    "value_eth",
    "eth_usd",
    "usd_value",
  ];

  let totalEth = 0;
  let totalUsd = 0;
  let written = 0;
  const seen = new Set<string>();
  const reached = { cap: false };
  let writer: import("node:fs").WriteStream | null = null;
  if (!dryRun) {
    writer = createWriteStream(outFile, { encoding: "utf8" });
    await writeLine(writer, header.join(","));
  }

  for (const chain of ["base", "optimism"] as ChainName[]) {
    const wallets = scoped[chain];
    if (wallets.length === 0) continue;

    for (const wallet of wallets) {
      if (reached.cap) break;
      try {
        if (latestMode) {
          // Latest mode (not chunked)
          const internalTxs = await fetchEtherscanLatestInternalLimited(chain, wallet, cap, orderArg);
          const internalInbound = internalTxs.filter((t) => (t?.to || "").toLowerCase() === wallet.toLowerCase());
          for (const t of internalInbound) {
            if (reached.cap) break;
            const tsSec = Number(t.timeStamp || t.timestamp || 0);
            if (!Number.isFinite(tsSec)) continue;
            const dateIso = new Date(tsSec * 1000).toISOString();
            const dayIso = dateIso.slice(0, 10) + "T00:00:00Z";
            const eth = Number(t.value) / 1e18;
            if (!Number.isFinite(eth) || eth <= 0) continue;
            let usd = 0;
            try { const price = await getEthUsdOnDate(dayIso); usd = eth * price; } catch {}
            const hash = t.hash || "";
            const from = t.from || "";
            const to = t.to || "";
            const key = `${chain}|${wallet.toLowerCase()}|${hash.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            totalEth += eth;
            totalUsd += usd || 0;
            written += 1;
            if (!dryRun && writer) {
              await writeLine(writer, [
                dateIso, chain, wallet, hash, from, to,
                eth.toFixed(6), usd ? (usd / eth).toFixed(2) : "", usd ? usd.toFixed(2) : "",
              ].join(","));
            }
            if (written >= cap) { reached.cap = true; break; }
          }
        } else if (chunkDays > 0) {
          // Chunked date-bounded mode
          const daySeconds = 24 * 60 * 60;
          let chunkStartTs = START_TS;
          while (chunkStartTs <= END_TS && !reached.cap) {
            const chunkEndTs = Math.min(END_TS, chunkStartTs + (chunkDays * daySeconds) - 1);
            const startBlock = await resolveBlockAtTime(chain, chunkStartTs, "after");
            const endBlock = await resolveBlockAtTime(chain, chunkEndTs, "before");
            const internalTxs = await fetchInternalByBlockRange(chain, wallet, startBlock, endBlock, maxPages);
            const internalInbound = internalTxs.filter((t) => (t?.to || "").toLowerCase() === wallet.toLowerCase());
            for (const t of internalInbound) {
              if (reached.cap) break;
              const tsSec = Number(t.timeStamp || t.timestamp || 0);
              if (!Number.isFinite(tsSec)) continue;
              const dateIso = new Date(tsSec * 1000).toISOString();
              const dayIso = dateIso.slice(0, 10) + "T00:00:00Z";
              const eth = Number(t.value) / 1e18;
              if (!Number.isFinite(eth) || eth <= 0) continue;
              let usd = 0;
              try { const price = await getEthUsdOnDate(dayIso); usd = eth * price; } catch {}
              const hash = t.hash || "";
              const from = t.from || "";
              const to = t.to || "";
              const key = `${chain}|${wallet.toLowerCase()}|${hash.toLowerCase()}`;
              if (seen.has(key)) continue;
              seen.add(key);
              totalEth += eth;
              totalUsd += usd || 0;
              written += 1;
              if (!dryRun && writer) {
                await writeLine(writer, [
                  dateIso, chain, wallet, hash, from, to,
                  eth.toFixed(6), usd ? (usd / eth).toFixed(2) : "", usd ? usd.toFixed(2) : "",
                ].join(","));
              }
              if (written >= cap) { reached.cap = true; break; }
            }
            chunkStartTs = chunkEndTs + 1;
          }
        } else {
          // Single date-bounded range (not chunked)
          const startBlock = await resolveBlockAtTime(chain, START_TS, "after");
          const endBlock = await resolveBlockAtTime(chain, END_TS, "before");
          const internalTxs = await fetchInternalByBlockRange(chain, wallet, startBlock, endBlock, maxPages);
          const internalInbound = internalTxs.filter((t) => (t?.to || "").toLowerCase() === wallet.toLowerCase());
          for (const t of internalInbound) {
            if (reached.cap) break;
            const tsSec = Number(t.timeStamp || t.timestamp || 0);
            if (!Number.isFinite(tsSec)) continue;
            const dateIso = new Date(tsSec * 1000).toISOString();
            const dayIso = dateIso.slice(0, 10) + "T00:00:00Z";
            const eth = Number(t.value) / 1e18;
            if (!Number.isFinite(eth) || eth <= 0) continue;
            let usd = 0;
            try { const price = await getEthUsdOnDate(dayIso); usd = eth * price; } catch {}
            const hash = t.hash || "";
            const from = t.from || "";
            const to = t.to || "";
            const key = `${chain}|${wallet.toLowerCase()}|${hash.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            totalEth += eth;
            totalUsd += usd || 0;
            written += 1;
            if (!dryRun && writer) {
              await writeLine(writer, [
                dateIso, chain, wallet, hash, from, to,
                eth.toFixed(6), usd ? (usd / eth).toFixed(2) : "", usd ? usd.toFixed(2) : "",
              ].join(","));
            }
            if (written >= cap) { reached.cap = true; break; }
          }
        }
      } catch (e: any) {
        console.error(`[error] ${chain}:${wallet} ->`, e?.response?.data || e?.message || String(e));
      }
    }
  }

  if (dryRun) {
    console.log(`[dryRun] Would write ${written} rows to ./${outFile}`);
  } else if (writer) {
    await writeLine(writer, ["TOTAL", "", "", "", "", "", totalEth.toFixed(6), "", totalUsd.toFixed(2)].join(","));
    await new Promise<void>((resolve) => writer!.end(resolve));
    console.log(`Wrote ${written} data rows to ./${outFile}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });


