/**
 * Development sign-in. Wallet connection is unavailable in development
 * (see backend Phase 7 boundary) — this screen says so explicitly and
 * never fakes a wallet session.
 */
import { useState } from "react";
import { ApiError } from "../api/client.js";
import { useSession } from "../app/session.js";
import { useNavigate } from "../app/router.js";
import { useToast } from "../app/toast.js";
import { PageHeader } from "../components/chrome.js";

const DEFAULT_DEV_KEY = import.meta.env.VITE_DEV_AUTH_TOKEN ?? "";

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [externalKey, setExternalKey] = useState("");
  const [devKey, setDevKey] = useState(DEFAULT_DEV_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.token) {
    navigate("/dashboard");
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.signIn(devKey, externalKey.trim());
      toast.notify("success", "Signed in (development session)");
      navigate("/dashboard");
    } catch (err) {
      const message =
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <PageHeader
        title="Sign in"
        intro="Development authentication only. Real wallet sign-in arrives with the verified Lace integration."
      />
      <div className="card">
        <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
          Wallet connection unavailable in development. Sessions here are local
          dev tokens — never mainnet credentials.
        </div>
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
            <label htmlFor="login-operator">Operator handle</label>
            <input
              id="login-operator"
              value={externalKey}
              onChange={(e) => setExternalKey(e.target.value)}
              placeholder="e.g. alice"
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-devkey">Development key</label>
            <input
              id="login-devkey"
              type="password"
              value={devKey}
              onChange={(e) => setDevKey(e.target.value)}
              placeholder="DEV_AUTH_TOKEN"
              autoComplete="current-password"
              required
            />
            <span className="hint">
              Must match the API server&apos;s DEV_AUTH_TOKEN.
            </span>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
