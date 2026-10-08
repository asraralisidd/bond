/**
 * Vector design language: geometric SVG icons, architecture diagrams,
 * gauges, and timelines. Stroke-based, currentColor-driven, no raster
 * assets. Decorative SVGs are aria-hidden; data visualizations expose
 * text equivalents for assistive technology.
 */
import type { ReactNode } from "react";

function IconBase({
  children,
  size = 18,
  label,
}: {
  children: ReactNode;
  size?: number;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label === undefined ? "true" : undefined}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function VectorAgent({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19.5c1.2-3.4 3.6-5 6.5-5s5.3 1.6 6.5 5" />
      <circle cx="12" cy="12" r="9" strokeDasharray="2.5 2.5" opacity="0.45" />
    </IconBase>
  );
}

export function VectorShield({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <path d="M12 3.2 19 6v5.2c0 4.3-2.9 7.3-7 9.3-4.1-2-7-5-7-9.3V6l7-2.8Z" />
      <path d="m9.2 11.8 2 2 3.6-4" />
    </IconBase>
  );
}

export function VectorBond({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <rect x="4" y="7.5" width="16" height="10" rx="1.5" />
      <path d="M4 10.5h16M12 7.5V4.8M9.2 4.8h5.6" />
      <circle cx="12" cy="13.8" r="1.6" />
    </IconBase>
  );
}

export function VectorRisk({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <path d="M12 4 20.5 19.5h-17L12 4Z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.6" r="0.4" fill="currentColor" />
    </IconBase>
  );
}

export function VectorZK({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <rect x="5" y="5" width="14" height="14" rx="2" strokeDasharray="3 2" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2" opacity="0.6" />
    </IconBase>
  );
}

export function VectorAttestor({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <circle cx="6" cy="7" r="2.4" />
      <circle cx="18" cy="7" r="2.4" />
      <circle cx="12" cy="17" r="2.4" />
      <path d="M8 8.5l2.5 6M16 8.5l-2.5 6M8.2 7h7.6" opacity="0.7" />
    </IconBase>
  );
}

export function VectorBlockchain({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <rect x="3" y="4" width="7" height="5" rx="1" />
      <rect x="14" y="4" width="7" height="5" rx="1" />
      <rect x="8.5" y="15" width="7" height="5" rx="1" />
      <path d="M10 9v3.5h-1.5M14 9v3.5h1.5M12 9v6" opacity="0.7" />
    </IconBase>
  );
}

export function VectorTransaction({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </IconBase>
  );
}

export function VectorSlash({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M13.5 6.5 9 13.5h3l-1.5 4L15 10.5h-3l1.5-4Z" />
    </IconBase>
  );
}

export function VectorVerification({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5.2" />
    </IconBase>
  );
}

export function VectorReputation({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <path d="M12 20.5S4.5 16 4.5 9.8C4.5 7 6.7 5 9.2 5c1.2 0 2.2.5 2.8 1.3C12.6 5.5 13.6 5 14.8 5c2.5 0 4.7 2 4.7 4.8 0 7-7.5 10.7-7.5 10.7Z" />
      <path d="M4.5 12h3l1.5-3 2 5 1.5-2H19.5" />
    </IconBase>
  );
}

export function VectorGrid({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M4 12h16M12 4v16" opacity="0.6" />
    </IconBase>
  );
}

export function VectorWallet({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h11A3.5 3.5 0 0 1 20 9.5V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17V7.5Z" />
      <circle cx="16" cy="13.5" r="1.2" />
    </IconBase>
  );
}

export function VectorSettings({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.5v2.6M12 17.9v2.6M3.5 12h2.6M17.9 12h2.6M6 6l1.8 1.8M16.2 16.2 18 18M18 6l-1.8 1.8M7.8 16.2 6 18" />
    </IconBase>
  );
}

export function VectorActivity({ size }: { size?: number }) {
  return (
    <IconBase size={size}>
      <path d="M3.5 12h4l2-5 3.5 10 2-5h5.5" />
    </IconBase>
  );
}

/* ---------- shared building blocks ---------- */

export function TechnicalCard({
  title,
  icon,
  children,
  tone = "neutral",
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  tone?: "neutral" | "accent" | "good" | "warn" | "bad" | "violet";
}) {
  return (
    <section className={`tcard tcard-${tone}`} aria-label={title}>
      <header className="tcard-head">
        {icon ? (
          <span className="tcard-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <h2>{title}</h2>
      </header>
      <div className="tcard-body">{children}</div>
    </section>
  );
}

export function MetricCard({
  label,
  value,
  icon,
  tone = "neutral",
  sub,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: "neutral" | "accent" | "good" | "warn" | "bad" | "violet";
  sub?: ReactNode;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-top">
        {icon ? (
          <span className="metric-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-value">{value}</div>
      {sub ? <div className="metric-sub">{sub}</div> : null}
    </div>
  );
}

export function StatusDot({
  tone,
  pulse = false,
  label,
}: {
  tone: "good" | "warn" | "bad" | "accent" | "violet" | "neutral";
  pulse?: boolean;
  label: string;
}) {
  return (
    <span className="status-dot-wrap">
      <span
        className={`status-dot status-dot-${tone}${pulse ? " pulse" : ""}`}
        aria-hidden="true"
      />
      <span className="status-dot-label">{label}</span>
    </span>
  );
}

/* ---------- architecture diagram ---------- */

const PIPELINE: { id: string; label: string; sub: string; tone: string }[] = [
  {
    id: "agent",
    label: "AI AGENT",
    sub: "registered identity",
    tone: "accent",
  },
  {
    id: "risk",
    label: "RISK ENGINE",
    sub: "deterministic analysis",
    tone: "warn",
  },
  { id: "zk", label: "ZK ELIGIBILITY", sub: "private proofs", tone: "violet" },
  {
    id: "bond",
    label: "COLLATERAL BOND",
    sub: "committed value",
    tone: "accent",
  },
  {
    id: "attestor",
    label: "INDEPENDENT ATTESTORS",
    sub: "quorum verified",
    tone: "good",
  },
  {
    id: "enforce",
    label: "AUTOMATED ENFORCEMENT",
    sub: "deterministic slash",
    tone: "bad",
  },
];

export function ArchitectureDiagram() {
  return (
    <div
      className="arch-diagram"
      role="img"
      aria-label="BOND protocol pipeline: AI agent, risk engine, ZK eligibility, collateral bond, independent attestors, automated enforcement"
    >
      <svg viewBox="0 0 320 560" className="arch-svg" aria-hidden="true">
        <defs>
          <pattern
            id="arch-grid"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M20 0H0v20"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.4"
              opacity="0.12"
            />
          </pattern>
        </defs>
        <rect x="0" y="0" width="320" height="560" fill="url(#arch-grid)" />
        {PIPELINE.map((_, i) =>
          i < PIPELINE.length - 1 ? (
            <line
              key={`link-${i}`}
              x1="160"
              y1={78 + i * 80}
              x2="160"
              y2={102 + i * 80}
              className="arch-link"
            />
          ) : null,
        )}
        {PIPELINE.map((_, i) =>
          i < PIPELINE.length - 1 ? (
            <circle
              key={`pulse-${i}`}
              cx="160"
              cy={78 + i * 80}
              r="2.5"
              className="arch-packet"
              style={{ animationDelay: `${i * 0.55}s` }}
            />
          ) : null,
        )}
      </svg>
      <ol className="arch-nodes">
        {PIPELINE.map((node) => (
          <li key={node.id} className={`arch-node arch-node-${node.tone}`}>
            <span className="arch-node-dot" aria-hidden="true" />
            <span className="arch-node-text">
              <span className="arch-node-label">{node.label}</span>
              <span className="arch-node-sub">{node.sub}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- security timeline ---------- */

const LIFECYCLE = [
  "REGISTER",
  "BOND",
  "PROVE",
  "OPERATE",
  "ASSESS",
  "ATTEST",
  "ENFORCE",
  "WITHDRAW",
];

export function SecurityTimeline({ active = -1 }: { active?: number }) {
  return (
    <ol className="security-timeline" aria-label="Protocol lifecycle stages">
      {LIFECYCLE.map((stage, i) => (
        <li
          key={stage}
          className={`stl-node${i < active ? " done" : ""}${i === active ? " current" : ""}`}
          aria-current={i === active ? "step" : undefined}
        >
          <span className="stl-dot" aria-hidden="true">
            {i < active ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m5 13 4 4 10-11" />
              </svg>
            ) : (
              <span className="stl-num">{i + 1}</span>
            )}
          </span>
          <span className="stl-label">{stage}</span>
          {i < LIFECYCLE.length - 1 ? (
            <span className="stl-link" aria-hidden="true" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/* ---------- risk gauge ---------- */

export function RiskGauge({
  score,
  level,
}: {
  score: number | null;
  level: string;
}) {
  const clamped = score === null ? null : Math.max(0, Math.min(100, score));
  const angle = clamped === null ? 0 : (clamped / 100) * 180;
  const tone =
    clamped === null
      ? "neutral"
      : clamped >= 75
        ? "bad"
        : clamped >= 40
          ? "warn"
          : "good";
  const radians = ((180 - angle) * Math.PI) / 180;
  const nx = 100 - 78 * Math.cos(radians);
  const ny = 92 - 78 * Math.sin(radians);
  return (
    <div
      className="risk-gauge"
      role="img"
      aria-label={
        clamped === null
          ? `Risk level ${level}, no score`
          : `Risk score ${Math.round(clamped)} of 100, level ${level}`
      }
    >
      <svg viewBox="0 0 200 110" className="risk-gauge-svg" aria-hidden="true">
        <path
          d="M22 92 A78 78 0 0 1 178 92"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeLinecap="round"
          opacity="0.16"
        />
        {clamped !== null ? (
          <path
            d="M22 92 A78 78 0 0 1 178 92"
            fill="none"
            stroke="currentColor"
            strokeWidth="10"
            strokeLinecap="round"
            className={`risk-gauge-arc risk-gauge-${tone}`}
            strokeDasharray={`${(angle / 180) * 245.4} 245.4`}
          />
        ) : null}
        {clamped !== null ? (
          <line
            x1="100"
            y1="92"
            x2={nx}
            y2={ny}
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="risk-gauge-needle"
          />
        ) : null}
        <circle cx="100" cy="92" r="5" fill="currentColor" opacity="0.7" />
      </svg>
      <div className="risk-gauge-readout">
        <span className="risk-gauge-score">
          {clamped === null ? "—" : Math.round(clamped)}
        </span>
        <span className={`risk-gauge-level risk-gauge-${tone}`}>{level}</span>
      </div>
    </div>
  );
}

/* ---------- attestation quorum diagram ---------- */

export function AttestationQuorum({
  confirms,
  rejects,
  threshold,
  decided,
}: {
  confirms: number;
  rejects: number;
  threshold: number;
  decided: boolean;
}) {
  const nodes = Math.max(1, confirms + rejects);
  return (
    <div
      className="quorum-diagram"
      role="img"
      aria-label={`${confirms} confirm, ${rejects} reject, threshold ${threshold}${decided ? ", decided" : ""}`}
    >
      <svg viewBox="0 0 320 120" className="quorum-svg" aria-hidden="true">
        <line x1="60" y1="60" x2="160" y2="30" className="arch-link" />
        <line x1="60" y1="60" x2="160" y2="60" className="arch-link" />
        <line x1="60" y1="60" x2="160" y2="90" className="arch-link" />
        <line x1="220" y1="30" x2="260" y2="60" className="arch-link" />
        <line x1="220" y1="60" x2="260" y2="60" className="arch-link" />
        <line x1="220" y1="90" x2="260" y2="60" className="arch-link" />
        <circle cx="60" cy="60" r="16" className="quorum-source" />
        {Array.from({ length: nodes }).map((_, i) => {
          const y = nodes === 1 ? 60 : 30 + (i * 60) / Math.max(1, nodes - 1);
          const tone =
            confirms + rejects === 0
              ? "neutral"
              : i < confirms
                ? "good"
                : "bad";
          return (
            <g key={i}>
              <line x1="60" y1="60" x2="160" y2={y} className="arch-link" />
              <line x1="220" y1={y} x2="260" y2="60" className="arch-link" />
              <circle
                cx="190"
                cy={y}
                r="13"
                className={`quorum-node quorum-${tone}`}
              />
            </g>
          );
        })}
        <circle
          cx="285"
          cy="60"
          r="16"
          className={decided ? "quorum-decided" : "quorum-pending"}
        />
      </svg>
      <div className="quorum-legend">
        <span>flag</span>
        <span>attestors</span>
        <span>{decided ? "decided" : "quorum"}</span>
      </div>
    </div>
  );
}

/* ---------- protocol status strip ---------- */

export function ProtocolStatus({
  items,
}: {
  items: {
    label: string;
    state: string;
    tone: "good" | "warn" | "bad" | "accent" | "neutral";
  }[];
}) {
  return (
    <div className="protocol-status" role="status" aria-label="System status">
      {items.map((item) => (
        <span key={item.label} className="protocol-status-item">
          <span className="protocol-status-label">{item.label}</span>
          <span
            className={`protocol-status-dot protocol-status-${item.tone} pulse`}
            aria-hidden="true"
          />
          <span className="protocol-status-state">{item.state}</span>
        </span>
      ))}
    </div>
  );
}

/* ---------- network indicator ---------- */

export function NetworkIndicator({ network }: { network: string | null }) {
  const label = network ?? "SIMULATED";
  const live = network !== null && network !== "SIMULATED";
  return (
    <span
      className={`net-indicator${live ? " net-indicator-live" : ""}`}
      title={
        live
          ? "Midnight network configured (connection unverified until exercised)"
          : "Simulated execution — not a production network"
      }
    >
      <VectorBlockchain size={14} />
      <span aria-hidden="true">●</span> {label}
    </span>
  );
}
