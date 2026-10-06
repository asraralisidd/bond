/**
 * Minimal DOM test helpers (no testing-library available in this
 * environment): mount with act, flush promises, query by role/text.
 */
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { act } from "react-dom/test-utils";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function cleanup(container: HTMLElement): void {
  container.remove();
}

export function stubFetch(
  handler: (url: string, init?: RequestInit) => unknown,
): () => void {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  (globalThis as Record<string, unknown>).fetch = async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url, init });
    const body = await handler(url, init);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "x-request-id": "req-test-1" }),
      json: async () => body,
    } as Response;
  };
  (globalThis.fetch as unknown as { __calls: unknown }).__calls = calls;
  return () => {
    globalThis.fetch = original;
  };
}

export function fetchCalls(): { url: string; init?: RequestInit }[] {
  const calls = (globalThis.fetch as unknown as { __calls?: unknown }).__calls;
  return Array.isArray(calls)
    ? (calls as { url: string; init?: RequestInit }[])
    : [];
}
