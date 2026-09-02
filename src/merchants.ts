import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Request } from "express";

/** Fixed operator feeCollector wallet (Plan A). Documented as FEE_COLLECTOR default. */
export const OPERATOR_FEE_COLLECTOR =
  "0xa922F38041B5ee227c96A547F106F1330447e30E" as `0x${string}`;

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface MerchantEntry {
  /** Merchant receive wallet (FeeSplitter.seller) — display only. */
  seller: `0x${string}`;
  /** FeeSplitter contract address — x402 payTo for this merchant. */
  payTo: `0x${string}`;
  /** Human-readable label (no secrets). */
  label: string;
}

export type MerchantRegistry = Record<string, MerchantEntry>;

export interface MerchantResolveOk {
  ok: true;
  id: string;
  merchant: MerchantEntry;
}

export interface MerchantResolveErr {
  ok: false;
  error: "unknown_merchant";
  id: string;
}

export type MerchantResolveResult = MerchantResolveOk | MerchantResolveErr;

/** Built-in demo entry matching merchants.example.json (used when no file/env). */
export const BUILTIN_DEMO_MERCHANTS: MerchantRegistry = {
  demo: {
    seller: OPERATOR_FEE_COLLECTOR,
    payTo: "0xC20bC6cAc978f8d2AE94Ee9D41F2DF396A5f10fE",
    label: "demo (operator is also seller)",
  },
};

export function isEvmAddress(value: string): value is `0x${string}` {
  return EVM_ADDRESS_RE.test(value);
}

function normalizeAddress(raw: unknown, field: string, merchantId: string): `0x${string}` {
  if (typeof raw !== "string" || !isEvmAddress(raw.trim())) {
    throw new Error(
      `Invalid merchant "${merchantId}": ${field} must be a 0x-prefixed 40-hex EVM address`,
    );
  }
  return raw.trim() as `0x${string}`;
}

/** Parse and validate a merchants JSON object. Rejects invalid addresses. */
export function parseMerchantsRegistry(raw: unknown): MerchantRegistry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Merchants registry must be a JSON object of merchantId → entry");
  }

  const out: MerchantRegistry = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    const merchantId = id.trim();
    if (!merchantId) {
      throw new Error("Merchant id must be a non-empty string");
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid merchant "${merchantId}": entry must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const seller = normalizeAddress(obj.seller, "seller", merchantId);
    const payTo = normalizeAddress(obj.payTo, "payTo", merchantId);
    const label =
      typeof obj.label === "string" && obj.label.trim()
        ? obj.label.trim()
        : merchantId;
    out[merchantId] = { seller, payTo, label };
  }

  if (Object.keys(out).length === 0) {
    throw new Error("Merchants registry must contain at least one merchant");
  }

  return out;
}

function tryReadMerchantsFile(filePath: string): MerchantRegistry | undefined {
  if (!existsSync(filePath)) return undefined;
  const text = readFileSync(filePath, "utf8");
  return parseMerchantsRegistry(JSON.parse(text) as unknown);
}

/**
 * Load merchant registry at startup.
 * Prefer `MERCHANTS_JSON` (inline), else `MERCHANTS_FILE` (default `merchants.json`),
 * then `merchants.example.json` next to cwd / packaged example, else built-in demo.
 */
export function loadMerchantsRegistry(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): MerchantRegistry {
  const inline = env.MERCHANTS_JSON?.trim();
  if (inline) {
    return parseMerchantsRegistry(JSON.parse(inline) as unknown);
  }

  const fileName = env.MERCHANTS_FILE?.trim() || "merchants.json";
  const candidates = [
    path.isAbsolute(fileName) ? fileName : path.join(cwd, fileName),
    path.join(cwd, "merchants.example.json"),
  ];

  for (const candidate of candidates) {
    const loaded = tryReadMerchantsFile(candidate);
    if (loaded) return loaded;
  }

  return { ...BUILTIN_DEMO_MERCHANTS };
}

/** Public list payload for GET /merchants (no secrets). */
export function listMerchantsPublic(
  registry: MerchantRegistry,
): Array<{ id: string; label: string; seller: string; payTo: string }> {
  return Object.entries(registry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, m]) => ({
      id,
      label: m.label,
      seller: m.seller,
      payTo: m.payTo,
    }));
}

/**
 * Resolve merchant id from query `merchant` or header `x-merchant-id`
 * (case-insensitive header). Missing → defaultMerchantId.
 */
export function merchantIdFromRequest(
  req: Pick<Request, "query" | "header">,
  defaultMerchantId: string,
): string {
  const fromQuery = req.query?.merchant;
  if (typeof fromQuery === "string" && fromQuery.trim()) {
    return fromQuery.trim();
  }
  if (Array.isArray(fromQuery) && typeof fromQuery[0] === "string" && fromQuery[0].trim()) {
    return fromQuery[0].trim();
  }

  const fromHeader =
    req.header("x-merchant-id") ??
    req.header("X-Merchant-Id") ??
    req.header("X-MERCHANT-ID");
  if (typeof fromHeader === "string" && fromHeader.trim()) {
    return fromHeader.trim();
  }

  return defaultMerchantId;
}

export function resolveMerchant(
  req: Pick<Request, "query" | "header">,
  registry: MerchantRegistry,
  defaultMerchantId: string,
): MerchantResolveResult {
  const id = merchantIdFromRequest(req, defaultMerchantId);
  const merchant = registry[id];
  if (!merchant) {
    return { ok: false, error: "unknown_merchant", id };
  }
  return { ok: true, id, merchant };
}

/** Rewrite accepts[].payTo (and nested recipient if present) on a decoded PAYMENT-REQUIRED. */
export function rewritePaymentRequiredPayTo(
  decoded: Record<string, unknown>,
  payTo: `0x${string}`,
): void {
  const accepts = decoded.accepts;
  if (!Array.isArray(accepts)) return;

  for (const entry of accepts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const accept = entry as Record<string, unknown>;
    accept.payTo = payTo;
    if (typeof accept.recipient === "string") {
      accept.recipient = payTo;
    }
    const extra = accept.extra;
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      const extraObj = extra as Record<string, unknown>;
      if (typeof extraObj.recipient === "string") {
        extraObj.recipient = payTo;
      }
      if (typeof extraObj.payTo === "string") {
        extraObj.payTo = payTo;
      }
    }
  }
}
