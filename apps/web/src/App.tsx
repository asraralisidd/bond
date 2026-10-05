import { useEffect, useState } from "react";
import type { HealthResponse } from "@bond/shared-types";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl}/health`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HealthResponse;
      })
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page">
      <h1>BOND</h1>
      <p>
        Privacy-Preserving Collateral &amp; Automated Slashing for AI Agents
      </p>
      <section className="card">
        <h2>Foundation shell</h2>
        <p>
          Business logic is <strong>not implemented</strong> yet. This page only
          verifies the web shell can reach the API shell.
        </p>
        {health ? (
          <p data-testid="api-status">
            API: {health.status} (v{health.version})
          </p>
        ) : error ? (
          <p data-testid="api-status">API unreachable: {error}</p>
        ) : (
          <p data-testid="api-status">Contacting API…</p>
        )}
      </section>
    </main>
  );
}
