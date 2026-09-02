// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC-20 surface used by FeeSplitter (native Circle USDC on EVM).
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title FeeSplitter
 * @notice Receive USDC as x402 `payTo`, then permissionlessly release seller + fee shares.
 *
 * Chain-agnostic: pass the target chain's native Circle USDC as `asset_` (Base / Arbitrum /
 * Polygon — see contracts/README.md). Logic is identical across EVM networks.
 *
 * Coinbase CDP + x402 `exact` settles via EIP-3009 `transferWithAuthorization`
 * to `payTo`. That only credits the token balance of `payTo` — it does **not** execute
 * receiver bytecode. Therefore this contract cannot auto-split in the same settlement
 * transaction. Call `release()` (or any pull) later:
 *   - fee     = balance * feeBps / 10000  → feeCollector
 *   - remainder                          → seller
 *
 * Rounding: Solidity integer division floors. When `balance * feeBps < 10000`, fee is 0.
 * At the default 10 bps (0.1%), `$0.001` USDC = 1000 atomic units yields
 * `1000 * 10 / 10000 = 1` atomic fee (so micro-tolls still produce a 1-unit fee).
 *
 * No upgrade proxy. No Ownable — `release()` is permissionless.
 */
contract FeeSplitter {
    address public immutable seller;
    address public immutable feeCollector;
    address public immutable asset;
    uint16 public immutable feeBps;

    error ZeroAddress();
    error FeeBpsTooHigh();
    error NothingToRelease();
    error TransferFailed();

    /**
     * @param seller_       Receives (10000 - feeBps) / 10000 of balance on release
     * @param feeCollector_ Receives feeBps / 10000 (operator wallet — pass via env at deploy)
     * @param asset_        ERC-20 to split (per-chain native USDC; see contracts/README.md matrix)
     * @param feeBps_       Fee in basis points; pass 10 for 0.1%. Must be <= 10000.
     */
    constructor(address seller_, address feeCollector_, address asset_, uint16 feeBps_) {
        if (seller_ == address(0) || feeCollector_ == address(0) || asset_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > 10_000) revert FeeBpsTooHigh();

        seller = seller_;
        feeCollector = feeCollector_;
        asset = asset_;
        feeBps = feeBps_;
    }

    /// @notice Send accumulated `asset` balance: fee to collector, rest to seller.
    function release() external {
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance == 0) revert NothingToRelease();

        uint256 fee = (balance * uint256(feeBps)) / 10_000;
        uint256 toSeller = balance - fee;

        if (fee > 0) {
            if (!IERC20(asset).transfer(feeCollector, fee)) revert TransferFailed();
        }
        if (toSeller > 0) {
            if (!IERC20(asset).transfer(seller, toSeller)) revert TransferFailed();
        }
    }
}
