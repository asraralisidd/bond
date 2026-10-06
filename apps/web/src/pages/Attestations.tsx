/**
 * Attestations: lookup by id, request flow entry, quorum and decision
 * state. Attestor secrets are user-supplied credentials per submission —
 * never stored, never displayed back.
 */
import { useState } from "react";
import { api, ApiError } from "../api/client.js";
import { PageHeader, StatusBadge } from "../components/chrome.js";
import { useToast } from "../app/toast.js";
import { useNavigate } from "../app/router.js";
import { remember } from "../lib/recent.js";

export function AttestationsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [lookup, setLookup] = useState("");
  const [flagId, setFlagId] = useState("");
  const [attestorIds, setAttestorIds] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestAttestation(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.requestAttestation({
        flagId: flagId.trim(),
        attestorIds: attestorIds
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        expiresAt: expiresAt.trim(),
      });
      remember({
        kind: "attestation",
        id: result.attestationId,
        agentId: null,
        label: `flag ${flagId.slice(0, 8)}… → ${result.status}`,
      });
      toast.notify("success", "Attestation requested");
      navigate(`/attestations/${result.attestationId}`);
    } catch (err) {
      const message =
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Attestations"
        intro="Independent quorum decisions over risk findings. A decision — never a raw flag — is what enforcement can consume."
      />
      <div className="grid grid-2">
        <div className="card">
          <h2>Look up attestation</h2>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (lookup.trim()) {
                navigate(`/attestations/${lookup.trim()}`);
              }
            }}
          >
            <div className="field">
              <label htmlFor="att-lookup">Attestation ID</label>
              <input
                id="att-lookup"
                className="mono"
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
                placeholder="attestation uuid"
                required
              />
            </div>
            <button type="submit" className="btn">
              Open
            </button>
          </form>
        </div>
        <div className="card">
          <h2>Request attestation</h2>
          {error ? (
            <div
              className="alert alert-error"
              role="alert"
              style={{ marginBottom: "0.8rem" }}
            >
              {error}
            </div>
          ) : null}
          <form className="form" onSubmit={requestAttestation}>
            <div className="field">
              <label htmlFor="att-flag">Risk flag ID</label>
              <input
                id="att-flag"
                className="mono"
                value={flagId}
                onChange={(e) => setFlagId(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="att-ids">Attestor IDs (comma-separated)</label>
              <input
                id="att-ids"
                className="mono"
                value={attestorIds}
                onChange={(e) => setAttestorIds(e.target.value)}
                placeholder="registered attestor ids"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="att-exp">Expires at (ISO)</label>
              <input
                id="att-exp"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                placeholder="2026-12-31T00:00:00.000Z"
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Requesting…" : "Request attestation"}
            </button>
          </form>
        </div>
      </div>
      <div className="card mt">
        <h2>How quorum works here</h2>
        <p className="muted">
          Verdicts (<StatusBadge status="confirm" /> /{" "}
          <StatusBadge status="reject" /> / <StatusBadge status="abstain" />)
          accumulate against the configured threshold. Abstentions never count
          toward either side. Only a <em>decided</em> attestation can feed
          enforcement — and only through an explicit, tracked transaction.
        </p>
      </div>
    </>
  );
}
