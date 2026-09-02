# Security

## Reporting a vulnerability

Please open a **private** GitHub security advisory or an issue on:

https://github.com/kevin2003050666-coder/x402-micro-tollgate/issues

Do **not** include private keys, CDP secrets, or production pay-to wallet seeds in public issues.

## Scope notes

- This project is a thin x402 seller gateway. Settlement is performed by the **Coinbase CDP facilitator** when live credentials are configured. EIP-3009 payment authorization **nonces are single-use at the facilitator** (on-chain uniqueness source of truth).
- The gateway additionally fingerprints `PAYMENT-SIGNATURE` in a short-TTL in-memory LRU after successful settle to reject duplicate HTTP retries (`400 payment_replay`). This is defense-in-depth only — not a durable store and not a substitute for facilitator nonce checks.
- Demo mode does not settle on-chain; treat demo payment tokens (`PAYMENT-SIGNATURE: demo-settled`, MCP `_meta` demo payloads) as local-only.
- Optional FeeSplitter `release()` keeper (`KEEPER_*`) is **off by default**. Never commit `KEEPER_PRIVATE_KEY`.
- Permissionless seller: amounts **&lt; $10 USDC** (`FEE_FREE_BELOW_USDC=10000000`) pay the seller EOA directly; **≥ $10** use a CREATE2 `FeeSplitter` as `payTo`. Settlement only credits `payTo` — it does **not** run contract code or split in the same tx. Wrong seller / factory address → funds to the wrong wallet (validate EIP-55 checksums at startup).

## Secrets

Never commit `.env`. Rotate `CDP_API_KEY_*` if exposed. Prefer a dedicated receive address for `X402_PAY_TO` / `SELLER`. Never put keeper or wallet private keys in the repository.
