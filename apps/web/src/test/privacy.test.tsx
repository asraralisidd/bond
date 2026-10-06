/**
 * Privacy/security UI tests: what the DOM may and may not contain.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { VerifyPage } from "../pages/Verify.js";
import { StatusBadge, ModeBadge } from "../components/chrome.js";
import { TxBadge } from "../components/lifecycle.js";
import { cleanup, fetchCalls, flush, render, stubFetch } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const PRIVATE_CANARIES = [
  "424242424242",
  "nullifier-canary-001",
  "witness-canary-002",
  "secret-canary-003",
  "amountMinorUnits",
  "commitmentSalt",
  "operatorSecret",
  "privateKey",
];

function verificationPayload() {
  return {
    data: {
      verification: {
        agentId: "agent-001",
        result: "caution",
        policyVersion: "bond-policy-v1",
        rulesVersion: "v0",
        registrationStatus: "ACTIVE",
        bondStatus: "ACTIVE",
        reputationStanding: "good",
        slashCount: 0,
        asOf: "2026-10-06T00:00:00.000Z",
      },
      bond: { status: "ACTIVE" },
      reputation: {
        standing: "good",
        confirmedFlags: 0,
        partialSlashes: 0,
        fullSlashes: 0,
        resolvedWithRemediation: 0,
      },
      slashHistory: [],
      // A compromised/spurious backend must still not leak: these fields
      // are not rendered because components allowlist what they show.
      amountMinorUnits: "424242424242",
      nullifier: "nullifier-canary-001",
      witness: "witness-canary-002",
      secret: "secret-canary-003",
    },
  };
}

describe("public verification privacy", () => {
  it("renders the verdict without any private fields", async () => {
    const restore = stubFetch((url) => {
      if (url.includes("/eligibility")) {
        return {
          data: {
            agentId: "agent-001",
            policyVersion: "bond-policy-v1",
            eligible: true,
            proofs: [],
            asOf: "2026-10-06T00:00:00.000Z",
          },
        };
      }
      return verificationPayload();
    });
    const container = await render(<VerifyPage />);
    const input = container.querySelector("#verify-agent") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, "agent-001");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const form = container.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    await flush();
    const html = container.innerHTML;
    expect(html).toContain("caution");
    for (const canary of PRIVATE_CANARIES) {
      expect(html, `must not render ${canary}`).not.toContain(canary);
    }
    // Precise language: absence of findings, never a safety claim.
    expect(html).toContain("No confirmed findings");
    expect(html).not.toContain("This agent is safe");
    expect(html).not.toMatch(/proven safe/i);
    restore();
    cleanup(container);
  });

  it("SIMULATED transactions are never shown as confirmed", async () => {
    const sim = await render(<TxBadge status="SUBMITTED" mode="SIMULATED" />);
    expect(sim.innerHTML).toContain("SIMULATED");
    expect(sim.textContent).not.toContain("Confirmed");
    cleanup(sim);

    const confirmed = await render(<TxBadge status="CONFIRMED" mode="REAL" />);
    expect(confirmed.textContent).toContain("Confirmed");
    expect(confirmed.innerHTML).not.toContain("SIMULATED");
    cleanup(confirmed);

    const mode = await render(<ModeBadge mode="SIMULATED" />);
    expect(mode.textContent).toContain("SIMULATED");
    cleanup(mode);
  });

  it("status badges never invent private data", async () => {
    const container = await render(
      <div>
        <StatusBadge status="SLASHED" />
        <StatusBadge status="ACTIVE" />
      </div>,
    );
    expect(container.textContent).toContain("SLASHED");
    expect(container.textContent).toContain("ACTIVE");
    cleanup(container);
    expect(fetchCalls()).toEqual([]);
  });
});
