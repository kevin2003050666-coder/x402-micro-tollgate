import { config as loadEnv } from "dotenv";

loadEnv();

export type X402Environment = "development" | "production";

export interface TollgateConfig {
  port: number;
  upstreamUrl: string | undefined;
  payTo: `0x${string}` | undefined;
  price: string;
  network: string;
  environment: X402Environment;
  /** Path prefix that requires payment (e.g. `/v1`). Empty string gates everything except free paths. */
  gatedPrefix: string;
  cdpApiKeyId: string | undefined;
  cdpApiKeySecret: string | undefined;
  /** True when CDP facilitator credentials + pay-to are present. */
  useLiveFacilitator: boolean;
  /**
   * Public https origin for Bazaar resource URLs (no trailing slash).
   * Without this, demos use http://127.0.0.1:PORT — Bazaar listing is a no-op until set + one CDP settlement.
   */
  publicBaseUrl: string;
  /** Contact mailto on the landing page (not a SaaS CTA). */
  contactEmail: string;
  /**
   * Operator fee in basis points (default 10 = 0.1%).
   * Documented for FeeSplitter deploy; live CDP settle still pays 100% to `payTo`.
   */
  feeBps: number;
  /** Fee collector wallet after FeeSplitter.release(); optional until splitter is deployed. */
  feeCollector: `0x${string}` | undefined;
}

const DEFAULT_NETWORK_BY_ENV: Record<X402Environment, string> = {
  development: "eip155:84532",
  production: "eip155:8453",
};

function parseEnvironment(raw: string | undefined): X402Environment {
  if (raw === "production") return "production";
  return "development";
}

function normalizePrefix(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "/v1";
  if (raw === "*" || raw === "/") return "";
  return raw.startsWith("/") ? raw.replace(/\/+$/, "") : `/${raw.replace(/\/+$/, "")}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TollgateConfig {
  const environment = parseEnvironment(env.X402_ENVIRONMENT ?? env.CDP_X402_SERVER_ENVIRONMENT);
  const network = env.NETWORK?.trim() || DEFAULT_NETWORK_BY_ENV[environment];
  const payToRaw = env.X402_PAY_TO?.trim();
  const payTo =
    payToRaw && /^0x[a-fA-F0-9]{40}$/.test(payToRaw)
      ? (payToRaw as `0x${string}`)
      : undefined;

  const cdpApiKeyId = env.CDP_API_KEY_ID?.trim() || undefined;
  const cdpApiKeySecret = env.CDP_API_KEY_SECRET?.trim() || undefined;
  const port = Number(env.PORT) > 0 ? Number(env.PORT) : 8402;

  const publicRaw = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const publicBaseUrl =
    publicRaw && /^https?:\/\//i.test(publicRaw)
      ? publicRaw
      : `http://127.0.0.1:${port}`;

  const feeBpsRaw = env.FEE_BPS?.trim();
  const feeBpsParsed = feeBpsRaw !== undefined && feeBpsRaw !== "" ? Number(feeBpsRaw) : 10;
  const feeBps =
    Number.isInteger(feeBpsParsed) && feeBpsParsed >= 0 && feeBpsParsed <= 10_000
      ? feeBpsParsed
      : 10;

  const feeCollectorRaw = env.FEE_COLLECTOR?.trim();
  const feeCollector =
    feeCollectorRaw && /^0x[a-fA-F0-9]{40}$/.test(feeCollectorRaw)
      ? (feeCollectorRaw as `0x${string}`)
      : undefined;

  const contactEmail =
    env.CONTACT_EMAIL?.trim() ||
    env.WAITLIST_EMAIL?.trim() || // legacy alias
    "2767111713@qq.com";

  return {
    port,
    upstreamUrl: env.UPSTREAM_URL?.trim() || undefined,
    payTo,
    price: env.PRICE?.trim() || "$0.001",
    network,
    environment,
    gatedPrefix: normalizePrefix(env.GATED_PREFIX),
    cdpApiKeyId,
    cdpApiKeySecret,
    useLiveFacilitator: Boolean(cdpApiKeyId && cdpApiKeySecret && payTo),
    publicBaseUrl,
    contactEmail,
    feeBps,
    feeCollector,
  };
}

/** Free HTTP paths that never require x402 payment (MCP has its own payment loop). */
export const FREE_PATHS = new Set(["/", "/health", "/zh", "/mcp", "/sse", "/messages"]);

export function isFreePath(path: string): boolean {
  const bare = path.split(/[?#]/)[0] || "/";
  return FREE_PATHS.has(bare);
}

export function isGatedPath(path: string, gatedPrefix: string): boolean {
  if (isFreePath(path)) return false;
  const bare = path.split(/[?#]/)[0] || "/";
  if (gatedPrefix === "") return true;
  return bare === gatedPrefix || bare.startsWith(`${gatedPrefix}/`);
}

export function gatedRoutePatterns(gatedPrefix: string): string[] {
  if (gatedPrefix === "") {
    return ["* /*"];
  }
  return [
    `* ${gatedPrefix}`,
    `* ${gatedPrefix}/*`,
  ];
}
