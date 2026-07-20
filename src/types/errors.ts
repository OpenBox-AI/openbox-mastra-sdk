/**
 * Error hierarchy — delegated to the base SDK (`@openbox-ai/openbox-sdk`).
 *
 * Base owns the full hierarchy (constructors, `name` assignment via
 * `new.target`, and message-building for `GuardrailsValidationError`). Only
 * two Mastra-specific pieces remain local:
 *  - `ApprovalPendingError`: no base equivalent — Mastra uses it to signal
 *    "still waiting" control flow (workflow-suspend retries), a concept the
 *    base SDK's blocking `ApprovalPoller` does not model.
 *  - `GuardrailsValidationError` re-export: base's constructor takes
 *    `string[] | null` (joins internally); every Mastra call site already
 *    passes one pre-joined message string. `[message]` reproduces the exact
 *    original message text (`[x].join("; ") === x`), so no wrapper is needed
 *    beyond re-exporting the class directly — callers pass the string as-is.
 */
export {
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  ContractError,
  GovernanceAPIError,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxError,
  OpenBoxInsecureURLError,
  OpenBoxNetworkError,
  OpenBoxSigningError,
  extractGovernanceError,
  mapSigningError
} from "@openbox-ai/openbox-sdk";

import { OpenBoxError } from "@openbox-ai/openbox-sdk";

/**
 * Raised while a HITL approval is still outstanding (no base equivalent).
 * Mastra-specific: signals "not yet decided" so callers can suspend/retry
 * instead of failing the operation outright.
 */
export class ApprovalPendingError extends OpenBoxError {}
