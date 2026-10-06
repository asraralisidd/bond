import { describe, expect, it } from "vitest";
import { DomainError } from "@bond/shared-types";
import { MIDNIGHT_ENV_KEYS, resolveMidnightConfig } from "./config.js";

describe("midnight configuration", () => {
  it("defaults to SIMULATED with no network configured", () => {
    const config = resolveMidnightConfig({});
    expect(config.mode).toBe("SIMULATED");
    expect(config.endpoints).toBeNull();
  });

  it("resolves REAL undeployed endpoints with overrides", () => {
    const config = resolveMidnightConfig({
      MIDNIGHT_NETWORK: "undeployed",
      BOND_CONTRACT_ADDRESS: "addr-test-123",
    });
    expect(config.mode).toBe("REAL");
    expect(config.endpoints?.networkId).toBe("undeployed");
    expect(config.endpoints?.indexerHttp).toContain("127.0.0.1:8088");
    expect(config.endpoints?.proofServerUrl).toBe("http://127.0.0.1:6300");
    expect(config.contractAddress).toBe("addr-test-123");
    const overridden = resolveMidnightConfig({
      MIDNIGHT_NETWORK: "preprod",
      PROOF_SERVER_URL: "http://proof.internal:6300",
    });
    expect(overridden.endpoints?.networkId).toBe("preprod");
    expect(overridden.endpoints?.proofServerUrl).toBe(
      "http://proof.internal:6300",
    );
    expect(overridden.endpoints?.indexerHttp).toContain("preprod");
  });

  it("supports explicit UNAVAILABLE and rejects unknown networks", () => {
    expect(resolveMidnightConfig({ MIDNIGHT_NETWORK: "off" }).mode).toBe(
      "UNAVAILABLE",
    );
    expect(() =>
      resolveMidnightConfig({ MIDNIGHT_NETWORK: "mainnet-fork-2" }),
    ).toThrowError(DomainError);
  });

  it("documents every env key it reads", () => {
    expect([...MIDNIGHT_ENV_KEYS]).toEqual([
      "MIDNIGHT_NETWORK",
      "MIDNIGHT_INDEXER_HTTP",
      "MIDNIGHT_INDEXER_WS",
      "MIDNIGHT_NODE_URL",
      "PROOF_SERVER_URL",
      "BOND_CONTRACT_ADDRESS",
      "BOND_ZK_ASSETS_PATH",
    ]);
  });
});
