/**
 * Sign-in: wallet challenge-response (production path) + development
 * key (dev only, unchanged). Wallet connection uses the injected
 * Midnight DApp Connector (e.g. Lace) — never bundled, never faked.
 */
import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client.js";
import { consumeExpiredNotice, useSession } from "../app/session.js";
import { useNavigate } from "../app/router.js";
import { useToast } from "../app/toast.js";
import { PageHeader } from "../components/chrome.js";
import { availableWallets, connectWallet } from "../wallet/connector.js";

const DEFAULT_DEV_KEY = import.meta.env.VITE_DEV_AUTH_TOKEN ?? "";

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [externalKey, setExternalKey] = useState("");
  const [devKey, setDevKey] = useState(DEFAULT_DEV_KEY);
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletRdns, setWalletRdns] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expiredNotice] = useState(() => consumeExpiredNotice());
  const [wallets, setWallets] = useState<{ rdns: string; name: string }[]>([]);

  useEffect(() => {
    setWallets(availableWallets());
  }, []);

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
        intro="Connect a Midnight wallet to authenticate, or use development sign-in for local work."
      />
      <div className="card">
        <h3>Wallet sign-in</h3>
        {wallets.length === 0 ? (
          <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
            No Midnight wallet detected. Install Lace (or a compatible wallet)
            with the Midnight DApp Connector enabled, then reload.
          </div>
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                if (!walletRdns) {
                  setError("Select a wallet first.");
                  return;
                }
                setWalletBusy(true);
                setError(null);
                try {
                  // 1. Server network is authoritative (from /ready).
                  // SIMULATED deployments claim "simulated" (no chain
                  // interaction); REAL deployments claim their network id.
                  const ready = await api.ready();
                  const serverNetwork =
                    ready.checks.midnight.network ?? "simulated";
                  const connectHint =
                    serverNetwork === "simulated"
                      ? "undeployed"
                      : serverNetwork;
                  // 2. Connect (user approves in the wallet).
                  const connected = await connectWallet(
                    walletRdns,
                    connectHint,
                  );
                  // 3. REAL deployments require the wallet on the same
                  // network; SIMULATED has no chain side to match.
                  if (serverNetwork !== "simulated") {
                    const walletNetwork = await connected.getNetworkId();
                    if (walletNetwork !== serverNetwork) {
                      setError(
                        `Wallet is on '${walletNetwork}' but this server uses '${serverNetwork}'. Switch networks in the wallet and try again.`,
                      );
                      return;
                    }
                  }
                  // 4. Server challenge for this network.
                  const challenge =
                    await api.requestWalletChallenge(serverNetwork);
                  // 3. Wallet signs the canonical message (user-approved).
                  const signed = await connected.signMessage(challenge.message);
                  // 4. Server verifies and binds the session to the
                  // signing key; strict shape keeps secrets out of logs.
                  if (
                    typeof signed.data !== "string" ||
                    typeof signed.signature !== "string" ||
                    typeof signed.verifyingKey !== "string"
                  ) {
                    setError("Wallet returned a malformed signature.");
                    return;
                  }
                  const verified = await api.verifyWalletChallenge(
                    challenge.challengeId,
                    {
                      data: signed.data,
                      signature: signed.signature,
                      verifyingKey: signed.verifyingKey,
                    },
                  );
                  session.signInWithWallet(
                    signed.verifyingKey.toLowerCase(),
                    challenge.network,
                    verified.token,
                    verified.operatorId,
                  );
                  toast.notify("success", "Signed in with wallet");
                  navigate("/dashboard");
                } catch (err) {
                  setError(
                    err instanceof ApiError
                      ? `${err.code}: ${err.message}`
                      : err instanceof Error
                        ? err.message
                        : String(err),
                  );
                } finally {
                  setWalletBusy(false);
                }
              })();
            }}
          >
            <div className="field">
              <label htmlFor="login-wallet">Wallet</label>
              <select
                id="login-wallet"
                value={walletRdns}
                onChange={(e) => setWalletRdns(e.target.value)}
              >
                <option value="">Select a wallet…</option>
                {wallets.map((w) => (
                  <option key={w.rdns} value={w.rdns}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={walletBusy}
            >
              {walletBusy ? "Connecting…" : "Connect wallet"}
            </button>
          </form>
        )}
      </div>
      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Development sign-in</h3>
        <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
          Local dev tokens only — never mainnet credentials.
        </div>
        {expiredNotice ? (
          <div
            className="alert alert-info"
            role="status"
            style={{ marginBottom: "1rem" }}
          >
            Your session expired. Please sign in again.
          </div>
        ) : null}
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
