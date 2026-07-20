/**
 * Guards against silent drift between Mastra's locally-kept validation
 * primitives and the base SDK's (`@openbox-ai/openbox-sdk`) equivalent
 * behavior. Both `API_KEY_PATTERN` (config/openbox-config.ts) and the
 * approval-decision vocabulary (client/openbox-client.ts) are kept as local
 * copies — base does not export either the raw regex or its approval-decision
 * `Set` standalone — so a manual edit to one side alone would otherwise go
 * unnoticed until a real key/approval payload disagreed in production.
 *
 * Since the underlying constants aren't exported, this asserts BEHAVIORAL
 * parity: the same representative inputs must classify identically on both
 * sides.
 */
import { ApprovalResult } from "@openbox-ai/openbox-sdk";
import { OpenBoxConfig as BaseOpenBoxConfig } from "@openbox-ai/openbox-sdk/config";

import {
  API_KEY_PATTERN,
  parseApprovalDecision,
  validateApiKeyFormat,
  Verdict,
  type ApprovalPollResponse
} from "../../src/index.js";

/** Whether base's `OpenBoxConfig.resolve()` accepts `apiKey` (isolates the API-key-format check — apiUrl is fixed/valid and no identity fields are set). */
function acceptedByBaseConfig(apiKey: string): boolean {
  try {
    BaseOpenBoxConfig.resolve({
      apiKey,
      apiUrl: "https://api.openbox.ai",
      environ: {}
    });
    return true;
  } catch {
    return false;
  }
}

const API_KEY_PARITY_CASES = [
  "obx_live_abc123",
  "obx_test_ABC_123",
  "obx_live_a",
  "obx_test_snake_case_key_1",
  "obx_live_",
  "obx_test_",
  "obx_prod_abc123",
  "OBX_LIVE_abc123",
  "obx_live_abc-123",
  "obx_live_abc.123",
  "obx_test_abc 123",
  "not-a-key",
  "",
  "obx_test_日本語"
];

describe("API key pattern drift parity vs base SDK", () => {
  it.each(API_KEY_PARITY_CASES)(
    "Mastra's API_KEY_PATTERN/validateApiKeyFormat agrees with base's OpenBoxConfig.resolve() for %j",
    key => {
      const expected = acceptedByBaseConfig(key);

      expect(validateApiKeyFormat(key)).toBe(expected);
      expect(API_KEY_PATTERN.test(key)).toBe(expected);
    }
  );
});

type ApprovalDecisionCase = Pick<ApprovalPollResponse, "action" | "verdict">;

const APPROVAL_DECISION_PARITY_CASES: ApprovalDecisionCase[] = [
  { action: "allow" },
  { action: "ALLOW" },
  { action: "Block" },
  { action: "halt" },
  { action: "continue" },
  { action: "stop" },
  { action: "require-approval" },
  { action: "request_approval" },
  { action: "constrain" },
  { action: "", verdict: "allow" },
  { action: "  ", verdict: "block" },
  { verdict: "halt" },
  { verdict: "require_approval" },
  { action: "banana", verdict: "allow" },
  { verdict: "banana" },
  {}
];

describe("approval decision vocabulary drift parity vs base SDK", () => {
  it.each(APPROVAL_DECISION_PARITY_CASES)(
    "Mastra's parseApprovalDecision agrees with base's ApprovalResult.fromDict for %j",
    input => {
      const baseVerdict = ApprovalResult.fromDict(
        input as Record<string, unknown>
      ).verdict;
      const mastraVerdict = parseApprovalDecision(input);

      expect(mastraVerdict).toBe(baseVerdict);
    }
  );

  // Sanity check that the parity cases above actually exercise both
  // ALLOW and a stop-shaped verdict, so this guard cannot pass vacuously.
  it("exercises at least one allow-shaped and one stop-shaped decision", () => {
    const verdicts = APPROVAL_DECISION_PARITY_CASES.map(
      input => parseApprovalDecision(input)
    );

    expect(verdicts).toContain(Verdict.ALLOW);
    expect(verdicts).toContain(Verdict.BLOCK);
  });
});
