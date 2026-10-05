# ADR-007 — Lightweight infrastructure (no heavy platform)

- **Status:** Accepted (Phase 0).
- **Context:** Development happens on an 8 GB RAM laptop; initial load is
  operator-scale, not internet-scale. Premature platform engineering would
  sink the project.
- **Decision:** No Kubernetes, Kafka, Elasticsearch, service mesh,
  multi-region, or extra microservices/Redis without a demonstrated
  requirement + new ADR. Observability = structured logs + Postgres events
  - health checks. Local env = compose `db` + host-run services.
- **Consequences:** Fast iteration, tiny ops burden; load limits unknown
  until measured — measuring comes before scaling.
- **Verification:** None; revisit triggers are defined by measurement, not
  speculation.
