# Why HTTP 402 for agents

Agents do not have credit cards. Monthly SaaS + KYC is human UX.
HTTP 402 + Base USDC is per-call, no signup.

## Stack

- **Seller:** `x402-micro-tollgate` — HTTP 402 paywall, EIP-3009 `TransferWithAuthorization`, FeeSplitter (fee-free under $10, straight to the seller EOA).
- **Buyer:** `createX402Fetch` from `x402-micro-tollgate/client` — single-call and session budgets, exactly 1 automatic retry, and a three-dimensional circuit breaker (rate / minute spend / request fingerprint).

## Proof

- Live node: https://x402-micro-tollgate.onrender.com (`/health`, `/x402/discover`, `/llms.txt`, `/openapi.yaml`)
- npm: `x402-micro-tollgate@0.3.3`
- FeeSplitterFactory (Base): `0x20387e081E6fa05cdE0DBb42765D7C62e70e836a`
- Demo FeeSplitter (Base): `0xC20bC6cAc978f8d2AE94Ee9D41F2DF396A5f10fE`

## Manifesto

MIT. Fork it. Do not rent agents a subscription — let them pay per call.

Independent open source. Not an official Coinbase or Binance product.
