/**
 * Prometheus-compatible metrics (Phase 15). Zero dependencies.
 *
 * Truthful only: every value is counted from observed requests or read
 * from the worker snapshot at scrape time. Nothing is estimated,
 * sampled, or fabricated.
 *
 * Privacy: labels are bounded and server-defined (method, route
 * template, status class, worker phase). Raw URLs, user IDs, request
 * bodies, tokens, amounts, and error text NEVER appear in labels or
 * values. Route templates derive from registered Express routes only —
 * unmatched paths collapse to a single "unmatched" bucket.
 */
import type { NextFunction, Request, Response } from "express";
import { getWorkerSnapshot } from "../services/worker/registry.js";

const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const KNOWN_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** Escape a Prometheus label value (defensive; labels are server-defined). */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : "OTHER";
}

/**
 * Route template from Express routing state (populated by finish time).
 * Examples: "/api/v1/agents/:id", "/health". Unmatched → "unmatched".
 */
function routeTemplate(req: Request): string {
  const routePath = typeof req.route?.path === "string" ? req.route.path : "";
  const template = `${req.baseUrl ?? ""}${routePath}`;
  return template.length > 0 ? template : "unmatched";
}

function statusClass(status: number): string {
  if (status >= 200 && status < 300) {
    return "2xx";
  }
  if (status >= 400 && status < 500) {
    return "4xx";
  }
  if (status >= 500) {
    return "5xx";
  }
  return "other";
}

interface Histogram {
  counts: number[];
  sum: number;
  total: number;
}

const requestsTotal = new Map<string, number>();
const durations = new Map<string, Histogram>();

function observe(
  method: string,
  route: string,
  status: number,
  seconds: number,
): void {
  const key = `${method}\n${route}\n${statusClass(status)}`;
  requestsTotal.set(key, (requestsTotal.get(key) ?? 0) + 1);
  const histKey = `${method}\n${route}`;
  let hist = durations.get(histKey);
  if (!hist) {
    hist = { counts: DURATION_BUCKETS.map(() => 0), sum: 0, total: 0 };
    durations.set(histKey, hist);
  }
  for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
    if (seconds <= (DURATION_BUCKETS[i] as number)) {
      hist.counts[i] = (hist.counts[i] ?? 0) + 1;
    }
  }
  hist.sum += seconds;
  hist.total += 1;
}

/** Records method/route-template/status-class/duration on finish. */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      observe(
        normalizeMethod(req.method),
        routeTemplate(req),
        res.statusCode,
        seconds,
      );
    } catch {
      // Metrics must never break request handling.
    }
  });
  next();
}

function renderCounter(
  name: string,
  help: string,
  entries: { labels: string; value: number }[],
): string {
  const lines = [`# HELP ${name} ${help}.`, `# TYPE ${name} counter`];
  for (const entry of entries) {
    lines.push(
      entry.labels.length > 0
        ? `${name}{${entry.labels}} ${entry.value}`
        : `${name} ${entry.value}`,
    );
  }
  return lines.join("\n");
}

function renderGauge(
  name: string,
  help: string,
  entries: { labels: string; value: number }[],
): string {
  const lines = [`# HELP ${name} ${help}.`, `# TYPE ${name} gauge`];
  for (const entry of entries) {
    lines.push(
      entry.labels.length > 0
        ? `${name}{${entry.labels}} ${entry.value}`
        : `${name} ${entry.value}`,
    );
  }
  return lines.join("\n");
}

/** Test hook: reset in-memory counters between cases. */
export function resetMetrics(): void {
  requestsTotal.clear();
  durations.clear();
}

export function renderMetrics(): string {
  const sections: string[] = [];

  const requestEntries: { labels: string; value: number }[] = [];
  for (const [key, value] of requestsTotal) {
    const [method, route, status] = key.split("\n");
    requestEntries.push({
      labels: `method="${escapeLabel(method ?? "")}",route="${escapeLabel(route ?? "")}",status_class="${escapeLabel(status ?? "")}"`,
      value,
    });
  }
  sections.push(
    renderCounter(
      "bond_http_requests_total",
      "HTTP requests observed",
      requestEntries,
    ),
  );

  const histLines = [
    "# HELP bond_http_request_duration_seconds HTTP request duration.",
    "# TYPE bond_http_request_duration_seconds histogram",
  ];
  for (const [key, hist] of durations) {
    const [method, route] = key.split("\n");
    const base = `method="${escapeLabel(method ?? "")}",route="${escapeLabel(route ?? "")}"`;
    let cumulative = 0;
    for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
      cumulative += hist.counts[i] ?? 0;
      histLines.push(
        `bond_http_request_duration_seconds_bucket{${base},le="${DURATION_BUCKETS[i]}"} ${cumulative}`,
      );
    }
    histLines.push(
      `bond_http_request_duration_seconds_bucket{${base},le="+Inf"} ${hist.total}`,
    );
    histLines.push(
      `bond_http_request_duration_seconds_sum{${base}} ${hist.sum}`,
    );
    histLines.push(
      `bond_http_request_duration_seconds_count{${base}} ${hist.total}`,
    );
  }
  sections.push(histLines.join("\n"));

  const snapshot = (() => {
    try {
      return getWorkerSnapshot();
    } catch {
      return null;
    }
  })();
  const stats = snapshot?.stats;
  sections.push(
    renderCounter("bond_worker_polls_total", "Worker poll iterations", [
      { labels: "", value: stats?.polls ?? 0 },
    ]),
    renderCounter("bond_worker_jobs_claimed_total", "Jobs claimed", [
      { labels: "", value: stats?.claimed ?? 0 },
    ]),
    renderCounter("bond_worker_jobs_submitted_total", "Jobs submitted", [
      { labels: "", value: stats?.submitted ?? 0 },
    ]),
    renderCounter("bond_worker_jobs_confirmed_total", "Jobs confirmed", [
      { labels: "", value: stats?.confirmed ?? 0 },
    ]),
    renderCounter("bond_worker_jobs_retried_total", "Jobs retried", [
      { labels: "", value: stats?.retried ?? 0 },
    ]),
    renderCounter(
      "bond_worker_jobs_dead_lettered_total",
      "Jobs dead-lettered",
      [{ labels: "", value: stats?.deadLettered ?? 0 }],
    ),
    renderCounter("bond_worker_jobs_reconciled_total", "Jobs reconciled", [
      { labels: "", value: stats?.reconciled ?? 0 },
    ]),
    renderGauge(
      "bond_worker_stuck_submitted",
      "SUBMITTED rows awaiting reconciliation",
      [{ labels: "", value: stats?.stuckSubmitted ?? 0 }],
    ),
    renderGauge("bond_worker_active_jobs", "Jobs currently executing", [
      { labels: "", value: stats?.activeJobs ?? 0 },
    ]),
    renderGauge("bond_worker_running", "1 when the worker phase is RUNNING", [
      { labels: "", value: snapshot?.phase === "RUNNING" ? 1 : 0 },
    ]),
    renderGauge("bond_worker_info", "Worker phase (bounded label)", [
      {
        labels: `phase="${escapeLabel(snapshot?.phase ?? "stopped")}"`,
        value: 1,
      },
    ]),
  );

  sections.push(
    renderGauge("bond_process_uptime_seconds", "Process uptime", [
      { labels: "", value: Math.floor(process.uptime()) },
    ]),
    renderGauge("bond_process_resident_memory_bytes", "Resident set size", [
      { labels: "", value: process.memoryUsage().rss },
    ]),
  );

  return `${sections.join("\n")}\n`;
}

export function metricsHandler(_req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.send(renderMetrics());
}
