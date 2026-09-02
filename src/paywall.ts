import type { Request } from "express";
import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";
import { svmPaywall } from "@x402/paywall/svm";
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
 * Marker inside `@x402/paywall` EVM bundle (v2.24) WagmiProvider setup.
 * Stock connectors: injected (`Sm`) + Coinbase Wallet / Smart Wallet (`l8`).
 */
export const PAYWALL_CONNECTORS_MARKER =
  'connectors:[Sm(),l8({appName:window.x402.appName||"x402 Paywall"})]';

/**
 * PaywallConfig extended with buyer-facing CDP client key (public), Onramp
 * session-token endpoint, and WalletConnect project id.
 */
export type TollgatePaywallConfig = PaywallConfig & {
  /** Public CDP client / project API key for browser Smart Wallet UX. */
  cdpClientKey?: string;
  /** POST endpoint that mints Onramp session tokens (never expose secrets). */
  sessionTokenEndpoint?: string;
  /** WalletConnect Cloud project id (public). */
  walletConnectProjectId?: string;
  /** When true, register `@x402/paywall` SVM handler (Solana accepts). */
  enableSvm?: boolean;
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
    /sepolia|amoy|devnet/i.test(config.network) ||
    config.networks.some((n) => /sepolia|amoy|devnet/i.test(n));

  const paywall: TollgatePaywallConfig = {
    appName: "x402-micro-tollgate",
    testnet,
    enableSvm: config.paywallSvm,
  };

  if (config.cdpClientApiKey) {
    paywall.cdpClientKey = config.cdpClientApiKey;
  }

  if (config.cdpApiKeyId && config.cdpApiKeySecret) {
    paywall.sessionTokenEndpoint = SESSION_TOKEN_PATH;
  }

  if (config.walletConnectProjectId) {
    paywall.walletConnectProjectId = config.walletConnectProjectId;
  }

  return paywall;
}

/**
 * Official `@x402/paywall` provider + thin multi-wallet / Onramp injection.
 * Primary CTA: Coinbase Smart Wallet (Passkey). Also: MetaMask, injected, WalletConnect.
 * SVM paywall registered only when `paywallSvm` / Solana accepts are enabled.
 */
export function createTollgatePaywall(config: TollgateConfig): PaywallProvider {
  const defaults = buildPaywallConfig(config);
  let builder = createPaywall().withNetwork(evmPaywall);
  if (defaults.enableSvm) {
    // First-match on accepts[] order — keep EVM first so Base USDC stays default UX.
    builder = builder.withNetwork(svmPaywall);
  }
  const inner = builder
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
      let html = inner.generateHtml(
        paymentRequired as Parameters<typeof inner.generateHtml>[0],
        merged,
      );
      html = patchPaywallConnectors(html);
      return injectBuyerExtras(html, merged);
    },
  };
  return provider;
}

/**
 * Expand stock wagmi connectors so the "Select a wallet" dropdown lists:
 * MetaMask (injected target), Injected, Coinbase Smart Wallet (Passkey-capable),
 * plus optional WalletConnect via `window.x402.extraConnectors`.
 */
export function patchPaywallConnectors(html: string): string {
  if (!html.includes(PAYWALL_CONNECTORS_MARKER)) {
    return html;
  }
  const replacement =
    "connectors:[Sm({target:\"metaMask\"}),Sm(),l8({appName:window.x402.appName||\"x402 Paywall\",preference:{options:\"smartWalletOnly\"}}),...(window.x402&&window.x402.extraConnectors?window.x402.extraConnectors:[])]";
  return html.replace(PAYWALL_CONNECTORS_MARKER, replacement);
}

/**
 * Inject public buyer config + optional Onramp + WalletConnect loader + secondary CTA copy.
 */
export function injectBuyerExtras(
  html: string,
  config: TollgatePaywallConfig,
): string {
  const sessionTokenEndpoint = config.sessionTokenEndpoint?.trim() ?? "";
  const cdpClientKey = config.cdpClientKey?.trim() ?? "";
  const walletConnectProjectId = config.walletConnectProjectId?.trim() ?? "";
  const onrampEnabled = Boolean(sessionTokenEndpoint);

  const extras = `
<script data-x402-buyer-config>
(function () {
  window.x402 = window.x402 || {};
  window.x402.extraConnectors = window.x402.extraConnectors || [];
  ${cdpClientKey ? `window.x402.cdpClientKey = ${JSON.stringify(cdpClientKey)};` : ""}
  ${
    sessionTokenEndpoint
      ? `window.x402.sessionTokenEndpoint = ${JSON.stringify(sessionTokenEndpoint)};`
      : ""
  }
  ${
    walletConnectProjectId
      ? `window.x402.walletConnectProjectId = ${JSON.stringify(walletConnectProjectId)};`
      : ""
  }
})();
</script>
${walletConnectProjectId ? walletConnectLoaderHtml(walletConnectProjectId) : ""}
${walletChooserHintHtml(Boolean(walletConnectProjectId), Boolean(config.enableSvm))}
${acceptPickerHtml()}
${onrampEnabled ? onrampPanelHtml() : ""}
`;

  if (html.includes("</body>")) {
    return html.replace("</body>", `${extras}</body>`);
  }
  return `${html}${extras}`;
}

function walletChooserHintHtml(
  walletConnectEnabled: boolean,
  svmEnabled: boolean,
): string {
  const wc = walletConnectEnabled
    ? " MetaMask, injected browsers, and WalletConnect appear under <strong>Select a wallet</strong>."
    : " MetaMask and other injected browsers appear under <strong>Select a wallet</strong>. Set <code>WALLETCONNECT_PROJECT_ID</code> to enable WalletConnect.";
  const svm = svmEnabled
    ? " Solana paywall UI is enabled when a Solana accept is first-match (experimental)."
    : "";
  return `
<style data-x402-wallets>
  #x402-wallet-hint {
    position: fixed; left: 0; right: 0; top: 0; z-index: 2147482999;
    padding: 0.55rem 1rem;
    background: rgba(7, 16, 24, 0.94);
    border-bottom: 1px solid rgba(232, 241, 244, 0.14);
    color: #c5d4dc;
    font-family: "Source Sans 3", system-ui, sans-serif;
    font-size: 0.82rem;
    line-height: 1.35;
  }
  #x402-wallet-hint strong { color: #e8f1f4; font-weight: 600; }
  #x402-wallet-hint code {
    font-size: 0.78em; background: rgba(255,255,255,0.06); padding: 0.05rem 0.3rem;
  }
</style>
<div id="x402-wallet-hint" role="note">
  <strong>Passkey Smart Wallet</strong> (Coinbase) is the primary pay path — or connect wallet.${wc}${svm}
  TronLink is not offered (TRON x402 not facilitated yet).
</div>
`;
}

function walletConnectLoaderHtml(projectId: string): string {
  return `
<script type="module" data-x402-walletconnect>
import { walletConnect } from "https://esm.sh/@wagmi/connectors@5.11.2?deps=viem@2.56.2,wagmi@2.17.1,@wagmi/core@2.21.2";
window.x402 = window.x402 || {};
window.x402.extraConnectors = [
  walletConnect({
    projectId: ${JSON.stringify(projectId)},
    showQrModal: true,
    metadata: {
      name: "x402-micro-tollgate",
      description: "x402 USDC/USDT micropayment paywall",
      url: typeof location !== "undefined" ? location.origin : "https://x402.org",
      icons: [],
    },
  }),
];
</script>
`;
}

/**
 * Thin chain + asset picker when paymentRequired.accepts.length > 1.
 * Stock `@x402/paywall` always signs accepts[0] — we reorder before React mounts
 * (sessionStorage + optional reload) so the selected entry drives the signature.
 */
export function acceptPickerHtml(): string {
  return `
<style data-x402-accept-picker>
  #x402-accept-picker {
    display: none; position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(7, 16, 24, 0.92);
    color: #e8f1f4; font-family: "Source Sans 3", system-ui, sans-serif;
    align-items: center; justify-content: center; padding: 1.25rem;
  }
  #x402-accept-picker[data-open="1"] { display: flex; }
  #x402-accept-picker .card {
    width: min(26rem, 100%); background: #0f1a22; border: 1px solid rgba(232,241,244,0.14);
    padding: 1.25rem 1.35rem;
  }
  #x402-accept-picker h2 { margin: 0 0 0.35rem; font-size: 1.15rem; font-weight: 650; }
  #x402-accept-picker p { margin: 0 0 1rem; font-size: 0.85rem; color: #8aa0ab; }
  #x402-accept-picker label { display: block; font-size: 0.75rem; color: #8aa0ab; margin: 0.65rem 0 0.25rem; }
  #x402-accept-picker select {
    width: 100%; padding: 0.55rem 0.65rem; border-radius: 2px; border: 1px solid rgba(232,241,244,0.2);
    background: #071018; color: #e8f1f4; font: inherit;
  }
  #x402-accept-picker button {
    margin-top: 1.1rem; width: 100%; font: inherit; font-weight: 650; cursor: pointer;
    border: 0; border-radius: 2px; padding: 0.65rem 1rem; background: #3ecfad; color: #071018;
  }
  #x402-accept-picker .meta { margin-top: 0.75rem; font-size: 0.75rem; color: #8aa0ab; word-break: break-all; }
</style>
<div id="x402-accept-picker" role="dialog" aria-modal="true" aria-label="Choose network and asset">
  <div class="card">
    <h2>Choose network &amp; asset</h2>
    <p>Select where you will pay. This sets the x402 accept used for signing.</p>
    <label for="x402-pick-network">Network</label>
    <select id="x402-pick-network"></select>
    <label for="x402-pick-asset">Asset</label>
    <select id="x402-pick-asset"></select>
    <div class="meta" id="x402-pick-meta"></div>
    <button type="button" id="x402-pick-continue">Continue to pay</button>
  </div>
</div>
<script data-x402-accept-picker>
(function () {
  var LABEL = {
    "eip155:8453": "Base",
    "eip155:84532": "Base Sepolia",
    "eip155:10": "Optimism",
    "eip155:42161": "Arbitrum One",
    "eip155:137": "Polygon",
    "eip155:56": "BNB Smart Chain",
    "eip155:1": "Ethereum",
    "eip155:43114": "Avalanche C-Chain",
    "eip155:42220": "Celo",
    "eip155:1329": "Sei",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana Devnet"
  };

  function symbolOf(a) {
    if (!a) return "";
    if (a.extra && a.extra.name) {
      var n = String(a.extra.name).toUpperCase();
      if (n.indexOf("USDT") >= 0 || n === "TETHER USD" || n === "TETHERTOKEN") return "USDT";
      if (n.indexOf("USDC") >= 0 || n === "USD COIN") return "USDC";
    }
    return (a.asset || "").slice(0, 6) + "…";
  }

  function storageKey(pr) {
    var url = (pr && pr.resource && pr.resource.url) || location.href;
    return "x402-accept-sel:" + url;
  }

  function applySelection(pr, network, asset) {
    var accepts = pr.accepts || [];
    var idx = -1;
    for (var i = 0; i < accepts.length; i++) {
      if (accepts[i].network === network && accepts[i].asset === asset) { idx = i; break; }
    }
    if (idx < 0) return false;
    if (idx > 0) {
      var chosen = accepts.splice(idx, 1)[0];
      accepts.unshift(chosen);
    }
    window.x402.amount = accepts[0].amount;
    return true;
  }

  // Sync: reorder before paywall React mounts on window load.
  var x402 = window.x402 = window.x402 || {};
  var pr = x402.paymentRequired;
  if (!pr || !Array.isArray(pr.accepts) || pr.accepts.length <= 1) return;

  var key = storageKey(pr);
  var saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(key) || "null"); } catch (e) {}
  if (saved && saved.network && saved.asset && applySelection(pr, saved.network, saved.asset)) {
    return; // single path — stock paywall uses accepts[0]
  }

  // Need picker: hide root until user chooses, then reload with sessionStorage set.
  window.__x402NeedAcceptPicker = true;
  document.addEventListener("DOMContentLoaded", function () {
    if (!window.__x402NeedAcceptPicker) return;
    var root = document.getElementById("root");
    if (root) root.style.visibility = "hidden";
    var hint = document.getElementById("x402-wallet-hint");
    if (hint) hint.style.display = "none";
    var onramp = document.getElementById("x402-onramp-bar");
    if (onramp) onramp.style.display = "none";

    var picker = document.getElementById("x402-accept-picker");
    var netSel = document.getElementById("x402-pick-network");
    var assetSel = document.getElementById("x402-pick-asset");
    var meta = document.getElementById("x402-pick-meta");
    var btn = document.getElementById("x402-pick-continue");
    if (!picker || !netSel || !assetSel || !btn) return;

    var accepts = (window.x402.paymentRequired && window.x402.paymentRequired.accepts) || [];
    var byNet = {};
    accepts.forEach(function (a) {
      if (!byNet[a.network]) byNet[a.network] = [];
      byNet[a.network].push(a);
    });
    Object.keys(byNet).forEach(function (net) {
      var opt = document.createElement("option");
      opt.value = net;
      opt.textContent = LABEL[net] || net;
      netSel.appendChild(opt);
    });

    function refreshAssets() {
      assetSel.innerHTML = "";
      var list = byNet[netSel.value] || [];
      list.forEach(function (a) {
        var opt = document.createElement("option");
        opt.value = a.asset;
        opt.textContent = symbolOf(a) + " (" + (a.extra && a.extra.assetTransferMethod ? a.extra.assetTransferMethod : "eip3009") + ")";
        assetSel.appendChild(opt);
      });
      refreshMeta();
    }
    function refreshMeta() {
      var list = byNet[netSel.value] || [];
      var a = null;
      for (var i = 0; i < list.length; i++) if (list[i].asset === assetSel.value) a = list[i];
      if (!a) { meta.textContent = ""; return; }
      meta.textContent = "payTo " + a.payTo + " · amount " + a.amount + " · " + a.network;
    }
    netSel.addEventListener("change", refreshAssets);
    assetSel.addEventListener("change", refreshMeta);
    refreshAssets();
    picker.setAttribute("data-open", "1");

    btn.addEventListener("click", function () {
      try {
        sessionStorage.setItem(key, JSON.stringify({ network: netSel.value, asset: assetSel.value }));
      } catch (e) {}
      location.reload();
    });
  });
})();
</script>
`;
}

function onrampPanelHtml(): string {
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
