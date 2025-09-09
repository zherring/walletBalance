import "dotenv/config";
import {
  createPublicClient,
  http,
  parseAbi,
  formatEther,
  formatUnits,
  type Address,
} from "viem";
import axios from "axios";

import { mkdir, writeFile } from "node:fs/promises";

/** ======= TYPES UP TOP (no hoisting footgun) ======= */
type ChainName = "base" | "optimism";

/** ======= CONFIG (edit these) ======= */
const RAW_WALLETS = (process.env.WALLETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function parseWallets(
  raw: string[],
): { scoped: Record<ChainName, Address[]>; unscoped: Address[] } {
  const scoped: Record<ChainName, Address[]> = { base: [], optimism: [] };
  const unscoped: Address[] = [];

  for (const entry of raw) {
    const [maybeChain, maybeAddr] = entry.split(":");
    const isOp = maybeChain === "optimism" || maybeChain === "op";
    if (maybeAddr && (maybeChain === "base" || isOp)) {
      scoped[isOp ? "optimism" : "base"].push(maybeAddr as Address);
    } else {
      unscoped.push(entry as Address);
    }
  }
  return { scoped, unscoped };
}

const DATE_ISO = "2024-12-31T23:59:59Z"; // end-of-year UTC

// Bring-your-own RPCs (free Alchemy/QuickNode ok)
const RPC = {
  base: process.env.RPC_BASE || "https://base-mainnet.g.alchemy.com/v2/KEY",
  op: process.env.RPC_OP || "https://opt-mainnet.g.alchemy.com/v2/KEY",
};

const TOKENS: Record<
  ChainName,
  { symbol: string; address: string; decimals: number }[]
> = {
  base: [
    {
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
    },
  ],
  optimism: [
    {
      symbol: "USDC",
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      decimals: 6,
    },
    {
      symbol: "OP",
      address: "0x4200000000000000000000000000000000000042",
      decimals: 18,
    },
  ],
};

// CoinGecko IDs by token contract (lowercased)
const COINGECKO_IDS_BY_ADDRESS: Record<string, string> = {
  // USDC
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "usd-coin", // base USDC
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": "usd-coin", // optimism USDC
  // OP token (Optimism)
  "0x4200000000000000000000000000000000000042": "optimism",
};

// minimal ERC20 ABI
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

type ChainCfg = {
  name: ChainName;
  rpc: string;
  chainId: number;
};

const CHAINS: ChainCfg[] = [
  { name: "base", rpc: RPC.base, chainId: 8453 },
  { name: "optimism", rpc: RPC.op, chainId: 10 },
];

// --- utils
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const looksLikePlaceholder = (s: string) => /\/KEY$/.test(s);

/** simple retry for transient RPC hiccups */
async function withRetry<T>(fn: () => Promise<T>, tries = 3, delayMs = 100) {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * Binary-search the block whose timestamp is <= targetTs and next block is > targetTs.
 * Works on L2s as long as RPC supports getBlock.
 */
async function resolveBlockAtTime(
  client: ReturnType<typeof createPublicClient>,
  targetTs: number,
): Promise<bigint> {
  const latest = await client.getBlockNumber();
  // Quick exit: check latest timestamp
  let latestBlock = await withRetry(() =>
    client.getBlock({ blockNumber: latest }),
  );
  if (Number(latestBlock.timestamp) <= targetTs) return latest;

  // low=0 (or 1), high=latest
  let low = 0n;
  let high = latest;

  while (low < high) {
    const mid = (low + high + 1n) >> 1n; // upper mid to avoid infinite loop
    const b = await withRetry(() => client.getBlock({ blockNumber: mid }));
    const ts = Number(b.timestamp);
    if (ts <= targetTs) {
      low = mid; // mid is valid or too early
    } else {
      high = mid - 1n; // mid too new
    }
    // be a tiny bit gentle to avoid 429s on free RPCs
    if ((mid & 7n) === 0n) await sleep(5);
  }
  return low;
}

async function getEthUsdOnDate(dateIso: string): Promise<number> {
  // CoinGecko wants DD-MM-YYYY
  const d = new Date(dateIso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const dateStr = `${dd}-${mm}-${yyyy}`;

  const { data } = await axios.get(
    `https://api.coingecko.com/api/v3/coins/ethereum/history?date=${dateStr}&localization=false`,
    { timeout: 15000 },
  );
  const price = data?.market_data?.current_price?.usd;
  if (typeof price !== "number") throw new Error("Failed to fetch ETH/USD price");
  return price;
}

// Generic CoinGecko price fetch (by coin id) with simple in-memory cache
const priceCache = new Map<string, number>();

async function getUsdOnDateByCoinId(
  coinId: string,
  dateIso: string,
): Promise<number | null> {
  const cacheKey = `${coinId}::${dateIso}`;
  if (priceCache.has(cacheKey)) return priceCache.get(cacheKey)!;

  const d = new Date(dateIso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const dateStr = `${dd}-${mm}-${yyyy}`;

  try {
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${dateStr}&localization=false`,
      { timeout: 15000 },
    );
    const price = data?.market_data?.current_price?.usd;
    if (typeof price === "number") {
      priceCache.set(cacheKey, price);
      return price;
    }
    return null;
  } catch {
    return null;
  }
}

function toFixed(n: number, d = 6) {
  return Number.isFinite(n) ? n.toFixed(d) : "NaN";
}

// --- CSV helpers
function csvEscape(value: string): string {
  if (value == null) return "";
  const needsQuotes = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function toCsvLine(columns: (string | number | null | undefined)[]): string {
  return columns
    .map((c) => (typeof c === "number" ? String(c) : c ?? ""))
    .map(csvEscape)
    .join(",");
}

async function main() {
  if (
    !RPC.base ||
    !RPC.op ||
    looksLikePlaceholder(RPC.base) ||
    looksLikePlaceholder(RPC.op)
  ) {
    console.error(
      "Set RPC_BASE and RPC_OP to real provider URLs (no '/KEY' placeholders).",
    );
    process.exit(1);
  }

  const { scoped, unscoped } = parseWallets(RAW_WALLETS);
  const anyScoped = Object.values(scoped).some((arr) => arr.length > 0);

  if (!anyScoped && unscoped.length === 0) {
    console.error(
      "Set WALLETS in .env (comma-separated). Supports 'base:0x..' or 'optimism|op:0x..' or plain '0x..'",
    );
    process.exit(1);
  }

  const targetTs = Math.floor(new Date(DATE_ISO).getTime() / 1000);
  const ethUsd = await getEthUsdOnDate(DATE_ISO).catch(() => null);

  console.log(`\nSnapshot @ ${DATE_ISO} (ts=${targetTs})`);
  if (ethUsd) console.log(`ETH/USD (CoinGecko): ${ethUsd}`);
  else console.log("ETH/USD price unavailable (CoinGecko). Proceeding without USD columns.");

  // Pre-fetch USD prices for all unique token addresses on this date
  const uniqueAddresses = new Set<string>();
  for (const list of Object.values(TOKENS)) {
    for (const t of list) uniqueAddresses.add(t.address.toLowerCase());
  }
  const addressUsdMap = new Map<string, number | null>();
  await Promise.all(
    Array.from(uniqueAddresses).map(async (addrLc) => {
      const coinId = COINGECKO_IDS_BY_ADDRESS[addrLc];
      const usd = coinId ? await getUsdOnDateByCoinId(coinId, DATE_ISO) : null;
      if (usd == null) {
        console.log(`[warn] no USD price for ${addrLc} on ${DATE_ISO}`);
      }
      addressUsdMap.set(addrLc, usd);
    }),
  );

  // CSV rows accumulator
  const csvRows: string[] = [];
  const header = [
    "date_iso",
    "chain",
    "block_number",
    "wallet",
    "asset_type",
    "symbol",
    "token_address",
    "token_decimals",
    "balance",
    "usd_price_on_date",
    "usd_value",
  ];
  csvRows.push(toCsvLine(header));

  for (const chain of CHAINS) {
    // If any scoped wallets are provided, only run for chains that have scoped wallets
    if (anyScoped && scoped[chain.name].length === 0) continue;
    const client = createPublicClient({ transport: http(chain.rpc) });

    const block = await resolveBlockAtTime(client, targetTs);
    const blockHex = "0x" + block.toString(16);

    console.log(`\n=== ${chain.name.toUpperCase()} — block ${block} (${blockHex}) ===`);

    const walletsForChain: Address[] = [
      ...scoped[chain.name],
      ...(!anyScoped ? unscoped : []),
    ];

    for (const wallet of walletsForChain) {
      console.log(`wallet=${wallet} | date=${DATE_ISO} | block=${block}`);
      // Native ETH balance and USD
      const ethWei = await client.getBalance({ address: wallet, blockNumber: block });
      const eth = Number(formatEther(ethWei));
      if (ethUsd) {
        console.log(`ETH=${toFixed(eth, 6)} | ETH/USD=${toFixed(eth * ethUsd, 2)}`);
      } else {
        console.log(`ETH=${toFixed(eth, 6)}`);
      }

      // Push native ETH row
      csvRows.push(
        toCsvLine([
          DATE_ISO,
          chain.name,
          String(block),
          wallet,
          "native",
          "ETH",
          "",
          "18",
          eth.toFixed(6),
          ethUsd != null ? toFixed(ethUsd, 2) : "",
          ethUsd != null ? toFixed(eth * ethUsd, 2) : "",
        ]),
      );
      for (const token of TOKENS[chain.name]) {
        const raw = (await client.readContract({
          address: token.address as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [wallet],
          blockNumber: block,
        })) as bigint;

        const balance = Number(formatUnits(raw, token.decimals));
        const usd = addressUsdMap.get(token.address.toLowerCase()) ?? null;
        if (usd != null) {
          const usdVal = balance * usd;
          console.log(`${token.symbol}=${balance.toFixed(6)} | usd=${toFixed(usdVal, 2)}`);
        } else {
          console.log(`${token.symbol}=${balance.toFixed(6)}`);
        }

        // Push ERC20 row
        csvRows.push(
          toCsvLine([
            DATE_ISO,
            chain.name,
            String(block),
            wallet,
            "erc20",
            token.symbol,
            token.address,
            String(token.decimals),
            balance.toFixed(6),
            usd != null ? toFixed(usd, 6) : "",
            usd != null ? toFixed(balance * usd, 2) : "",
          ]),
        );
      }
    }
  }

  // Ensure output directory exists and write CSV
  const outDir = "csvs";
  const outFile = `${outDir}/eoy_2024.csv`;
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, csvRows.join("\n"), "utf8");
  console.log(`\nWrote ${csvRows.length - 1} data rows to ./${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
