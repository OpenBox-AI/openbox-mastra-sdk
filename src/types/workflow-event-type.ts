/**
 * Compat wrapper over base's `EventType` (`@openbox-ai/openbox-sdk`).
 *
 * Base's wire values are identical to Mastra's original `enum
 * WorkflowEventType` (verified byte-for-byte: WorkflowStarted,
 * WorkflowCompleted, WorkflowFailed, SignalReceived, ActivityStarted,
 * ActivityCompleted). Base additionally has `HANDOFF` (A2A), unused by
 * Mastra today and intentionally omitted here to keep the exported member set
 * identical to the original public API.
 *
 * Mastra's original was a string TS `enum` (no reverse mapping for string
 * enums, so nothing is lost) — reshaped here as a const object + union type to
 * source its values from base rather than re-declaring the wire strings
 * locally. All existing `WorkflowEventType.XXX` value/type call sites keep
 * compiling unchanged.
 */
import { EventType } from "@openbox-ai/openbox-sdk";

export const WorkflowEventType = {
  WORKFLOW_STARTED: EventType.WORKFLOW_STARTED,
  WORKFLOW_COMPLETED: EventType.WORKFLOW_COMPLETED,
  WORKFLOW_FAILED: EventType.WORKFLOW_FAILED,
  SIGNAL_RECEIVED: EventType.SIGNAL_RECEIVED,
  ACTIVITY_STARTED: EventType.ACTIVITY_STARTED,
  ACTIVITY_COMPLETED: EventType.ACTIVITY_COMPLETED
} as const;

export type WorkflowEventType =
  (typeof WorkflowEventType)[keyof typeof WorkflowEventType];
