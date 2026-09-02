import type { Request, Response, RequestHandler } from "express";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { TollgateConfig } from "./config.js";
import { jsonError } from "./http.js";

const ONRAMP_HOST = "api.developer.coinbase.com";
const ONRAMP_PATH = "/onramp/v1/token";
const ONRAMP_URL = `https://${ONRAMP_HOST}${ONRAMP_PATH}`;

type AddressEntry = {
  address?: unknown;
  blockchains?: unknown;
};

/**
 * Best-effort client IP for Onramp Secure Init.
 * Prefer Express `req.ip` (honors trust proxy when PUBLIC_BASE_URL is https).
 * Never trust a client-supplied body field for IP.
 */
export function resolveClientIp(req: Request): string {
  const ip = (req.ip || req.socket.remoteAddress || "").trim();
  if (!ip) return "127.0.0.1";
  // Node may return IPv6-mapped IPv4 (::ffff:x.x.x.x)
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function normalizeAddresses(raw: unknown): Array<{ address: string; blockchains: string[] }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{ address: string; blockchains: string[] }> = [];
  for (const entry of raw as AddressEntry[]) {
    if (!entry || typeof entry !== "object") return null;
    const address = typeof entry.address === "string" ? entry.address.trim() : "";
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
    let blockchains: string[] = ["base"];
    if (entry.blockchains !== undefined) {
      if (
        !Array.isArray(entry.blockchains) ||
        entry.blockchains.length === 0 ||
        !entry.blockchains.every((b) => typeof b === "string" && b.trim().length > 0)
      ) {
        return null;
      }
      blockchains = entry.blockchains.map((b) => String(b).trim().toLowerCase());
    }
    out.push({ address, blockchains });
  }
  return out;
}

/**
 * POST /x402/session-token — mint Coinbase Onramp session token with server CDP keys.
 * Body: `{ addresses: [{ address, blockchains? }], assets?: string[] }`
 * Secrets never leave the server; browser only receives the short-lived token.
 */
export function createSessionTokenHandler(config: TollgateConfig): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!config.cdpApiKeyId || !config.cdpApiKeySecret) {
      jsonError(
        res,
        503,
        "onramp_not_configured",
        "Set CDP_API_KEY_ID and CDP_API_KEY_SECRET to enable Coinbase Onramp session tokens.",
      );
      return;
    }

    const addresses = normalizeAddresses(req.body?.addresses);
    if (!addresses) {
      jsonError(
        res,
        400,
        "invalid_addresses",
        "addresses is required: non-empty array of { address: 0x…, blockchains?: string[] }",
      );
      return;
    }

    const assetsRaw = req.body?.assets;
    let assets: string[] | undefined;
    if (assetsRaw !== undefined) {
      if (
        !Array.isArray(assetsRaw) ||
        assetsRaw.length === 0 ||
        !assetsRaw.every((a: unknown) => typeof a === "string" && a.trim().length > 0)
      ) {
        jsonError(res, 400, "invalid_assets", "assets must be a non-empty string array when provided");
        return;
      }
      assets = assetsRaw.map((a: string) => a.trim());
    } else {
      assets = ["USDC"];
    }

    try {
      const jwt = await generateJwt({
        apiKeyId: config.cdpApiKeyId,
        apiKeySecret: config.cdpApiKeySecret,
        requestMethod: "POST",
        requestHost: ONRAMP_HOST,
        requestPath: ONRAMP_PATH,
      });

      const payload: Record<string, unknown> = {
        addresses,
        assets,
        clientIp: resolveClientIp(req),
      };

      const upstream = await fetch(ONRAMP_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const text = await upstream.text();
      let data: unknown = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      if (!upstream.ok) {
        res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({
          error: "onramp_session_failed",
          message: "Failed to create Coinbase Onramp session token",
          details:
            typeof data === "object" && data && "message" in data
              ? (data as { message: unknown }).message
              : undefined,
        });
        return;
      }

      res.status(200).json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      jsonError(res, 500, "onramp_session_error", message);
    }
  };
}
