import { describe, expect, it } from "vitest";
import { RISK_ENGINE_STATUS } from "@bond/risk-engine";
import { ATTESTOR_STATUS } from "@bond/attestor";
import { MIDNIGHT_ADAPTER_STATUS } from "@bond/midnight-adapter";

describe("foundation shells", () => {
  it("all domain packages report not-implemented", () => {
    expect(RISK_ENGINE_STATUS).toBe("not-implemented");
    expect(ATTESTOR_STATUS).toBe("not-implemented");
    expect(MIDNIGHT_ADAPTER_STATUS).toBe("not-implemented");
  });
});
