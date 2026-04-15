import { AsyncLocalStorage } from "node:async_hooks";

export type OpenBoxEventMetadata = Record<string, unknown>;

export interface OpenBoxExecutionContext {
  activityId?: string | undefined;
  activityType?: string | undefined;
  agentId?: string | undefined;
  attempt?: number | undefined;
  goal?: string | undefined;
  metadata?: OpenBoxEventMetadata | undefined;
  runId?: string | undefined;
  source?: "agent" | "tool" | "workflow" | undefined;
  taskQueue?: string | undefined;
  workflowId?: string | undefined;
  workflowType?: string | undefined;
}

const executionContextStore = new AsyncLocalStorage<OpenBoxExecutionContext>();

export function getOpenBoxExecutionContext():
  | OpenBoxExecutionContext
  | undefined {
  return executionContextStore.getStore();
}

export function mergeOpenBoxEventMetadata(
  base: OpenBoxEventMetadata | undefined,
  override: OpenBoxEventMetadata | undefined
): OpenBoxEventMetadata | undefined {
  if (!base) {
    return override ? cloneMetadataValue(override) : undefined;
  }

  if (!override) {
    return cloneMetadataValue(base);
  }

  return mergeMetadataObjects(base, override);
}

export async function runWithOpenBoxExecutionContext<T>(
  context: OpenBoxExecutionContext,
  callback: () => Promise<T>
): Promise<T> {
  const activeContext = executionContextStore.getStore();
  const nextContext: OpenBoxExecutionContext = {
    ...(activeContext ?? {}),
    ...context
  };

  nextContext.metadata = mergeOpenBoxEventMetadata(
    activeContext?.metadata,
    context.metadata
  );

  return executionContextStore.run(nextContext, callback);
}

function mergeMetadataObjects(
  base: OpenBoxEventMetadata,
  override: OpenBoxEventMetadata
): OpenBoxEventMetadata {
  const result: OpenBoxEventMetadata = {
    ...cloneMetadataValue(base)
  };

  for (const [key, value] of Object.entries(override)) {
    const currentValue = result[key];

    if (isPlainObject(currentValue) && isPlainObject(value)) {
      result[key] = mergeMetadataObjects(
        currentValue as OpenBoxEventMetadata,
        value as OpenBoxEventMetadata
      );
      continue;
    }

    result[key] = cloneMetadataValue(value);
  }

  return result;
}

function cloneMetadataValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  return structuredClone(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
