import { getAddress, isAddress } from "viem";

/**
 * Validate an EVM address for seller / payTo use.
 * - Must be 0x + 40 hex
 * - Mixed-case addresses must pass EIP-55 checksum (viem strict)
 * - Returns checksummed `0x…` form
 *
 * Invalid → throws (callers should hard-fail startup or return 500 config error).
 */
export function assertValidAddress(
  value: string | undefined | null,
  label = "address",
): `0x${string}` {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error(`Invalid ${label}: empty`);
  }
  if (!isAddress(raw, { strict: true })) {
    throw new Error(
      `Invalid ${label}: "${raw}" is not a valid EVM address (check EIP-55 checksum)`,
    );
  }
  return getAddress(raw) as `0x${string}`;
}

/** Seller alias — same rules as assertValidAddress. */
export function assertValidSeller(value: string | undefined | null): `0x${string}` {
  return assertValidAddress(value, "seller");
}

export function tryParseAddress(value: string | undefined | null): `0x${string}` | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return assertValidAddress(value);
  } catch {
    return undefined;
  }
}
