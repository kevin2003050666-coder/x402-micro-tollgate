import type { Request } from "express";
import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";
import type {
  PaywallConfig,
  PaywallProvider,
} from "@x402/core/server";
import type { TollgateConfig } from "./config.js";

/** Minimal payment-required shape accepted by `@x402/paywall` generateHtml. */
export type PaywallPaymentRequired = {
  x402Version: number;
  error?: string;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
    [key: string]: unknown;
  };
  accepts: Array<Record<string, unknown>>;
  extensions?: Record<string, unknown>;
};

/** Free path for Coinbase Onramp session tokens (server CDP credentials only). */
export const SESSION_TOKEN_PATH = "/x402/session-token";

/**
 * PaywallConfig extended with buyer-facing CDP client key (public) and Onramp
 * session-token endpoint. Matches the documented x402 PaywallConfig pattern;
 * `@x402/paywall` v2 embeds Coinbase Smart Wallet via wagmi — Onramp UI is
 * injected when `sessionTokenEndpoint` is set.
 */
export type TollgatePaywallConfig = PaywallConfig & {
  /** Public CDP client / project API key for browser Smart Wallet UX. */
  cdpClientKey?: string;
  /** POST endpoint that mints Onramp session tokens (never expose secrets). */
  sessionTokenEndpoint?: string;
};

export function isBrowserPaymentRequest(
  req: Pick<Request, "headers"> | { getHeader?(name: string): string | undefined },
): boolean {
  const accept =
    "getHeader" in req && typeof req.getHeader === "function"
      ? (req.getHeader("accept") ?? "")
      : String((req as Request).headers?.accept ?? "");
  const ua =
    "getHeader" in req && typeof req.getHeader === "function"
      ? (req.getHeader("user-agent") ?? "")
      : String((req as Request).headers?.["user-agent"] ?? "");
  return accept.includes("text/html") && ua.includes("Mozilla");
}

export function buildPaywallConfig(config: TollgateConfig): TollgatePaywallConfig {
  const testnet =
    config.environment === "development" ||
    config.network === "eip155:84532" ||
    /sepolia/i.test(config.network);

  const paywall: TollgatePaywallConfig = {
    appName: "x402-micro-tollgate",
    testnet,
  };

  if (config.cdpClientApiKey) {
    paywall.cdpClientKey = config.cdpClientApiKey;
  }

  // Onramp "Get USDC" needs server CDP secret keys to mint session tokens.
  // Client key is optional for the button (used for branding / future CDP UX).
  if (config.cdpApiKeyId && config.cdpApiKeySecret) {
    paywall.sessionTokenEndpoint = SESSION_TOKEN_PATH;
  }

  return paywall;
}

/**
 * Official `@x402/paywall` EVM provider + thin Onramp injection when configured.
 * Coinbase Wallet connector in the bundled UI supports Smart Wallet / Passkey
 * (no MetaMask required).
 */
export function createTollgatePaywall(config: TollgateConfig): PaywallProvider {
  const defaults = buildPaywallConfig(config);
  const inner = createPaywall()
    .withNetwork(evmPaywall)
    .withConfig({
      appName: defaults.appName,
      appLogo: defaults.appLogo,
      testnet: defaults.testnet,
      currentUrl: defaults.currentUrl,
    })
    .build();

  const provider: PaywallProvider = {
    generateHtml(paymentRequired, runtimeConfig?: PaywallConfig): string {
      const merged: TollgatePaywallConfig = {
        ...defaults,
        ...(runtimeConfig ?? {}),
      };
      const html = inner.generateHtml(
        paymentRequired as Parameters<typeof inner.generateHtml>[0],
        merged,
      );
      return injectBuyerExtras(html, merged);
    },
  };
  return provider;
}

/**
 * Inject public buyer config + optional Onramp "Get USDC" panel into paywall HTML.
 * Does not embed wallet secrets — only client key + session-token path.
 */
export function injectBuyerExtras(
  html: string,
  config: TollgatePaywallConfig,
): string {
  const sessionTokenEndpoint = config.sessionTokenEndpoint?.trim() ?? "";
  const cdpClientKey = config.cdpClientKey?.trim() ?? "";
  const onrampEnabled = Boolean(sessionTokenEndpoint);

  const extras = `
<script data-x402-buyer-config>
(function () {
  window.x402 = window.x402 || {};
  ${cdpClientKey ? `window.x402.cdpClientKey = ${JSON.stringify(cdpClientKey)};` : ""}
  ${
    sessionTokenEndpoint
      ? `window.x402.sessionTokenEndpoint = ${JSON.stringify(sessionTokenEndpoint)};`
      : ""
  }
})();
</script>
${onrampEnabled ? onrampPanelHtml() : ""}
`;

  if (html.includes("</body>")) {
    return html.replace("</body>", `${extras}</body>`);
  }
  return `${html}${extras}`;
}

function onrampPanelHtml(): string {
  // Thin overlay — real Apple Pay / card checkout only inside Coinbase Onramp
  // after session token + domain approval. We do not fake Apple Pay here.
  return `
<style data-x402-onramp>
  #x402-onramp-bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;
    padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom, 0));
    background: rgba(7, 16, 24, 0.92);
    border-top: 1px solid rgba(232, 241, 244, 0.14);
    color: #e8f1f4;
    font-family: "Source Sans 3", system-ui, sans-serif;
    display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center;
    justify-content: space-between;
  }
  #x402-onramp-bar p { margin: 0; font-size: 0.85rem; color: #8aa0ab; max-width: 42rem; }
  #x402-onramp-bar button {
    font-family: inherit; font-weight: 600; cursor: pointer;
    border: 0; border-radius: 2px; padding: 0.55rem 1rem;
    background: #3ecfad; color: #071018;
  }
  #x402-onramp-bar button:disabled { opacity: 0.55; cursor: wait; }
  #x402-onramp-status { font-size: 0.8rem; color: #f0c14a; width: 100%; }
</style>
<div id="x402-onramp-bar" role="region" aria-label="Get USDC via Coinbase Onramp">
  <p>Need USDC on Base? <strong style="color:#e8f1f4">Get USDC</strong> opens Coinbase Onramp (Apple Pay / card only if Onramp supports them for this domain — not guaranteed without production access).</p>
  <button type="button" id="x402-get-usdc">Get USDC</button>
  <div id="x402-onramp-status" hidden></div>
</div>
<script data-x402-onramp>
(function () {
  var btn = document.getElementById("x402-get-usdc");
  var statusEl = document.getElementById("x402-onramp-status");
  if (!btn) return;

  function setStatus(msg) {
    if (!statusEl) return;
    if (!msg) { statusEl.hidden = true; statusEl.textContent = ""; return; }
    statusEl.hidden = false;
    statusEl.textContent = msg;
  }

  async function resolveAddress() {
    var eth = window.ethereum;
    if (eth && eth.request) {
      try {
        var accounts = await eth.request({ method: "eth_accounts" });
        if (accounts && accounts[0]) return accounts[0];
        accounts = await eth.request({ method: "eth_requestAccounts" });
        if (accounts && accounts[0]) return accounts[0];
      } catch (e) { /* fall through */ }
    }
    var typed = window.prompt("Enter your Base wallet address to receive USDC:");
    return typed && typed.trim() ? typed.trim() : null;
  }

  btn.addEventListener("click", async function () {
    var endpoint = window.x402 && window.x402.sessionTokenEndpoint;
    if (!endpoint) {
      setStatus("Onramp session token is not configured on this host.");
      return;
    }
    btn.disabled = true;
    setStatus("Creating Onramp session…");
    try {
      var address = await resolveAddress();
      if (!address) {
        setStatus("Connect a Smart Wallet first (or enter an address).");
        btn.disabled = false;
        return;
      }
      var res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          addresses: [{ address: address, blockchains: ["base"] }],
          assets: ["USDC"]
        })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        setStatus((data && (data.error || data.message)) || ("Onramp session failed (" + res.status + ")"));
        btn.disabled = false;
        return;
      }
      var token = data.token || data.sessionToken;
      if (!token) {
        setStatus("Onramp response missing session token.");
        btn.disabled = false;
        return;
      }
      var url = "https://pay.coinbase.com/buy/select-asset?sessionToken=" + encodeURIComponent(token)
        + "&defaultAsset=USDC&defaultNetwork=base";
      window.open(url, "_blank", "noopener,noreferrer");
      setStatus("Opened Coinbase Onramp. Return here after funding, then pay.");
    } catch (err) {
      setStatus(err && err.message ? err.message : "Onramp request failed");
    } finally {
      btn.disabled = false;
    }
  });
})();
</script>
`;
}
