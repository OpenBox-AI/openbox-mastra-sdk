import {
  runWithOpenBoxExecutionContext,
  type OpenBoxEventMetadata
} from "../governance/context.js";

const OPENBOX_ACTIVITY_METADATA = Symbol.for(
  "openbox.mastra.activityMetadata"
);

export type OpenBoxActivityMetadataResolver<TParams = unknown> =
  | OpenBoxEventMetadata
  | ((params: TParams) => OpenBoxEventMetadata | undefined);

export function withOpenBoxActivityMetadata<TStep>(
  step: TStep,
  metadata: OpenBoxActivityMetadataResolver
): TStep {
  Object.defineProperty(step as object, OPENBOX_ACTIVITY_METADATA, {
    configurable: true,
    enumerable: false,
    value: metadata
  });

  return step;
}

export function resolveOpenBoxActivityMetadata<TParams>(
  step: unknown,
  params: TParams
): OpenBoxEventMetadata | undefined {
  const metadata = (step as Record<PropertyKey, unknown>)[
    OPENBOX_ACTIVITY_METADATA
  ] as OpenBoxActivityMetadataResolver<TParams> | undefined;

  if (!metadata) {
    return undefined;
  }

  if (typeof metadata === "function") {
    return metadata(params);
  }

  return metadata;
}

export async function runWithOpenBoxEventMetadata<T>(
  metadata: OpenBoxEventMetadata | undefined,
  callback: () => Promise<T>
): Promise<T> {
  return runWithOpenBoxExecutionContext(
    metadata ? { metadata } : {},
    callback
  );
}
