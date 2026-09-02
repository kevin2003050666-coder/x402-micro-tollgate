# FeeSplitter — multi-chain receive + release (not same-tx auto-split)

Skeleton + CREATE2 factory. **Do not deploy factory from CI** (no keys). Live Render / npm gateway stays demo-safe until an operator deploys a factory (or per-merchant splitter) and sets env.

Same Solidity on every supported EVM chain — only the constructor `asset` (native Circle USDC) changes per network.

## Why receive + release?

Coinbase CDP + x402 `exact` settles USDC with EIP-3009 `transferWithAuthorization` to `payTo`. That transfer updates balances inside the USDC contract; it does **not** call receiver bytecode. A splitter as `payTo` therefore only **accumulates** USDC. A later permissionless `release()` (or pull) sends:

| Share | Destination |
|---|---|
| `balance * feeBps / 10000` | `feeCollector` (operator wallet) |
| remainder | `seller` |

Default `feeBps = 10` → **0.1%**. Integer division floors: when `balance * feeBps < 10000`, fee is **0**. At 10 bps, `$0.001` USDC (= **1000** atomic units, 6 decimals) yields `1000 * 10 / 10000 = **1**` atomic fee.

There is no same-tx auto-split path in CDP/x402 `exact` unless a future facilitator path explicitly calls into the contract (none documented for this flow). **Do not** invent atomic `DynamicFeeSplitter.pay(seller)` settlement — tokens only credit `payTo`.

## FeeSplitterFactory (CREATE2)

[`FeeSplitterFactory.sol`](./FeeSplitterFactory.sol) deploys per-seller [`FeeSplitter`](./FeeSplitter.sol) with:

- Immutable `feeCollector`, `asset`, `feeBps` (set once at factory deploy)
- Salt = `bytes32(uint256(uint160(seller)))` — one splitter address per seller per factory
- `predictAddress(seller)` — counterfactual payTo (gateway uses the same CREATE2 math off-chain)
- `create(seller)` / `getOrCreate(seller)` — operator/deploy helper; **buyers never call the factory**
- `Deployed(seller, splitter)` event

### Gateway threshold (permissionless seller)

| Single payment amount (USDC, 6 decimals) | `payTo` |
|---|---|
| **&lt; `10_000_000` ($10)** | seller EOA — **0 protocol fee** |
| **≥ `10_000_000` ($10)** | CREATE2-predicted FeeSplitter — later `release()` → 99.9% / 0.1% |

Env: `FEE_FREE_BELOW_USDC` (default `10000000`), `FACTORY_ADDRESS`, `SELLER` / `X402_SELLER`.

**Before the first ≥ $10 settle:** operator must `getOrCreate(seller)` (Remix / cast / script) so the predicted address has code. EIP-3009 will not deploy the contract. Typo risk: a wrong seller address → funds to a wrong EOA or wrong counterfactual splitter — validate checksums at gateway startup.

Off-chain predict uses the FeeSplitter creation bytecode in `src/fee-splitter-bytecode.ts` (regenerate with `npm run generate:feesplitter-bytecode` after editing `FeeSplitter.sol`; needs `solc`).

## Multi-chain USDC / USDT matrix

Native Circle USDC and canonical/bridged USDT where known. Gateway catalog status: **live** (CDP facilitator documents `exact`), **config-ready** (addresses wired), **planned** (docs only). See root README.

| Chain | CAIP-2 | USDC | USDT | Status | Factory |
|---|---|---|---|---|---|
| Base | `eip155:8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0xfde4C96c8593536E31F1268f9C6E2eC6A3CEF3b2` | live | **live** [`deployments/base.json`](./deployments/base.json) |
| Optimism | `eip155:10` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `0x94b008aA00579c1307B0AD2A4316A7eD9A5E2e5c` | config-ready | stub |
| Arbitrum One | `eip155:42161` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | live | stub |
| Polygon PoS | `eip155:137` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | live | stub |
| BSC | `eip155:56` | peg 18dec | peg 18dec | config-ready | stub |
| Ethereum | `eip155:1` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | config-ready | stub |
| Avalanche | `eip155:43114` | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7` | config-ready | stub |

Constructor inputs shared across chains for **FeeSplitter**: `seller`, `feeCollector`, `asset` (USDC or chosen ERC-20), `feeBps = 10`. For **FeeSplitterFactory**: `feeCollector`, `asset`, `feeBps = 10`. See [`deploy-args.example.json`](./deploy-args.example.json) and per-chain stubs under [`deployments/`](./deployments/).

### Testnets (optional)

For dry-runs only — not required for production readiness:

| Chain | CAIP-2 | USDC (test) | Note |
|---|---|---|---|
| Base Sepolia | `eip155:84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | CDP lists `exact`; Remix → **Base Sepolia** |
| Arbitrum Sepolia | `eip155:421614` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Circle testnet USDC; confirm CDP support before relying on it |
| Polygon PoS Amoy | `eip155:80002` | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | Circle testnet USDC; confirm CDP support before relying on it |

## Limitations

- **FeeSplitter is ERC-20 EVM only.** Solana/TRON need separate adapters — gateway marks them experimental/planned.
- **USDT** uses Permit2 in x402 accepts (not EIP-3009). Factory live path in this repo is **Base USDC**.
- **EIP-3009 settle still only credits `payTo`.** Settlement does not invoke splitter logic or the factory; operators must deploy via `getOrCreate` before ≥ $10 settles, then call `release()` later.
- Do **not** commit private keys. Operator **`feeCollector`** defaults to `0xa922F38041B5ee227c96A547F106F1330447e30E`.

## Deploy (Remix) — operator steps

### A) Permissionless factory (0.3.0)

1. Open [Remix](https://remix.ethereum.org); paste [`FeeSplitter.sol`](./FeeSplitter.sol) + [`FeeSplitterFactory.sol`](./FeeSplitterFactory.sol) (same folder / import path).
2. Compile with Solidity `0.8.20+`, **optimizer enabled, runs=200** (must match `src/fee-splitter-bytecode.ts` for off-chain CREATE2 predict).
3. Deploy `FeeSplitterFactory` with:
   - `feeCollector_` — `0xa922F38041B5ee227c96A547F106F1330447e30E` (or your override)
   - `asset_` — chain native USDC from the matrix
   - `feeBps_` — `10`
4. Set gateway `FACTORY_ADDRESS` to the factory (operator-set; do **not** hardcode secrets). Live Base deployment: [`deployments/base.json`](./deployments/base.json).
5. Set `SELLER` to the seller EOA, `FEE_FREE_BELOW_USDC=10000000`.
6. Before first payment ≥ $10 to that seller: call `getOrCreate(seller)` once (anyone can call; gas paid by caller).
7. After USDC accumulates on the splitter, anyone can call `release()` (or optional `KEEPER_*`, **off by default**).

### B) Hosted multi-tenant (MERCHANTS_JSON — optional compat)

1. Deploy `FeeSplitter` per merchant (or use factory `getOrCreate`).
2. Register in `MERCHANTS_JSON` / `merchants.json` as that merchant’s `payTo`.
3. Call gated APIs with `?merchant=id` / `x-merchant-id`. Registry `payTo` is used as-is (no amount threshold rewrite).

## Gateway note

`FEE_BPS` / `FEE_COLLECTOR` / `FACTORY_ADDRESS` / `FEE_FREE_BELOW_USDC` are documented in the root README. They do **not** change CDP facilitator behavior. Permissionless path: `x402Tollgate({ seller })` or env `SELLER`. Hosted path: `MERCHANTS_JSON` remains optional when seller is set.
