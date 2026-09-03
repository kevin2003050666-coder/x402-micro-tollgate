import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyCliEnv, parseCliArgs } from "../src/cli-args.js";

describe("CLI arg parsing", () => {
  it("parses --seller and applies X402_PAY_TO", () => {
    const opts = parseCliArgs([
      "--seller",
      "0x1234567890123456789012345678901234567890",
      "--stdio",
    ]);
    assert.equal(opts.stdio, true);
    assert.equal(opts.seller, "0x1234567890123456789012345678901234567890");
    assert.equal(opts.sellerMissingValue, false);

    const env: NodeJS.ProcessEnv = {};
    applyCliEnv(opts, env);
    assert.equal(env.X402_PAY_TO, "0x1234567890123456789012345678901234567890");
  });

  it("parses short -s as seller", () => {
    const opts = parseCliArgs(["-s", "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]);
    assert.equal(opts.seller, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  });

  it("flags missing --seller value", () => {
    const opts = parseCliArgs(["--seller", "--stdio"]);
    assert.equal(opts.seller, undefined);
    assert.equal(opts.sellerMissingValue, true);
    assert.equal(opts.stdio, true);
  });

  it("parses --port / -p without affecting seller", () => {
    const opts = parseCliArgs(["--port", "9000", "-s", "0x1111111111111111111111111111111111111111"]);
    assert.equal(opts.port, "9000");
    assert.equal(opts.seller, "0x1111111111111111111111111111111111111111");

    const env: NodeJS.ProcessEnv = { X402_PAY_TO: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    applyCliEnv({ port: opts.port }, env);
    assert.equal(env.PORT, "9000");
    assert.equal(env.X402_PAY_TO, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("does not invent seller when flag omitted (env preserved)", () => {
    const opts = parseCliArgs(["--stdio"]);
    assert.equal(opts.seller, undefined);
    const env: NodeJS.ProcessEnv = { X402_PAY_TO: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    applyCliEnv(opts, env);
    assert.equal(env.X402_PAY_TO, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("parses --help / -h", () => {
    assert.equal(parseCliArgs(["--help"]).help, true);
    assert.equal(parseCliArgs(["-h"]).help, true);
    assert.equal(parseCliArgs([]).help, false);
  });
});
