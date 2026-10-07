"""End-to-end AI agent security demo (Phase 17).

An external AI-powered agent operating under BOND:

    Model Provider -> AIAgent -> bond_sdk -> BOND API -> Risk Engine
        -> Risk Flags -> Attestation -> Enforcement (SIMULATED)

BOND is NOT the model. The default scripted provider needs no API key,
no internet, and no wallet. Enforcement effects are SIMULATED and
always labeled as such — this demo never claims live blockchain
execution.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from secrets import token_hex
from typing import Any, Callable, Protocol, TextIO

from bond_sdk import (
    ActivityPolicyContext,
    BondAgentClient,
    BondApiError,
    BondClient,
    build_activity,
    build_model_activity,
)
from bond_sdk.adapters import GenericFrameworkAdapter
from bond_sdk.providers import (
    normalize_anthropic_usage,
    normalize_openai_usage,
)

POLICY_VERSION = "bond-policy-v1"
SPEND_LIMIT = "1000"

AI_DEMO_PLATFORM = "bond-demo"
AI_DEMO_AGENT_TYPE = "custom"
AI_DEMO_CAPABILITIES = ("demo-messaging", "demo-tool-use")

BENIGN_REF = "ai-demo-agent-benign-v1"
RISKY_REF = "ai-demo-agent-risky-v1"
BEHAVIORAL_REF = "ai-demo-agent-behavioral-v1"
REPUTATION_REF = "ai-demo-agent-reputation-v1"
POLICY_REF_PREFIX = "ai-demo-agent-policy"
PROVIDERS_REF = "ai-demo-agent-providers-v1"

FIXED_OCCURRED_AT = "2026-01-01T00:00:00.000Z"
BEHAVIORAL_BASE_AT = datetime(2026, 1, 1, tzinfo=timezone.utc)

#: Behavioral rule IDs (Phase 20, deterministic statistics — no ML).
BEHAVIORAL_RULE_IDS = (
    "activity-burst",
    "spend-velocity",
    "novel-tool",
    "repeat-violation",
)


# ---------------------------------------------------------------------------
# Model layer: provider-neutral, scripted by default.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelResponse:
    """One model-generated action. Untrusted until build_activity()."""

    action: str
    action_type: str
    parameters: dict[str, Any]


class ModelProvider(Protocol):
    """Minimal model interface: prompt + context in, action out."""

    def generate(
        self, prompt: str, context: dict[str, Any]
    ) -> ModelResponse:
        ...


class ScriptedModelProvider:
    """Deterministic canned actions. No key, no network, no model.

    Scenarios derived from the verified BOND risk rules:
    - "benign": allowlisted action, declared tool, spend under limit
      (all rule guards pass → zero findings).
    - "risky": denylisted action at 3x the spend limit (policy-denylist
      high/90 + spend-limit-breach high/85).
    - "behavioral": scripted 19-step sequence (own step builder).
    - "reputation": risky action reused for the trust lifecycle
      (own stage builder; generate() falls through to risky).
    """

    def __init__(self, scenario: str) -> None:
        if scenario not in ("benign", "risky", "behavioral", "reputation", "policy", "delegation", "providers"):
            raise BondApiError(
                "INVALID_IDENTIFIER",
                f"Unknown demo scenario: {scenario}",
                0,
                None,
            )
        self._scenario = scenario

    @property
    def name(self) -> str:
        return f"scripted:{self._scenario}"

    def generate(
        self, prompt: str, context: dict[str, Any]
    ) -> ModelResponse:
        del prompt, context
        if self._scenario == "benign":
            return ModelResponse(
                action="pay-vendor",
                action_type="transfer",
                parameters={
                    "amount_minor_units": "500",
                    "metadata": {"vendor": "demo-vendor"},
                },
            )
        return ModelResponse(
            action="self-transfer",
            action_type="transfer",
            parameters={
                "amount_minor_units": "3000",
                "metadata": {"vendor": "demo-vendor"},
            },
        )


class EnvModelProvider:
    """Live-model placeholder with honest gating.

    Resolves provider configuration from the environment but refuses to
    execute: no provider request/response format has been verified in
    this environment, so claiming support would be fabrication. Fails
    clearly instead.
    """

    def __init__(self, provider: str | None, api_key: str | None) -> None:
        if not provider or not api_key:
            raise BondApiError(
                "UNAUTHORIZED",
                "live-model mode requires BOND_MODEL_PROVIDER and "
                "BOND_MODEL_API_KEY to be set.",
                0,
                None,
            )
        self._provider = provider

    @property
    def name(self) -> str:
        return f"live:{self._provider}"

    def generate(
        self, prompt: str, context: dict[str, Any]
    ) -> ModelResponse:
        del prompt, context
        raise BondApiError(
            "INVALID_IDENTIFIER",
            f"live-model provider '{self._provider}' is not verified in "
            "this environment: no request/response format has been "
            "exercised. Use scripted mode.",
            0,
            None,
        )


# ---------------------------------------------------------------------------
# Agent configuration.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AIDemoConfig:
    """Demo configuration from the environment. No secrets stored."""

    api_url: str = "http://localhost:4000"
    dev_auth_token: str | None = None
    external_key: str = "ai-demo-operator"
    mode: str = "scripted"
    scenario: str = "benign"

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> AIDemoConfig:
        source = env if env is not None else os.environ
        return AIDemoConfig(
            api_url=source.get("BOND_API_URL", "http://localhost:4000"),
            dev_auth_token=source.get("BOND_DEV_AUTH_TOKEN"),
            external_key=source.get(
                "BOND_DEV_EXTERNAL_KEY", "ai-demo-operator"
            ),
            mode=source.get("BOND_DEMO_MODE", "scripted"),
            scenario=source.get("BOND_DEMO_SCENARIO", "benign"),
        )


def _policy(benign: bool) -> ActivityPolicyContext:
    return ActivityPolicyContext(
        policy_version=POLICY_VERSION,
        allowed_actions=("pay-vendor",),
        declared_tools=("transfers",),
        denylisted_actions=() if benign else ("self-transfer",),
        spend_limit_minor_units=SPEND_LIMIT,
    )


# ---------------------------------------------------------------------------
# Agent driver.
# ---------------------------------------------------------------------------

EmitFn = Callable[[str], None]


def _default_agent_client_factory(
    base_url: str, token: str
) -> BondAgentClient:
    """Build a real agent transport. Replaceable in tests."""
    return BondAgentClient(BondClient(base_url=base_url, token=token))


def _default_grant_client_factory(base_url: str, token: str) -> BondClient:
    """Build a real grant-bearer transport. Replaceable in tests."""
    return BondClient(base_url=base_url, token=token)


class AIAgent:
    """External agent operating under BOND via the Python SDK only."""

    def __init__(
        self,
        config: AIDemoConfig,
        client: BondClient,
        model: ModelProvider,
        agent_client_factory: Callable[
            [str, str], BondAgentClient
        ] = _default_agent_client_factory,
        grant_client_factory: Callable[
            [str, str], BondClient
        ] = _default_grant_client_factory,
    ) -> None:
        self._config = config
        self._client = client
        self._model = model
        self._agent_client_factory = agent_client_factory
        self._grant_client_factory = grant_client_factory

    def run(self, out: TextIO = sys.stdout) -> dict[str, Any]:
        """Execute the end-to-end flow. Returns a safe summary dict."""

        def emit(text: str) -> None:
            print(text, file=out)

        summary: dict[str, Any] = {
            "mode": self._config.mode,
            "scenario": self._config.scenario,
            "model": getattr(self._model, "name", "unknown"),
        }

        emit("BOND AI AGENT SECURITY DEMO")
        emit("")
        emit("Mode:")
        emit(f"  {summary['mode']}")

        # 1. Health check.
        self._client.health()

        # 2-3. Authenticate + register (deterministic, rerun-safe).
        if not self._config.dev_auth_token:
            raise BondApiError(
                "UNAUTHORIZED",
                "BOND_DEV_AUTH_TOKEN is not set.",
                0,
                None,
            )
        session = self._client.create_session(
            self._config.dev_auth_token, self._config.external_key
        )
        self._client.set_token(session["token"])
        if self._config.scenario == "delegation":
            return self._run_delegation(emit, summary)
        # Policy runs use a fresh agent per run: usage windows
        # accumulate server-side, so reusing an agent would make step
        # assertions history dependent instead of deterministic.
        if self._config.scenario == "policy":
            external_ref = f"{POLICY_REF_PREFIX}-{token_hex(4)}"
        else:
            external_ref = {
                "benign": BENIGN_REF,
                "risky": RISKY_REF,
                "behavioral": BEHAVIORAL_REF,
                "reputation": REPUTATION_REF,
                "providers": PROVIDERS_REF,
            }[self._config.scenario]
        agent = self._register(external_ref)
        agent_id = agent["agentId"]
        summary["agentId"] = agent_id

        # Operator issues an agent-scoped credential; the agent acts
        # through BondAgentClient from here on for agent-scoped reads
        # and activity submission. Registration, bonds, and attestations
        # stay on the operator client. The raw secret lives only in
        # memory and is revoked at the end of the run.
        agent_client, credential_id = self._issue_agent_credential(agent_id)
        summary["credentialId"] = credential_id

        try:
            emit("")
            emit("Agent:")
            emit(f"  ID: {agent_id}")
            emit(f"  Type: {agent.get('agentType', 'custom')}")
            emit("Agent Credential:")
            emit(f"  {summary['credentialId']} (revoked at end of run)")
            emit("Model:")
            emit(f"  Provider: {summary['model']}")
            emit(f"  Mode: {summary['mode']}")
            emit("")
            emit("Scenario:")
            emit(f"  {summary['scenario']}")

            if self._config.scenario == "behavioral":
                self._run_behavioral(emit, summary, agent_id, agent_client)
                emit("")
                emit("Enforcement:")
                emit("  not-applicable (behavioral findings are advisory)")
                return summary

            if self._config.scenario == "reputation":
                self._run_reputation(emit, summary, agent_id, agent_client)
                return summary

            if self._config.scenario == "policy":
                self._run_policy(emit, summary, agent_id, agent_client)
                emit("")
                emit("Enforcement:")
                emit("  not-applicable (policy findings are advisory)")
                return summary

            if self._config.scenario == "providers":
                self._run_providers(emit, summary, agent_id, agent_client)
                emit("")
                emit("Enforcement:")
                emit("  not-applicable (integration findings are advisory)")
                return summary

            # 4-8. Model generates; SDK validates; API analyzes.
            response = self._model.generate(
                "act under bond policy",
                {"agentId": agent_id, "scenario": self._config.scenario},
            )
            parameters = dict(response.parameters)
            # activity_id intentionally left for the SDK to generate fresh per
            # run: flag IDs derive deterministically from activity content,
            # so reusing an ID across runs would collide server-side.
            parameters.setdefault("occurred_at", FIXED_OCCURRED_AT)
            activity = build_activity(
                agent_id=agent_id,
                action_type=response.action_type,  # type: ignore[arg-type]
                action=response.action,
                policy_context=_policy(self._config.scenario == "benign"),
                **parameters,
            )
            outcome = agent_client.analyze_activity(agent_id, activity)
            score = outcome.get("score") or {}
            summary["analysisId"] = outcome.get("analysisId")
            summary["score"] = score.get("score")
            summary["flagIds"] = outcome.get("flagIds") or []

            emit("")
            emit("Activity:")
            emit(f"  Type: {response.action_type}")
            emit(f"  Action: {response.action}")
            emit("")
            emit("Risk:")
            emit(f"  score: {summary['score']}")
            emit(f"  flags: {len(summary['flagIds'])}")

            # 9-11. Flags (from this run's analysis, not stale history),
            # status, public verification.
            flags = [
                agent_client.get_flag(flag_id)
                for flag_id in summary["flagIds"]
            ]
            summary["flags"] = [
                {
                    "riskFlagId": flag.get("riskFlagId"),
                    "severity": flag.get("severity"),
                    "category": flag.get("category"),
                }
                for flag in flags
                if isinstance(flag, dict)
            ]
            recorded = agent_client.list_flags(agent_id) or []
            summary["flagCount"] = len(summary["flags"])
            summary["totalFlagsOnRecord"] = len(recorded)
            current = agent_client.get_agent(agent_id)
            summary["agentStatus"] = current.get("status", "unknown")
            verification = agent_client.verify_agent(agent_id)
            summary["verification"] = (
                verification.get("verification", {}).get("result", "unknown")
                if isinstance(verification, dict)
                else "unknown"
            )

            emit("")
            emit("Agent Status:")
            emit(f"  {summary['agentStatus']}")
            emit("")
            emit("Public Verification:")
            emit(f"  {summary['verification']}")

            if self._config.scenario == "benign":
                self._report_benign(summary, emit)
            elif self._config.scenario == "risky":
                self._report_risky(summary, emit, agent_id)
            else:
                raise BondApiError(
                    "INVALID_IDENTIFIER",
                    f"Unknown demo scenario: {self._config.scenario}.",
                    0,
                    None,
                )

            emit("")
            emit("Enforcement:")
            emit(f"  {summary.get('enforcement', 'not-applicable')}")
            return summary
        finally:
            # Best-effort hygiene on success AND failure paths.
            self._revoke_agent_credential(
                summary, emit, agent_id, credential_id
            )

    def _run_behavioral(
        self,
        emit: EmitFn,
        summary: dict[str, Any],
        agent_id: str,
        agent_client: BondAgentClient,
    ) -> None:
        """Deterministic behavioral sequence (Phase 20, scripted only).

        Submits a fixed 19-step script with +60s occurredAt steps:
        benign baseline → burst → spend velocity → novel tool →
        repeated denylist violations. Windows are server-side
        (created_at), so the stepped occurredAt values are
        reproducibility aids, not security inputs.
        """
        base_policy = ActivityPolicyContext(
            policy_version=POLICY_VERSION,
            allowed_actions=("pay-vendor",),
            declared_tools=("transfers",),
            spend_limit_minor_units=SPEND_LIMIT,
        )
        violation_policy = ActivityPolicyContext(
            policy_version=POLICY_VERSION,
            allowed_actions=("pay-vendor", "self-transfer"),
            declared_tools=("transfers",),
            denylisted_actions=("self-transfer",),
            spend_limit_minor_units=SPEND_LIMIT,
        )
        steps: list[dict[str, Any]] = []
        for _ in range(3):
            steps.append(
                {"action": "pay-vendor", "amount": "100", "policy": base_policy}
            )
        for _ in range(8):
            steps.append(
                {"action": "pay-vendor", "amount": "100", "policy": base_policy}
            )
        for _ in range(4):
            steps.append(
                {"action": "pay-vendor", "amount": "900", "policy": base_policy}
            )
        steps.append(
            {
                "action": "pay-vendor",
                "amount": "100",
                "tool": "shell-exec",
                "policy": base_policy,
            }
        )
        for _ in range(3):
            steps.append(
                {
                    "action": "self-transfer",
                    "amount": "100",
                    "policy": violation_policy,
                }
            )
        observed: dict[str, dict[str, Any]] = {}
        emit("")
        emit("Behavioral Sequence:")
        for index, step in enumerate(steps):
            occurred = (
                BEHAVIORAL_BASE_AT + timedelta(seconds=60 * index)
            ).isoformat()
            params: dict[str, Any] = {
                "amount_minor_units": step["amount"],
                "occurred_at": occurred,
            }
            if "tool" in step:
                params["tool"] = step["tool"]
            activity = build_activity(
                agent_id=agent_id,
                action_type="transfer",
                action=step["action"],
                policy_context=step["policy"],
                **params,
            )
            outcome = agent_client.analyze_activity(agent_id, activity)
            factors = ((outcome.get("score") or {}).get("factors")) or []
            step_behavioral = []
            for factor in factors:
                if not isinstance(factor, dict):
                    continue
                rule_id = factor.get("ruleId")
                if rule_id in BEHAVIORAL_RULE_IDS:
                    step_behavioral.append(rule_id)
                    observed.setdefault(
                        str(rule_id),
                        {
                            "severity": factor.get("severity"),
                            "category": factor.get("category"),
                        },
                    )
            emit(
                f"  step {index + 1:02d}/{len(steps)} "
                f"{step['action']}: "
                f"behavioral={','.join(step_behavioral) or 'none'}"
            )
        summary["behavioralSteps"] = len(steps)
        summary["behavioralRuleIds"] = sorted(observed)
        summary["behavioralFindings"] = {
            rule_id: observed[rule_id] for rule_id in sorted(observed)
        }
        recorded = agent_client.list_flags(agent_id) or []
        summary["flagCount"] = len(recorded)
        versions = sorted(
            {
                str(flag.get("modelVersion"))
                for flag in recorded
                if isinstance(flag, dict)
                and "ruleset-v2" in str(flag.get("modelVersion", ""))
            }
        )
        summary["behavioralModelVersions"] = versions
        self._report_behavioral(summary, emit)

    def _report_behavioral(
        self, summary: dict[str, Any], emit: EmitFn
    ) -> None:
        if not summary["behavioralRuleIds"]:
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                "Behavioral scenario produced no behavioral findings; "
                "expected activity-burst / spend-velocity / novel-tool / "
                "repeat-violation signals.",
                0,
                None,
            )
        emit("")
        emit("Behavioral Findings (advisory — attestors still decide):")
        for rule_id in summary["behavioralRuleIds"]:
            detail = summary["behavioralFindings"][rule_id]
            emit(
                f"  - {rule_id}: "
                f"{detail.get('category')} / {detail.get('severity')}"
            )
        emit("Behavioral Model Versions:")
        for version in summary["behavioralModelVersions"]:
            emit(f"  {version}")

    def _run_reputation(
        self,
        emit: EmitFn,
        summary: dict[str, Any],
        agent_id: str,
        agent_client: BondAgentClient,
    ) -> None:
        """Deterministic reputation lifecycle (Phase 21, scripted only).

        Stages: baseline → benign activity (preserved) → risky
        activity (observed dip) → attested decision (verified dip) →
        simulated enforcement (no chain: the slash hook fires only on
        real worker-confirmed slash events, covered by API tests).
        Every stage prints the score, trust level, and the reasons
        behind each change.
        """
        stages: list[dict[str, Any]] = []

        def snapshot(stage: str) -> None:
            rep = agent_client.get_reputation(agent_id) or {}
            stages.append(
                {
                    "stage": stage,
                    "score": rep.get("score"),
                    "trustLevel": rep.get("trustLevel"),
                }
            )
            emit("")
            emit(f"Reputation [{stage}]:")
            emit(f"  score: {rep.get('score')}")
            emit(f"  trust: {rep.get('trustLevel')}")
            emit(f"  version: {rep.get('version')}")

        snapshot("baseline")

        benign = build_activity(
            agent_id=agent_id,
            action_type="transfer",
            action="pay-vendor",
            policy_context=_policy(True),
            amount_minor_units="500",
            occurred_at=FIXED_OCCURRED_AT,
        )
        agent_client.analyze_activity(agent_id, benign)
        snapshot("after-benign-activity")

        response = self._model.generate(
            "act under bond policy",
            {"agentId": agent_id, "scenario": "reputation"},
        )
        risky = build_activity(
            agent_id=agent_id,
            action_type=response.action_type,  # type: ignore[arg-type]
            action=response.action,
            policy_context=_policy(False),
            occurred_at=FIXED_OCCURRED_AT,
            **dict(response.parameters),
        )
        outcome = agent_client.analyze_activity(agent_id, risky)
        summary["flagIds"] = outcome.get("flagIds") or []
        if not summary["flagIds"]:
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                "Reputation scenario produced no flags; expected findings.",
                0,
                None,
            )
        flags = [
            agent_client.get_flag(flag_id)
            for flag_id in summary["flagIds"]
        ]
        summary["flags"] = [
            {
                "riskFlagId": flag.get("riskFlagId"),
                "severity": flag.get("severity"),
                "category": flag.get("category"),
            }
            for flag in flags
            if isinstance(flag, dict)
        ]
        snapshot("after-risky-activity")

        # Independent attestation + simulated enforcement (reuses the
        # risky-scenario path; enforcement effects stay SIMULATED).
        self._attest_and_enforce(summary, emit, agent_id)
        snapshot("after-attested-decision")

        full = agent_client.get_reputation(agent_id) or {}
        summary["reputationStages"] = stages
        summary["reputationEvents"] = full.get("events") or []
        summary["reputation"] = {
            "score": full.get("score"),
            "trustLevel": full.get("trustLevel"),
            "version": full.get("version"),
        }
        scores = [s["score"] for s in stages]
        if not (
            scores[1] == scores[0]
            and scores[2] < scores[1]
            and scores[3] < scores[2]
        ):
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                f"Reputation did not degrade as expected: {scores}.",
                0,
                None,
            )
        emit("")
        emit("Reputation History (why it changed):")
        for event in summary["reputationEvents"]:
            if not isinstance(event, dict):
                continue
            emit(
                f"  - {event.get('eventType')}: "
                f"{event.get('scoreBefore')} → {event.get('scoreAfter')} "
                f"({event.get('impact'):+d}, {event.get('reasonCode')})"
            )
            emit(f"    {event.get('reason')}")
        emit("")
        emit("Note:")
        emit("  Reputation is advisory trust intelligence and does not")
        emit("  directly authorize or execute enforcement.")

    def _run_policy(
        self,
        emit: EmitFn,
        summary: dict[str, Any],
        agent_id: str,
        agent_client: BondAgentClient,
    ) -> None:
        """Deterministic policy scenarios A–E (Phase 22, scripted only).

        The operator installs one policy, then the agent submits:
        A compliant, B disallowed model, C token overuse, D cost
        overuse, E repeated compliant usage (policy rate limit plus
        behavioral burst). Costs are adapter-reported estimates —
        never provider billing. Enforcement is not executed.
        """
        created = self._client.create_agent_policy(
            agent_id,
            {
                "allowedProviders": ["acme"],
                "allowedModels": ["acme-small"],
                "maxInputTokens": 100000,
                "maxTotalTokens": 200000,
                "maxCostMinorUnitsPerRequest": "500",
                "maxRequestsPerWindow": 10,
                "requestWindowSeconds": 3600,
            },
        )
        summary["policyId"] = created["policyId"]
        summary["policyVersion"] = created["version"]
        emit("")
        emit("Policy:")
        emit(f"  id: {created['policyId']}")
        emit(f"  version: {created['version']}")

        base = {
            "action": "pay-vendor",
            "amount_minor_units": "100",
            "provider": "acme",
            "model": "acme-small",
            "input_tokens": 1000,
            "output_tokens": 1000,
            "total_tokens": 2000,
            "estimated_cost_minor_units": "10",
        }
        steps: list[dict[str, Any]] = [
            {"name": "A-compliant", "expect": [], **dict(base)},
            {
                "name": "B-model",
                "expect": ["policy-model-denied"],
                **{**base, "model": "rival-giant"},
            },
            {
                "name": "C-tokens",
                "expect": ["policy-input-token-limit"],
                **{
                    **base,
                    "input_tokens": 150000,
                    "total_tokens": 151000,
                },
            },
            {
                "name": "D-cost",
                "expect": ["policy-cost-limit"],
                **{**base, "estimated_cost_minor_units": "800"},
            },
        ]
        results: list[dict[str, Any]] = []
        burst_seen = False

        def submit(
            label: str, params: dict[str, Any], index: int
        ) -> dict[str, Any]:
            nonlocal burst_seen
            occurred = (
                BEHAVIORAL_BASE_AT + timedelta(seconds=60 * index)
            ).isoformat()
            activity = build_activity(
                agent_id=agent_id,
                action_type="transfer",
                action=params["action"],
                policy_context=_policy(True),
                amount_minor_units=params["amount_minor_units"],
                provider=params.get("provider"),
                model=params.get("model"),
                input_tokens=params.get("input_tokens"),
                output_tokens=params.get("output_tokens"),
                total_tokens=params.get("total_tokens"),
                estimated_cost_minor_units=params.get(
                    "estimated_cost_minor_units"
                ),
                occurred_at=occurred,
            )
            outcome = agent_client.analyze_activity(agent_id, activity)
            decision = outcome.get("policy") or {}
            violations = [
                str(v.get("ruleId"))
                for v in (decision.get("violations") or [])
                if isinstance(v, dict)
            ]
            for flag_id in outcome.get("flagIds") or []:
                parts = str(flag_id).split("-")
                rule = "-".join(parts[2:])
                if rule == "activity-burst":
                    burst_seen = True
            emit(
                f"  {label}: allowed={decision.get('allowed')} "
                f"violations={','.join(violations) or 'none'}"
            )
            return {
                "label": label,
                "allowed": decision.get("allowed"),
                "violations": violations,
            }

        emit("")
        emit("Policy Sequence:")
        for index, step in enumerate(steps):
            result = submit(
                step["name"],
                {k: v for k, v in step.items() if k != "expect"},
                index,
            )
            results.append(result)
            expected = step["expect"]
            if result["allowed"] == (len(expected) > 0):
                raise BondApiError(
                    "INVALID_ACTIVITY_INPUT",
                    f"Policy step {step['name']}: expected violations "
                    f"{expected}, got allowed={result['allowed']}.",
                    0,
                    None,
                )
            for rule_id in expected:
                if rule_id not in result["violations"]:
                    raise BondApiError(
                        "INVALID_ACTIVITY_INPUT",
                        f"Policy step {step['name']}: missing {rule_id}.",
                        0,
                        None,
                    )
        # Scenario E: eight more compliant transfers. Analyses 11+
        # exceed the 10-request window (policy rate limit) and the
        # behavioral burst threshold together.
        for extra in range(8):
            result = submit(
                f"E-repeat-{extra + 1}", dict(base), len(steps) + extra
            )
            results.append(result)
        final = results[-1]
        if "policy-request-rate-limit" not in final["violations"]:
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                "Policy scenario E produced no rate-limit violation.",
                0,
                None,
            )
        if not burst_seen:
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                "Policy scenario E produced no behavioral burst.",
                0,
                None,
            )
        summary["policyScenarioResults"] = [
            {
                "label": r["label"],
                "allowed": r["allowed"],
                "violations": r["violations"],
            }
            for r in results
        ]
        summary["policyBurstSeen"] = burst_seen
        emit("")
        emit("Policy + Behavioral (scenario E):")
        emit("  policy-request-rate-limit + activity-burst observed")

    def _run_delegation(
        self, emit: EmitFn, summary: dict[str, Any]
    ) -> dict[str, Any]:
        """Coordinator/worker delegation lifecycle (Phase 23, scripted).

        A = coordinator (holds activity:submit), B = worker (holds
        only agent:read until delegated). Steps: delegate → allowed
        operation (SUCCESS) → out-of-scope attempt (DENIED) → revoke
        → retry (DENIED) → policy violation under a fresh delegation
        (Policy → Risk → flag). Secrets stay in memory; both
        credentials are revoked at the end.
        """
        agent_a = self._register("ai-demo-agent-delegator-v1")
        agent_b = self._register("ai-demo-agent-delegate-v1")
        agent_a_id = agent_a["agentId"]
        agent_b_id = agent_b["agentId"]
        summary["delegatorAgentId"] = agent_a_id
        summary["delegateAgentId"] = agent_b_id
        emit("")
        emit("Coordinator:")
        emit(f"  ID: {agent_a_id}")
        emit("Worker:")
        emit(f"  ID: {agent_b_id}")

        client_a, cred_a = self._issue_agent_credential(
            agent_a_id, ["activity:submit", "risk:read"]
        )
        client_b, cred_b = self._issue_agent_credential(
            agent_b_id, ["agent:read"]
        )
        summary["credentialRevoked"] = False
        try:
            delegation = client_a.create_delegation(
                agent_a_id,
                {
                    "delegateAgentId": agent_b_id,
                    "capabilities": ["activity:submit"],
                    "expiresAt": "2026-12-31T00:00:00.000Z",
                    "scope": {"tools": ["transfers"]},
                },
            )
            delegation_id = delegation["delegationId"]
            summary["delegationId"] = delegation_id
            emit("")
            emit("Delegation:")
            emit(f"  ID: {delegation_id}")
            emit(f"  capabilities: {delegation['capabilities']}")
            emit(f"  status: {delegation['status']}")

            def submit(label: str, tool: str) -> dict[str, Any]:
                activity = build_activity(
                    agent_id=agent_b_id,
                    action_type="transfer",
                    action="pay-vendor",
                    policy_context=_policy(True),
                    amount_minor_units="100",
                    tool=tool,
                    occurred_at=FIXED_OCCURRED_AT,
                )
                try:
                    outcome = client_b.analyze_activity(
                        agent_b_id, activity, delegation_id=delegation_id
                    )
                except BondApiError as exc:
                    emit(f"  {label}: DENIED ({exc.code})")
                    return {"denied": True, "code": exc.code}
                attribution = outcome.get("attribution") or {}
                emit(
                    f"  {label}: SUCCESS "
                    f"(requester={attribution.get('requesterAgentId') == agent_a_id}, "
                    f"executor={attribution.get('executorAgentId') == agent_b_id})"
                )
                return {"denied": False, "outcome": outcome}

            emit("")
            emit("Operations:")
            allowed = submit("allowed-transfer", "transfers")
            if allowed["denied"]:
                raise BondApiError(
                    "INVALID_ACTIVITY_INPUT",
                    "Delegated in-scope operation was denied.",
                    0,
                    None,
                )
            summary["attribution"] = allowed["outcome"]["attribution"]
            scoped = submit("out-of-scope-tool", "shell-exec")
            if not scoped["denied"]:
                raise BondApiError(
                    "INVALID_ACTIVITY_INPUT",
                    "Out-of-scope delegated operation was allowed.",
                    0,
                    None,
                )

            revoked = client_a.revoke_delegation(
                delegation_id, reason="demo complete"
            )
            emit("")
            emit("Revocation:")
            emit(f"  status: {revoked['status']}")
            retried = submit("post-revoke-transfer", "transfers")
            if not retried["denied"]:
                raise BondApiError(
                    "INVALID_ACTIVITY_INPUT",
                    "Revoked delegation still authorized use.",
                    0,
                    None,
                )

            # Policy violation under a fresh delegation: install a
            # tool deny plus a token cap on the worker, delegate again,
            # submit over both. The deny surfaces through the v1
            # effective context; the token breach through the policy
            # evaluator — both become ordinary risk flags.
            self._client.create_agent_policy(
                agent_b_id,
                {"deniedTools": ["transfers"], "maxInputTokens": 100},
            )
            delegation2 = client_a.create_delegation(
                agent_a_id,
                {
                    "delegateAgentId": agent_b_id,
                    "capabilities": ["activity:submit"],
                    "expiresAt": "2026-12-31T00:00:00.000Z",
                },
            )
            summary["policyDelegationId"] = delegation2["delegationId"]
            activity = build_activity(
                agent_id=agent_b_id,
                action_type="transfer",
                action="pay-vendor",
                policy_context=_policy(True),
                amount_minor_units="100",
                tool="transfers",
                input_tokens=5000,
                total_tokens=5000,
                occurred_at=FIXED_OCCURRED_AT,
            )
            outcome = client_b.analyze_activity(
                agent_b_id,
                activity,
                delegation_id=delegation2["delegationId"],
            )
            decision = outcome.get("policy") or {}
            violations = [
                str(v.get("ruleId"))
                for v in (decision.get("violations") or [])
                if isinstance(v, dict)
            ]
            summary["policyViolations"] = violations
            summary["policyFlagIds"] = outcome.get("flagIds") or []
            emit("")
            emit("Policy Under Delegation:")
            emit(f"  violations={','.join(violations) or 'none'}")
            emit(f"  flags={len(summary['policyFlagIds'])}")
            if not violations or not summary["policyFlagIds"]:
                raise BondApiError(
                    "INVALID_ACTIVITY_INPUT",
                    "Policy violation under delegation produced no "
                    "violations/flags.",
                    0,
                    None,
                )
            emit("")
            emit("Enforcement:")
            emit("  not-applicable (delegation findings are advisory)")
            return summary
        finally:
            revoked_all = True
            for agent_id, credential_id in (
                (agent_a_id, cred_a),
                (agent_b_id, cred_b),
            ):
                try:
                    self._client.revoke_agent_credential(
                        agent_id, credential_id
                    )
                except Exception:
                    revoked_all = False
            summary["credentialRevoked"] = revoked_all

    def _run_providers(
        self,
        emit: EmitFn,
        summary: dict[str, Any],
        agent_id: str,
        agent_client: BondAgentClient,
    ) -> None:
        """Deterministic provider/framework integration (Phase 24).

        All provider responses below are synthetic literals — no API
        keys, no network calls, no provider SDKs. Steps: allowed
        OpenAI call (success) → disallowed Anthropic call (provider
        + model violation) → token overuse (limit violation) →
        framework-adapter call (success). Costs are estimates only.
        """
        created = self._client.create_agent_policy(
            agent_id,
            {
                "allowedProviders": ["openai"],
                "allowedModels": ["gpt-4o"],
                "maxInputTokens": 100000,
            },
        )
        summary["policyId"] = created["policyId"]
        summary["policyVersion"] = created["version"]
        emit("")
        emit("Policy:")
        emit(f"  id: {created['policyId']}")
        emit(f"  version: {created['version']}")

        # Demo-authorized actions/tools: the caller context permits
        # the integration shapes; the persisted server policy above
        # governs provider/model/token limits.
        policy_context = ActivityPolicyContext(
            policy_version=POLICY_VERSION,
            allowed_actions=("model-invocation", "research-assistant"),
            declared_tools=("transfers", "research-assistant"),
            spend_limit_minor_units=SPEND_LIMIT,
        )

        def submit(label: str, payload: dict[str, Any]) -> dict[str, Any]:
            outcome = agent_client.analyze_activity(agent_id, payload)
            decision = outcome.get("policy") or {}
            violations = [
                str(v.get("ruleId"))
                for v in (decision.get("violations") or [])
                if isinstance(v, dict)
            ]
            emit(
                f"  {label}: allowed={decision.get('allowed')} "
                f"violations={','.join(violations) or 'none'} "
                f"flags={len(outcome.get('flagIds') or [])}"
            )
            return {
                "allowed": decision.get("allowed"),
                "violations": violations,
                "flags": outcome.get("flagIds") or [],
                "attribution": outcome.get("attribution") or {},
            }

        emit("")
        emit("Provider Sequence:")
        results: dict[str, dict[str, Any]] = {}

        openai_usage = normalize_openai_usage(
            {
                "model": "gpt-4o",
                "id": "chatcmpl-demo-1",
                "usage": {
                    "prompt_tokens": 120,
                    "completion_tokens": 80,
                    "total_tokens": 200,
                },
            }
        )
        results["allowed-openai"] = submit(
            "allowed-openai",
            build_model_activity(
                agent_id,
                openai_usage,
                policy_context,
                occurred_at=FIXED_OCCURRED_AT,
            ),
        )

        anthropic_usage = normalize_anthropic_usage(
            {
                "model": "claude-sonnet-4",
                "usage": {"input_tokens": 50, "output_tokens": 60},
            }
        )
        results["denied-anthropic"] = submit(
            "denied-anthropic",
            build_model_activity(
                agent_id,
                anthropic_usage,
                policy_context,
                occurred_at=FIXED_OCCURRED_AT,
            ),
        )

        heavy_usage = normalize_openai_usage(
            {
                "model": "gpt-4o",
                "usage": {
                    "prompt_tokens": 150000,
                    "completion_tokens": 1000,
                    "total_tokens": 151000,
                },
            }
        )
        results["token-overuse"] = submit(
            "token-overuse",
            build_model_activity(
                agent_id,
                heavy_usage,
                policy_context,
                occurred_at=FIXED_OCCURRED_AT,
            ),
        )

        framework = GenericFrameworkAdapter(agent_id, policy_context)
        framework_activity = framework.describe_event(
            action_type="tool-call",
            action="research-assistant",
            tool="research-assistant",
            text_snippet="synthetic framework output summary",
            usage=openai_usage,
            occurred_at=FIXED_OCCURRED_AT,
        ).to_dict()
        framework_result = submit("framework-adapter", framework_activity)
        results["framework-adapter"] = framework_result

        summary["providerResults"] = {
            name: {
                "allowed": result["allowed"],
                "violations": result["violations"],
            }
            for name, result in results.items()
        }
        checks = [
            (
                results["allowed-openai"]["allowed"] is True
                and not results["allowed-openai"]["violations"]
                and not results["allowed-openai"]["flags"],
                "allowed OpenAI call must succeed cleanly",
            ),
            (
                "policy-provider-denied"
                in results["denied-anthropic"]["violations"]
                and results["denied-anthropic"]["flags"],
                "disallowed provider must violate and flag",
            ),
            (
                "policy-input-token-limit"
                in results["token-overuse"]["violations"]
                and results["token-overuse"]["flags"],
                "token overuse must violate and flag",
            ),
            (
                results["framework-adapter"]["allowed"] is True
                and not results["framework-adapter"]["violations"],
                "framework adapter call must pass policy",
            ),
        ]
        for passed, message in checks:
            if not passed:
                raise BondApiError(
                    "INVALID_ACTIVITY_INPUT",
                    f"Providers scenario failed: {message}.",
                    0,
                    None,
                )
        framework_flags = results["framework-adapter"]["flags"]
        emit("")
        emit("Behavioral Note:")
        if framework_flags:
            rule_ids = sorted(
                {
                    str(flag_id).split("-", 2)[-1]
                    for flag_id in framework_flags
                }
            )
            emit(
                f"  advisory behavioral flag(s): {','.join(rule_ids)} "
                f"(first-seen tool novelty, expected)"
            )
        else:
            emit("  no behavioral flags")
        attribution = results["allowed-openai"].get("attribution", {})
        summary["attribution"] = {
            "requesterAgentId": attribution.get("requesterAgentId", agent_id),
            "executorAgentId": agent_id,
            "delegationId": None,
        }
        emit("")
        emit("Attribution:")
        emit(f"  executor={agent_id} (self, no delegation)")

    def _issue_agent_credential(
        self, agent_id: str, capabilities: list[str] | None = None
    ) -> tuple[BondAgentClient, str]:
        """Operator creates a credential; agent acts through BondAgentClient."""
        extra = {} if capabilities is None else {"capabilities": capabilities}
        created = self._client.create_agent_credential(agent_id, **extra)
        metadata = created["metadata"]
        secret = created["secret"]
        credential_id = metadata["credentialId"]
        client = self._agent_client_factory(
            self._config.api_url, f"{credential_id}.{secret}"
        )
        return client, credential_id

    def _revoke_agent_credential(
        self,
        summary: dict[str, Any],
        emit: EmitFn,
        agent_id: str,
        credential_id: str,
    ) -> None:
        try:
            self._client.revoke_agent_credential(agent_id, credential_id)
            summary["credentialRevoked"] = True
        except Exception:
            # Revocation is hygiene, not correctness: the credential was
            # already exercised and the run result stands regardless.
            summary["credentialRevoked"] = False

    def _report_benign(
        self, summary: dict[str, Any], emit: EmitFn
    ) -> None:
        if summary["flags"]:
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                f"Benign scenario produced {len(summary['flags'])} "
                "unexpected flags.",
                0,
                None,
            )
        emit("")
        emit("Risk Findings:")
        emit("  none — No confirmed findings were returned for this analysis.")

    def _report_risky(
        self, summary: dict[str, Any], emit: EmitFn, agent_id: str
    ) -> None:
        if not summary["flags"]:
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                "Risky scenario produced no flags; expected findings.",
                0,
                None,
            )
        emit("")
        emit("Risk Findings:")
        for flag in summary["flags"]:
            emit(
                f"  - {flag.get('riskFlagId')}: "
                f"{flag.get('category')} / {flag.get('severity')}"
            )
        self._attest_and_enforce(summary, emit, agent_id)

    def _attest_and_enforce(
        self, summary: dict[str, Any], emit: EmitFn, agent_id: str
    ) -> None:
        # Bond required for enforcement (genuine local operation).
        bond_id = self._ensure_bond(agent_id)
        summary["bondId"] = bond_id

        # Two independent demo attestors with per-run identities and
        # fresh secrets (server rejects re-registration of an existing
        # attestor id, and only the current secret authenticates verdicts,
        # so reruns must not reuse attestor ids).
        run_suffix = token_hex(4)
        secrets = [token_hex(16), token_hex(16)]
        attestor_ids: list[str] = []
        for index, secret in enumerate(secrets, start=1):
            created = self._client.register_attestor(
                attestor_id=f"ai-demo-attestor-{index}-{run_suffix}",
                organization="ai-demo-org",
                secret=secret,
            )
            attestor_ids.append(created["attestorId"])

        flag_id = summary["flags"][0]["riskFlagId"]
        expires_at = (
            datetime.now(timezone.utc) + timedelta(hours=1)
        ).isoformat()
        requested = self._client.request_attestation(
            flag_id=flag_id,
            attestor_ids=attestor_ids,
            threshold=2,
            expires_at=expires_at,
        )
        attestation_id = requested["attestationId"]
        summary["attestationId"] = attestation_id

        for attestor_id, secret in zip(attestor_ids, secrets):
            self._client.submit_verdict(
                attestation_id,
                attestor_id=attestor_id,
                verdict="confirm",
                secret=secret,
            )
        attestation = self._client.get_attestation(attestation_id)
        summary["quorum"] = attestation.get("status", "unknown")
        if summary["quorum"] != "quorum-met":
            raise BondApiError(
                "INVALID_ATTESTATION",
                f"Quorum not met (status: {summary['quorum']}).",
                0,
                None,
            )

        decision = self._client.issue_decision(
            attestation_id, action="partial-slash"
        )
        summary["decision"] = decision.get("action")

        emit("")
        emit("Attestation:")
        emit(f"  id: {attestation_id}")
        emit(f"  quorum: {summary['quorum']}")
        emit("")
        emit("Decision:")
        emit(f"  action: {summary['decision']}")

        enforced = self._client.enforce_attestation(
            attestation_id, amount_minor_units="1000"
        )
        summary["transactionId"] = enforced.get("transactionId")
        tx = self._client.get_transaction(summary["transactionId"])
        summary["transactionStatus"] = tx.get("status", "unknown")
        # SIMULATED boundary: the reference below is an adapter receipt,
        # never a blockchain confirmation.
        summary["enforcement"] = "SIMULATED"

        emit("")
        emit("Transaction:")
        emit(f"  id: {summary['transactionId']}")
        emit(f"  status: {summary['transactionStatus']}")

        self._release_bond(summary, emit, bond_id)

    def _ensure_bond(self, agent_id: str) -> str | None:
        try:
            bond = self._client.create_bond(
                agent_id=agent_id, commitment_minor_units="10000"
            )
            bond_id = bond["bondId"]
        except BondApiError as exc:
            # Rerun path: a live bond already exists, or the agent has
            # moved past REGISTERED. Release/withdraw then proceeds only
            # if a bond handle is available; enforcement reports BLOCKED
            # otherwise — never fabricated.
            if "live bond" in exc.message or "REGISTERED" in exc.message:
                return None
            raise
        for status in ("PENDING", "ACTIVE"):
            self._client.set_bond_status(bond_id, status)
        return bond_id

    def _release_bond(
        self, summary: dict[str, Any], emit: EmitFn, bond_id: str | None
    ) -> None:
        if bond_id is None:
            summary["release"] = "skipped (no bond handle this run)"
            emit("")
            emit("Release:")
            emit(f"  {summary['release']}")
            return
        bond = self._client.get_bond(bond_id)
        if bond.get("status") in ("ACTIVE", "LOCKED", "PARTIALLY_SLASHED"):
            released = self._client.set_bond_status(bond_id, "WITHDRAWABLE")
            summary["release"] = released.get("status", "WITHDRAWABLE")
        else:
            summary["release"] = (
                f"skipped (bond status {bond.get('status')})"
            )
        emit("")
        emit("Release:")
        emit(f"  {summary['release']}")

    def _register(self, external_ref: str) -> dict[str, Any]:
        # Delegated setup: the operator mints a single-use registration
        # grant; registration itself is performed presenting the grant
        # bearer, never the operator token.
        grant = self._client.create_setup_grant(scopes=["agent:register"])
        grant_client = self._grant_client_factory(
            self._config.api_url,
            f"{grant['metadata']['grantId']}.{grant['secret']}",
        )
        try:
            return grant_client.register_agent(
                platform="bond-demo",
                agent_type="custom",
                capabilities=["demo-messaging", "demo-tool-use"],
                external_ref=external_ref,
            )
        except BondApiError as exc:
            # Rerun path: the deterministic triple already exists.
            if (
                exc.code == "INVALID_IDENTIFIER"
                and "already registered" in exc.message
            ):
                agents = self._client.list_agents(limit=100) or []
                for row in agents:
                    if (
                        isinstance(row, dict)
                        and row.get("externalRef") == external_ref
                    ):
                        return row
            raise
        finally:
            grant_client.close()


def _select_model(config: AIDemoConfig) -> ModelProvider:
    if config.mode in ("", "scripted"):
        return ScriptedModelProvider(config.scenario)
    if config.mode == "live-model":
        return EnvModelProvider(
            os.environ.get("BOND_MODEL_PROVIDER"),
            os.environ.get("BOND_MODEL_API_KEY"),
        )
    raise BondApiError(
        "INVALID_IDENTIFIER",
        f"Unknown BOND_DEMO_MODE: {config.mode}.",
        0,
        None,
    )


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns process exit code (0 ok, 1 failure)."""
    del argv
    client: BondClient | None = None
    try:
        config = AIDemoConfig.from_env()
        if config.scenario not in ("benign", "risky", "behavioral", "reputation", "policy", "delegation", "providers"):
            raise BondApiError(
                "INVALID_IDENTIFIER",
                f"Unknown BOND_DEMO_SCENARIO: {config.scenario}.",
                0,
                None,
            )
        model = _select_model(config)
        if config.mode == "live-model":
            # Probe now so misconfiguration fails before any BOND state.
            model.generate("ping", {})
        client = BondClient(base_url=config.api_url)
        AIAgent(config, client, model).run()
        return 0
    except BondApiError as exc:
        print(f"demo failed: {exc.code}: {exc.message}", file=sys.stderr)
        return 1
    except Exception as exc:  # never leak internals beyond a message
        print(f"demo failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
