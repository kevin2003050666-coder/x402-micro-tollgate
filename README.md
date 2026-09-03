# x402-micro-tollgate

**Visa for AI agents that can’t hold a card.**

Second-scale settlement bridge for agent traffic — the Web3 tollbooth that clears USDC micropayments and takes **0.1%**.

> 为千万级无支付能力的 AI Agent 提供秒级过桥清算，抽成 0.1% 的 Web3 版 Visa 收费站

**Security backed by Coinbase CDP.** We don't touch your keys or settle payments on custom cryptography — EIP-3009 authorization nonces are single-use at the CDP facilitator (source of truth for on-chain uniqueness). The gateway hardens four buyer/seller trust surfaces: **payment-proof replay/race**, **SSRF on URL fetch**, **upstream bypass (shared-secret trust header)**, and **Base congestion / settle-latency** (pending + retry same proof — never treat HTTP timeout alone as “payment failed”).

## What it is

A thin self-hosted tollgate in front of your API or MCP tools. When an agent calls a paid route, it gets **HTTP 402 as a price tag** (not a hard deny). It pays a small USDC (or configured USDT) amount; you deliver. Default clearing is **Base + USDC** via **Coinbase CDP**; multi-network accepts are env-driven (see matrix below). Humans can still hit a free path; agents convert at the booth.

Self-host is free ([MIT](./LICENSE)). Repo: [github.com/kevin2003050666-coder/x402-micro-tollgate](https://github.com/kevin2003050666-coder/x402-micro-tollgate) · Questions: [`2767111713@qq.com`](mailto:2767111713@qq.com?subject=x402-micro-tollgate)

> Not an official Coinbase product. Not a full agent marketplace. Not a billing SaaS. A sharp Visa-style tollbooth. Not fiat custody.

## Network × asset matrix

Default deploy profile: **Base USDC only** (dev: Base Sepolia). Enable multi with `NETWORKS` + `ASSETS` or `ACCEPTS_JSON` / `X402_*` aliases. Browser HTML 402 shows a **chain + asset picker** when more than one accept is configured.

| Network | CAIP-2 | USDC | USDT | Status | Facilitator / notes |
|---|---|---|---|---|---|
| Base | `eip155:8453` | native Circle | bridged | **live** | CDP `exact`. FeeSplitterFactory **live** ([deployments/base.json](./contracts/deployments/base.json)) |
| Base Sepolia | `eip155:84532` | test USDC | — | **live** | CDP testnet |
| Optimism | `eip155:10` | native | bridged | config-ready | Addresses wired; **not** on current CDP matrix |
| Arbitrum One | `eip155:42161` | native | bridged | **live** | CDP `exact`; factory stub |
| Polygon PoS | `eip155:137` | native (not USDC.e) | PoS USDT | **live** | CDP `exact`; factory stub |
| BNB Smart Chain | `eip155:56` | peg 18 dec | peg 18 dec | config-ready | Not on CDP list |
| Ethereum | `eip155:1` | native | Tether | config-ready | Facilitator-dependent |
| Avalanche C-Chain | `eip155:43114` | native | USDT | config-ready | In `@x402/evm` defaults |
| Celo / Sei | `eip155:42220` / `1329` | USDC | — | config-ready | Catalog extras |
| Solana | `solana:5eykt…` | SPL USDC | SPL USDT | **experimental** | CDP lists Solana; gateway stubs + optional SVM paywall (`SOLANA_PAY_TO`) |
| TRON | `tron:mainnet` | — | TRC-20 | **planned** | No scheme in deps — **never** in `accepts[]` |

USDT on EVM typically uses `extra.assetTransferMethod: "permit2"` (not EIP-3009). FeeSplitter production path remains **Base + USDC**; other chains are config stubs under [`contracts/deployments/`](./contracts/deployments/).

### Browser wallets

| Wallet | Role |
|---|---|
| Coinbase Smart Wallet (Passkey) | Primary CTA |
| MetaMask | Via wagmi injected target |
| Injected | Other browser wallets |
| WalletConnect | When `WALLETCONNECT_PROJECT_ID` set |
| Solana paywall | Experimental, behind Solana accepts / `PAYWALL_SVM` |
| TronLink | **Not offered** (TRON planned only) |

---

## Who it’s for

- **API sellers** who want agents to pay per call — without building a billing console or selling monthly seats
- **Tool builders** shipping paid MCP endpoints into Cursor / Claude
- **Operators** who want Visa-like take-rate economics (**0.1%**), not hosting invoices

## How money works

1. **Price tag** — unpaid traffic gets HTTP 402 with the amount due (conversion, not rejection)
2. **Pay** — the agent settles a USDC micropayment in seconds via Coinbase CDP
3. **Unlock** — the tollgate proxies to your upstream; you keep ~**99.9%**, protocol take **0.1%**

No protocol monthly fee. Monetization is the toll — like interchange on card rails.

---

## 1-minute quickstart

Requires Node.js 22+.

```bash
git clone https://github.com/kevin2003050666-coder/x402-micro-tollgate
cd x402-micro-tollgate && cp .env.example .env
# set CDP_API_KEY_ID, CDP_API_KEY_SECRET, X402_PAY_TO (optional: PUBLIC_BASE_URL, UPSTREAM_URL)
npm i && npm start
# curl http://127.0.0.1:8402/health   → 200
# curl http://127.0.0.1:8402/x402/discover → 200 (free agent yellow pages)
# curl http://127.0.0.1:8402/v1/quote → 402
# curl "http://127.0.0.1:8402/v1/fetch-md?url=https://example.com" → 402 (paid HTML→Markdown demo)
```

**npx one-liners** (no clone):

```bash
npx x402-micro-tollgate@0.3.2
npx x402-micro-tollgate@0.3.2 --seller 0xYourReceivingAddress --stdio
```

`--seller` / `-s` sets `X402_PAY_TO` before boot (env vars still work). Default without `--stdio` is HTTP + `/mcp` on port 8402.

Agent / crawler docs: [`llms.txt`](./llms.txt) (also `GET /llms.txt` and `GET /.well-known/llms.txt` when the gateway is running) · OpenAPI 3.1: [`docs/openapi.yaml`](./docs/openapi.yaml) (also `GET /openapi.yaml` and `GET /docs/openapi.yaml`)

Alternative one-liner: `docker compose up --build`

Without CDP keys the process runs in **demo mode** (protocol-shaped 402 / MCP PaymentRequired, no on-chain settle).

Cursor `mcp.json`:

```json
{
  "mcpServers": {
    "x402-micro-tollgate": {
      "url": "http://127.0.0.1:8402/mcp"
    }
  }
}
```

Stdio:

```json
{
  "mcpServers": {
    "x402-micro-tollgate": {
      "command": "npx",
      "args": [
        "x402-micro-tollgate@0.3.2",
        "--seller",
        "0xYourReceivingAddress",
        "--stdio"
      ],
      "env": {
        "CDP_API_KEY_ID": "...",
        "CDP_API_KEY_SECRET": "...",
        "PUBLIC_BASE_URL": "https://your.public.host"
      }
    }
  }
}
```

(`X402_PAY_TO` in `env` still works if you omit `--seller`.)

### Library drop-in (permissionless seller)

```ts
import express from "express";
import { x402Tollgate } from "x402-micro-tollgate";

const app = express();
app.use("/v1", await x402Tollgate({ seller: process.env.SELLER! }));
```

Or set `SELLER` / `X402_SELLER` in `.env` and run `npm start`. See [Environment](#environment) for the $10 threshold, factory address, and fee-release details.

### Buyer / Agent client

Thin TypeScript helper that wraps official `@x402/fetch` + `@x402/evm` `ExactEvmScheme`. On HTTP 402 it parses `PAYMENT-REQUIRED`, checks budgets, signs EIP-3009 once, and retries **once** with `PAYMENT-SIGNATURE` (never loops).

```bash
npm i x402-micro-tollgate@0.3.2
```

```ts
import { createX402Fetch } from "x402-micro-tollgate/client";
const fetch402 = createX402Fetch({ privateKey: process.env.BUYER_KEY as `0x${string}` });
const res = await fetch402("https://x402-micro-tollgate.onrender.com/v1/quote");
```

Defaults: `maxSingleSpendUsdc = 0.05`, `maxTotalSpendUsdc = 1.00` (clear `Error` if exceeded). **Hot-wallet warning:** keep only ~**$5–$10 USDC** on the signing key — treat it as an agent spend faucet, not a treasury.

---

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kevin2003050666-coder/x402-micro-tollgate)

Uses [`render.yaml`](./render.yaml): Node 22, `npm start`, health `/health`, env names from [`.env.example`](./.env.example). Set `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `X402_PAY_TO` in the dashboard for live settlement; set `PUBLIC_BASE_URL` to your `https://….onrender.com` origin for Bazaar.

Ops bump: **redeploy discover** (force Render GitHub auto-deploy so production picks up `GET /x402/discover`). If auto-deploy does not fire within a few minutes after this lands on `main`, use the Render dashboard → Manual Deploy → Deploy latest commit.

**Self-host production:** Docker — `docker compose up --build` (see [`Dockerfile`](./Dockerfile) / [`docker-compose.yml`](./docker-compose.yml)).

---

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8402` | HTTP listen port |
| `UPSTREAM_URL` | _(unset → mock)_ | Your API origin |
| `UPSTREAM_SHARED_SECRET` / `X402_UPSTREAM_SECRET` | — | Optional. After settle, tollgate injects `X-Tollgate-Secret` + `X-Tollgate-Paid` (HMAC). Upstream must require them and reject public direct hits (not mTLS) |
| `X402_PAY_TO` | — | EVM receive address (live mode SDK init) |
| `SELLER` / `X402_SELLER` | — | Permissionless seller EOA (EIP-55 validated; invalid → startup fail) |
| `FACTORY_ADDRESS` | — | Operator-set `FeeSplitterFactory` for CREATE2 predict when amount ≥ threshold (Base live address in [`contracts/deployments/base.json`](./contracts/deployments/base.json); do not hardcode secrets) |
| `FEE_FREE_BELOW_USDC` / `X402_FEE_FREE_BELOW_USDC` | `10000000` | Atomic USDC (6 decimals). **&lt; $10** → payTo=seller; **≥ $10** → FeeSplitter |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | CDP facilitator (+ Onramp session tokens) |
| `CDP_CLIENT_API_KEY` | — | Public CDP client key for browser Smart Wallet paywall (safe in frontend). Alias: `CDP_CLIENT_KEY` |
| `X402_FACILITATOR_URL` / `CDP_FACILITATOR_URL` | CDP default | Optional alternate facilitator base URL for MCP (`createCdpFacilitatorClient({ baseUrl })`). Single-vendor; no multi-facilitator routing yet |
| `PRICE` | `$0.001` | Network default USDC/USDT price tag |
| `NETWORK` / `X402_NETWORK` | `eip155:84532` / `8453` | Primary CAIP-2 (aliases: `base`, `optimism`, …) |
| `NETWORKS` / `X402_NETWORKS` | _(primary only)_ | Comma/JSON list of networks for multi-accept |
| `ASSETS` / `X402_ASSETS` | `USDC` | Cross with NETWORKS → accepts (USDC, USDT) |
| `ACCEPTS_JSON` / `X402_ACCEPTS_JSON` | — | Explicit accepts array (overrides NETWORKS×ASSETS) |
| `FACTORY_ADDRESSES` | — | JSON map caip2 → FeeSplitterFactory (Base live; others optional) |
| `SOLANA_PAY_TO` | — | Base58 payTo for experimental Solana accepts |
| `PAYWALL_SVM` | `false` | Force `@x402/paywall` SVM UI (also auto if Solana in accepts) |
| `WALLETCONNECT_PROJECT_ID` | — | Enables WalletConnect in browser paywall |
| `X402_MIN_PRICE_USDC` | — | Optional static minimum accept amount (atomic USDC). Effective price = max(PRICE, this, gas floor) |
| `X402_DYNAMIC_MIN_ENABLED` | `false` | When `true`, Base base-fee oracle may bump min accept / feeFreeBelow if gas would eat too much of the payment |
| `X402_GAS_COST_MAX_FRACTION` | `0.5` | Bump when estimated gas USD &gt; this fraction of the payment |
| `X402_GAS_ORACLE_TTL_MS` | `30000` | baseFee cache TTL (clamped 15–60s) |
| `X402_GAS_RPC_URL` / `BASE_RPC_URL` | public Base RPC | JSON-RPC for `eth_getBlockByNumber` baseFee |
| `X402_GAS_USED_ESTIMATE` | `100000` | Rough L2 gas units for settle cost estimate |
| `X402_ETH_USD` | `4000` | Conservative ETH/USD floor (no live FX required) |
| `X402_ENVIRONMENT` | `development` | or `production` |
| `GATED_PREFIX` | `/v1` | HTTP paths that require payment |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:$PORT` | Public `https://` origin for Bazaar resource URLs |
| `CONTACT_EMAIL` | `2767111713@qq.com` | Landing contact mailto (not a SaaS CTA) |
| `FEE_BPS` | `10` | Documented operator fee (0.1%). Live settle still pays 100% to `payTo` until `release()` |
| `FEE_COLLECTOR` | `0xa922…7e30E` | **Fixed operator** wallet for the 0.1% slice after `FeeSplitter.release()` |
| `MERCHANTS_JSON` | — | Optional hosted multi-tenant registry (not required when `SELLER` is set) |
| `MERCHANTS_FILE` | `merchants.json` | File path; falls back to `merchants.example.json` / built-in demo when no seller |
| `DEFAULT_MERCHANT` | `demo` | Used when `?merchant=` / `x-merchant-id` omitted — **agents SHOULD always send merchant id** |
| `REQUIRE_MERCHANT` | `false` | When `true`, gated paths reject missing merchant id with `400 {error:"merchant_required"}` (no demo fallback) |
| `PAYMENT_DEDUPE_TTL_MS` | `600000` | In-memory payment-proof idempotency window (10 min). CDP facilitator nonce remains source of truth |
| `PAYMENT_DEDUPE_MAX_ENTRIES` | `10000` | Max keys in the gateway `PaymentDedupeStore` LRU (no Redis; interface is Redis-ready) |
| `X402_VERIFY_TIMEOUT_MS` | `15000` | Documented verify-phase budget (local / facilitator verify) |
| `X402_SETTLE_TIMEOUT_MS` | `180000` | Wait for facilitator/on-chain settle before `202 payment_pending` (default 3 min — Base congestion) |
| `KEEPER_ENABLED` | `false` | Optional FeeSplitter `release()` keeper — **never on by default** |
| `KEEPER_DRY_RUN` | _(see notes)_ | `true` logs `keeper_would_release` without sending txs |
| `KEEPER_PRIVATE_KEY` | — | EVM key for live `release()` only (never commit) |
| `KEEPER_RPC_URL` | Base public RPC | JSON-RPC endpoint for balance + release |
| `KEEPER_INTERVAL_MS` | `3600000` | Poll interval (1h) |
| `KEEPER_MIN_USDC` | `1000000` | Min USDC balance (atomic) before `release()` — default $1 |

### Permissionless seller + $10 threshold (0.3.0)

**0.3.0**: set `SELLER` (or use `x402Tollgate({ seller })`) and `FACTORY_ADDRESS` for ≥ $10 CREATE2 routing. No `MERCHANTS_JSON` required.

| Amount (USDC atomic, 6 decimals) | `accepts[].payTo` |
|---|---|
| **&lt; `10_000_000` ($10)** | seller EOA — **0 protocol fee** |
| **≥ `10_000_000` ($10)** | CREATE2-predicted `FeeSplitter` for that seller |

x402 `exact` + EIP-3009 only **credits** `payTo` — it does not execute `FeeSplitter` / factory code and does **not** split in the same transaction. For ≥ $10: set `FACTORY_ADDRESS` to the operator-deployed factory (Base reference: [`contracts/deployments/base.json`](./contracts/deployments/base.json)), call `getOrCreate(seller)` before the first such settle, then `release()` later (99.9% / 0.1%). Address typos send funds to the wrong place — the gateway checksum-validates `SELLER` at startup. Do **not** hardcode private keys or operator secrets in source.

### Merchant registry (optional hosted multi-tenant)

Operator **`FEE_COLLECTOR`** is fixed: `0xa922F38041B5ee227c96A547F106F1330447e30E`. Each merchant gets their own [`FeeSplitter`](./contracts/README.md) (`seller` = merchant wallet, `feeCollector` = operator, `feeBps` = 10). The registry maps `merchantId` → splitter address (`payTo`) + seller for display. When `SELLER` is set, the registry is optional; `?merchant=` still works if you provide `MERCHANTS_JSON`.

**Register a merchant:**

1. Deploy `FeeSplitter` with `seller` = merchant wallet, `feeCollector` = `0xa922F38041B5ee227c96A547F106F1330447e30E`, `feeBps` = 10, and the chain’s native USDC as `asset`.
2. Add an entry to `MERCHANTS_JSON` (or `merchants.json` / copy from [`merchants.example.json`](./merchants.example.json)):
   ```json
   {
     "acme": {
       "seller": "0xMerchantWallet…",
       "payTo": "0xDeployedFeeSplitter…",
       "label": "Acme API"
     }
   }
   ```
3. Call gated APIs with `?merchant=acme` or header `x-merchant-id: acme` (case-insensitive). **Agents SHOULD always send merchant id.** If omitted, the gateway falls back to `DEFAULT_MERCHANT` (`demo`) — that means traffic (and USDC) can silently land on the demo FeeSplitter. Set `REQUIRE_MERCHANT=true` to reject missing merchant with `400 { "error": "merchant_required" }`. Unknown merchant on gated paths → `400` `{ "error": "unknown_merchant" }`.
4. Free listing: `GET /merchants` (also `/v1/merchants`).
5. Agent yellow pages: `GET /x402/discover` (alias `GET /discover`) — stable JSON catalog derived from the same registry / `SELLER` / demo. **JSON config stays supported**; there is no on-chain `Registry.sol` $5 stake in this release.

**Note:** The Base demo splitter has `seller` = `feeCollector` = operator — fine for demo. Real merchants need their own splitter with their wallet as `seller`.

CDP `createX402Server` uses a **single global** `payTo` for SDK init (`X402_PAY_TO` or the default merchant splitter). Per-request merchant routing rewrites `PAYMENT-REQUIRED` `accepts[].payTo` to the resolved FeeSplitter (same pattern as the https `resource.url` rewrite).

If `X402_PAY_TO` is still an EOA and you only have one merchant, behavior stays simple. Multi-merchant production should point each registry `payTo` at a deployed splitter — x402/`exact` credits that splitter via EIP-3009; call `release()` later (manually or via the optional keeper) to send 99.9% / 0.1%. Same contract on **Base / Arbitrum / Polygon** — see the [multi-chain FeeSplitter matrix](./contracts/README.md#multi-chain-usdc-matrix-production). This is **receive → later `release()`**, not an atomic same-transaction split and not OpenZeppelin `PaymentSplitter`.

### Discovery (live) + liquidity roadmap (planned)

**Ship now — Discovery only.** Free route `GET /x402/discover` (alias `/discover`) returns agent-readable yellow pages from **existing** sources (`MERCHANTS_JSON` / merchants file / `SELLER` / built-in demo) + `PUBLIC_BASE_URL`. No 402. Example shape:

```json
{
  "version": 1,
  "network": "eip155:8453",
  "updatedAt": "2026-09-03T00:00:00.000Z",
  "source": "merchants",
  "services": [{
    "id": "demo",
    "label": "demo (operator is also seller)",
    "endpoint": "https://your-host/v1/quote?merchant=demo",
    "mcp": "https://your-host/mcp",
    "capabilities": ["quote", "proxy", "fetch-md"],
    "price": "$0.001",
    "asset": "USDC",
    "payTo": "0x…",
    "seller": "0x…",
    "status": "demo"
  }]
}
```

`status` is health-honest: `live` only when CDP facilitator credentials + payTo are configured; otherwise `demo` (or `config` when accepts are non-live). This is **not** an on-chain Agent Registry.

**Planned (documented only — do not treat as shipped):**

| Track | Why not now |
|---|---|
| **Flash Liquidity Pool** (0-confirm advance across chains) | Capital-intensive: a solo founder cannot hold multi-chain USDC float. 0-confirm advance = **credit risk**. Need a circuit-breaker when the hot wallet balance is insufficient. If Superchain / AggLayer gets sub-second native interoperability, cross-chain friction \(S_{cross}\) → 0 and this track may shrink. |
| **Reverse Bounty** (pay agents to call) | Sybil drain if the seller subsidizes calls. Require rate-limit / per-agent identity / IP+fingerprint gates **before** any `claimBounty`. The current ~$20 Discord/X bounty stays a **manual operator payout** — not an on-chain claim. |

Full notes: [`docs/ROADMAP-LIQUIDITY.md`](./docs/ROADMAP-LIQUIDITY.md). No `depositBounty` / `claimBounty` on FeeSplitter and no fake “live” cross-chain clearing claims in this release.

> 发现层已上线（`GET /x402/discover`）；闪电流动性池与反向赏金仅为规划，见 roadmap。

### Gas vs micropayment floor (optional)

Micropayments ($0.001–$0.01) **assume Base low fees**. When L2 gas spikes, estimated settle cost can eat most of a tiny payment. Opt in with `X402_DYNAMIC_MIN_ENABLED=true`: a cached Base `baseFee` oracle (TTL 15–60s, no RPC spam) estimates gas USD (`gasUsedEstimate * baseFee * X402_ETH_USD`) and, if that exceeds `X402_GAS_COST_MAX_FRACTION` of the payment (default 50%), bumps the displayed/enforced minimum accept amount and may raise `feeFreeBelow` so FeeSplitter+`release()` isn’t used until larger amounts. Default is **OFF** so demo `$0.001` still works under normal conditions. Operators can also set a static `X402_MIN_PRICE_USDC`. Current effective mins are on `GET /health` → `gasFloor`.

### Security (gateway hardening)

Four defenses buyers and sellers should know about:

1. **Payment signature replay / race** — Idempotency key = SHA-256(`PAYMENT-SIGNATURE`). An in-process mutex + `PaymentDedupeStore` (memory today; Redis-shaped interface) does set-if-absent **before** upstream. Concurrent losers get `409 { "error": "payment_already_used" }`. Durable mark happens **only after settle success**; verify failure releases the pending reservation so honest retries are not bricked.
2. **SSRF on `/v1/fetch-md`** — Only `http`/`https`; DNS resolve rejects private/bogon/link-local/metadata; DNS is re-checked before fetch (rebinding defense); redirects are disabled.
3. **Upstream bypass** — Optional `UPSTREAM_SHARED_SECRET`: after payment, proxy injects `X-Tollgate-Secret` / `X-Tollgate-Paid` / `X-Tollgate-Timestamp`. Your upstream must require them (see snippet below). This is a shared-secret MVP, **not** mTLS.
4. **Base congestion / settle latency** — `X402_SETTLE_TIMEOUT_MS` (default 3 minutes) is separate from the short verify budget. If settle is still in progress when the waiter expires → `202 { "error": "payment_pending", "retry_with_same_proof": true }`. **Do not** create a new payment and **do not** treat the buyer as failed solely because HTTP timed out — retry the **same** proof; the gateway resumes without double-settling.

CDP facilitator is a **single-vendor** settle dependency by default; see [SECURITY.md](./SECURITY.md) for `X402_FACILITATOR_URL` (alternate facilitator when available — no multi-facilitator routing yet).

### Payment proof idempotency + settle pending

CDP x402 `exact` + EIP-3009 authorizations are **single-use at the facilitator** (nonce). The gateway additionally tracks each proof fingerprint as `pending` → `settled` → `consumed`:

| Store state | Client sees |
|---|---|
| `pending` (settle in flight / after settle-wait timeout) | `202 payment_pending` + `retry_with_same_proof: true` |
| `settled` (paid; upstream not delivered yet) | Skip re-settle; proxy once; mark `consumed` |
| `consumed` | `409 payment_already_used` |

Process-local only by default (restart clears). Facilitator remains authoritative for on-chain nonce uniqueness.

### Upstream trust header (Express example)

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const SECRET = process.env.UPSTREAM_SHARED_SECRET!;

export const requireTollgate: RequestHandler = (req, res, next) => {
  const secret = req.header("x-tollgate-secret") ?? "";
  const paid = req.header("x-tollgate-paid") ?? "";
  const ts = req.header("x-tollgate-timestamp") ?? "";
  const expected = createHmac("sha256", SECRET)
    .update(`${ts}.${req.method.toUpperCase()}.${req.path}`, "utf8")
    .digest("hex");
  const okSecret =
    secret.length === SECRET.length &&
    timingSafeEqual(Buffer.from(secret), Buffer.from(SECRET));
  const okPaid =
    paid.length === expected.length &&
    timingSafeEqual(Buffer.from(paid), Buffer.from(expected));
  if (!okSecret || !okPaid) {
    res.status(401).json({ error: "tollgate_required" });
    return;
  }
  next();
};

// app.use(requireTollgate); // reject public direct hits
```

Or import `verifyUpstreamTrustHeaders` from `x402-micro-tollgate` in your upstream process.

### Optional FeeSplitter release keeper

Scaffold in [`src/keeper.ts`](./src/keeper.ts). **Off by default** (`KEEPER_ENABLED` unset/false). When enabled, every `KEEPER_INTERVAL_MS` (default 1h) it checks USDC balances of registry `payTo` FeeSplitter addresses and calls `release()` when balance ≥ `KEEPER_MIN_USDC` (default `$1`).

**Warning:** Gas for `release()` can exceed the **0.1%** operator fee on sub-cent payments — hence the min-balance gate. Do **not** turn this on by default on Render. Prefer `KEEPER_DRY_RUN=true` (logs `keeper_would_release`) before using a real `KEEPER_PRIVATE_KEY`. Never commit keys.

---

## Bazaar discovery (agents find sellers)

[Bazaar](https://github.com/coinbase/x402/blob/main/docs/extensions/bazaar.mdx) is the x402 discovery catalog.

- **HTTP**: `createX402Server` auto-injects bazaar; we override with `discoverable: true`, descriptions, and input/output schemas (`GET /v1/quote` + gated prefix proxies).
- **MCP**: `x402ResourceServer` does **not** auto-declare Bazaar — we register `bazaarResourceServerExtension` and pass `declareDiscoveryExtension({ toolName, inputSchema, … })` on `get_quote` / `proxy_request`. Resource URL is `PUBLIC_BASE_URL/mcp` (a real http(s) URL, not a display name).

**To appear in Bazaar:**

1. Set `PUBLIC_BASE_URL` to a public **https** origin (localhost listings are a no-op for real crawlers).
2. Run with live CDP credentials + `X402_PAY_TO`.
3. Complete **one successful settlement** through the CDP facilitator (empty-body probes on gated routes return **402**, not 400).

Launch tip: share your `/mcp` or `/v1/quote` URL in Discord **#x402** after that first settlement.

---

## Pay in browser (Smart Wallet)

When a **browser** hits a gated route (`Accept: text/html` + Mozilla UA), the gateway returns a thin HTML paywall instead of JSON. Agents / MCP / `curl` keep the JSON 402 body.

### What you get

1. **Connect / create a Coinbase Smart Wallet** via the official [`@x402/paywall`](https://www.npmjs.com/package/@x402/paywall) EVM UI (Coinbase Wallet connector — Passkey Smart Wallet, **no MetaMask required**).
2. **Sign** the x402 `exact` EIP-3009 payment on Base (or Base Sepolia in development) and **retry** with `PAYMENT-SIGNATURE`.
3. **Get USDC** (optional): when server CDP keys are set, the paywall shows a **Get USDC** button that calls `POST /x402/session-token` and opens [Coinbase Onramp](https://docs.cdp.coinbase.com/onramp/introduction/quickstart). Apple Pay / card appear only if Onramp supports them for your domain — this repo does **not** fake Apple Pay outside Onramp, and does **not** claim a guaranteed “10 second Apple Pay” without Portal production access.

### Setup (buyer UX)

```bash
# .env — server secrets stay on the host
CDP_API_KEY_ID=…
CDP_API_KEY_SECRET=…
X402_PAY_TO=0x…          # or SELLER=0x…

# Public client key only (browser-safe)
CDP_CLIENT_API_KEY=…     # from portal.cdp.coinbase.com

# Optional but recommended for live demo / Bazaar
PUBLIC_BASE_URL=https://your.host
X402_ENVIRONMENT=development   # Base Sepolia (eip155:84532)
# X402_ENVIRONMENT=production  # Base mainnet (eip155:8453)
```

| Piece | Role |
|---|---|
| `CDP_CLIENT_API_KEY` | Injected into paywall HTML as `window.x402.cdpClientKey` |
| `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` | Facilitator settle **and** `POST /x402/session-token` (Onramp JWT) |
| `POST /x402/session-token` | Free path; body `{ "addresses": [{ "address": "0x…", "blockchains": ["base"] }], "assets": ["USDC"] }` → `{ token }` |

### Honesty / production notes

- **MVP networks:** Base Sepolia (`development`) and Base mainnet (`production` / `NETWORK=eip155:8453`).
- **Onramp production:** enable Onramp in CDP Portal, allowlist your domain, and complete any Apple Pay domain verification Coinbase requires. Until then, Smart Wallet pay + sign + retry still works; Get USDC may error or omit card rails.
- **CSP:** the paywall ships inline scripts (same as upstream `@x402/paywall`). Prefer not to set a strict `script-src` without nonces on 402 HTML responses.
- **Security:** wallet private keys never touch the frontend; only the public client key is embedded. Session tokens are minted server-side.

Try it: open `https://your-host/v1/quote` in Chrome after configuring the keys above.

---

## What it does

```
Agents / clients
   ├─ HTTP  /v1/*          → x402 402 JSON (agents) or Smart Wallet HTML paywall (browsers)
   ├─ GET   /v1/fetch-md   → paid HTML→Markdown demo (same x402 gate)
   ├─ GET   /x402/discover → free agent yellow pages (alias /discover; from merchants JSON)
   ├─ GET   /llms.txt      → free AI-crawler summary (alias /.well-known/llms.txt)
   ├─ GET   /openapi.yaml  → free OpenAPI 3.1 (alias /docs/openapi.yaml)
   ├─ POST  /x402/session-token → free Onramp session token (when CDP server keys set)
   ├─ GET   /merchants     → free merchant registry (id, label, seller, payTo)
   ├─ GET   /health        → free (+ paywall config flags)
   ├─ GET   /              → developer landing (EN / 中文)
   └─ MCP   /mcp           → server_info (free), get_quote + proxy_request (paid + bazaar)
```

| Surface | Stack |
|---|---|
| HTTP | `createX402Server` + `paymentMiddlewareFromHTTPServer` + `@x402/paywall` (browser) |
| MCP | `x402ResourceServer` + `createCdpFacilitatorClient` + `createPaymentWrapper` + Bazaar extension |

CLI: `npx x402-micro-tollgate@0.3.2` | `--seller 0x…` / `-s` | `--stdio` | `--port N`

Agent SEO: [`llms.txt`](./llms.txt) · [`docs/openapi.yaml`](./docs/openapi.yaml)

---

## Publishing

Package identity (must stay in sync):

- `package.json` `mcpName` = `io.github.kevin2003050666-coder/x402-micro-tollgate`
- `server.json` `name` = same string

Flow (needs tokens on a machine that has them — not this VM):

1. Public GitHub mirror at `kevin2003050666-coder/x402-micro-tollgate`
2. `npm publish` (or tag `v*` → `.github/workflows/publish-mcp.yml`)
3. `mcp-publisher publish` (OIDC) → official MCP Registry
4. PulseMCP auto-ingests from the official registry — **do not** submit to PulseMCP directly

Update `server.json` `remotes[0].url` to your real public `/mcp` before publishing remotes.

---

## Tests

```bash
npm test
```

No live CDP credentials required.

---

## License

MIT · See [CONTRIBUTING.md](./CONTRIBUTING.md) · [SECURITY.md](./SECURITY.md)
