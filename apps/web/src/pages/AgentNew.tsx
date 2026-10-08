/**
 * Register Agent: platform-agnostic registration (no provider SDKs in
 * the core form — platform is a metadata label, per architecture).
 */
import { useState } from "react";
import { api, ApiError } from "../api/client.js";
import { useNavigate } from "../app/router.js";
import { useToast } from "../app/toast.js";
import { PageHeader } from "../components/chrome.js";
import { remember } from "../lib/recent.js";

const AGENT_TYPES = [
  "conversational",
  "coding",
  "workflow",
  "trading",
  "custom",
];

export function AgentNewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [platform, setPlatform] = useState("custom");
  const [agentType, setAgentType] = useState("custom");
  const [capabilities, setCapabilities] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const agent = await api.registerAgent({
        platform: platform.trim(),
        agentType,
        capabilities: capabilities
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0),
        externalRef: externalRef.trim(),
      });
      remember({
        kind: "agent",
        id: agent.agentId,
        agentId: agent.agentId,
        label: `${agent.platform} / ${agent.agentType}`,
      });
      toast.notify("success", "Agent registered");
      navigate(`/agents/${agent.agentId}`);
    } catch (err) {
      const message =
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      setError(message);
      toast.notify("error", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter">
      <PageHeader
        title="Register agent"
        intro="Binds an external agent to your operator identity. Duplicate (operator, platform, reference) triples are rejected."
      />
      <div className="card">
        {error ? (
          <div
            className="alert alert-error"
            role="alert"
            style={{ marginBottom: "1rem" }}
          >
            {error}
          </div>
        ) : null}
        <form className="form" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="agent-platform">Platform label</label>
            <input
              id="agent-platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              placeholder="e.g. langchain, custom"
              required
            />
            <span className="hint">
              Metadata only — never changes protocol behavior.
            </span>
          </div>
          <div className="field">
            <label htmlFor="agent-type">Agent type</label>
            <select
              id="agent-type"
              value={agentType}
              onChange={(e) => setAgentType(e.target.value)}
            >
              {AGENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="agent-caps">Capabilities (comma-separated)</label>
            <input
              id="agent-caps"
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="read-only, no-spend"
            />
          </div>
          <div className="field">
            <label htmlFor="agent-ref">External reference</label>
            <input
              id="agent-ref"
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              placeholder="Assistant ID, deployment URL…"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Registering…" : "Register agent"}
          </button>
        </form>
      </div>
    </div>
  );
}
