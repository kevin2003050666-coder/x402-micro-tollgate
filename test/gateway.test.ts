import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import { decodePaymentRequiredHeader } from "@x402/core/http";

describe("gateway HTTP", () => {
  it("GET /health is free and returns 200", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
    });

    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.service, "x402-micro-tollgate");
    assert.ok(res.headers["x-request-id"]);
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
    assert.doesNotMatch(res.text, /__WAITLIST_EMAIL__/);
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

  it("unpaid gated route returns 402 with PAYMENT-REQUIRED", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
      PRICE: "$0.001",
      NETWORK: "eip155:84532",
      GATED_PREFIX: "/v1",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
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
    assert.equal(required.accepts[0]?.payTo, "0x1234567890123456789012345678901234567890");
    assert.equal(required.accepts[0]?.scheme, "exact");
    assert.equal(required.accepts[0]?.amount, "1000");
    assert.equal(required.resource?.url, "https://tollgate.example.com/v1/quote");
    assert.ok(required.extensions?.bazaar);
    const bazaar = required.extensions!.bazaar as { discoverable?: boolean };
    assert.equal(bazaar.discoverable, true);
  });

  it("unpaid GET /v1/fetch-md returns 402 with readable JSON body", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
      PRICE: "$0.002",
      GATED_PREFIX: "/v1",
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
  });

  it("empty JSON body probe on gated route returns 402 not 400", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
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

  it("demo settled payment reaches mock upstream without double-charge on retry", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
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

    const retry = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "demo-settled");
    assert.equal(retry.status, 200);
    assert.equal(retry.body.symbol, "ETH-USD");
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
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
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
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
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
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
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
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const local = await request(app)
      .get("/v1/fetch-md")
      .query({ url: "http://127.0.0.1/" })
      .set("PAYMENT-SIGNATURE", "demo-settled");
    assert.equal(local.status, 400);
    assert.equal(local.body.error.code, "ssrf_blocked");

    const privateIp = await request(app)
      .get("/v1/fetch-md")
      .query({ url: "http://192.168.1.10/secret" })
      .set("PAYMENT-SIGNATURE", "demo-settled");
    assert.equal(privateIp.status, 400);
    assert.equal(privateIp.body.error.code, "ssrf_blocked");

    const fileScheme = await request(app)
      .get("/v1/fetch-md")
      .query({ url: "file:///etc/passwd" })
      .set("PAYMENT-SIGNATURE", "demo-settled");
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
