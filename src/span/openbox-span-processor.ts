import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor
} from "@opentelemetry/sdk-trace-base";

import type { WorkflowSpanBuffer } from "../types/index.js";
import { type Verdict } from "../types/index.js";

export interface StoredSpanBody {
  requestBody?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  responseBody?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
}

export interface StoredWorkflowVerdict {
  reason?: string | undefined;
  runId?: string | undefined;
  verdict: Verdict;
}

export interface OpenBoxSpanData {
  activityId?: string | undefined;
  attributes: Record<string, unknown>;
  durationNs?: number | undefined;
  endTime?: number | undefined;
  events: Array<{
    attributes: Record<string, unknown>;
    name: string;
    timestamp: number;
  }>;
  kind?: string | undefined;
  name: string;
  parentSpanId?: string | undefined;
  requestBody?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  responseBody?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  spanId: string;
  startTime?: number | undefined;
  status?: {
    code: string;
    description?: string | undefined;
  } | undefined;
  traceId: string;
}

export interface OpenBoxSpanProcessorOptions {
  fallbackProcessor?: {
    forceFlush: (timeoutMillis?: number) => Promise<void> | void | boolean;
    onEnd: (span: ReadableSpan) => void;
    shutdown: () => Promise<void> | void;
  };
  ignoredUrlPrefixes?: string[] | undefined;
}

type SpanLike = Pick<
  ReadableSpan,
  | "attributes"
  | "endTime"
  | "events"
  | "kind"
  | "name"
  | "parentSpanContext"
  | "startTime"
> & {
  context: {
    spanId?: number;
    traceId?: number;
    span_id?: number;
    trace_id?: number;
  } | undefined;
  spanContext?: (() => {
    spanId: string;
    traceId: string;
  }) | undefined;
  status?: {
    description?: string;
    statusCode?: { name?: string } | { name: string } | number;
    status_code?: { name?: string } | { name: string } | number;
  };
};

export class OpenBoxSpanProcessor implements SpanProcessor {
  readonly #bodyData = new Map<string, StoredSpanBody>();
  readonly #buffers = new Map<string, WorkflowSpanBuffer>();
  readonly #ignoredUrlPrefixes: Set<string>;
  readonly #traceToActivity = new Map<string, string>();
  readonly #traceToWorkflow = new Map<string, string>();
  readonly #verdicts = new Map<string, StoredWorkflowVerdict>();

  public readonly fallbackProcessor?: OpenBoxSpanProcessorOptions["fallbackProcessor"];

  public constructor({
    fallbackProcessor,
    ignoredUrlPrefixes
  }: OpenBoxSpanProcessorOptions = {}) {
    this.fallbackProcessor = fallbackProcessor;
    this.#ignoredUrlPrefixes = new Set(ignoredUrlPrefixes ?? []);
  }

  public registerWorkflow(workflowId: string, buffer: WorkflowSpanBuffer): void {
    this.#buffers.set(workflowId, buffer);
  }

  public registerTrace(
    traceId: number | string,
    workflowId: string,
    activityId?: string
  ): void {
    const normalizedTraceId = normalizeHexId(traceId, 32);

    this.#traceToWorkflow.set(normalizedTraceId, workflowId);

    if (activityId) {
      this.#traceToActivity.set(normalizedTraceId, activityId);
    }
  }

  public getBuffer(workflowId: string): WorkflowSpanBuffer | undefined {
    return this.#buffers.get(workflowId);
  }

  public removeBuffer(workflowId: string): WorkflowSpanBuffer | undefined {
    const buffer = this.#buffers.get(workflowId);
    this.#buffers.delete(workflowId);

    return buffer;
  }

  public unregisterWorkflow(workflowId: string): void {
    this.#buffers.delete(workflowId);
    this.#verdicts.delete(workflowId);
  }

  public setVerdict(
    workflowId: string,
    verdict: Verdict,
    reason?: string,
    runId?: string
  ): void {
    this.#verdicts.set(workflowId, { reason, runId, verdict });

    const buffer = this.#buffers.get(workflowId);

    if (buffer) {
      buffer.verdict = verdict;
      buffer.verdictReason = reason;
    }
  }

  public getVerdict(workflowId: string): StoredWorkflowVerdict | undefined {
    return this.#verdicts.get(workflowId);
  }

  public clearVerdict(workflowId: string): void {
    this.#verdicts.delete(workflowId);
  }

  public storeBody(spanId: number | string, body: StoredSpanBody): void {
    const normalizedSpanId = normalizeHexId(spanId, 16);
    const current = this.#bodyData.get(normalizedSpanId) ?? {};
    this.#bodyData.set(normalizedSpanId, {
      ...current,
      ...body
    });
  }

  public getPendingBody(spanId: number | string): StoredSpanBody | undefined {
    return this.#bodyData.get(normalizeHexId(spanId, 16));
  }

  public onStart(span: ReadableSpan, parentContext: Context): void {
    const spanLike = span as unknown as SpanLike;
    this.#registerCorrelation(spanLike);
    void parentContext;
  }

  public onEnd(span: ReadableSpan): void {
    const spanLike = span as unknown as SpanLike;

    if (this.#shouldIgnoreSpan(spanLike)) {
      this.fallbackProcessor?.onEnd(span);
      return;
    }

    this.#registerCorrelation(spanLike);

    const traceId = getTraceId(spanLike);
    const spanId = getSpanId(spanLike);
    const attributes = toRecord(spanLike.attributes);
    const workflowId =
      toStringAttribute(attributes["openbox.workflow_id"]) ??
      (traceId != null ? this.#traceToWorkflow.get(traceId) : undefined);
    const activityId =
      toStringAttribute(attributes["openbox.activity_id"]) ??
      (traceId != null ? this.#traceToActivity.get(traceId) : undefined);

    if (workflowId) {
      const buffer = this.#buffers.get(workflowId);

      if (buffer) {
        const spanData = this.extractSpanData(span);

        if (activityId) {
          spanData.activityId = activityId;
        }

        if (spanId != null) {
          const body = this.#bodyData.get(spanId);

          if (body) {
            spanData.requestBody = body.requestBody;
            spanData.responseBody = body.responseBody;
            spanData.requestHeaders = body.requestHeaders;
            spanData.responseHeaders = body.responseHeaders;
            this.#bodyData.delete(spanId);
          }
        }

        buffer.spans.push(spanData as unknown as Record<string, unknown>);
      }
    }

    this.fallbackProcessor?.onEnd(span);
  }

  public async shutdown(): Promise<void> {
    await this.fallbackProcessor?.shutdown();
  }

  public async forceFlush(timeoutMillis = 30_000): Promise<void> {
    await this.fallbackProcessor?.forceFlush(timeoutMillis);
  }

  public extractSpanData(span: ReadableSpan): OpenBoxSpanData {
    const spanLike = span as unknown as SpanLike;
    const traceId = getTraceId(spanLike) ?? "0";
    const spanId = getSpanId(spanLike) ?? "0";
    const parentSpanId = getParentSpanId(spanLike);
    const events = (spanLike.events ?? []).map(event => ({
      attributes: toRecord(event.attributes),
      name: event.name,
      timestamp: hrTimeToNanoseconds(
        (event as { time?: [number, number] | number; timestamp?: [number, number] | number }).time ??
          (event as { timestamp?: [number, number] | number }).timestamp
      ) ?? 0
    }));
    const statusCode =
      getStatusCodeName(spanLike.status?.statusCode) ??
      getStatusCodeName(spanLike.status?.status_code);
    const startTime = hrTimeToNanoseconds(spanLike.startTime);
    const endTime = hrTimeToNanoseconds(spanLike.endTime);

    return {
      attributes: toRecord(spanLike.attributes),
      durationNs:
        startTime != null && endTime != null ? endTime - startTime : undefined,
      endTime,
      events,
      kind: getSpanKindName(spanLike.kind),
      name: spanLike.name,
      parentSpanId,
      spanId,
      startTime,
      status: statusCode
        ? {
            code: statusCode,
            description: spanLike.status?.description
          }
        : undefined,
      traceId
    };
  }

  #shouldIgnoreSpan(span: SpanLike): boolean {
    const url = toStringAttribute(toRecord(span.attributes)["http.url"]);

    if (!url) {
      return false;
    }

    for (const prefix of this.#ignoredUrlPrefixes) {
      if (url.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }

  #registerCorrelation(span: SpanLike): void {
    const traceId = getTraceId(span);

    if (!traceId) {
      return;
    }

    const attributes = toRecord(span.attributes);
    const workflowId = toStringAttribute(attributes["openbox.workflow_id"]);
    const activityId = toStringAttribute(attributes["openbox.activity_id"]);

    if (workflowId) {
      this.#traceToWorkflow.set(traceId, workflowId);
    }

    if (activityId) {
      this.#traceToActivity.set(traceId, activityId);
    }
  }
}

export const WorkflowSpanProcessor = OpenBoxSpanProcessor;

function formatHex(value: number, width: number): string {
  return value.toString(16).padStart(width, "0");
}

function normalizeHexId(value: number | string, width: number): string {
  return typeof value === "string" ? value.padStart(width, "0") : formatHex(value, width);
}

function getParentSpanId(span: SpanLike): string | undefined {
  if (span.parentSpanContext?.spanId) {
    return span.parentSpanContext.spanId.padStart(16, "0");
  }

  return undefined;
}

function getSpanKindName(kind: { name?: string } | number | undefined): string | undefined {
  if (typeof kind === "number") {
    return (
      {
        0: "INTERNAL",
        1: "SERVER",
        2: "CLIENT",
        3: "PRODUCER",
        4: "CONSUMER"
      }[kind] ?? "INTERNAL"
    );
  }

  return kind?.name;
}

function getSpanId(span: SpanLike): string | undefined {
  const fromContext = span.spanContext?.().spanId;

  if (fromContext) {
    return fromContext.padStart(16, "0");
  }

  if (span.context?.spanId != null) {
    return formatHex(span.context.spanId, 16);
  }

  if (span.context?.span_id != null) {
    return formatHex(span.context.span_id, 16);
  }

  return undefined;
}

function getStatusCodeName(
  statusCode: { name?: string } | number | undefined
): string | undefined {
  if (typeof statusCode === "number") {
    return (
      {
        0: "UNSET",
        1: "OK",
        2: "ERROR"
      }[statusCode] ?? "UNSET"
    );
  }

  return statusCode?.name;
}

function getTraceId(span: SpanLike): string | undefined {
  const fromContext = span.spanContext?.().traceId;

  if (fromContext) {
    return fromContext.padStart(32, "0");
  }

  if (span.context?.traceId != null) {
    return formatHex(span.context.traceId, 32);
  }

  if (span.context?.trace_id != null) {
    return formatHex(span.context.trace_id, 32);
  }

  return undefined;
}

function hrTimeToNanoseconds(
  value: [number, number] | number | undefined
): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] * 1_000_000_000 + value[1];
  }

  return undefined;
}

function toRecord(
  value: Record<string, unknown> | undefined
): Record<string, unknown> {
  return value ? { ...value } : {};
}

function toStringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
