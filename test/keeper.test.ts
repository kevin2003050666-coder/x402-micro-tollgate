import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KEEPER_INTERVAL_MS,
  DEFAULT_KEEPER_MIN_USDC,
  loadKeeperConfig,
  startFeeSplitterKeeper,
} from "../src/keeper.js";
import { BUILTIN_DEMO_MERCHANTS } from "../src/merchants.js";

describe("FeeSplitter keeper config", () => {
  it("is disabled by default", () => {
    const cfg = loadKeeperConfig(
      {},
      { network: "eip155:84532", merchants: BUILTIN_DEMO_MERCHANTS },
    );
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.intervalMs, DEFAULT_KEEPER_INTERVAL_MS);
    assert.equal(cfg.minUsdc, DEFAULT_KEEPER_MIN_USDC);
  });

  it("enables dry-run without private key", () => {
    const cfg = loadKeeperConfig(
      {
        KEEPER_ENABLED: "true",
        KEEPER_DRY_RUN: "true",
        KEEPER_INTERVAL_MS: "5000",
        KEEPER_MIN_USDC: "2000000",
      },
      { network: "eip155:8453", merchants: BUILTIN_DEMO_MERCHANTS },
    );
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.intervalMs, 5000);
    assert.equal(cfg.minUsdc, 2_000_000n);
    assert.equal(cfg.privateKey, undefined);
  });

  it("startFeeSplitterKeeper returns null when disabled", () => {
    const handle = startFeeSplitterKeeper({
      enabled: false,
      dryRun: true,
      privateKey: undefined,
      rpcUrl: undefined,
      intervalMs: 60_000,
      minUsdc: DEFAULT_KEEPER_MIN_USDC,
      network: "eip155:84532",
      merchants: BUILTIN_DEMO_MERCHANTS,
    });
    assert.equal(handle, null);
  });

  it("startFeeSplitterKeeper dry-run starts and can stop", async () => {
    const logs: Record<string, unknown>[] = [];
    const handle = startFeeSplitterKeeper(
      {
        enabled: true,
        dryRun: true,
        privateKey: undefined,
        // Use a bogus RPC — tick may error; we only assert start + stop.
        rpcUrl: "http://127.0.0.1:9",
        intervalMs: 60 * 60 * 1000,
        minUsdc: DEFAULT_KEEPER_MIN_USDC,
        network: "eip155:84532",
        merchants: BUILTIN_DEMO_MERCHANTS,
      },
      {
        info: (m) => logs.push(m),
        error: (m) => logs.push(m),
      },
    );
    assert.ok(handle);
    assert.ok(logs.some((l) => l.msg === "keeper_started"));
    // Give the first tick a moment to attempt RPC (will fail fast to closed port).
    await new Promise((r) => setTimeout(r, 50));
    handle!.stop();
  });
});
