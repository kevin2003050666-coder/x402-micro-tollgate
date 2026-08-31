# Security

## Reporting a vulnerability

Please open a **private** GitHub security advisory or an issue on:

https://github.com/kevin2003050666-coder/x402-micro-tollgate/issues

Do **not** include private keys, CDP secrets, or production pay-to wallet seeds in public issues.

## Scope notes

- This project is a thin x402 seller gateway. Settlement is performed by the **Coinbase CDP facilitator** when live credentials are configured.
- Demo mode does not settle on-chain; treat demo payment tokens (`PAYMENT-SIGNATURE: demo-settled`, MCP `_meta` demo payloads) as local-only.

## Secrets

Never commit `.env`. Rotate `CDP_API_KEY_*` if exposed. Prefer a dedicated receive address for `X402_PAY_TO`.
