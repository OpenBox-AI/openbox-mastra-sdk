import { EvaluationResult } from "@openbox-ai/openbox-sdk";

import {
  GuardrailsCheckResult,
  type GuardrailReason
} from "./guardrails.js";
import { Verdict } from "./verdict.js";

export interface GovernanceVerdictResponseInit {
  alignmentScore?: number | undefined;
  approvalId?: string | undefined;
  behavioralViolations?: string[] | undefined;
  constraints?: Record<string, unknown>[] | undefined;
  governanceEventId?: string | undefined;
  guardrailsResult?: GuardrailsCheckResult | undefined;
  metadata?: Record<string, unknown> | undefined;
  policyId?: string | undefined;
  reason?: string | undefined;
  riskScore?: number | undefined;
  trustTier?: string | undefined;
  verdict: Verdict;
}

type GovernanceVerdictResponseWire = {
  action?: string;
  alignment_score?: number;
  approval_id?: string;
  behavioral_violations?: string[];
  constraints?: Record<string, unknown>[];
  governance_event_id?: string;
  guardrails_result?: {
    input_type?: string;
    raw_logs?: Record<string, unknown>;
    reasons?: GuardrailReason[] | null;
    redacted_input: unknown;
    validation_passed?: boolean;
  } | null;
  metadata?: Record<string, unknown>;
  policy_id?: string;
  reason?: string;
  risk_score?: number;
  trust_tier?: string;
  verdict?: string;
};

/**
 * Mastra's DTO shape for a governance verdict — kept as a constructor-based
 * class (many call sites do `new GovernanceVerdictResponse({...})` or an
 * object-literal `as GovernanceVerdictResponse` cast) so the public API and
 * every internal consumer keep compiling unchanged.
 *
 * `fromObject` DELEGATES the actual wire-parsing behavior to base's
 * `EvaluationResult.fromDict` (verdict-first, action-fallback, guardrails
 * parsing) rather than re-implementing it — base wins on conflict. This is a
 * genuine behavior fix carried over from base: the old local parser did
 * `Verdict.fromString(data.verdict ?? data.action ?? "continue")`, where `??`
 * does NOT fall through on an empty string, so `{verdict:"", action:"stop"}`
 * incorrectly resolved to ALLOW; base's parser checks `verdict.trim()` before
 * preferring it over `action`. See migration-notes.md ("verdict priority +
 * application").
 */
export class GovernanceVerdictResponse {
  public readonly alignmentScore: number | undefined;
  public readonly approvalId: string | undefined;
  public readonly behavioralViolations: string[] | undefined;
  public readonly constraints: Record<string, unknown>[] | undefined;
  public readonly governanceEventId: string | undefined;
  public readonly guardrailsResult: GuardrailsCheckResult | undefined;
  public readonly metadata: Record<string, unknown> | undefined;
  public readonly policyId: string | undefined;
  public readonly reason: string | undefined;
  public readonly riskScore: number;
  public readonly trustTier: string | undefined;
  public readonly verdict: Verdict;

  public constructor({
    alignmentScore,
    approvalId,
    behavioralViolations,
    constraints,
    governanceEventId,
    guardrailsResult,
    metadata,
    policyId,
    reason,
    riskScore = 0,
    trustTier,
    verdict
  }: GovernanceVerdictResponseInit) {
    this.alignmentScore = alignmentScore;
    this.approvalId = approvalId;
    this.behavioralViolations = behavioralViolations;
    this.constraints = constraints;
    this.governanceEventId = governanceEventId;
    this.guardrailsResult = guardrailsResult;
    this.metadata = metadata;
    this.policyId = policyId;
    this.reason = reason;
    this.riskScore = riskScore;
    this.trustTier = trustTier;
    this.verdict = verdict;
  }

  public get action(): string {
    if (this.verdict === Verdict.ALLOW) {
      return "continue";
    }

    if (this.verdict === Verdict.HALT) {
      return "stop";
    }

    if (this.verdict === Verdict.REQUIRE_APPROVAL) {
      return "require-approval";
    }

    return this.verdict;
  }

  public static fromObject(
    data: GovernanceVerdictResponseWire
  ): GovernanceVerdictResponse {
    const base = EvaluationResult.fromDict(data as Record<string, unknown>);
    const guardrailsResult = base.guardrails
      ? new GuardrailsCheckResult({
          inputType: base.guardrails.inputType,
          rawLogs: base.guardrails.rawLogs ?? undefined,
          reasons: base.guardrails.reasons as GuardrailReason[],
          redactedInput: base.guardrails.redactedInput,
          validationPassed: base.guardrails.validationPassed
        })
      : undefined;

    return new GovernanceVerdictResponse({
      alignmentScore: base.alignmentScore ?? undefined,
      approvalId: base.approvalId ?? undefined,
      behavioralViolations: base.behavioralViolations ?? undefined,
      constraints: base.constraints ?? undefined,
      governanceEventId: base.governanceEventId ?? undefined,
      guardrailsResult,
      metadata: base.metadata ?? undefined,
      policyId: base.policyId ?? undefined,
      reason: base.reason ?? undefined,
      riskScore: base.riskScore,
      trustTier: base.trustTier ?? undefined,
      verdict: base.verdict
    });
  }
}
