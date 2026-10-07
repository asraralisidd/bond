"""Framework-free BOND API client.

The single module that talks to the backend: one request wrapper, JSON
envelope unwrapping, stable error codes with request ids, bearer auth,
idempotency keys. Mirrors ``@bond/sdk`` behavior (paths, methods,
envelopes, hooks, idempotency rules).

No framework, no storage: the token lives in memory (or a
caller-supplied provider) and is never persisted or logged. Transport
is httpx with an injectable client for tests. No automatic retries —
callers decide, using ``BondApiError.retry_after`` on 429s.

Agent-integration operations (register/report/status/verify) and
operator/wallet operations (sessions, bonds, transactions, attestations,
eligibility, credentials, setup grants) share one client. Operator
sessions, agent credentials, and setup grants are distinct principals;
the docstrings mark which operations an external agent typically uses.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any, Union
from urllib.parse import quote

import httpx

from .auth import TokenProvider, resolve_token
from .errors import BondApiError, parse_retry_after

TokenSource = Union[str, TokenProvider, None]
UnauthorizedHook = Callable[[BondApiError], None]


def new_idempotency_key() -> str:
    """Cryptographically random idempotency key (UUID4)."""
    return str(uuid.uuid4())


def resolve_api_base(configured: str | None, is_production: bool) -> str:
    """Resolve the API base URL.

    Production deployments MUST pass an explicit URL — a silent
    localhost default in production would point the client at a
    nonexistent backend.
    """
    if configured:
        return configured
    if is_production:
        raise BondApiError(
            "INVALID_IDENTIFIER",
            "An explicit API base URL is required in production; "
            "refusing the localhost default.",
            0,
            None,
        )
    return "http://localhost:4000"


def _strip_nones(value: Any) -> Any:
    """Drop None dict values recursively, mirroring JSON.stringify.

    The TypeScript SDK omits `undefined` object properties at every
    nesting level; Python callers pass None for the same "absent"
    meaning, so the wire payloads must match exactly. Lists keep
    their positions (JSON null preserved, as in TypeScript).
    """
    if isinstance(value, dict):
        return {
            key: _strip_nones(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, (list, tuple)):
        return [_strip_nones(item) for item in value]
    return value


class BondClient:
    """Synchronous BOND API client."""

    def __init__(
        self,
        base_url: str,
        token: TokenSource = None,
        *,
        http_client: httpx.Client | None = None,
        on_unauthorized: UnauthorizedHook | None = None,
    ) -> None:
        if not isinstance(base_url, str) or not base_url:
            raise BondApiError(
                "INVALID_IDENTIFIER",
                "BondClient requires a non-empty base_url",
                0,
                None,
            )
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._http = http_client
        self._owned_http = http_client is None
        self.on_unauthorized = on_unauthorized
        self._last_request_id: str | None = None

    def close(self) -> None:
        """Close the owned HTTP client, if this client created one."""
        if self._owned_http and self._http is not None:
            self._http.close()
            self._http = None

    def __enter__(self) -> BondClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def set_token(self, token: TokenSource) -> None:
        """Replace the in-memory bearer token (never persisted)."""
        self._token = token

    @property
    def last_request_id(self) -> str | None:
        """Request id of the most recently completed API call."""
        return self._last_request_id

    def _transport(self) -> httpx.Client:
        if self._http is None:
            self._http = httpx.Client(base_url=self._base_url)
            self._owned_http = True
        return self._http

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        idempotent: bool = False,
        skip_unauthorized_hook: bool = False,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[Any, str | None]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        token = resolve_token(self._token)
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if idempotent:
            headers["Idempotency-Key"] = new_idempotency_key()
        payload = _strip_nones(json) if isinstance(json, dict) else json
        try:
            response = self._transport().request(
                method, path, json=payload, headers=headers
            )
        except Exception as exc:
            raise BondApiError(
                "NETWORK_ERROR",
                str(exc) if isinstance(exc, Exception) else "Network unreachable",
                0,
                None,
            ) from None
        request_id = response.headers.get("x-request-id")
        self._last_request_id = request_id
        try:
            body = response.json()
        except Exception:
            body = None
        if response.status_code < 200 or response.status_code >= 300:
            code = (
                body.get("code")
                if isinstance(body, dict) and isinstance(body.get("code"), str)
                else "UNKNOWN_ERROR"
            )
            message = (
                body.get("message")
                if isinstance(body, dict)
                and isinstance(body.get("message"), str)
                else f"HTTP {response.status_code}"
            )
            retry_after = (
                parse_retry_after(response.headers.get("retry-after"))
                if response.status_code == 429
                else None
            )
            api_error = BondApiError(
                code, message, response.status_code, request_id, retry_after
            )
            if response.status_code == 401 and not skip_unauthorized_hook:
                try:
                    if self.on_unauthorized is not None:
                        self.on_unauthorized(api_error)
                except Exception:
                    # Handler must never break the error path.
                    pass
            raise api_error
        data = body.get("data") if isinstance(body, dict) else None
        return data, request_id

    def _get(self, path: str) -> Any:
        data, _ = self._request("GET", path)
        return data

    def _post(
        self,
        path: str,
        payload: Any = None,
        *,
        idempotent: bool = False,
        skip_unauthorized_hook: bool = False,
    ) -> Any:
        data, _ = self._request(
            "POST",
            path,
            json=payload,
            idempotent=idempotent,
            skip_unauthorized_hook=skip_unauthorized_hook,
        )
        return data

    def _patch(self, path: str, payload: Any = None) -> Any:
        data, _ = self._request("PATCH", path, json=payload)
        return data

    def _delete(self, path: str, payload: Any = None) -> Any:
        data, _ = self._request("DELETE", path, json=payload)
        return data

    # -- Health ---------------------------------------------------------

    def health(self) -> Any:
        """Liveness probe. Agent use: connectivity check."""
        return self._get("/health")

    def ready(self) -> Any:
        """Readiness snapshot. Agent use: gate startup on dependencies."""
        return self._get("/ready")

    # -- Authentication -------------------------------------------------
    # Operator-scoped. Agents use a token obtained out-of-band; the SDK
    # never invents per-agent credentials.

    def create_session(self, dev_key: str, external_key: str) -> Any:
        """Development session issuance (dev environments only)."""
        return self._post(
            "/api/v1/auth/session",
            {"devKey": dev_key, "externalKey": external_key},
        )

    def sign_out(self) -> Any:
        """Revoke the current session. Skips the 401 hook (no loops)."""
        return self._post(
            "/api/v1/auth/sign-out", {}, skip_unauthorized_hook=True
        )

    def request_wallet_challenge(self, network: str | None = None) -> Any:
        """Production login step 1: server-issued signing challenge."""
        return self._post("/api/v1/auth/wallet/challenge", {"network": network})

    def verify_wallet_challenge(
        self, challenge_id: str, signature: dict[str, str]
    ) -> Any:
        """Production login step 2: exchange a signed challenge for a session."""
        return self._post(
            "/api/v1/auth/wallet/verify",
            {"challengeId": challenge_id, "signature": signature},
        )

    # -- Agents ----------------------------------------------------------

    def list_agents(self, limit: int = 50) -> Any:
        """List own agents. Agent use: discover integration target."""
        return self._get(f"/api/v1/agents?limit={limit}")

    def get_agent(self, agent_id: str) -> Any:
        """Fetch one owned agent. Agent use: read status (getStatus)."""
        return self._get(f"/api/v1/agents/{agent_id}")

    def register_agent(
        self,
        *,
        platform: str,
        agent_type: str,
        capabilities: list[str],
        external_ref: str,
    ) -> Any:
        """Register an agent (operator action, idempotent)."""
        return self._post(
            "/api/v1/agents",
            {
                "platform": platform,
                "agentType": agent_type,
                "capabilities": capabilities,
                "externalRef": external_ref,
            },
            idempotent=True,
        )

    def set_agent_status(self, agent_id: str, status: str) -> Any:
        """Machine-governed status transition (operator action)."""
        return self._patch(f"/api/v1/agents/{agent_id}/status", {"status": status})

    def create_agent_credential(
        self,
        agent_id: str,
        capabilities: list[str] | None = None,
        expires_at: str | None = None,
    ) -> Any:
        """Create an agent credential (OPERATOR ONLY; secret returned once)."""
        return self._post(
            f"/api/v1/agents/{agent_id}/credentials",
            {"capabilities": capabilities, "expiresAt": expires_at},
        )

    def list_agent_credentials(self, agent_id: str) -> Any:
        """List credential metadata (OPERATOR ONLY; never secrets)."""
        return self._get(f"/api/v1/agents/{agent_id}/credentials")

    def rotate_agent_credential(
        self, agent_id: str, credential_id: str
    ) -> Any:
        """Rotate a credential (OPERATOR ONLY; new secret returned once)."""
        return self._post(
            f"/api/v1/agents/{agent_id}/credentials/{credential_id}/rotate", {}
        )

    def revoke_agent_credential(
        self, agent_id: str, credential_id: str, reason: str | None = None
    ) -> Any:
        """Revoke a credential (OPERATOR ONLY)."""
        return self._delete(
            f"/api/v1/agents/{agent_id}/credentials/{credential_id}",
            {"reason": reason},
        )

    def create_setup_grant(
        self,
        scopes: list[str],
        agent_id: str | None = None,
        expires_at: str | None = None,
    ) -> Any:
        """Create a single-use setup grant (OPERATOR ONLY; secret once)."""
        return self._post(
            "/api/v1/setup-grants",
            {"agentId": agent_id, "scopes": scopes, "expiresAt": expires_at},
        )

    def list_setup_grants(self) -> Any:
        """List grant metadata (OPERATOR ONLY; never secrets)."""
        return self._get("/api/v1/setup-grants")

    def revoke_setup_grant(
        self, grant_id: str, reason: str | None = None
    ) -> Any:
        """Revoke a grant (OPERATOR ONLY)."""
        return self._delete(
            f"/api/v1/setup-grants/{grant_id}", {"reason": reason}
        )

    # -- Bonds ------------------------------------------------------------

    def create_bond(self, *, agent_id: str, commitment_minor_units: str) -> Any:
        """Lock collateral (operator action, idempotent)."""
        return self._post(
            "/api/v1/bonds",
            {"agentId": agent_id, "commitmentMinorUnits": commitment_minor_units},
            idempotent=True,
        )

    def get_bond(self, bond_id: str) -> Any:
        return self._get(f"/api/v1/bonds/{bond_id}")

    def set_bond_status(self, bond_id: str, status: str) -> Any:
        return self._patch(f"/api/v1/bonds/{bond_id}/status", {"status": status})

    # -- Transactions ------------------------------------------------------

    def create_transaction(
        self,
        *,
        purpose: str,
        agent_id: str | None = None,
        bond_id: str | None = None,
        idempotency_key: str,
        nullifier: str | None = None,
    ) -> Any:
        """Create a transaction intent. Caller supplies idempotencyKey."""
        return self._post(
            "/api/v1/transactions",
            {
                "purpose": purpose,
                "agentId": agent_id,
                "bondId": bond_id,
                "idempotencyKey": idempotency_key,
                "nullifier": nullifier,
            },
        )

    def get_transaction(self, transaction_id: str) -> Any:
        return self._get(f"/api/v1/transactions/{transaction_id}")

    def advance_transaction(self, transaction_id: str, status: str) -> Any:
        return self._post(
            f"/api/v1/transactions/{transaction_id}/advance", {"status": status}
        )

    def record_wallet_submission(self, transaction_id: str, chain_tx_id: str) -> Any:
        """Record a wallet-relayed chain reference (wallet-attended flow)."""
        return self._post(
            f"/api/v1/transactions/{transaction_id}/submitted",
            {"chainTxId": chain_tx_id},
        )

    def confirm_transaction(self, transaction_id: str) -> Any:
        return self._post(
            f"/api/v1/transactions/{transaction_id}/confirm", {}
        )

    # -- Risk ---------------------------------------------------------------

    def analyze_activity(self, agent_id: str, activity: dict[str, Any]) -> Any:
        """Submit activity for analysis. Agent use: reportActivity.

        Accepts a dict produced by :func:`activity.ActivityInput.to_dict`
        (or an equivalent hand-built RawActivityInput payload).
        """
        return self._post(
            "/api/v1/risk/analyses",
            {"agentId": agent_id, "activity": activity},
            idempotent=True,
        )

    def list_flags(self, agent_id: str) -> Any:
        """List risk flags. Agent use: check standing after reporting."""
        return self._get(f"/api/v1/risk/flags?agentId={quote(agent_id, safe='')}")

    def get_flag(self, flag_id: str) -> Any:
        return self._get(f"/api/v1/risk/flags/{flag_id}")

    def list_events(
        self,
        limit: int | None = None,
        cursor: str | None = None,
        event_type: str | None = None,
    ) -> Any:
        """Poll the authorization-scoped event feed."""
        params: dict[str, str] = {}
        if limit is not None:
            params["limit"] = str(limit)
        if cursor is not None:
            params["cursor"] = cursor
        if event_type is not None:
            params["type"] = event_type
        query = "&".join(
            f"{key}={quote(value, safe='')}" for key, value in params.items()
        )
        return self._get(f"/api/v1/events{('?' + query) if query else ''}")

    # -- Attestors / attestations ---------------------------------------------
    # Operator- and attestor-scoped; included for surface parity. External
    # agents report activity and read status — they never submit verdicts.

    def register_attestor(
        self,
        *,
        organization: str,
        secret: str,
        attestor_id: str | None = None,
    ) -> Any:
        return self._post(
            "/api/v1/attestors",
            {
                "attestorId": attestor_id,
                "organization": organization,
                "secret": secret,
            },
        )

    def request_attestation(
        self,
        *,
        flag_id: str,
        attestor_ids: list[str],
        threshold: int | None = None,
        expires_at: str,
        idempotency_key: str | None = None,
    ) -> Any:
        return self._post(
            "/api/v1/attestations",
            {
                "flagId": flag_id,
                "attestorIds": attestor_ids,
                "threshold": threshold,
                "expiresAt": expires_at,
                "idempotencyKey": idempotency_key or new_idempotency_key(),
            },
        )

    def get_attestation(self, attestation_id: str) -> Any:
        return self._get(f"/api/v1/attestations/{attestation_id}")

    def submit_verdict(
        self, attestation_id: str, *, attestor_id: str, verdict: str, secret: str
    ) -> Any:
        """Submit an attestor verdict.

        Attestor-secret auth (NOT the bearer token): the secret travels
        in a header to this endpoint only, never in logs or elsewhere.
        """
        headers = {
            "Content-Type": "application/json",
            "X-Attestor-Secret": secret,
        }
        try:
            response = self._transport().request(
                "POST",
                f"/api/v1/attestations/{attestation_id}/verdicts",
                json={"attestorId": attestor_id, "verdict": verdict},
                headers=headers,
            )
        except Exception as exc:
            raise BondApiError(
                "NETWORK_ERROR",
                str(exc) if isinstance(exc, Exception) else "Network unreachable",
                0,
                None,
            ) from None
        request_id = response.headers.get("x-request-id")
        self._last_request_id = request_id
        try:
            body = response.json()
        except Exception:
            body = None
        if response.status_code < 200 or response.status_code >= 300:
            code = (
                body.get("code")
                if isinstance(body, dict) and isinstance(body.get("code"), str)
                else "UNKNOWN_ERROR"
            )
            message = (
                body.get("message")
                if isinstance(body, dict)
                and isinstance(body.get("message"), str)
                else f"HTTP {response.status_code}"
            )
            retry_after = (
                parse_retry_after(response.headers.get("retry-after"))
                if response.status_code == 429
                else None
            )
            raise BondApiError(
                code, message, response.status_code, request_id, retry_after
            )
        return body.get("data") if isinstance(body, dict) else None

    def evaluate_attestation(
        self, attestation_id: str, strictness: int | None = None
    ) -> Any:
        return self._post(
            f"/api/v1/attestations/{attestation_id}/evaluate",
            {"strictness": strictness},
        )

    def issue_decision(
        self, attestation_id: str, action: str | None = None
    ) -> Any:
        return self._post(
            f"/api/v1/attestations/{attestation_id}/decision", {"action": action}
        )

    def enforce_attestation(
        self, attestation_id: str, amount_minor_units: str | None = None
    ) -> Any:
        return self._post(
            f"/api/v1/attestations/{attestation_id}/enforce",
            {
                "amountMinorUnits": amount_minor_units,
                "idempotencyKey": new_idempotency_key(),
            },
        )

    # -- Eligibility ------------------------------------------------------------

    def create_eligibility_proof(
        self,
        *,
        agent_id: str,
        bond_id: str,
        required_minimum_minor_units: str,
        nonce: str,
        expires_at: str,
        policy_version: str | None = None,
        purpose: str | None = None,
    ) -> Any:
        return self._post(
            "/api/v1/eligibility/proofs",
            {
                "agentId": agent_id,
                "bondId": bond_id,
                "policyVersion": policy_version,
                "purpose": purpose,
                "requiredMinimumMinorUnits": required_minimum_minor_units,
                "nonce": nonce,
                "expiresAt": expires_at,
            },
            idempotent=True,
        )

    def get_eligibility(self, proof_id: str) -> Any:
        return self._get(f"/api/v1/eligibility/proofs/{proof_id}")

    def consume_eligibility(self, proof_id: str, nonce: str) -> Any:
        return self._post(
            f"/api/v1/eligibility/proofs/{proof_id}/consume", {"nonce": nonce}
        )

    # -- Public verification ------------------------------------------------------
    # Unauthenticated, scoped projections. Agent use: self-check standing.

    def verify_agent(self, agent_id: str) -> Any:
        return self._get(f"/api/v1/public/agents/{quote(agent_id, safe='')}")

    def verify_eligibility(
        self, agent_id: str, policy_version: str | None = None
    ) -> Any:
        path = f"/api/v1/public/agents/{quote(agent_id, safe='')}/eligibility"
        if policy_version is not None:
            path += f"?policyVersion={quote(policy_version, safe='')}"
        return self._get(path)
