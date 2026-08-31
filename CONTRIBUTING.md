# Contributing

Thanks for interest in **x402-micro-tollgate**.

## Dev setup

```bash
cp .env.example .env
npm install
npm test
npm start
```

- Node.js 22+
- Without CDP keys the app runs in **demo mode** (HTTP 402 + MCP PaymentRequired still work)

## Principles

- Keep the gateway **thin**: HTTP 402 proxy + MCP paid tools, official CDP/x402 only
- No SaaS dashboard, no custom facilitator, no PulseMCP direct submit
- Prefer small PRs with tests (`npm test` must pass without live CDP credentials)

## Bazaar / discovery

If you change paid routes or tools, keep Bazaar extensions (`discoverable: true` + schemas) in sync. Set `PUBLIC_BASE_URL` to a public `https://` origin when testing discovery; localhost URLs will not catalog usefully.

## Issues

Use GitHub Issues on [kevin2003050666-coder/x402-micro-tollgate](https://github.com/kevin2003050666-coder/x402-micro-tollgate). Security: see [SECURITY.md](./SECURITY.md).

## License

MIT
