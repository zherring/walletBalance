## walletBalance — End-of-Year 2024 snapshot

Snapshot EOY-2024 balances for specified wallets across Base and Optimism, including native ETH and selected ERC-20s, with historical USD values via CoinGecko. Results are written to `csvs/eoy_2024.csv`.

### Features
- **Chains**: Base, Optimism
- **Assets**: Native ETH plus configured ERC‑20s (USDC on both, OP on Optimism)
- **Historical pricing**: CoinGecko price on 2024‑12‑31
- **Output**: CSV at `csvs/eoy_2024.csv`, progress logs to console

### Requirements
- Node.js 18+
- RPC endpoints (e.g., Alchemy/QuickNode) for Base and Optimism

### Setup
1. Install dependencies:
```bash
npm install
```
2. Configure environment variables. Either:
   - Create a `.env` with the variables below, or
   - Copy `env.example` to `.env` and edit, or
   - Export them in your shell.

Required variables:
```bash
ETHERSCAN_API_KEY=REPLACE_WITH_KEY
RPC_BASE=https://base-mainnet.g.alchemy.com/v2/REPLACE_WITH_KEY
RPC_OP=https://opt-mainnet.g.alchemy.com/v2/REPLACE_WITH_KEY
# Comma-separated wallets (see formats below)
WALLETS=base:0x...,optimism:0x...,0x...
```

Wallet formats for `WALLETS` (comma-separated):
- `base:0xYourAddress` — only query on Base
- `optimism:0xYourAddress` or `op:0xYourAddress` — only query on Optimism
- `0xYourAddress` — unscoped; used for all chains unless any scoped wallets are present

Examples:
```bash
WALLETS=base:0x1111111111111111111111111111111111111111,op:0x2222222222222222222222222222222222222222
WALLETS=0x3333333333333333333333333333333333333333,0x4444444444444444444444444444444444444444
```

### Run snapshot (EOY 2024)
```bash
npm start
```
This prints progress and writes the final CSV to `csvs/eoy_2024.csv`.

### Run inbound (internal ETH transfers)
```bash
npm run inbound -- --year 2025 --order newest --limit 200000
```
Flags:
- `--year=YYYY` Bound to a calendar year (default 2025)
- `--mode=latest` Fetch latest internal transfers instead of year-bounded; writes `csvs/latest_internal_eth.csv`
- `--wallet=0x...` Limit to one wallet
- `--chain=base|optimism` Limit to one chain
- `--limit=N` Cap collected rows (default 200000)
- `--order=newest|oldest` Sort direction for latest mode (default newest)
- `--maxPages=N` Pagination bound for year-bounded mode (default 100)
- `--dryRun=1` Skip writing file; print summary

CSV output:
- Year-bounded: `csvs/<year>_internal_eth.csv`
- Latest mode: `csvs/latest_internal_eth.csv`

### CSV schema
Columns (in order):
- `date_iso`
- `chain`
- `wallet`
- `hash`
- `from`
- `to`
- `value_eth`
- `eth_usd`
- `usd_value`

### Notes
- If RPC URLs still include `/KEY`, the snapshot script will exit with an instruction to set real URLs.
- APIs are rate-limited; the inbound script throttles and retries.
- To customize tokens for the snapshot, edit `TOKENS` and `COINGECKO_IDS_BY_ADDRESS` in `snapshot.mts`.

### License
MIT — see `LICENSE`.
