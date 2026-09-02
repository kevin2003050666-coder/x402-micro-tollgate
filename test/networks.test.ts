import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
} from "../src/config.js";
import {
  NETWORK_CATALOG,
  normalizeNetworkId,
  parseAcceptSpecs,
  parseNetworksList,
  SOLANA_MAINNET,
  TRON_MAINNET_PLANNED,
} from "../src/networks.js";
import {
  acceptPickerHtml,
  createTollgatePaywall,
  injectBuyerExtras,
  patchPaywallConnectors,
  PAYWALL_CONNECTORS_MARKER,
} from "../src/paywall.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import { createApp } from "../src/app.js";
import request from "supertest";

describe("networks catalog + accepts parsing", () => {
  it("normalizes aliases to CAIP-2", () => {
    assert.equal(normalizeNetworkId("base"), "eip155:8453");
    assert.equal(normalizeNetworkId("optimism"), "eip155:10");
    assert.equal(normalizeNetworkId("bsc"), "eip155:56");
    assert.equal(normalizeNetworkId("avalanche-c"), "eip155:43114");
    assert.equal(normalizeNetworkId("solana"), SOLANA_MAINNET);
    assert.equal(normalizeNetworkId("eip155:8453"), "eip155:8453");
  });

  it("defaults to single Base Sepolia USDC accept", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.network, "eip155:84532");
    assert.deepEqual(cfg.networks, ["eip155:84532"]);
    assert.equal(cfg.accepts.length, 1);
    assert.equal(cfg.accepts[0]?.symbol, "USDC");
    assert.equal(cfg.accepts[0]?.network, "eip155:84532");
  });

  it("parses NETWORKS × ASSETS including USDT + BSC", () => {
    const cfg = loadConfig({
      X402_ENVIRONMENT: "production",
      NETWORKS: "base,optimism,bsc",
      ASSETS: "usdc,usdt",
    });
    assert.equal(cfg.network, "eip155:8453");
    assert.ok(cfg.networks.includes("eip155:56"));
    const pairs = cfg.accepts.map((a) => `${a.network}:${a.symbol}`);
    assert.ok(pairs.includes("eip155:8453:USDC"));
    assert.ok(pairs.includes("eip155:8453:USDT"));
    assert.ok(pairs.includes("eip155:10:USDT"));
    assert.ok(pairs.includes("eip155:56:USDT"));
    const bscUsdt = cfg.accepts.find((a) => a.network === "eip155:56" && a.symbol === "USDT");
    assert.equal(bscUsdt?.decimals, 18);
    assert.equal(bscUsdt?.transferMethod, "permit2");
  });

  it("parses ACCEPTS_JSON / X402_ACCEPTS_JSON with Solana payTo", () => {
    const cfg = loadConfig({
      X402_ACCEPTS_JSON: JSON.stringify([
        { network: "base", asset: "USDC" },
        { network: "arbitrum", asset: "USDT" },
        {
          network: "solana",
          asset: "USDC",
          payTo: "So11111111111111111111111111111111111111112",
        },
      ]),
    });
    assert.equal(cfg.accepts.length, 3);
    assert.equal(cfg.accepts[2]?.network, SOLANA_MAINNET);
    assert.equal(cfg.paywallSvm, true);
  });

  it("rejects TRON in NETWORKS (planned only)", () => {
    assert.throws(
      () => parseNetworksList({ NETWORKS: "base,tron" }, "eip155:8453"),
      /planned only/,
    );
    assert.equal(NETWORK_CATALOG[TRON_MAINNET_PLANNED]?.status, "planned");
  });

  it("skips Solana in NETWORKS×ASSETS without SOLANA_PAY_TO", () => {
    const specs = parseAcceptSpecs(
      { NETWORKS: "base,solana", ASSETS: "USDC" },
      ["eip155:8453", SOLANA_MAINNET],
      "eip155:8453",
    );
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.network, "eip155:8453");
  });
});

describe("multi-accept demo 402 + paywall picker", () => {
  it("402 accepts[] lists multiple networks/assets when configured", async () => {
    const config = loadConfig({
      X402_ENVIRONMENT: "production",
      NETWORKS: "base,arbitrum",
      ASSETS: "USDC,USDT",
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
      MERCHANTS_JSON: JSON.stringify({
        demo: {
          seller: "0x1234567890123456789012345678901234567890",
          payTo: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          label: "demo",
        },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });
    const res = await request(app)
      .get("/v1/quote")
      .set("Accept", "application/json");
    assert.equal(res.status, 402);
    const header = res.headers["payment-required"];
    assert.ok(header);
    const decoded = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
    assert.ok(decoded.accepts.length >= 4);
    const nets = new Set(decoded.accepts.map((a: { network: string }) => a.network));
    assert.ok(nets.has("eip155:8453"));
    assert.ok(nets.has("eip155:42161"));
  });

  it("patches connectors and injects accept picker for multi-wallet UX", () => {
    const html = patchPaywallConnectors(
      `<html><body><script>${PAYWALL_CONNECTORS_MARKER}</script></body></html>`,
    );
    assert.match(html, /metaMask/);
    assert.match(html, /smartWalletOnly/);
    assert.match(html, /extraConnectors/);

    const withPicker = injectBuyerExtras(html, {
      walletConnectProjectId: "wc-test",
      enableSvm: false,
    });
    assert.match(withPicker, /x402-accept-picker/);
    assert.match(withPicker, /Choose network/);
    assert.match(withPicker, /WALLETCONNECT_PROJECT_ID|walletConnectProjectId|wc-test/);
    assert.match(withPicker, /Passkey Smart Wallet/);

    const pickerOnly = acceptPickerHtml();
    assert.match(pickerOnly, /x402-pick-network/);
    assert.match(pickerOnly, /x402-pick-asset/);
  });

  it("paywall HTML includes picker script when multi accepts", () => {
    const config = loadConfig({
      NETWORKS: "base,polygon",
      ASSETS: "USDC,USDT",
      X402_ENVIRONMENT: "production",
      WALLETCONNECT_PROJECT_ID: "demo-project",
      CDP_CLIENT_API_KEY: "pk_demo",
    });
    const paywall = createTollgatePaywall(config);
    const accepts = config.accepts.map((a) => ({
      scheme: "exact",
      network: a.network,
      asset: a.asset,
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      amount: "1000",
      extra: {
        name: a.name,
        version: a.version ?? "2",
        ...(a.transferMethod === "permit2"
          ? { assetTransferMethod: "permit2" }
          : {}),
      },
    }));
    const html = paywall.generateHtml({
      x402Version: 2,
      resource: { url: "https://example.com/v1/quote" },
      accepts,
    });
    assert.match(html, /x402-accept-picker/);
    assert.match(html, /extraConnectors|walletConnect/);
    assert.match(html, /Passkey Smart Wallet/);
  });

  it("health exposes matrix + wallets", async () => {
    const config = loadConfig({
      NETWORKS: "base",
      ASSETS: "USDC",
      X402_ENVIRONMENT: "production",
      WALLETCONNECT_PROJECT_ID: "wc",
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });
    const health = await request(app).get("/health");
    assert.equal(health.status, 200);
    assert.ok(Array.isArray(health.body.networkMatrix));
    assert.ok(health.body.networkMatrix.some((r: { status: string }) => r.status === "planned"));
    assert.ok(health.body.paywall.wallets.includes("coinbase-smart-wallet"));
    assert.ok(health.body.paywall.wallets.includes("walletconnect"));
  });
});
