/**
 * Compat wrapper: the base SDK (`@openbox-ai/openbox-sdk`) owns verdict values
 * and priority/parsing behavior. This module re-exports base's free-function
 * API as Mastra's historical `Verdict.xxx()` static-object shape so existing
 * call sites across `governance/`, `mastra/`, and `otel/` keep compiling
 * unchanged. Base wins on behavior — this file adds no logic of its own.
 */
import {
  Verdict as BaseVerdictValues,
  highestPriorityVerdict,
  verdictFromString,
  verdictPriority,
  verdictRequiresApproval,
  verdictShouldStop,
  type Verdict as BaseVerdict
} from "@openbox-ai/openbox-sdk";

export type Verdict = BaseVerdict;

export const Verdict = Object.freeze({
  ...BaseVerdictValues,
  fromString(value?: string | null): Verdict {
    return verdictFromString(value ?? null);
  },
  highestPriority(verdicts: Verdict[]): Verdict {
    return highestPriorityVerdict(verdicts);
  },
  priorityOf(verdict: Verdict): number {
    return verdictPriority(verdict);
  },
  requiresApproval(verdict: Verdict): boolean {
    return verdictRequiresApproval(verdict);
  },
  shouldStop(verdict: Verdict): boolean {
    return verdictShouldStop(verdict);
  }
});
