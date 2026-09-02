# FeeSplitter (Base) — receive + release, not same-tx auto-split

Skeleton only. **Do not deploy from this PR.** Live Render / npm gateway behavior is unchanged until an operator deploys a splitter and sets `X402_PAY_TO` to its address.

## Why receive + release?

Coinbase CDP + x402 `exact` on Base settles USDC with EIP-3009 `transferWithAuthorization` to `payTo`. That transfer updates balances inside the USDC contract; it does **not** call receiver bytecode. A splitter as `payTo` therefore only **accumulates** USDC. A later permissionless `release()` (or pull) sends:

| Share | Destination |
|---|---|
| `balance * feeBps / 10000` | `feeCollector` (operator wallet) |
| remainder | `seller` |

Default `feeBps = 10` → **0.1%**. Integer division floors: when `balance * feeBps < 10000`, fee is **0**. At 10 bps, `$0.001` USDC (= **1000** atomic units, 6 decimals) yields `1000 * 10 / 10000 = **1**` atomic fee.

There is no same-tx auto-split path in CDP/x402 `exact` unless a future facilitator path explicitly calls into the contract (none documented for this flow).

## Addresses

| Item | Value |
|---|---|
| Base mainnet USDC (`asset`) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `feeCollector` | Your operator wallet — leave as deploy/env input; **do not hardcode a key** |
| `seller` | Seller payout wallet |
| `feeBps` | `10` (0.1%) unless you intentionally change it |

## Deploy (Remix → Base) — operator steps

1. Open [Remix](https://remix.ethereum.org) and paste [`FeeSplitter.sol`](./FeeSplitter.sol).
2. Compile with Solidity `0.8.20+` (optimizer optional).
3. Connect MetaMask (or similar) to **Base** and deploy `FeeSplitter` with:
   - `seller_` — seller receive wallet
   - `feeCollector_` — operator fee wallet
   - `asset_` — Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
   - `feeBps_` — `10`
4. Set gateway env `X402_PAY_TO=<FeeSplitter address>`.
5. Optionally set `FEE_BPS=10` and `FEE_COLLECTOR=<same operator wallet>` on the node for documentation / ops clarity. While `X402_PAY_TO` remains an EOA, the node still pays **100%** to that EOA (no fee take).
6. After payments accumulate on the splitter, anyone can call `release()`.

## Gateway note

`FEE_BPS` / `FEE_COLLECTOR` are compile-safe config knobs documented in the root README. They do **not** change the CDP live settle path by themselves — wiring `X402_PAY_TO` to a deployed splitter is the operator switch.
