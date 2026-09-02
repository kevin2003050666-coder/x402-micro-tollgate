# Security

## Reporting a vulnerability

Please open a **private** GitHub security advisory or an issue on:

https://github.com/kevin2003050666-coder/x402-micro-tollgate/issues

Do **not** include private keys, CDP secrets, or production pay-to wallet seeds in public issues.

## Scope notes

- This project is a thin x402 seller gateway. Settlement is performed by the **Coinbase CDP facilitator** when live credentials are configured (single-vendor by default). EIP-3009 payment authorization **nonces are single-use at the facilitator** (on-chain uniqueness source of truth).
- **Facilitator single-vendor risk:** Live settle depends on CDP’s hosted facilitator (`https://api.cdp.coinbase.com/platform/v2/x402` by default). Set `X402_FACILITATOR_URL` / `CDP_FACILITATOR_URL` to point MCP’s `createCdpFacilitatorClient({ baseUrl })` at an alternate facilitator when one is available. HTTP live `createX402Server` still uses the CDP default until the SDK exposes an override. **There is no multi-facilitator routing / failover engine yet** — treat facilitator availability as an operational dependency.
- **Payment proof idempotency:** SHA-256(`PAYMENT-SIGNATURE`) keys an in-process mutex + `PaymentDedupeStore` (memory LRU/TTL; Redis-ready interface). Concurrent duplicates → `409 payment_already_used`. Durable mark only after settle success; verify failure releases pending so honest retries work.
- **Settle latency (Base congestion):** `X402_SETTLE_TIMEOUT_MS` (default 3 minutes) waits for facilitator/on-chain settle. On timeout → `202 payment_pending` + `retry_with_same_proof`. Never treat the buyer payment as failed solely because HTTP timed out if settle may still confirm — retry the **same** Authorization.
- **Gas vs micropayment (optional):** `X402_DYNAMIC_MIN_ENABLED` (default **off**) reads a cached Base `baseFee` and may raise the effective minimum accept amount / `feeFreeBelow` when estimated L2 gas would consume more than `X402_GAS_COST_MAX_FRACTION` of the payment. See `/health` → `gasFloor`. Does not spam RPC (TTL 15–60s).
- **SSRF:** `/v1/fetch-md` allows only http(s), blocks private/bogon/link-local/metadata after DNS resolve, re-checks DNS before fetch, and does not follow redirects.
- **Upstream trust:** Optional `UPSTREAM_SHARED_SECRET` / `X402_UPSTREAM_SECRET` injects `X-Tollgate-Secret` + HMAC `X-Tollgate-Paid` after payment. Upstream must require these headers. Shared-secret MVP only — **not** mTLS.
- Demo mode does not settle on-chain; treat demo payment tokens (`PAYMENT-SIGNATURE: demo-settled`, MCP `_meta` demo payloads) as local-only.
- Optional FeeSplitter `release()` keeper (`KEEPER_*`) is **off by default**. Never commit `KEEPER_PRIVATE_KEY`.
- Permissionless seller: amounts **&lt; $10 USDC** (`FEE_FREE_BELOW_USDC=10000000`) pay the seller EOA directly; **≥ $10** use a CREATE2 `FeeSplitter` as `payTo`. Settlement only credits `payTo` — it does **not** run contract code or split in the same tx. Wrong seller / factory address → funds to the wrong wallet (validate EIP-55 checksums at startup).

## Secrets

Never commit `.env`. Rotate `CDP_API_KEY_*` and `UPSTREAM_SHARED_SECRET` if exposed. Prefer a dedicated receive address for `X402_PAY_TO` / `SELLER`. Never put keeper or wallet private keys in the repository.
