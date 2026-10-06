/**
 * Phase 10 frontend security tests: attacker-controlled API text must
 * render as inert text, never as HTML/JS.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { DataState } from "../components/DataState.js";
import { cleanup, flush, render } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("frontend adversarial rendering", () => {
  it("renders markup-shaped backend errors as inert text", async () => {
    const hostile = new ApiError(
      "NOT_FOUND",
      '<img src=x onerror="alert(1)">',
      404,
      "req-xss-1",
    );
    const container = await render(
      <DataState<string>
        data={null}
        error={hostile}
        loading={false}
        empty={{ title: "none", body: "none" }}
        onRetry={() => {}}
      >
        {() => <div>content</div>}
      </DataState>,
    );
    await flush();
    // No element is created from the payload; the text survives escaped.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    cleanup(container);
  });

  it("renders script-shaped request ids as text, not markup", async () => {
    const hostile = new ApiError(
      "RATE_LIMITED",
      "slow down",
      429,
      '<script>alert("rid")</script>',
    );
    const container = await render(
      <DataState<string>
        data={null}
        error={hostile}
        loading={false}
        empty={{ title: "none", body: "none" }}
        onRetry={() => {}}
      >
        {() => <div>content</div>}
      </DataState>,
    );
    await flush();
    expect(container.querySelector("script")).toBeNull();
    cleanup(container);
  });
});
