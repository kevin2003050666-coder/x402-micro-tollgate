# Roadmap: Bi-directional Liquidity Routing (Planned)

> **Status:** Discovery is **live** (`GET /x402/discover`). Flash Liquidity Pool and Reverse Bounty are **planned only** — not implemented in this release. Do not claim live cross-chain clearing or on-chain bounty claims.

Kevin’s three-track sketch for a Bi-directional Liquidity Routing Network:

| Track | Role | This release |
|---|---|---|
| **Discovery** | Agent Registry / yellow pages | **Shipped (thin):** JSON catalog from existing `MERCHANTS_JSON` / merchants file / `SELLER` / demo. No `Registry.sol`, no $5 stake. |
| **Clearing** | Flash Liquidity Pool | **Planned** — see below |
| **Incentive** | Reverse Bounty | **Planned** — see below |

## Discovery (live — thin)

- Free HTTP: `GET /x402/discover` (alias `GET /discover`)
- Stable shape: `version`, `network`, `updatedAt`, `source`, `services[]`
- Derived from the same merchant registry operators already use — **JSON config remains supported**
- `status` is honest (`live` / `demo` / `config`) — never fake “live” settle

## Flash Liquidity Pool (planned — not implemented)

**Idea:** 0-confirm advance of USDC across chains so an agent can pay on chain A and a seller receives on chain B without waiting for native finality.

**Why not ship now:**

1. **Capital-intensive** — a solo founder cannot hold multi-chain USDC float for advances.
2. **Credit risk** — 0-confirm advance is an unsecured loan until the source-leg settles; reorgs / failed settle leave the pool underwater.
3. **Circuit-breaker required** — when the hot wallet balance is insufficient, advances must refuse rather than over-promise.

**Future escape hatch:** if Superchain / AggLayer (or similar) delivers sub-second **native** interoperability, cross-chain friction \(S_{cross}\) → 0 and a flash pool may become unnecessary or much thinner.

**Non-goals for now:** no Solana→Base 0-confirm advance, no settle/advance/claim APIs, no Solidity Flash pool.

## Reverse Bounty (planned — not implemented)

**Idea:** sellers subsidize agents to call APIs (`depositBounty` / `claimBounty`) to bootstrap discovery traffic.

**Why not ship now:**

1. **Sybil drain** — if anyone can claim, bots empty the bounty.
2. **Gates before claim** — rate-limit, per-agent identity, and IP + fingerprint checks are required **before** any `claimBounty`.
3. **Manual payout today** — the ~$20 Discord / X operator bounty stays an **off-chain manual payout**, not an on-chain claim.

**Non-goals for now:** no `depositBounty` / `claimBounty` on FeeSplitter; no on-chain bounty vault.

## Contracts note

FeeSplitter remains **receive → later `release()`** only. Do not add Registry / Bounty / Flash interfaces in production Solidity until capital + Sybil gates are designed. A one-line stub comment may appear under [`contracts/README.md`](../contracts/README.md); no deployable contracts for these tracks in this PR.

## 中文摘要

- **已上线：** 发现层 `GET /x402/discover`（来自现有商户 JSON / SELLER / demo，非链上 Registry）。
- **规划中：** 闪电流动性池（跨链 0-confirm 垫资 = 资金与信用风险）；反向赏金（需限流与身份门控，当前 Discord/X 赏金仍为人工打款）。
