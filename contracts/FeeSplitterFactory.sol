// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeSplitter} from "./FeeSplitter.sol";

/**
 * @title FeeSplitterFactory
 * @notice CREATE2 factory for per-seller FeeSplitter instances.
 *
 * Salt = `bytes32(uint256(uint160(seller)))` so each seller maps to one
 * counterfactual address for a given factory (immutable feeCollector/asset/feeBps).
 *
 * x402 `exact` + EIP-3009 settles USDC to `payTo` only — it does **not** call
 * this factory or FeeSplitter. Operators (or an optional keeper) must
 * `getOrCreate(seller)` **before** the first ≥ threshold settlement that uses
 * the predicted splitter as `payTo`, then call `FeeSplitter.release()` later.
 * Buyers never call this factory.
 */
contract FeeSplitterFactory {
    address public immutable feeCollector;
    address public immutable asset;
    uint16 public immutable feeBps;

    event Deployed(address indexed seller, address indexed splitter);

    error ZeroAddress();
    error FeeBpsTooHigh();

    constructor(address feeCollector_, address asset_, uint16 feeBps_) {
        if (feeCollector_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        if (feeBps_ > 10_000) revert FeeBpsTooHigh();
        feeCollector = feeCollector_;
        asset = asset_;
        feeBps = feeBps_;
    }

    /// @notice CREATE2 salt derived solely from seller (one splitter per seller per factory).
    function salt(address seller) public pure returns (bytes32) {
        return bytes32(uint256(uint160(seller)));
    }

    /// @notice Counterfactual FeeSplitter address for `seller` (works before deploy).
    function predictAddress(address seller) public view returns (address) {
        if (seller == address(0)) revert ZeroAddress();
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(FeeSplitter).creationCode,
                abi.encode(seller, feeCollector, asset, feeBps)
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt(seller), initCodeHash))
                )
            )
        );
    }

    /// @notice Deploy FeeSplitter for `seller`. Reverts if already deployed at the CREATE2 address.
    function create(address seller) external returns (address splitter) {
        if (seller == address(0)) revert ZeroAddress();
        bytes32 s = salt(seller);
        splitter = address(new FeeSplitter{salt: s}(seller, feeCollector, asset, feeBps));
        emit Deployed(seller, splitter);
    }

    /// @notice Return existing splitter or deploy via CREATE2.
    function getOrCreate(address seller) external returns (address splitter) {
        splitter = predictAddress(seller);
        if (splitter.code.length > 0) {
            return splitter;
        }
        bytes32 s = salt(seller);
        splitter = address(new FeeSplitter{salt: s}(seller, feeCollector, asset, feeBps));
        emit Deployed(seller, splitter);
    }
}
