import {
  encodeDeployData,
  getContractAddress,
  pad,
  type Hex,
  type Address,
} from "viem";
import { FEE_SPLITTER_CREATION_BYTECODE } from "./fee-splitter-bytecode.js";
import { assertValidSeller, assertValidAddress } from "./address.js";

/** $10 USDC in atomic units (6 decimals). Single payment below this → payTo = seller EOA (0 protocol fee). */
export const DEFAULT_FEE_FREE_BELOW_USDC = 10_000_000n;

const FEE_SPLITTER_CONSTRUCTOR_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "seller_", type: "address" },
      { name: "feeCollector_", type: "address" },
      { name: "asset_", type: "address" },
      { name: "feeBps_", type: "uint16" },
    ],
  },
] as const;

export interface PredictFeeSplitterParams {
  factoryAddress: `0x${string}`;
  seller: `0x${string}`;
  feeCollector: `0x${string}`;
  asset: `0x${string}`;
  feeBps?: number;
  /** Override creation bytecode (defaults to compiled FeeSplitter). */
  creationBytecode?: Hex;
}

/**
 * CREATE2 salt matching FeeSplitterFactory.salt(seller) =
 * bytes32(uint256(uint160(seller))).
 */
export function feeSplitterSalt(seller: `0x${string}`): Hex {
  return pad(seller as Address, { size: 32 });
}

/**
 * Predict the CREATE2 FeeSplitter address for a seller (works before deploy).
 * Must match FeeSplitterFactory.predictAddress(seller) for the same factory immutables.
 *
 * Operator must `getOrCreate(seller)` before the first ≥ threshold settle that uses
 * this address as payTo — EIP-3009 only credits balances; it does not deploy.
 */
export function predictFeeSplitterAddress(
  params: PredictFeeSplitterParams,
): `0x${string}` {
  const seller = assertValidSeller(params.seller);
  const factoryAddress = assertValidAddress(params.factoryAddress, "factoryAddress");
  const feeCollector = assertValidAddress(params.feeCollector, "feeCollector");
  const asset = assertValidAddress(params.asset, "asset");
  const feeBps = params.feeBps ?? 10;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error(`Invalid feeBps: ${feeBps}`);
  }

  const bytecode = encodeDeployData({
    abi: FEE_SPLITTER_CONSTRUCTOR_ABI,
    bytecode: params.creationBytecode ?? FEE_SPLITTER_CREATION_BYTECODE,
    args: [seller, feeCollector, asset, feeBps],
  });

  return getContractAddress({
    opcode: "CREATE2",
    from: factoryAddress,
    salt: feeSplitterSalt(seller),
    bytecode,
  });
}

export interface ResolvePayToParams {
  /** Accepts amount in USDC atomic units (6 decimals). */
  amountAtomic: bigint | string | number;
  seller: `0x${string}`;
  /** Default 10_000_000 ($10). Amounts strictly below → seller EOA. */
  feeFreeBelowUsdc?: bigint;
  factoryAddress?: `0x${string}`;
  feeCollector: `0x${string}`;
  asset: `0x${string}`;
  feeBps?: number;
  creationBytecode?: Hex;
}

function toAmountAtomic(value: bigint | string | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid amountAtomic: ${value}`);
    }
    return BigInt(Math.trunc(value));
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid amountAtomic: ${value}`);
  }
  return BigInt(trimmed);
}

/**
 * Permissionless seller payTo resolver:
 * - amount < feeFreeBelowUsdc (default $10 = 10_000_000) → seller EOA (0 protocol fee)
 * - amount ≥ threshold → CREATE2-predicted FeeSplitter (later permissionless release())
 *
 * Does **not** deploy the splitter and does **not** claim same-tx atomic split.
 */
export function resolvePayTo(params: ResolvePayToParams): `0x${string}` {
  const seller = assertValidSeller(params.seller);
  const amount = toAmountAtomic(params.amountAtomic);
  const threshold = params.feeFreeBelowUsdc ?? DEFAULT_FEE_FREE_BELOW_USDC;

  if (amount < threshold) {
    return seller;
  }

  if (!params.factoryAddress) {
    throw new Error(
      "FACTORY_ADDRESS is required when amount ≥ FEE_FREE_BELOW_USDC (predicted FeeSplitter payTo)",
    );
  }

  return predictFeeSplitterAddress({
    factoryAddress: params.factoryAddress,
    seller,
    feeCollector: params.feeCollector,
    asset: params.asset,
    feeBps: params.feeBps,
    creationBytecode: params.creationBytecode,
  });
}
