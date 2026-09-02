import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { RequestHandler } from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  createDemoPaymentLayer,
  withPublicResourceUrl,
  withMerchantGate,
  buildPublicResourceUrl,
} from "../src/payment.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { paymentRequiredJsonBody } from "../src/payment-required-body.js";
import {
  BUILTIN_DEMO_MERCHANTS,
  OPERATOR_FEE_COLLECTOR,
} from "../src/merchants.js";

const TEST_SELLER = "0x1234567890123456789012345678901234567890";
const TEST_SPLITTER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const OTHER_SPLITTER = "0x9999999999999999999999999999999999999999";
const OTHER_SELLER = "0x8888888888888888888888888888888888888888";
const SDK_GLOBAL_PAYTO = "0x1111111111111111111111111111111111111111";

function merchantsJson(
  entries: Record<string, { seller: string; payTo: string; label: string }>,
): string {
  return JSON.stringify(entries);
}

describe("gateway HTTP", () => {
  it("GET /health is free and returns 200 with feeCollector + defaultMerchant", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
    });

    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.service, "x402-micro-tollgate");
    assert.equal(res.body.feeCollector, OPERATOR_FEE_COLLECTOR);
    assert.equal(res.body.defaultMerchant, "demo");
    assert.ok(res.headers["x-request-id"]);
  });

  it("GET /merchants returns demo entry free", async () => {
    const config = loadConfig({});
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app).get("/merchants");
    assert.equal(res.status, 200);
    assert.equal(res.body.feeCollector, OPERATOR_FEE_COLLECTOR);
    assert.equal(res.body.defaultMerchant, "demo");
    assert.ok(Array.isArray(res.body.merchants));
    const demo = res.body.merchants.find((m: { id: string }) => m.id === "demo");
    assert.ok(demo);
    assert.equal(demo.seller, BUILTIN_DEMO_MERCHANTS.demo.seller);
    assert.equal(demo.payTo, BUILTIN_DEMO_MERCHANTS.demo.payTo);
    assert.equal(demo.label, BUILTIN_DEMO_MERCHANTS.demo.label);

    const underV1 = await request(app).get("/v1/merchants");
    assert.equal(underV1.status, 200);
    assert.ok(Array.isArray(underV1.body.merchants));
  });

  it("GET / landing is free HTML", async () => {
    const config = loadConfig({});
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app).get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /html/i);
    assert.match(res.text, /x402-micro-tollgate/);
    assert.match(res.text, /pay-per-call/i);
    assert.match(res.text, /Coinbase CDP/);
    assert.match(res.text, /official SDK/i);
    assert.match(res.text, /mailto:2767111713@qq\.com/);
    assert.doesNotMatch(res.text, /__CONTACT_EMAIL__/);
    assert.doesNotMatch(res.text, /\$9\.90/);
    assert.doesNotMatch(res.text, /waitlist/i);
    assert.doesNotMatch(res.text, /托管候补/);
  });

  it("GET /zh is free HTML", async () => {
    const config = loadConfig({});
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app).get("/zh");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /html/i);
    assert.match(res.text, /Coinbase CDP/);
    assert.match(res.text, /官方 SDK/);
  });

  it("unpaid gated route returns 402 with default merchant payTo", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      PRICE: "$0.001",
      NETWORK: "eip155:84532",
      GATED_PREFIX: "/v1",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app).get("/v1/quote");
    assert.equal(res.status, 402);
    assert.ok(res.headers["payment-required"]);
    assert.equal(res.body.error, "Payment Required");
    assert.equal(res.body.price, "$0.001 USDC");
    assert.match(res.body.doc, /kevin2003050666-coder\/x402-micro-tollgate/);
    assert.match(res.body.message, /paywall/i);

    const required = decodePaymentRequiredHeader(res.headers["payment-required"] as string);
    assert.equal(required.x402Version, 2);
    assert.ok(Array.isArray(required.accepts));
    assert.equal(required.accepts[0]?.network, "eip155:84532");
    assert.equal(required.accepts[0]?.payTo, TEST_SPLITTER);
    assert.equal(required.accepts[0]?.scheme, "exact");
    assert.equal(required.accepts[0]?.amount, "1000");
    assert.equal(required.resource?.url, "https://tollgate.example.com/v1/quote");
    assert.ok(required.extensions?.bazaar);
    const bazaar = required.extensions!.bazaar as { discoverable?: boolean };
    assert.equal(bazaar.discoverable, true);
  });

  it("resolves merchant from query and header; unknown merchant → 400", async () => {
    const config = loadConfig({
      GATED_PREFIX: "/v1",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
        acme: { seller: OTHER_SELLER, payTo: OTHER_SPLITTER, label: "Acme" },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const byQuery = await request(app).get("/v1/quote").query({ merchant: "acme" });
    assert.equal(byQuery.status, 402);
    const qRequired = decodePaymentRequiredHeader(byQuery.headers["payment-required"] as string);
    assert.equal(qRequired.accepts[0]?.payTo, OTHER_SPLITTER);

    const byHeader = await request(app).get("/v1/quote").set("x-merchant-id", "acme");
    assert.equal(byHeader.status, 402);
    const hRequired = decodePaymentRequiredHeader(byHeader.headers["payment-required"] as string);
    assert.equal(hRequired.accepts[0]?.payTo, OTHER_SPLITTER);

    const unknown = await request(app).get("/v1/quote").query({ merchant: "nope" });
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.body, { error: "unknown_merchant" });

    // Free paths must not break on unknown merchant
    const health = await request(app).get("/health").query({ merchant: "nope" });
    assert.equal(health.status, 200);
    const root = await request(app).get("/").query({ merchant: "nope" });
    assert.equal(root.status, 200);
    const merchants = await request(app).get("/merchants").query({ merchant: "nope" });
    assert.equal(merchants.status, 200);
  });

  it("REQUIRE_MERCHANT=true rejects gated calls without merchant id", async () => {
    const config = loadConfig({
      GATED_PREFIX: "/v1",
      REQUIRE_MERCHANT: "true",
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
        acme: { seller: OTHER_SELLER, payTo: OTHER_SPLITTER, label: "Acme" },
      }),
    });
    assert.equal(config.requireMerchant, true);
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const missing = await request(app).get("/v1/quote");
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: "merchant_required" });

    const ok = await request(app).get("/v1/quote").query({ merchant: "acme" });
    assert.equal(ok.status, 402);
  });

  it("unpaid GET /v1/fetch-md returns 402 with readable JSON body", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      PRICE: "$0.002",
      GATED_PREFIX: "/v1",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app).get("/v1/fetch-md").query({ url: "https://example.com" });
    assert.equal(res.status, 402);
    assert.ok(res.headers["payment-required"]);
    assert.equal(res.body.error, "Payment Required");
    assert.equal(res.body.price, "$0.002 USDC");
    assert.equal(
      res.body.doc,
      "https://github.com/kevin2003050666-coder/x402-micro-tollgate",
    );
    assert.match(res.body.message, /host your own tollgate/i);

    const required = decodePaymentRequiredHeader(res.headers["payment-required"] as string);
    assert.equal(
      required.resource?.url,
      "https://tollgate.example.com/v1/fetch-md?url=https%3A%2F%2Fexample.com",
    );
    assert.equal(required.accepts[0]?.payTo, TEST_SPLITTER);
  });

  it("empty JSON body probe on gated route returns 402 not 400", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app)
      .post("/v1/quote")
      .set("content-type", "application/json")
      .send("");
    assert.equal(res.status, 402);
    assert.ok(res.headers["payment-required"]);
  });

  it("demo settled payment succeeds once; replaying PAYMENT-SIGNATURE is rejected", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
    });

    const first = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "demo-settled");
    assert.equal(first.status, 200);
    assert.equal(first.body.source, "x402-micro-tollgate-mock");
    assert.ok(first.headers["payment-response"]);

    const replay = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "demo-settled");
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, "payment_already_used");

    // A distinct settled signature still works (demo accepts x-demo-payment).
    const second = await request(app)
      .get("/v1/quote")
      .set("x-demo-payment", "settled")
      .set("PAYMENT-SIGNATURE", "demo-settled-other");
    assert.equal(second.status, 200);
    assert.equal(second.body.symbol, "ETH-USD");
  });

  it("non-gated path outside prefix is not charged when prefix is /v1", async () => {
    const config = loadConfig({ GATED_PREFIX: "/v1" });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      upstreamHandler: (req, res) => {
        res.status(200).json({ proxied: true, path: req.path });
      },
    });

    const res = await request(app).get("/public/info");
    // Upstream handler receives it because payment middleware lets it through.
    assert.equal(res.status, 200);
    assert.equal(res.body.proxied, true);
  });
});

describe("proxy wiring to real upstream", () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let hits = 0;

  before(async () => {
    upstream = http.createServer((req, res) => {
      hits += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            method: req.method,
            url: req.url,
            paymentSignatureForwarded: Boolean(req.headers["payment-signature"]),
            body: Buffer.concat(chunks).toString("utf8") || null,
            hit: hits,
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      upstream.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("forwards method/path/query/body after payment middleware allows", async () => {
    hits = 0;
    const config = loadConfig({
      UPSTREAM_URL: upstreamUrl,
      X402_PAY_TO: TEST_SELLER,
      GATED_PREFIX: "/v1",
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
    });

    const res = await request(app)
      .post("/v1/orders?ref=42")
      .set("PAYMENT-SIGNATURE", "demo-settled")
      .set("content-type", "application/json")
      .send({ sku: "alpha", qty: 2 });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.method, "POST");
    assert.equal(res.body.url, "/v1/orders?ref=42");
    assert.equal(res.body.paymentSignatureForwarded, false);
    assert.equal(JSON.parse(res.body.body).sku, "alpha");
    assert.equal(hits, 1);
  });

  it("unpaid request never hits upstream", async () => {
    hits = 0;
    const config = loadConfig({
      UPSTREAM_URL: upstreamUrl,
      X402_PAY_TO: TEST_SELLER,
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
    });

    const res = await request(app).get("/v1/secret");
    assert.equal(res.status, 402);
    assert.equal(hits, 0);
  });
});

describe("GET /v1/fetch-md paid demo", () => {
  let fixture: http.Server;
  let fixtureUrl: string;

  before(async () => {
    fixture = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>Fixture Page</title></head>` +
          `<body><h1>Hello Agents</h1><p>Paid <strong>markdown</strong> demo.</p></body></html>`,
      );
    });
    await new Promise<void>((resolve) => {
      fixture.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = fixture.address() as AddressInfo;
    fixtureUrl = `http://127.0.0.1:${addr.port}/`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      fixture.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("demo-settled fetch of local HTML fixture returns markdown", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
    });
    const { createFetchMdHandler } = await import("../src/fetch-md.js");
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
      // Fixture is loopback; production handler blocks private IPs.
      fetchMdHandler: createFetchMdHandler({
        assertSafeUrl: async (raw) => new URL(raw),
      }),
    });

    const res = await request(app)
      .get("/v1/fetch-md")
      .query({ url: fixtureUrl })
      .set("PAYMENT-SIGNATURE", "demo-settled");

    assert.equal(res.status, 200);
    assert.equal(res.body.url, fixtureUrl);
    assert.equal(res.body.title, "Fixture Page");
    assert.match(res.body.markdown, /# Hello Agents/);
    assert.match(res.body.markdown, /\*\*markdown\*\*/);
    assert.ok(res.headers["payment-response"]);
  });

  it("rejects localhost and private URLs after payment", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    // Use x-demo-payment without a shared PAYMENT-SIGNATURE so dedupe does not
    // block successive negative cases on the same app instance.
    const local = await request(app)
      .get("/v1/fetch-md")
      .query({ url: "http://127.0.0.1/" })
      .set("x-demo-payment", "settled");
    assert.equal(local.status, 400);
    assert.equal(local.body.error.code, "ssrf_blocked");

    const privateIp = await request(app)
      .get("/v1/fetch-md")
      .query({ url: "http://192.168.1.10/secret" })
      .set("x-demo-payment", "settled");
    assert.equal(privateIp.status, 400);
    assert.equal(privateIp.body.error.code, "ssrf_blocked");

    const fileScheme = await request(app)
      .get("/v1/fetch-md")
      .query({ url: "file:///etc/passwd" })
      .set("x-demo-payment", "settled");
    assert.equal(fileScheme.status, 400);
    assert.equal(fileScheme.body.error.code, "invalid_scheme");
  });

  it("GET /health remains free after fetch-md wiring", async () => {
    const config = loadConfig({});
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });
});

describe("live PAYMENT-REQUIRED resource.url behind TLS proxy", () => {
  /**
   * Mimics @x402/express ExpressAdapter.getUrl():
   * `${req.protocol}://${host}${originalUrl}` — without trust proxy this is http://.
   * Global SDK payTo differs from per-merchant FeeSplitter payTo.
   */
  function sdkStyle402Middleware(globalPayTo: `0x${string}` = SDK_GLOBAL_PAYTO): RequestHandler {
    return (req, res) => {
      const sdkUrl = `${req.protocol}://${req.headers.host}${req.originalUrl}`;
      const paymentRequired = {
        x402Version: 2 as const,
        error: "Payment required",
        resource: {
          url: sdkUrl,
          description: "test",
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453" as `${string}:${string}`,
            amount: "1000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: globalPayTo,
            maxTimeoutSeconds: 300,
            recipient: globalPayTo,
          },
        ],
      };
      res
        .status(402)
        .setHeader(
          "PAYMENT-REQUIRED",
          encodePaymentRequiredHeader(
            paymentRequired as Parameters<typeof encodePaymentRequiredHeader>[0],
          ),
        )
        .json(paymentRequiredJsonBody(loadConfig({ PUBLIC_BASE_URL: "https://example-host" })));
    };
  }

  it("rewrites proxied http resource.url to PUBLIC_BASE_URL https + query", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      PUBLIC_BASE_URL: "https://example-host",
      GATED_PREFIX: "/v1",
    });
    assert.equal(config.publicBaseUrl, "https://example-host");

    const raw = sdkStyle402Middleware();
    const { app } = await createApp({
      config,
      paymentLayer: {
        mode: "live",
        payToEvmAddress: config.payTo,
        middleware: withPublicResourceUrl(raw, config),
      },
      disableMcp: true,
    });

    // Simulate Render: Node connection is HTTP; proxy sets X-Forwarded-Proto.
    const res = await request(app)
      .get("/v1/fetch-md")
      .query({ url: "https://example.com" })
      .set("X-Forwarded-Proto", "https")
      .set("Host", "example-host");

    assert.equal(res.status, 402);
    assert.ok(res.headers["payment-required"]);

    const required = decodePaymentRequiredHeader(
      res.headers["payment-required"] as string,
    );
    const url = required.resource?.url ?? "";
    assert.match(url, /^https:\/\//);
    assert.equal(
      url,
      "https://example-host/v1/fetch-md?url=https%3A%2F%2Fexample.com",
    );
    assert.equal(
      url,
      buildPublicResourceUrl(config, {
        originalUrl: "/v1/fetch-md?url=https%3A%2F%2Fexample.com",
      }),
    );
    // Without merchant gate, SDK global payTo is left unchanged.
    assert.equal(required.accepts[0]?.payTo, SDK_GLOBAL_PAYTO);
  });

  it("rewrites PAYMENT-REQUIRED payTo to resolved merchant FeeSplitter", async () => {
    const config = loadConfig({
      X402_PAY_TO: SDK_GLOBAL_PAYTO,
      PUBLIC_BASE_URL: "https://example-host",
      GATED_PREFIX: "/v1",
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
        acme: { seller: OTHER_SELLER, payTo: OTHER_SPLITTER, label: "Acme" },
      }),
    });

    const raw = sdkStyle402Middleware(SDK_GLOBAL_PAYTO);
    const { app } = await createApp({
      config,
      paymentLayer: {
        mode: "live",
        payToEvmAddress: config.payTo,
        middleware: withMerchantGate(withPublicResourceUrl(raw, config), config),
      },
      disableMcp: true,
    });

    const res = await request(app)
      .get("/v1/quote")
      .query({ merchant: "acme" })
      .set("X-Forwarded-Proto", "https")
      .set("Host", "example-host");

    assert.equal(res.status, 402);
    const required = decodePaymentRequiredHeader(
      res.headers["payment-required"] as string,
    );
    assert.equal(required.resource?.url, "https://example-host/v1/quote?merchant=acme");
    assert.equal(required.accepts[0]?.payTo, OTHER_SPLITTER);
    assert.equal(
      (required.accepts[0] as { recipient?: string } | undefined)?.recipient,
      OTHER_SPLITTER,
    );
  });

  it("enables trust proxy when PUBLIC_BASE_URL is https", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://example-host",
    });
    let sawProtocol: string | undefined;
    const probe: RequestHandler = (req, res) => {
      sawProtocol = req.protocol;
      res.status(200).json({ protocol: req.protocol });
    };
    const { app } = await createApp({
      config,
      paymentLayer: { mode: "demo", middleware: probe },
      disableMcp: true,
    });

    const gated = await request(app)
      .get("/v1/quote")
      .set("X-Forwarded-Proto", "https");
    assert.equal(gated.status, 200);
    assert.equal(sawProtocol, "https");
    assert.equal(gated.body.protocol, "https");
  });

  it("does not enable trust proxy for local http PUBLIC_BASE_URL", async () => {
    const config = loadConfig({
      PORT: "8402",
    });
    assert.match(config.publicBaseUrl, /^http:\/\/127\.0\.0\.1/);
    let sawProtocol: string | undefined;
    const probe: RequestHandler = (req, res) => {
      sawProtocol = req.protocol;
      res.status(200).json({ protocol: req.protocol });
    };
    const { app } = await createApp({
      config,
      paymentLayer: { mode: "demo", middleware: probe },
      disableMcp: true,
    });

    const gated = await request(app)
      .get("/v1/quote")
      .set("X-Forwarded-Proto", "https");
    assert.equal(gated.status, 200);
    assert.equal(sawProtocol, "http");
  });
});
