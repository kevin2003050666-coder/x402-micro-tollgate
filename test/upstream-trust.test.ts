import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import {
  buildUpstreamTrustHeaders,
  verifyUpstreamTrustHeaders,
} from "../src/upstream-trust.js";

const SECRET = "test-upstream-shared-secret";

describe("upstream trust headers", () => {
  it("buildUpstreamTrustHeaders produces verifiable HMAC", () => {
    const material = buildUpstreamTrustHeaders(SECRET, { method: "GET", path: "/v1/quote" }, 1_700_000_000_000);
    assert.equal(material.headers["X-Tollgate-Secret"], SECRET);
    assert.equal(material.headers["X-Tollgate-Timestamp"], "1700000000000");
    assert.match(material.headers["X-Tollgate-Paid"]!, /^[a-f0-9]{64}$/);

    const ok = verifyUpstreamTrustHeaders(
      SECRET,
      material.headers,
      { method: "GET", path: "/v1/quote" },
      { nowMs: 1_700_000_000_000 },
    );
    assert.deepEqual(ok, { ok: true });
  });

  it("verifyUpstreamTrustHeaders rejects spoofed HMAC", () => {
    const material = buildUpstreamTrustHeaders(SECRET, { method: "GET", path: "/v1/quote" }, 1_700_000_000_000);
    const bad = verifyUpstreamTrustHeaders(
      SECRET,
      { ...material.headers, "X-Tollgate-Paid": "00".repeat(32) },
      { method: "GET", path: "/v1/quote" },
      { nowMs: 1_700_000_000_000 },
    );
    assert.equal(bad.ok, false);
  });

  it("proxy injects trust headers after payment and strips client spoof", async () => {
    let seen: http.IncomingHttpHeaders | undefined;
    const upstream = http.createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = upstream.address() as AddressInfo;

    try {
      const config = loadConfig({
        GATED_PREFIX: "/v1",
        UPSTREAM_URL: `http://127.0.0.1:${port}`,
        UPSTREAM_SHARED_SECRET: SECRET,
      });
      const { app } = await createApp({
        config,
        paymentLayer: createDemoPaymentLayer(config),
        disableMcp: true,
      });

      const res = await request(app)
        .get("/v1/quote")
        .set("PAYMENT-SIGNATURE", "demo-settled-trust-unique")
        .set("x-demo-payment", "settled")
        .set("X-Tollgate-Secret", "forged-by-client")
        .set("X-Tollgate-Paid", "forged");

      assert.equal(res.status, 200);
      assert.ok(seen);
      assert.equal(seen["x-tollgate-secret"], SECRET);
      assert.ok(typeof seen["x-tollgate-paid"] === "string");
      assert.notEqual(seen["x-tollgate-paid"], "forged");
      assert.ok(seen["x-tollgate-timestamp"]);

      const check = verifyUpstreamTrustHeaders(
        SECRET,
        {
          "x-tollgate-secret": String(seen["x-tollgate-secret"]),
          "x-tollgate-paid": String(seen["x-tollgate-paid"]),
          "x-tollgate-timestamp": String(seen["x-tollgate-timestamp"]),
        },
        { method: "GET", path: "/v1/quote" },
        { nowMs: Number(seen["x-tollgate-timestamp"]) },
      );
      assert.deepEqual(check, { ok: true });
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
