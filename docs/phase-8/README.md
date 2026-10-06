# BOND Phase 8 — React Dashboard

> Owner dashboard + public verification over the Phase 7 API only.
> Dark-first security aesthetic, SIMULATED execution always labeled,
> no wallet code, no private data outside owner views.

## 1. Frontend architecture

`apps/web/src`: hash router (`app/router.ts`, no dependency),
session context, toast context, central typed API client
(`api/client.ts` + `api/types.ts`), shared chrome components,
lifecycle widgets, per-area pages, DOM tests under `src/test/`.
React state/hooks only — no store library, no UI framework, no
charting packages. New runtime deps: none. Dev/test deps added:
`jsdom` (Testing Library unavailable in this environment — tests use
`react-dom` + `act` directly).

## 2. Route map

`#/dashboard` (guarded), `#/agents`, `#/agents/new`, `#/agents/:id`,
`#/bonds`, `#/risk`, `#/attestations`, `#/attestations/:id`,
`#/security`, `#/transactions(/:id)` (deep link, no nav entry),
`#/verify` (public, no sign-in), `#/login`. Unknown routes fall back
to dashboard. Auth guard redirects signed-out users to login except
`/verify` and `/login`.

## 3. Component structure

`chrome.tsx` (Layout, sidebar/topbar, Badge/StatusBadge/ModeBadge,
PageHeader, Loading/Error/Empty), `lifecycle.tsx`
(LifecycleStepper, TxBadge), `DataState.tsx` (four-state renderer
every page uses), pages per area, `lib/recent.ts` (labeled
browser-local history for ids the API cannot list).

## 4. API client

One `fetch` wrapper: JSON envelopes, `ApiError{code,status,requestId}`,
Bearer from localStorage, per-mutation `Idempotency-Key`,
`x-request-id` capture (`getLastRequestId`), `useApi` hook with
loading/error/reload semantics and unmount cancellation. Attestor
verdicts go through a dedicated call carrying `X-Attestor-Secret`
(user-supplied per submission, never stored). No endpoint invented —
every path mirrors a Phase 7 route 1:1.

## 5. State management

`SessionProvider` (token + operator id) and `ToastProvider` only;
page-local `useState` + `useApi` elsewhere. Recent-id history is a
persistence helper, not application state.

## 6. Public/private boundaries

Owner screens may show commitments, slash totals, verdicts, tx refs.
Public verification renders only the public projection fields the
API returns — components allowlist fields, so even a compromised
payload cannot leak (proven by canary tests). Secrets (attestor,
dev key) are password inputs, never rendered or stored.

## 7. Simulated/real boundary

Sidebar + tx flows carry a dashed SIMULATED pill. `TxBadge` always
pairs status with mode; SIMULATED receipts stop at SUBMITTED in the
UI exactly as the API reports them. Login states wallet
unavailability explicitly. No wallet code exists anywhere.

## 8. UI design decisions

Ink background with faint radial glows, bordered panels, single teal
accent, severity colors reserved for badges; system font stack;
44-line responsive collapse (sidebar → drawer + scrim under 760px);
tables scroll horizontally with sticky semantics; reduced-motion
respected; focus rings everywhere; `aria-current` nav, labeled
controls, live-region toasts, icon `aria-hidden` with text labels.

## 9. Testing

10 DOM/unit tests: public-verification privacy (canary sweep,
precise "no confirmed findings" language, no safety claims),
SIMULATED-never-confirmed badges, error parsing with request ids,
idempotency + auth headers, router fallback, four-state renderer,
login wallet notice. Full suite: typecheck, eslint, prettier,
vitest, `vite build` all green.

## 10. Known blockers

No bond/attestation/transaction _list_ endpoints in Phase 7 (worked
around with labeled local history — a documented Phase 7 gap, not a
UI invention); no wallet integration (blocked, surfaced honestly);
dashboard fan-out is N+1 (fine at demo scale, needs summary
endpoints later).
