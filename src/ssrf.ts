import dns from "node:dns/promises";
import net from "node:net";
import type { LookupAddress } from "node:dns";

/** Result of validating a user-supplied URL before any outbound fetch. */
export interface SafePublicUrl {
  url: URL;
  /** Resolved addresses that passed private/bogon checks (empty when hostname is a literal public IP). */
  addresses: LookupAddress[];
}

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1" || normalized === "::") return true;
    // Unique-local fc00::/7
    if (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fc00") ||
      normalized.startsWith("fd00")
    ) {
      return true;
    }
    if (normalized.startsWith("fe80")) return true; // link-local
    if (normalized.startsWith("ff")) return true; // multicast
    // IPv4-mapped / IPv4-compatible
    if (normalized.startsWith("::ffff:")) {
      const v4 = normalized.slice("::ffff:".length);
      if (net.isIPv4(v4)) return isBlockedIp(v4);
    }
    return false;
  }
  return true;
}

function isBlockedHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost.") ||
    host === "metadata.google.internal"
  );
}

export type ResolveAddresses = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolve: ResolveAddresses = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Parse + allow only http(s), resolve DNS, reject if ANY address is private/bogon/link-local/metadata.
 * Call again immediately before fetch to mitigate DNS rebinding (resolve → validate → re-check → fetch).
 */
export async function assertSafePublicHttpUrl(
  raw: string,
  options: { resolve?: ResolveAddresses } = {},
): Promise<SafePublicUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { code: "invalid_url" });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("Only http and https URLs are allowed"), {
      code: "invalid_scheme",
    });
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedHostname(host)) {
    throw Object.assign(new Error("Localhost and private hosts are not allowed"), {
      code: "ssrf_blocked",
    });
  }

  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw Object.assign(new Error("Private or reserved IP addresses are not allowed"), {
        code: "ssrf_blocked",
      });
    }
    return { url, addresses: [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] };
  }

  const resolve = options.resolve ?? defaultResolve;
  let records: LookupAddress[];
  try {
    records = await resolve(host);
  } catch {
    throw Object.assign(new Error("Could not resolve hostname"), { code: "dns_failed" });
  }

  if (!records.length) {
    throw Object.assign(new Error("Could not resolve hostname"), { code: "dns_failed" });
  }

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw Object.assign(new Error("Hostname resolves to a private or reserved address"), {
        code: "ssrf_blocked",
      });
    }
  }

  return { url, addresses: records };
}

/**
 * DNS-rebinding defense: validate, then re-resolve and require the second lookup to still be public.
 * Prefer overlapping addresses with the first lookup when available.
 */
export async function assertSafePublicHttpUrlPinned(
  raw: string,
  options: { resolve?: ResolveAddresses } = {},
): Promise<SafePublicUrl> {
  const first = await assertSafePublicHttpUrl(raw, options);
  // Literal IPs cannot rebind via DNS.
  const host = first.url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return first;

  const second = await assertSafePublicHttpUrl(raw, options);
  const firstSet = new Set(first.addresses.map((a) => a.address));
  const overlap = second.addresses.filter((a) => firstSet.has(a.address));
  if (overlap.length === 0) {
    // Resolutions disagreed entirely — still OK if second is public-only, but pin to second.
    // Rebinding to a newly private IP is already rejected by assertSafePublicHttpUrl.
    return second;
  }
  return { url: second.url, addresses: overlap };
}
