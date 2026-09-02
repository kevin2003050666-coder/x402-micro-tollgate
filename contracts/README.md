# FeeSplitter — multi-chain receive + release (not same-tx auto-split)

Skeleton only. **Do not deploy from this PR.** Live Render / npm gateway behavior is unchanged until an operator deploys a splitter and sets `X402_PAY_TO` to its address.

Same Solidity on every supported EVM chain — only the constructor `asset` (native Circle USDC) changes per network.

## Why receive + release?

Coinbase CDP + x402 `exact` settles USDC with EIP-3009 `transferWithAuthorization` to `payTo`. That transfer updates balances inside the USDC contract; it does **not** call receiver bytecode. A splitter as `payTo` therefore only **accumulates** USDC. A later permissionless `release()` (or pull) sends:

| Share | Destination |
|---|---|
| `balance * feeBps / 10000` | `feeCollector` (operator wallet) |
| remainder | `seller` |

Default `feeBps = 10` → **0.1%**. Integer division floors: when `balance * feeBps < 10000`, fee is **0**. At 10 bps, `$0.001` USDC (= **1000** atomic units, 6 decimals) yields `1000 * 10 / 10000 = **1**` atomic fee.

There is no same-tx auto-split path in CDP/x402 `exact` unless a future facilitator path explicitly calls into the contract (none documented for this flow).

## Multi-chain USDC matrix (production)

Native Circle USDC addresses from [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses). CDP x402 `exact` network support from [CDP network support](https://docs.cdp.coinbase.com/x402/network-support). Use **native USDC**, not bridged `USDC.e`.

| Chain | CAIP-2 | Native USDC (`asset`) | x402 / CDP note | Remix network tip |
|---|---|---|---|---|
| Base | `eip155:8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | CDP facilitator: `exact` (production) | MetaMask → **Base** → deploy with Base USDC as `asset_` |
| Arbitrum One | `eip155:42161` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | CDP facilitator: `exact` (production) | MetaMask → **Arbitrum One** → deploy with Arb native USDC (not `USDC.e`) |
| Polygon PoS | `eip155:137` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | CDP facilitator: `exact` (production) | MetaMask → **Polygon** → deploy with native USDC (not bridged `0x2791…`) |

Constructor inputs shared across chains: `seller`, `feeCollector`, `asset` (row above), `feeBps = 10`. See [`deploy-args.example.json`](./deploy-args.example.json).

### Testnets (optional)

For dry-runs only — not required for production readiness:

| Chain | CAIP-2 | USDC (test) | Note |
|---|---|---|---|
| Base Sepolia | `eip155:84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | CDP lists `exact`; Remix → **Base Sepolia** |
| Arbitrum Sepolia | `eip155:421614` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Circle testnet USDC; confirm CDP support before relying on it |
| Polygon PoS Amoy | `eip155:80002` | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | Circle testnet USDC; confirm CDP support before relying on it |

## Limitations

- **ERC-20 EVM only.** This contract assumes a standard ERC-20 `balanceOf` / `transfer` surface (Circle native USDC on EVM).
- **Solana, BNB Chain, and non-USDC assets** need separate adapters / work — out of scope here.
- **EIP-3009 settle still only credits `payTo`.** Settlement does not invoke splitter logic; operators must call `release()` later.
- Do **not** commit private keys. For this product, operator **`feeCollector`** is fixed at `0xa922F38041B5ee227c96A547F106F1330447e30E` (see root README merchant registry). Do **not** force the live gateway `X402_PAY_TO` to a single splitter from this repo — use the merchant registry instead.

## Deploy (Remix) — operator steps

1. Open [Remix](https://remix.ethereum.org) and paste [`FeeSplitter.sol`](./FeeSplitter.sol).
2. Compile with Solidity `0.8.20+` (optimizer optional).
3. Connect MetaMask (or similar) to the target chain from the matrix and deploy `FeeSplitter` with:
   - `seller_` — seller receive wallet
   - `feeCollector_` — operator fee wallet
   - `asset_` — that chain’s native USDC from the matrix
   - `feeBps_` — `10`
4. Register the splitter in the gateway merchant registry (`MERCHANTS_JSON` / `merchants.json`) as that merchant’s `payTo`. Optionally set `X402_PAY_TO` to the default merchant splitter for CDP SDK init (global); per-request `payTo` is rewritten from the registry. Set `NETWORK` to the matching CAIP-2.
5. Optionally set `FEE_BPS=10` and leave `FEE_COLLECTOR` unset (defaults to the fixed operator `0xa922…7e30E`) for ops clarity. While `X402_PAY_TO` remains an EOA, the node still pays **100%** to that EOA (no fee take) unless the registry advertises a splitter.
6. After payments accumulate on the splitter, anyone can call `release()`.

## Gateway note

`FEE_BPS` / `FEE_COLLECTOR` are compile-safe config knobs documented in the root README. They do **not** change the CDP live settle path by themselves — wiring `X402_PAY_TO` to a deployed splitter is the operator switch.
