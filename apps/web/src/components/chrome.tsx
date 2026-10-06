/**
 * Shared UI primitives: layout, navigation shell, badges, state blocks.
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client.js";
import { useRoute } from "../app/router.js";
import { useSession } from "../app/session.js";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "info" | "accent";
  children: ReactNode;
}) {
  const cls = tone === "neutral" ? "badge" : `badge badge-${tone}`;
  return <span className={cls}>{children}</span>;
}

/** Maps lifecycle/transaction states to badge tones (single source). */
export function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  let tone: "neutral" | "good" | "warn" | "bad" | "info" | "accent" = "neutral";
  if (
    [
      "ACTIVE",
      "CONFIRMED",
      "VERIFIED",
      "TRUSTED",
      "GOOD",
      "ELIGIBLE",
      "RESOLVED",
      "DECIDED",
    ].includes(s)
  ) {
    tone = "good";
  } else if (
    [
      "FLAGGED",
      "PENDING",
      "SUBMITTED",
      "UNDER-REVIEW",
      "CAUTION",
      "PROBATION",
      "SUSPENDED",
      "OPEN",
      "REQUESTED",
      "QUORUM-MET",
    ].includes(s)
  ) {
    tone = "warn";
  } else if (
    [
      "SLASHED",
      "FAILED",
      "REJECTED",
      "UNTRUSTED",
      "POOR",
      "EXPIRED",
      "FULLY_SLASHED",
    ].includes(s)
  ) {
    tone = "bad";
  } else if (
    [
      "REGISTERED",
      "BONDED",
      "WITHDRAWABLE",
      "ATTESTED",
      "CREATED",
      "IDLE",
      "WALLET_APPROVAL",
    ].includes(s)
  ) {
    tone = "info";
  }
  return <Badge tone={tone}>{status}</Badge>;
}

/** SIMULATED vs REAL marker — never ambiguous, never production-styled. */
export function ModeBadge({ mode }: { mode: string }) {
  if (mode === "REAL") {
    return <Badge tone="accent">REAL</Badge>;
  }
  return (
    <Badge tone="warn">
      <span title="Simulated backend execution — not a blockchain transaction">
        SIMULATED
      </span>
    </Badge>
  );
}

export function PageHeader({
  title,
  intro,
  actions,
}: {
  title: string;
  intro?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{title}</h1>
        {actions}
      </div>
      {intro ? <p>{intro}</p> : null}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-label={label}>
      <div
        className="skeleton"
        style={{ height: "2.2rem", marginBottom: "0.7rem" }}
      />
      <div className="skeleton" style={{ height: "5rem" }} />
    </div>
  );
}

export function ErrorState({
  message,
  requestId,
  onRetry,
}: {
  message: string;
  requestId?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="state-block" role="alert">
      <h3>Something went wrong</h3>
      <p>{message}</p>
      {requestId ? (
        <p className="mono" style={{ fontSize: "0.75rem" }}>
          request {requestId}
        </p>
      ) : null}
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-block">
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

const NAV: {
  section: string | null;
  to: string;
  label: string;
  icon: string;
}[] = [
  { section: null, to: "#/dashboard", label: "Dashboard", icon: "◈" },
  { section: "Agents", to: "#/agents", label: "My Agents", icon: "⬡" },
  { section: null, to: "#/bonds", label: "Bonds", icon: "⬣" },
  { section: null, to: "#/risk", label: "Risk Intelligence", icon: "◉" },
  { section: null, to: "#/attestations", label: "Attestations", icon: "⬔" },
  { section: null, to: "#/security", label: "Security", icon: "⬒" },
  { section: "Public", to: "#/verify", label: "Verify Agent", icon: "✓" },
];

function isActive(routeRaw: string, to: string): boolean {
  if (to === "#/dashboard") {
    return routeRaw === "#/dashboard" || routeRaw === "#/";
  }
  if (to === "#/agents") {
    return routeRaw.startsWith("#/agents");
  }
  return routeRaw === to || routeRaw.startsWith(`${to}/`);
}

export function Layout({ children }: { children: ReactNode }) {
  const route = useRoute();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [networkLabel, setNetworkLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .ready()
      .then((ready) => {
        if (cancelled) {
          return;
        }
        const mode = ready.checks.midnight.mode;
        const network = ready.checks.midnight.network;
        setNetworkLabel(
          mode === "REAL" && network
            ? network
            : mode === "REAL"
              ? "REAL"
              : "SIMULATED",
        );
      })
      .catch(() => {
        if (!cancelled) {
          setNetworkLabel("SIMULATED");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="shell">
      {open ? (
        <div
          className="scrim"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Primary">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            B
          </div>
          <div>
            <div className="brand-name">BOND</div>
            <div className="brand-sub">Agent Security Protocol</div>
          </div>
        </div>
        <nav className="nav" aria-label="Sections">
          {NAV.map((item) => (
            <div key={item.to}>
              {item.section ? (
                <div className="nav-section">{item.section}</div>
              ) : null}
              <a
                className="nav-link"
                href={item.to}
                aria-current={isActive(route.raw, item.to) ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </a>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span
            className="net-pill"
            title={
              networkLabel && networkLabel !== "SIMULATED"
                ? "Midnight network configured (connection unverified until exercised)"
                : "Simulated execution — not a production network"
            }
          >
            <span aria-hidden="true">●</span> {networkLabel ?? "SIMULATED"}
          </span>
          {session.token ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={session.signOut}
            >
              Sign out
            </button>
          ) : (
            <a className="btn btn-ghost btn-sm" href="#/login">
              Sign in
            </a>
          )}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn-ghost btn-sm menu-btn"
            aria-label="Open navigation"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            ☰
          </button>
          <span className="topbar-title">
            Privacy-Preserving Collateral for Autonomous AI Agents
          </span>
          <span className="topbar-right">
            {session.walletVerifyingKey ? (
              <span
                className="mono"
                title={`Wallet session (key ${session.walletVerifyingKey})`}
              >
                wallet:{session.walletVerifyingKey.slice(0, 8)}…
                {session.walletNetwork ? ` @ ${session.walletNetwork}` : ""}
              </span>
            ) : session.operatorId ? (
              <span className="mono">{session.operatorId}</span>
            ) : (
              <span>Not signed in</span>
            )}
          </span>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
