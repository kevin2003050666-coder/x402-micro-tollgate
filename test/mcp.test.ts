import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import {
  createMcpPaymentLayer,
  buildDemoPaymentPayload,
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
} from "../src/mcp/payment.js";
import { createTollgateMcpServer } from "../src/mcp/server.js";
import { createGetQuoteHandler, createServerInfoHandler } from "../src/mcp/tools.js";

describe("MCP payment tools", () => {
  it("server_info is free and succeeds", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    const payment = await createMcpPaymentLayer(config);
    const result = await createServerInfoHandler(config, payment)();
    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.name, "x402-micro-tollgate");
    assert.equal(body.mode, "demo");
    assert.equal(body.price, "$0.001");
    assert.ok(body.mcp.streamableHttp);
  });

  it("unpaid get_quote returns PaymentRequired-style error", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
      PRICE: "$0.001",
      NETWORK: "eip155:84532",
    });
    const payment = await createMcpPaymentLayer(config);
    const wrapped = payment.wrapPaid(
      "get_quote",
      "quote",
      createGetQuoteHandler(config),
    );

    const result = await wrapped({}, { _meta: {} });
    assert.equal(result.isError, true);
    assert.ok(result.structuredContent);
    const required = result.structuredContent as {
      x402Version: number;
      accepts: Array<{ network: string; amount: string; payTo: string; scheme: string }>;
    };
    assert.equal(required.x402Version, 2);
    assert.equal(required.accepts[0]?.network, "eip155:84532");
    assert.equal(required.accepts[0]?.amount, "1000");
    assert.equal(required.accepts[0]?.payTo, "0x1234567890123456789012345678901234567890");
    assert.equal(required.accepts[0]?.scheme, "exact");
  });

  it("unpaid proxy_request returns PaymentRequired", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    const { server, payment } = await createTollgateMcpServer(config);

    // Call via wrapped handler directly (same wiring as registered tools)
    const wrapped = payment.wrapPaid("proxy_request", "proxy", async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }));
    const result = await wrapped({ method: "GET", path: "/v1/quote" }, {});
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.x402Version, 2);
    assert.ok(Array.isArray(parsed.accepts));

    await server.close();
  });

  it("demo payment meta allows get_quote and attaches payment-response", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    const payment = await createMcpPaymentLayer(config);
    const wrapped = payment.wrapPaid(
      "get_quote",
      "quote",
      createGetQuoteHandler(config),
    );

    const demoPayment = buildDemoPaymentPayload(
      "get_quote",
      payment.accepts,
      payment.publicMcpUrl,
    );
    const result = await wrapped(
      {},
      { _meta: { [MCP_PAYMENT_META_KEY]: demoPayment } },
    );

    assert.equal(result.isError, undefined);
    assert.ok(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 200);
    assert.equal(body.body.source, "x402-micro-tollgate-mock");
    assert.equal(body.body.symbol, "ETH-USD");
  });

  it("unpaid get_quote PaymentRequired includes bazaar extension and public URL", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
    });
    const payment = await createMcpPaymentLayer(config);
    assert.equal(payment.publicMcpUrl, "https://tollgate.example.com/mcp");
    const wrapped = payment.wrapPaid(
      "get_quote",
      "quote",
      createGetQuoteHandler(config),
    );
    const result = await wrapped({}, { _meta: {} });
    assert.equal(result.isError, true);
    const required = result.structuredContent as {
      resource?: { url?: string };
      extensions?: { bazaar?: { discoverable?: boolean; info?: { input?: { toolName?: string } } } };
    };
    assert.equal(required.resource?.url, "https://tollgate.example.com/mcp");
    assert.equal(required.extensions?.bazaar?.discoverable, true);
    assert.equal(required.extensions?.bazaar?.info?.input?.toolName, "get_quote");
  });

  it("demo payment meta allows proxy_request", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    const payment = await createMcpPaymentLayer(config);
    const { createProxyRequestHandler } = await import("../src/mcp/tools.js");
    const wrapped = payment.wrapPaid(
      "proxy_request",
      "proxy",
      createProxyRequestHandler(config),
    );

    const result = await wrapped(
      { method: "GET", path: "/v1/status" },
      {
        _meta: {
          [MCP_PAYMENT_META_KEY]: buildDemoPaymentPayload(
            "proxy_request",
            payment.accepts,
            payment.publicMcpUrl,
          ),
        },
      },
    );

    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 200);
    assert.equal(body.path, "/v1/status");
    assert.equal(body.body.message, "Mock upstream OK");
  });
});
