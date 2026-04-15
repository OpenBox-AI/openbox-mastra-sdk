import {
  type OpenBoxEventMetadata,
  getOpenBoxExecutionContext,
  mergeOpenBoxEventMetadata,
  runWithOpenBoxExecutionContext
} from "../governance/context.js";

const OPENBOX_ACTIVITY_METADATA = Symbol.for("openbox.mastra.activityMetadata");

export interface OpenBoxActivityMetadataResolverParams {
  getInitData?: <T>() => T;
  inputData: unknown;
  runId?: string | undefined;
  state?: unknown;
  workflowId?: string | undefined;
  [key: string]: unknown;
}

export type OpenBoxActivityMetadataResolver =
  (params: OpenBoxActivityMetadataResolverParams) =>
    | OpenBoxEventMetadata
    | undefined;

export type OpenBoxActivityMetadata =
  | OpenBoxEventMetadata
  | OpenBoxActivityMetadataResolver;

type OpenBoxMetadataCarrier = Record<PropertyKey, unknown> & {
  [OPENBOX_ACTIVITY_METADATA]?: OpenBoxActivityMetadata | undefined;
};

export function withOpenBoxActivityMetadata<TStep extends object>(
  step: TStep,
  metadata: OpenBoxActivityMetadata
): TStep {
  Object.defineProperty(step as OpenBoxMetadataCarrier, OPENBOX_ACTIVITY_METADATA, {
    enumerable: false,
    value: metadata
  });

  return step;
}

export function resolveOpenBoxActivityMetadata(
  step: object,
  params: OpenBoxActivityMetadataResolverParams
): OpenBoxEventMetadata | undefined {
  const metadataCarrier = step as OpenBoxMetadataCarrier;

  const storedMetadata = metadataCarrier[OPENBOX_ACTIVITY_METADATA];

  if (!storedMetadata) {
    return undefined;
  }

  const resolved =
    typeof storedMetadata === "function"
      ? storedMetadata(params)
      : storedMetadata;

  return resolved ? mergeOpenBoxEventMetadata(undefined, resolved) : undefined;
}

export function getOpenBoxEventMetadata():
  | OpenBoxEventMetadata
  | undefined {
  return getOpenBoxExecutionContext()?.metadata;
}

export async function runWithOpenBoxEventMetadata<T>(
  metadata: OpenBoxEventMetadata | undefined,
  callback: () => Promise<T>
): Promise<T> {
  if (!metadata) {
    return callback();
  }

  return runWithOpenBoxExecutionContext(
    {
      metadata
    },
    callback
  );
}
