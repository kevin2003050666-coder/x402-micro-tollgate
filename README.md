# x402-micro-tollgate

**Make any API pay-per-call for agents in 5 minutes.**

Thin seller-side [x402](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers) gateway + MCP server. Unpaid gated HTTP → `402`. Agents pay USDC, then the request is proxied to your upstream. Same process exposes MCP tools that charge per call. Paid surfaces declare the **Bazaar** discovery extension so agents can find you after a real CDP settlement.

**Hosted waitlist — $9.90/mo.** Don’t want to run the node? Skip SSL, public IP, and uptime babysitting — we host the tollgate. Email [`2767111713@qq.com`](mailto:2767111713@qq.com?subject=x402-micro-tollgate%20hosted%20waitlist%20%249.90) (same CTA on `/`).

Self-host is free (MIT). Repo: [github.com/kevin2003050666-coder/x402-micro-tollgate](https://github.com/kevin2003050666-coder/x402-micro-tollgate)

> Not a full A2A marketplace. Not a billing SaaS. A sharp tollgate.

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
| `X402_PAY_TO` | — | EVM receive address (live mode) |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | CDP facilitator |
| `PRICE` | `$0.001` | Network default USDC |
| `NETWORK` | `eip155:84532` / `8453` | CAIP-2 |
| `X402_ENVIRONMENT` | `development` | or `production` |
| `GATED_PREFIX` | `/v1` | HTTP paths that require payment |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:$PORT` | Public `https://` origin for Bazaar resource URLs |
| `WAITLIST_EMAIL` | `2767111713@qq.com` | Landing waitlist mailto |

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
   ├─ HTTP  /v1/*     → x402 402 (+ bazaar) or proxy → UPSTREAM_URL
   ├─ GET   /health   → free
   ├─ GET   /         → developer landing (EN / 中文)
   └─ MCP   /mcp      → server_info (free), get_quote + proxy_request (paid + bazaar)
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
