/**
 * Phase 11 frontend wallet tests: connector absence, account identity
 * handling, and honest transaction labels. No real wallet exists in
 * tests — window.midnight is stubbed or absent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { availableWallets } from "../wallet/connector.js";
import { TxBadge } from "../components/lifecycle.js";
import { cleanup, flush, render } from "./helpers.js";
import { LoginPage } from "../pages/Login.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  delete (window as unknown as { midnight?: unknown }).midnight;
});

describe("wallet connector surface", () => {
  it("reports no wallets when none is injected", () => {
    expect(availableWallets()).toEqual([]);
  });

  it("lists injected wallets without trusting their metadata", async () => {
    (window as unknown as { midnight?: unknown }).midnight = {
      "com.example.hostile": {
        rdns: "com.example.hostile",
        name: '<img src=x onerror="alert(1)">',
        apiVersion: "4.0.1",
        connect: async () => {
          throw new Error("denied");
        },
      },
    };
    expect(availableWallets()).toEqual([
      { rdns: "com.example.hostile", name: '<img src=x onerror="alert(1)">' },
    ]);
    // The hostile name renders as text (React escaping), never as markup.
    const container = await render(<LoginPage />);
    await flush();
    expect(container.querySelector("img")).toBeNull();
    cleanup(container);
  });
});

describe("honest transaction labels", () => {
  it("never claims success before confirmation", async () => {
    const waiting = await render(
      <TxBadge status="WALLET_APPROVAL" mode="REAL" />,
    );
    expect(waiting.textContent).toContain("Awaiting Wallet Approval");
    expect(waiting.textContent).not.toMatch(/success|confirm/i);
    cleanup(waiting);

    const submitted = await render(<TxBadge status="SUBMITTED" mode="REAL" />);
    expect(submitted.textContent).toContain("Submitted");
    expect(submitted.textContent).not.toContain("Confirmed");
    cleanup(submitted);

    const confirmed = await render(<TxBadge status="CONFIRMED" mode="REAL" />);
    expect(confirmed.textContent).toContain("Confirmed");
    cleanup(confirmed);
  });

  it("marks SIMULATED receipts explicitly", async () => {
    const sim = await render(<TxBadge status="SUBMITTED" mode="SIMULATED" />);
    expect(sim.textContent).toContain("SIMULATED");
    cleanup(sim);
  });
});
