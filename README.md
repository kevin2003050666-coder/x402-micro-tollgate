# x402-micro-tollgate

**Make any API pay-per-call for agents in 5 minutes.**

Thin seller-side [x402](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers) gateway + MCP server. Unpaid gated HTTP → `402`. Agents pay USDC, then the request is proxied to your upstream. Same process exposes MCP tools that charge per call. Paid surfaces declare the **Bazaar** discovery extension so agents can find you after a real CDP settlement.

**Security backed by Coinbase CDP.** We don't touch your keys or settle payments on custom cryptography — EIP-3009 authorization nonces are single-use at the CDP facilitator (source of truth for on-chain uniqueness). The gateway also keeps a short-TTL in-memory fingerprint of `PAYMENT-SIGNATURE` as duplicate-request protection (not a substitute for facilitator nonce checks).

Self-hosted drop-in HTTP 402 + MCP paywall — monetization is the protocol/toll fee (optional **0.1%** via custom [`FeeSplitter`](./contracts/README.md) **receive → later `release()`**, not OpenZeppelin PaymentSplitter and not same-tx atomic split), not monthly hosting. Questions: [`2767111713@qq.com`](mailto:2767111713@qq.com?subject=x402-micro-tollgate).

Self-host is free (MIT). Repo: [github.com/kevin2003050666-coder/x402-micro-tollgate](https://github.com/kevin2003050666-coder/x402-micro-tollgate)

> Not an official Coinbase product. Not a full A2A marketplace. Not a billing SaaS. A sharp tollgate.

### Permissionless seller (one line)

```ts
import express from "express";
import { x402Tollgate } from "x402-micro-tollgate";

const app = express();
app.use("/v1", await x402Tollgate({ seller: process.env.SELLER! }));
```

Or set `SELLER` / `X402_SELLER` in `.env` and run `npm start`. **&lt; $10 USDC** per payment → `payTo` = seller EOA (0 protocol fee). **≥ $10** → CREATE2 [`FeeSplitter`](./contracts/README.md) (deploy factory once, `getOrCreate(seller)` before first ≥$10 settle, then `release()`). `MERCHANTS_JSON` stays optional for hosted multi-tenant.

---

## 1-minute quickstart

Requires Node.js 22+.

```bash
git clone https://github.com/kevin2003050666-coder/x402-micro-tollgate
cd x402-micro-tollgate && cp .env.example .env
# set CDP_API_KEY_ID, CDP_API_KEY_SECRET, X402_PAY_TO (optional: PUBLIC_BASE_URL, UPSTREAM_URL)
npm i && npm start
# curl http://127.0.0.1:8402/health   → 200
# curl http://127.0.0.1:8402/v1/quote → 402
# curl "http://127.0.0.1:8402/v1/fetch-md?url=https://example.com" → 402 (paid HTML→Markdown demo)
```

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
      "args": ["x402-micro-tollgate", "--stdio"],
      "env": {
        "X402_PAY_TO": "0xYourReceivingAddress",
        "CDP_API_KEY_ID": "...",
        "CDP_API_KEY_SECRET": "...",
        "PUBLIC_BASE_URL": "https://your.public.host"
      }
    }
  }
}
```

---

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kevin2003050666-coder/x402-micro-tollgate)

Uses [`render.yaml`](./render.yaml): Node 22, `npm start`, health `/health`, env names from [`.env.example`](./.env.example). Set `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `X402_PAY_TO` in the dashboard for live settlement; set `PUBLIC_BASE_URL` to your `https://….onrender.com` origin for Bazaar.

**Self-host production:** Docker — `docker compose up --build` (see [`Dockerfile`](./Dockerfile) / [`docker-compose.yml`](./docker-compose.yml)).

---

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8402` | HTTP listen port |
| `UPSTREAM_URL` | _(unset → mock)_ | Your API origin |
| `X402_PAY_TO` | — | EVM receive address (live mode SDK init) |
| `SELLER` / `X402_SELLER` | — | Permissionless seller EOA (EIP-55 validated; invalid → startup fail) |
| `FACTORY_ADDRESS` | — | `FeeSplitterFactory` for CREATE2 predict when amount ≥ threshold |
| `FEE_FREE_BELOW_USDC` | `10000000` | Atomic USDC (6 decimals). **&lt; $10** → payTo=seller; **≥ $10** → FeeSplitter |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | CDP facilitator |
| `PRICE` | `$0.001` | Network default USDC |
| `NETWORK` | `eip155:84532` / `8453` | CAIP-2 |
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
| `PAYMENT_DEDUPE_TTL_MS` | `600000` | In-memory `PAYMENT-SIGNATURE` replay window (10 min). CDP facilitator nonce remains source of truth |
| `PAYMENT_DEDUPE_MAX_ENTRIES` | `10000` | Max fingerprints in the gateway LRU (no Redis) |
| `KEEPER_ENABLED` | `false` | Optional FeeSplitter `release()` keeper — **never on by default** |
| `KEEPER_DRY_RUN` | _(see notes)_ | `true` logs `keeper_would_release` without sending txs |
| `KEEPER_PRIVATE_KEY` | — | EVM key for live `release()` only (never commit) |
| `KEEPER_RPC_URL` | Base public RPC | JSON-RPC endpoint for balance + release |
| `KEEPER_INTERVAL_MS` | `3600000` | Poll interval (1h) |
| `KEEPER_MIN_USDC` | `1000000` | Min USDC balance (atomic) before `release()` — default $1 |

### Permissionless seller + $10 threshold

Toward **0.3.0**: set `SELLER` (or use `x402Tollgate({ seller })`). No `MERCHANTS_JSON` required.

| Amount (USDC atomic, 6 decimals) | `accepts[].payTo` |
|---|---|
| **&lt; `10_000_000` ($10)** | seller EOA — **0 protocol fee** |
| **≥ `10_000_000` ($10)** | CREATE2-predicted `FeeSplitter` for that seller |

x402 `exact` + EIP-3009 only **credits** `payTo` — it does not execute `FeeSplitter` / factory code and does **not** split in the same transaction. For ≥ $10: deploy [`FeeSplitterFactory`](./contracts/README.md), set `FACTORY_ADDRESS`, call `getOrCreate(seller)` before the first such settle, then `release()` later (99.9% / 0.1%). Address typos send funds to the wrong place — the gateway checksum-validates `SELLER` at startup.

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

**Note:** The Base demo splitter has `seller` = `feeCollector` = operator — fine for demo. Real merchants need their own splitter with their wallet as `seller`.

CDP `createX402Server` uses a **single global** `payTo` for SDK init (`X402_PAY_TO` or the default merchant splitter). Per-request merchant routing rewrites `PAYMENT-REQUIRED` `accepts[].payTo` to the resolved FeeSplitter (same pattern as the https `resource.url` rewrite).

If `X402_PAY_TO` is still an EOA and you only have one merchant, behavior stays simple. Multi-merchant production should point each registry `payTo` at a deployed splitter — x402/`exact` credits that splitter via EIP-3009; call `release()` later (manually or via the optional keeper) to send 99.9% / 0.1%. Same contract on **Base / Arbitrum / Polygon** — see the [multi-chain FeeSplitter matrix](./contracts/README.md#multi-chain-usdc-matrix-production). This is **receive → later `release()`**, not an atomic same-transaction split and not OpenZeppelin `PaymentSplitter`.

### Payment signature dedupe (gateway)

CDP x402 `exact` + EIP-3009 authorizations are **single-use at the facilitator** (nonce). After a successful settle, the Express gateway also records a SHA-256 fingerprint of the `PAYMENT-SIGNATURE` / `payment-signature` header in an in-memory LRU/TTL map (default TTL 10 minutes, max 10 000 entries). Replaying the same signature string on a gated path within that window returns `400 { "error": "payment_replay" }`. No Redis — process-local only. Restart clears the cache; the facilitator remains authoritative for on-chain nonce uniqueness.

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

## What it does

```
Agents / clients
   ├─ HTTP  /v1/*          → x402 402 (+ bazaar) or proxy → UPSTREAM_URL
   ├─ GET   /v1/fetch-md   → paid HTML→Markdown demo (same x402 gate)
   ├─ GET   /merchants     → free merchant registry (id, label, seller, payTo)
   ├─ GET   /health        → free
   ├─ GET   /              → developer landing (EN / 中文)
   └─ MCP   /mcp           → server_info (free), get_quote + proxy_request (paid + bazaar)
```

| Surface | Stack |
|---|---|
| HTTP | `createX402Server` + `paymentMiddlewareFromHTTPServer` |
| MCP | `x402ResourceServer` + `createCdpFacilitatorClient` + `createPaymentWrapper` + Bazaar extension |

CLI: `npx x402-micro-tollgate` | `--stdio` | `--port N`

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
