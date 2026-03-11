import { randomUUID } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";

import { context, trace } from "@opentelemetry/api";
import type {
  Instrumentation,
  InstrumentationConfig
} from "@opentelemetry/instrumentation";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { OpenBoxApiErrorPolicy, OpenBoxClient } from "../client/index.js";
import { getOpenBoxExecutionContext } from "../governance/context.js";
import { OpenBoxSpanProcessor } from "../span/index.js";
import {
  ApprovalPendingError,
  GovernanceHaltError,
  Verdict,
  WorkflowEventType
} from "../types/index.js";

const DB_INSTRUMENTATION_NAMES = new Map<string, string[]>([
  ["pg", ["@opentelemetry/instrumentation-pg"]],
  ["postgres", ["@opentelemetry/instrumentation-pg"]],
  ["mysql", ["@opentelemetry/instrumentation-mysql"]],
  ["mysql2", ["@opentelemetry/instrumentation-mysql2"]],
  ["mongodb", ["@opentelemetry/instrumentation-mongodb"]],
  ["mongoose", ["@opentelemetry/instrumentation-mongoose"]],
  ["redis", ["@opentelemetry/instrumentation-redis"]],
  ["ioredis", ["@opentelemetry/instrumentation-ioredis"]],
  ["knex", ["@opentelemetry/instrumentation-knex"]],
  ["oracledb", ["@opentelemetry/instrumentation-oracledb"]],
  ["cassandra", ["@opentelemetry/instrumentation-cassandra-driver"]],
  ["tedious", ["@opentelemetry/instrumentation-tedious"]]
]);

const HTTP_INSTRUMENTATION_DEFINITIONS = [
  {
    exportName: "HttpInstrumentation",
    moduleName: "@opentelemetry/instrumentation-http"
  },
  {
    exportName: "UndiciInstrumentation",
    moduleName: "@opentelemetry/instrumentation-undici"
  }
] as const;

const DB_INSTRUMENTATION_DEFINITIONS = new Map<
  string,
  {
    exportName: string;
    moduleName: string;
  }
>([
  [
    "@opentelemetry/instrumentation-pg",
    {
      exportName: "PgInstrumentation",
      moduleName: "@opentelemetry/instrumentation-pg"
    }
  ],
  [
    "@opentelemetry/instrumentation-mysql",
    {
      exportName: "MySQLInstrumentation",
      moduleName: "@opentelemetry/instrumentation-mysql"
    }
  ],
  [
    "@opentelemetry/instrumentation-mysql2",
    {
      exportName: "MySQL2Instrumentation",
      moduleName: "@opentelemetry/instrumentation-mysql2"
    }
  ],
  [
    "@opentelemetry/instrumentation-mongodb",
    {
      exportName: "MongoDBInstrumentation",
      moduleName: "@opentelemetry/instrumentation-mongodb"
    }
  ],
  [
    "@opentelemetry/instrumentation-mongoose",
    {
      exportName: "MongooseInstrumentation",
      moduleName: "@opentelemetry/instrumentation-mongoose"
    }
  ],
  [
    "@opentelemetry/instrumentation-redis",
    {
      exportName: "RedisInstrumentation",
      moduleName: "@opentelemetry/instrumentation-redis"
    }
  ],
  [
    "@opentelemetry/instrumentation-ioredis",
    {
      exportName: "IORedisInstrumentation",
      moduleName: "@opentelemetry/instrumentation-ioredis"
    }
  ],
  [
    "@opentelemetry/instrumentation-knex",
    {
      exportName: "KnexInstrumentation",
      moduleName: "@opentelemetry/instrumentation-knex"
    }
  ],
  [
    "@opentelemetry/instrumentation-oracledb",
    {
      exportName: "OracleInstrumentation",
      moduleName: "@opentelemetry/instrumentation-oracledb"
    }
  ],
  [
    "@opentelemetry/instrumentation-cassandra-driver",
    {
      exportName: "CassandraDriverInstrumentation",
      moduleName: "@opentelemetry/instrumentation-cassandra-driver"
    }
  ],
  [
    "@opentelemetry/instrumentation-tedious",
    {
      exportName: "TediousInstrumentation",
      moduleName: "@opentelemetry/instrumentation-tedious"
    }
  ]
]);

const DEFAULT_FILE_SKIP_PATTERNS = [
  "/dev/",
  "/proc/",
  "/sys/",
  "\\\\?\\pipe\\",
  "__pycache__",
  ".pyc",
  ".pyo",
  ".so",
  ".dylib"
];

const TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded"
];

export interface OpenBoxTelemetryOptions {
  captureHttpBodies?: boolean | undefined;
  dbLibraries?: ReadonlySet<string> | undefined;
  fileSkipPatterns?: string[] | undefined;
  governanceClient?: OpenBoxClient | undefined;
  ignoredUrls?: string[] | undefined;
  instrumentDatabases?: boolean | undefined;
  instrumentFileIo?: boolean | undefined;
  onHookApiError?: OpenBoxApiErrorPolicy | undefined;
  spanProcessor: OpenBoxSpanProcessor;
}

export interface OpenBoxTelemetryController {
  instrumentations: Instrumentation<InstrumentationConfig>[];
  shutdown: () => Promise<void>;
  tracerProvider: NodeTracerProvider;
}

export interface OpenBoxTracedOptions {
  captureArgs?: boolean | undefined;
  captureResult?: boolean | undefined;
  module?: string | undefined;
  name?: string | undefined;
  tracerName?: string | undefined;
}

interface HookGovernanceRuntime {
  client: OpenBoxClient;
  onApiError: OpenBoxApiErrorPolicy;
  spanProcessor: OpenBoxSpanProcessor;
}

type HookSpan = NonNullable<ReturnType<typeof trace.getActiveSpan>> & {
  attributes?: Record<string, unknown>;
  name?: string;
};

const APPROVAL_ABORT_PREFIX = "__openbox_approval__:";

let activeFetchRestore: (() => void) | undefined;
let activeFileRestore: (() => void) | undefined;
let activeHookGovernanceRuntime: HookGovernanceRuntime | undefined;
let activeUnregister: (() => void) | undefined;

export function setupOpenBoxOpenTelemetry({
  captureHttpBodies = true,
  dbLibraries,
  fileSkipPatterns = DEFAULT_FILE_SKIP_PATTERNS,
  governanceClient,
  ignoredUrls = [],
  instrumentDatabases = true,
  instrumentFileIo = false,
  onHookApiError,
  spanProcessor
}: OpenBoxTelemetryOptions): OpenBoxTelemetryController {
  teardownActiveTelemetry();
  const require = createRequire(import.meta.url);
  const { registerInstrumentations } = require(
    "@opentelemetry/instrumentation"
  ) as {
    registerInstrumentations: (options: {
      instrumentations: Instrumentation<InstrumentationConfig>[];
      tracerProvider: NodeTracerProvider;
    }) => () => void;
  };

  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [spanProcessor]
  });

  tracerProvider.register();
  const hookGovernance = governanceClient
    ? {
        client: governanceClient,
        onApiError:
          onHookApiError ?? governanceClient.onApiError ?? "fail_open",
        spanProcessor
      }
    : undefined;
  activeHookGovernanceRuntime = hookGovernance;

  const instrumentations: Instrumentation<InstrumentationConfig>[] = [
    ...selectHttpInstrumentations(ignoredUrls, captureHttpBodies),
    ...selectDatabaseInstrumentations(
      instrumentDatabases,
      dbLibraries,
      hookGovernance
    ),
    ...selectFileInstrumentation(instrumentFileIo, fileSkipPatterns)
  ];

  activeUnregister = registerInstrumentations({
    instrumentations,
    tracerProvider
  });

  if (captureHttpBodies) {
    activeFetchRestore = patchFetch(
      spanProcessor,
      ignoredUrls,
      hookGovernance
    );
  }

  if (instrumentFileIo) {
    activeFileRestore = patchFileIo(fileSkipPatterns, hookGovernance);
  }

  return {
    instrumentations,
    async shutdown() {
      teardownActiveTelemetry();
      await tracerProvider.shutdown();
      disableGlobalTraceApi();
    },
    tracerProvider
  };
}

export function traced<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: OpenBoxTracedOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return async function openBoxTraced(this: unknown, ...args: TArgs): Promise<TResult> {
    const hookGovernance = activeHookGovernanceRuntime;

    if (!hookGovernance) {
      return fn.apply(this, args);
    }

    const functionName = options.name ?? fn.name ?? "anonymous";
    const moduleName = options.module ?? "unknown";
    const tracer = trace.getTracer(options.tracerName ?? "openbox.tracing");

    return tracer.startActiveSpan(`function.${functionName}`, async span => {
      const spanContext = span.spanContext();
      const startTimeNs = Date.now() * 1_000_000;
      span.setAttribute("code.function", functionName);
      span.setAttribute("code.namespace", moduleName);
      let fnStarted = false;

      try {
        await evaluateHookGovernance(hookGovernance, {
          activeSpan: span,
          hookTrigger: {
            attribute_key_identifiers: ["code.function", "code.namespace"],
            ...(options.captureArgs
              ? { args: sanitizeForGovernancePayload(args) }
              : {}),
            function: functionName,
            module: moduleName,
            stage: "started",
            type: "function_call"
          },
          span: createHookSpan({
            attributes: {
              "code.function": functionName,
              "code.namespace": moduleName
            },
            endTimeNs: startTimeNs,
            kind: "INTERNAL",
            name: `function.${functionName}`,
            semanticType: "function_call",
            stage: "started",
            startTimeNs,
            traceId: spanContext.traceId
          }),
          stage: "started",
          traceId: spanContext.traceId
        });

        fnStarted = true;
        const result = await fn.apply(this, args);
        const endTimeNs = Date.now() * 1_000_000;

        await evaluateHookGovernance(hookGovernance, {
          activeSpan: span,
          hookTrigger: {
            attribute_key_identifiers: ["code.function", "code.namespace"],
            function: functionName,
            module: moduleName,
            ...(options.captureResult
              ? { result: sanitizeForGovernancePayload(result) }
              : {}),
            stage: "completed",
            type: "function_call"
          },
          span: createHookSpan({
            attributes: {
              "code.function": functionName,
              "code.namespace": moduleName
            },
            endTimeNs,
            kind: "INTERNAL",
            name: `function.${functionName}`,
            semanticType: "function_call",
            stage: "completed",
            startTimeNs,
            traceId: spanContext.traceId
          }),
          stage: "completed",
          traceId: spanContext.traceId
        });

        return result;
      } catch (error) {
        if (fnStarted) {
          const endTimeNs = Date.now() * 1_000_000;

          await evaluateHookGovernance(hookGovernance, {
            activeSpan: span,
            hookTrigger: {
              attribute_key_identifiers: ["code.function", "code.namespace"],
              error:
                error instanceof Error ? error.message : String(error),
              function: functionName,
              module: moduleName,
              stage: "completed",
              type: "function_call"
            },
            span: createHookSpan({
              attributes: {
                "code.function": functionName,
                "code.namespace": moduleName
              },
              endTimeNs,
              kind: "INTERNAL",
              name: `function.${functionName}`,
              semanticType: "function_call",
              stage: "completed",
              startTimeNs,
              traceId: spanContext.traceId
            }),
            stage: "completed",
            traceId: spanContext.traceId
          });
        }

        throw error;
      } finally {
        span.end();
      }
    });
  };
}

function selectHttpInstrumentations(
  ignoredUrls: string[],
  captureHttpBodies: boolean
): Instrumentation<InstrumentationConfig>[] {
  if (!captureHttpBodies) {
    return [];
  }

  return HTTP_INSTRUMENTATION_DEFINITIONS.map(definition => {
    if (
      definition.moduleName === "@opentelemetry/instrumentation-http"
    ) {
      return loadInstrumentation(definition, {
        disableIncomingRequestInstrumentation: true,
        headersToSpanAttributes: {},
        ignoreOutgoingRequestHook: (request: {
          host?: string;
          hostname?: string;
          href?: string;
          path?: string;
          port?: string;
          protocol?: string;
        }) => {
          const url = buildRequestUrl(request);

          return shouldIgnoreUrl(url, ignoredUrls);
        }
      });
    }

    return loadInstrumentation(definition);
  });
}

function selectDatabaseInstrumentations(
  instrumentDatabases: boolean,
  dbLibraries?: ReadonlySet<string>,
  hookGovernance?: HookGovernanceRuntime
): Instrumentation<InstrumentationConfig>[] {
  if (!instrumentDatabases) {
    return [];
  }

  const enabledNames =
    dbLibraries && dbLibraries.size > 0
      ? new Set(
          [...dbLibraries].flatMap(name =>
            DB_INSTRUMENTATION_NAMES.get(name.toLowerCase()) ?? []
          )
        )
      : undefined;

  const definitions = enabledNames
    ? [...enabledNames]
        .map(name => DB_INSTRUMENTATION_DEFINITIONS.get(name))
        .filter(
          (
            definition
          ): definition is NonNullable<typeof definition> => definition !== undefined
        )
    : [...DB_INSTRUMENTATION_DEFINITIONS.values()];

  return definitions.map(definition =>
    loadInstrumentation(
      definition,
      createDatabaseInstrumentationConfig(
        definition.moduleName,
        hookGovernance
      )
    )
  );
}

function selectFileInstrumentation(
  instrumentFileIo: boolean,
  fileSkipPatterns: string[]
): Instrumentation<InstrumentationConfig>[] {
  if (!instrumentFileIo) {
    return [];
  }

  const require = createRequire(import.meta.url);
  const { FsInstrumentation } = require(
    "@opentelemetry/instrumentation-fs"
  ) as {
    FsInstrumentation: new (
      config?: unknown
    ) => Instrumentation<InstrumentationConfig>;
  };
  const instrumentation = new FsInstrumentation({
    createHook(
      _functionName: string,
      info: { args: ArrayLike<unknown> }
    ) {
      const filePath = getFilePathFromArgs(info.args);

      if (!filePath) {
        return true;
      }

      if (fileSkipPatterns.some(pattern => filePath.includes(pattern))) {
        return false;
      }

      return !filePath.startsWith("/dev/");
    },
    requireParentSpan: true
  });

  return [instrumentation];
}

function createDatabaseInstrumentationConfig(
  moduleName: string,
  hookGovernance?: HookGovernanceRuntime
): unknown {
  if (!hookGovernance) {
    return undefined;
  }

  const queryStartTimes = new Map<string, number>();
  const emitStarted = (
    span: HookSpan,
    details: {
      dbName?: string | undefined;
      dbOperation?: string | undefined;
      dbStatement?: string | undefined;
      dbSystem?: string | undefined;
      serverAddress?: string | undefined;
      serverPort?: number | undefined;
    }
  ) => {
    const spanId = span.spanContext().spanId;
    const startTimeNs = Date.now() * 1_000_000;
    queryStartTimes.set(spanId, startTimeNs);
    void emitDatabaseHookGovernance({
      details,
      hookGovernance,
      span,
      stage: "started",
      startTimeNs
    }).catch(() => undefined);
  };
  const emitCompleted = (
    span: HookSpan,
    details: {
      dbName?: string | undefined;
      dbOperation?: string | undefined;
      dbStatement?: string | undefined;
      dbSystem?: string | undefined;
      error?: string | undefined;
      serverAddress?: string | undefined;
      serverPort?: number | undefined;
    }
  ) => {
    const spanId = span.spanContext().spanId;
    const startTimeNs =
      queryStartTimes.get(spanId) ?? Date.now() * 1_000_000;

    queryStartTimes.delete(spanId);

    void emitDatabaseHookGovernance({
      details,
      hookGovernance,
      span,
      stage: "completed",
      startTimeNs
    }).catch(() => undefined);
  };

  if (moduleName === "@opentelemetry/instrumentation-pg") {
    return {
      enhancedDatabaseReporting: true,
      requestHook(
        span: HookSpan,
        info: {
          connection?: {
            database?: string;
            host?: string;
            port?: number;
          };
          query?: {
            text?: string;
          };
        }
      ) {
        const dbStatement =
          info.query?.text ?? toStringValue(getSpanAttribute(span, "db.statement"));

        emitStarted(span, {
          dbName:
            info.connection?.database ??
            toStringValue(getSpanAttribute(span, "db.name")),
          dbOperation:
            parseDbOperation(dbStatement) ??
            toStringValue(getSpanAttribute(span, "db.operation")),
          dbStatement,
          dbSystem: toStringValue(getSpanAttribute(span, "db.system")) ?? "postgresql",
          serverAddress:
            info.connection?.host ??
            toStringValue(getSpanAttribute(span, "server.address")) ??
            toStringValue(getSpanAttribute(span, "net.peer.name")),
          serverPort:
            toNumberValue(getSpanAttribute(span, "server.port")) ??
            toNumberValue(getSpanAttribute(span, "net.peer.port")) ??
            info.connection?.port
        });
      },
      responseHook(
        span: HookSpan
      ) {
        const dbStatement = toStringValue(getSpanAttribute(span, "db.statement"));

        emitCompleted(span, {
          dbName: toStringValue(getSpanAttribute(span, "db.name")),
          dbOperation:
            parseDbOperation(dbStatement) ??
            toStringValue(getSpanAttribute(span, "db.operation")),
          dbStatement,
          dbSystem: toStringValue(getSpanAttribute(span, "db.system")) ?? "postgresql",
          error:
            toStringValue(getSpanAttribute(span, "error.type")) ??
            toStringValue(getSpanAttribute(span, "exception.message")),
          serverAddress:
            toStringValue(getSpanAttribute(span, "server.address")) ??
            toStringValue(getSpanAttribute(span, "net.peer.name")),
          serverPort:
            toNumberValue(getSpanAttribute(span, "server.port")) ??
            toNumberValue(getSpanAttribute(span, "net.peer.port"))
        });
      }
    };
  }

  if (moduleName === "@opentelemetry/instrumentation-oracledb") {
    return {
      enhancedDatabaseReporting: true,
      requestHook(
        span: HookSpan,
        info: {
          connection?: {
            hostName?: string;
            port?: number;
            serviceName?: string;
          };
          inputArgs?: unknown[];
        }
      ) {
        const dbStatement = Array.isArray(info.inputArgs)
          ? toStringValue(info.inputArgs[0])
          : undefined;

        emitStarted(span, {
          dbName:
            info.connection?.serviceName ??
            toStringValue(getSpanAttribute(span, "db.name")),
          dbOperation:
            parseDbOperation(dbStatement) ??
            toStringValue(getSpanAttribute(span, "db.operation")),
          dbStatement:
            dbStatement ?? toStringValue(getSpanAttribute(span, "db.statement")),
          dbSystem: toStringValue(getSpanAttribute(span, "db.system")) ?? "oracle",
          serverAddress:
            info.connection?.hostName ??
            toStringValue(getSpanAttribute(span, "server.address")) ??
            toStringValue(getSpanAttribute(span, "net.peer.name")),
          serverPort:
            toNumberValue(getSpanAttribute(span, "server.port")) ??
            toNumberValue(getSpanAttribute(span, "net.peer.port")) ??
            info.connection?.port
        });
      },
      responseHook(
        span: HookSpan
      ) {
        const dbStatement = toStringValue(getSpanAttribute(span, "db.statement"));

        emitCompleted(span, {
          dbName: toStringValue(getSpanAttribute(span, "db.name")),
          dbOperation:
            parseDbOperation(dbStatement) ??
            toStringValue(getSpanAttribute(span, "db.operation")),
          dbStatement,
          dbSystem: toStringValue(getSpanAttribute(span, "db.system")) ?? "oracle",
          error:
            toStringValue(getSpanAttribute(span, "error.type")) ??
            toStringValue(getSpanAttribute(span, "exception.message")),
          serverAddress:
            toStringValue(getSpanAttribute(span, "server.address")) ??
            toStringValue(getSpanAttribute(span, "net.peer.name")),
          serverPort:
            toNumberValue(getSpanAttribute(span, "server.port")) ??
            toNumberValue(getSpanAttribute(span, "net.peer.port"))
        });
      }
    };
  }

  return undefined;
}

async function emitDatabaseHookGovernance(input: {
  details: {
    dbName?: string | undefined;
    dbOperation?: string | undefined;
    dbStatement?: string | undefined;
    dbSystem?: string | undefined;
    error?: string | undefined;
    serverAddress?: string | undefined;
    serverPort?: number | undefined;
  };
  hookGovernance: HookGovernanceRuntime;
  span: HookSpan;
  stage: "completed" | "started";
  startTimeNs: number;
}): Promise<void> {
  const spanContext = input.span.spanContext();
  const nowNs = Date.now() * 1_000_000;
  const dbOperation = input.details.dbOperation ?? "query";

  const hookTrigger: Record<string, unknown> = {
    attribute_key_identifiers: ["db.system", "db.operation", "db.statement"],
    db_name: input.details.dbName,
    db_operation: dbOperation,
    db_statement: input.details.dbStatement,
    db_system: input.details.dbSystem ?? "unknown",
    server_address: input.details.serverAddress,
    server_port: input.details.serverPort,
    stage: input.stage,
    type: "db_query"
  };

  if (input.stage === "completed") {
    hookTrigger.duration_ms = Math.max(
      0,
      Math.round((nowNs - input.startTimeNs) / 1_000_000)
    );
    hookTrigger.error = input.details.error;
  }

  await evaluateHookGovernance(input.hookGovernance, {
    activeSpan: input.span,
    hookTrigger,
    span: createHookSpan({
      attributes: {
        "db.name": input.details.dbName ?? "unknown",
        "db.operation": dbOperation,
        "db.statement": input.details.dbStatement ?? "",
        "db.system": input.details.dbSystem ?? "unknown",
        ...(input.details.serverAddress
          ? { "server.address": input.details.serverAddress }
          : {}),
        ...(typeof input.details.serverPort === "number"
          ? { "server.port": input.details.serverPort }
          : {})
      },
      endTimeNs: nowNs,
      kind: "CLIENT",
      name: input.span.name ?? `DB ${dbOperation}`,
      semanticType: `db_${dbOperation.toLowerCase()}`,
      stage: input.stage,
      startTimeNs: input.startTimeNs,
      traceId: spanContext.traceId
    }),
    stage: input.stage,
    traceId: spanContext.traceId
  });
}

function patchFetch(
  spanProcessor: OpenBoxSpanProcessor,
  ignoredUrls: string[],
  hookGovernance?: HookGovernanceRuntime
): () => void {
  const originalFetch = globalThis.fetch;

  if (!originalFetch || !globalThis.Request || !globalThis.Response || !globalThis.Headers) {
    throw new Error("Global fetch APIs are required for OpenBox HTTP body capture");
  }

  globalThis.fetch = async function patchedFetch(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> {
    const request = new globalThis.Request(input, init);
    const url = request.url;

    if (shouldIgnoreUrl(url, ignoredUrls)) {
      return originalFetch(request);
    }

    const activeSpan = trace.getActiveSpan();

    if (!activeSpan) {
      return originalFetch(request);
    }

    const requestBody = await captureRequestBody(request);
    const requestHeaders = headersToRecord(request.headers);
    const spanContext = activeSpan.spanContext();
    const startTimeNs = Date.now() * 1_000_000;

    await evaluateHookGovernance(hookGovernance, {
      activeSpan,
      hookTrigger: {
        attribute_key_identifiers: ["http.method", "http.url"],
        method: request.method,
        request_body: requestBody,
        request_headers: requestHeaders,
        stage: "started",
        type: "http_request",
        url
      },
      span: createHookSpan({
        attributes: {
          "http.method": request.method,
          "http.url": url
        },
        endTimeNs: startTimeNs,
        kind: "CLIENT",
        name: `HTTP ${request.method}`,
        requestBody,
        requestHeaders,
        semanticType: `http_${request.method.toLowerCase()}`,
        stage: "started",
        startTimeNs: startTimeNs,
        traceId: spanContext.traceId
      }),
      stage: "started",
      traceId: spanContext.traceId
    });

    const response = await originalFetch(request);
    const responseHeaders = headersToRecord(response.headers);
    const responseBody = await captureResponseBody(response);

    spanProcessor.storeTraceBody(spanContext.traceId, {
      method: request.method,
      requestBody,
      requestHeaders,
      responseBody,
      responseHeaders,
      url
    });
    const endTimeNs = Date.now() * 1_000_000;

    await evaluateHookGovernance(hookGovernance, {
      activeSpan,
      hookTrigger: {
        attribute_key_identifiers: ["http.method", "http.url"],
        method: request.method,
        request_body: requestBody,
        request_headers: requestHeaders,
        response_body: responseBody,
        response_headers: responseHeaders,
        stage: "completed",
        status_code: response.status,
        type: "http_request",
        url
      },
      span: createHookSpan({
        attributes: {
          "http.method": request.method,
          "http.status_code": response.status,
          "http.url": url
        },
        endTimeNs,
        kind: "CLIENT",
        name: `HTTP ${request.method}`,
        requestBody,
        requestHeaders,
        responseBody,
        responseHeaders,
        semanticType: `http_${request.method.toLowerCase()}`,
        stage: "completed",
        startTimeNs,
        traceId: spanContext.traceId
      }),
      stage: "completed",
      traceId: spanContext.traceId
    });

    return response;
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function captureRequestBody(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get("content-type");

  if (!isTextContentType(contentType)) {
    return undefined;
  }

  const clone = request.clone();
  const text = await clone.text();

  return text || undefined;
}

async function captureResponseBody(
  response: Response
): Promise<string | undefined> {
  const contentType = response.headers.get("content-type");

  if (!isTextContentType(contentType)) {
    return undefined;
  }

  const clone = response.clone();
  const text = await clone.text();

  return text || undefined;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};

  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
}

function shouldIgnoreUrl(url: string | undefined, ignoredUrls: string[]): boolean {
  if (!url) {
    return false;
  }

  return ignoredUrls.some(prefix => url.startsWith(prefix));
}

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }

  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";

  return TEXT_CONTENT_TYPES.some(type => normalized.startsWith(type));
}

function buildRequestUrl(request: {
  host?: string;
  hostname?: string;
  href?: string;
  path?: string;
  port?: string;
  protocol?: string;
}): string | undefined {
  if (request.href) {
    return request.href;
  }

  if (!request.protocol || !(request.host || request.hostname)) {
    return undefined;
  }

  const host = request.host ?? request.hostname;

  return `${request.protocol}//${host}${request.path ?? ""}`;
}

function getFilePathFromArgs(args: ArrayLike<unknown>): string | undefined {
  const candidate = args[0];

  return typeof candidate === "string" ? candidate : undefined;
}

function teardownActiveTelemetry(): void {
  activeFetchRestore?.();
  activeFetchRestore = undefined;
  activeFileRestore?.();
  activeFileRestore = undefined;
  activeHookGovernanceRuntime = undefined;
  activeUnregister?.();
  activeUnregister = undefined;
}

function disableGlobalTraceApi(): void {
  const traceApi = trace as unknown as { disable?: () => void };
  traceApi.disable?.();
}

function patchFileIo(
  fileSkipPatterns: string[],
  hookGovernance?: HookGovernanceRuntime
): () => void {
  const require = createRequire(import.meta.url);
  const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  const fsModule = require("node:fs") as typeof import("node:fs");
  const tracer = trace.getTracer("openbox.file-io");
  const originalReadFile = fsPromises.readFile;
  const originalWriteFile = fsPromises.writeFile;
  const originalFsReadFile = fsModule.promises.readFile;
  const originalFsWriteFile = fsModule.promises.writeFile;

  const tracedReadFile = async function openBoxReadFile(
    ...args: Parameters<typeof originalReadFile>
  ): Promise<Awaited<ReturnType<typeof originalReadFile>>> {
    const [path] = args;
    const filePath = String(path);

    if (shouldSkipFilePath(filePath, fileSkipPatterns)) {
      return originalReadFile(...args);
    }

    return context.with(context.active(), async () => {
      return tracer.startActiveSpan("file.read", async span => {
        span.setAttribute("file.path", filePath);
        span.setAttribute("file.operation", "read");
        const spanContext = span.spanContext();
        const startTimeNs = Date.now() * 1_000_000;

        await evaluateHookGovernance(hookGovernance, {
          activeSpan: span,
          hookTrigger: {
            attribute_key_identifiers: ["file.path", "file.operation"],
            file_operation: "read",
            file_path: filePath,
            stage: "started",
            type: "file_operation"
          },
          span: createHookSpan({
            attributes: {
              "file.operation": "read",
              "file.path": filePath
            },
            endTimeNs: startTimeNs,
            kind: "INTERNAL",
            name: "file.read",
            semanticType: "file_read",
            stage: "started",
            startTimeNs,
            traceId: spanContext.traceId
          }),
          stage: "started",
          traceId: spanContext.traceId
        });

        try {
          const result = await originalReadFile(...args);
          const bytes = getByteLength(result);
          const endTimeNs = Date.now() * 1_000_000;
          span.setAttribute("file.bytes", bytes);

          await evaluateHookGovernance(hookGovernance, {
            activeSpan: span,
            hookTrigger: {
              attribute_key_identifiers: ["file.path", "file.operation"],
              bytes_read: bytes,
              file_operation: "read",
              file_path: filePath,
              stage: "completed",
              type: "file_operation"
            },
            span: createHookSpan({
              attributes: {
                "file.bytes": bytes,
                "file.operation": "read",
                "file.path": filePath
              },
              endTimeNs,
              kind: "INTERNAL",
              name: "file.read",
              semanticType: "file_read",
              stage: "completed",
              startTimeNs,
              traceId: spanContext.traceId
            }),
            stage: "completed",
            traceId: spanContext.traceId
          });

          return result;
        } finally {
          span.end();
        }
      });
    });
  };

  const tracedWriteFile = async function openBoxWriteFile(
    ...args: Parameters<typeof originalWriteFile>
  ): Promise<Awaited<ReturnType<typeof originalWriteFile>>> {
    const [file, data] = args;
    const filePath = String(file);

    if (shouldSkipFilePath(filePath, fileSkipPatterns)) {
      return originalWriteFile(...args);
    }

    return context.with(context.active(), async () => {
      return tracer.startActiveSpan("file.write", async span => {
        span.setAttribute("file.path", filePath);
        span.setAttribute("file.operation", "write");
        const bytes = getByteLength(data);
        const spanContext = span.spanContext();
        const startTimeNs = Date.now() * 1_000_000;
        span.setAttribute("file.bytes", bytes);

        await evaluateHookGovernance(hookGovernance, {
          activeSpan: span,
          hookTrigger: {
            attribute_key_identifiers: ["file.path", "file.operation"],
            bytes_written: bytes,
            file_operation: "write",
            file_path: filePath,
            stage: "started",
            type: "file_operation"
          },
          span: createHookSpan({
            attributes: {
              "file.bytes": bytes,
              "file.operation": "write",
              "file.path": filePath
            },
            endTimeNs: startTimeNs,
            kind: "INTERNAL",
            name: "file.write",
            semanticType: "file_write",
            stage: "started",
            startTimeNs,
            traceId: spanContext.traceId
          }),
          stage: "started",
          traceId: spanContext.traceId
        });

        try {
          const result = await originalWriteFile(...args);
          const endTimeNs = Date.now() * 1_000_000;

          await evaluateHookGovernance(hookGovernance, {
            activeSpan: span,
            hookTrigger: {
              attribute_key_identifiers: ["file.path", "file.operation"],
              bytes_written: bytes,
              file_operation: "write",
              file_path: filePath,
              stage: "completed",
              type: "file_operation"
            },
            span: createHookSpan({
              attributes: {
                "file.bytes": bytes,
                "file.operation": "write",
                "file.path": filePath
              },
              endTimeNs,
              kind: "INTERNAL",
              name: "file.write",
              semanticType: "file_write",
              stage: "completed",
              startTimeNs,
              traceId: spanContext.traceId
            }),
            stage: "completed",
            traceId: spanContext.traceId
          });

          return result;
        } finally {
          span.end();
        }
      });
    });
  };

  fsPromises.readFile = tracedReadFile as typeof fsPromises.readFile;
  fsPromises.writeFile = tracedWriteFile as typeof fsPromises.writeFile;
  fsModule.promises.readFile = tracedReadFile as typeof fsModule.promises.readFile;
  fsModule.promises.writeFile = tracedWriteFile as typeof fsModule.promises.writeFile;
  syncBuiltinESMExports();

  return () => {
    fsPromises.readFile = originalReadFile;
    fsPromises.writeFile = originalWriteFile;
    fsModule.promises.readFile = originalFsReadFile;
    fsModule.promises.writeFile = originalFsWriteFile;
    syncBuiltinESMExports();
  };
}

function getByteLength(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(value);
  }

  if (value instanceof Uint8Array) {
    return value.byteLength;
  }

  return 0;
}

function shouldSkipFilePath(filePath: string, fileSkipPatterns: string[]): boolean {
  return fileSkipPatterns.some(pattern => filePath.includes(pattern));
}

async function evaluateHookGovernance(
  hookGovernance: HookGovernanceRuntime | undefined,
  input: {
    activeSpan: HookSpan;
    hookTrigger: Record<string, unknown>;
    span: Record<string, unknown>;
    stage: "completed" | "started";
    traceId: string;
  }
): Promise<void> {
  if (!hookGovernance) {
    return;
  }

  const activityContext = resolveActivityContext(
    hookGovernance.spanProcessor,
    input.traceId
  );

  if (!activityContext) {
    return;
  }

  const priorAbortReason = hookGovernance.spanProcessor.getActivityAbort(
    activityContext.workflowId,
    activityContext.activityId
  );

  if (priorAbortReason) {
    if (priorAbortReason.startsWith(APPROVAL_ABORT_PREFIX)) {
      throw new ApprovalPendingError(
        priorAbortReason.slice(APPROVAL_ABORT_PREFIX.length)
      );
    }

    throw new GovernanceHaltError(`Governance blocked: ${priorAbortReason}`);
  }

  hookGovernance.spanProcessor.markGoverned(
    input.activeSpan.spanContext().spanId
  );

  const payload: Record<string, unknown> = {
    activity_id: activityContext.activityId,
    activity_type: activityContext.activityType,
    event_type:
      input.stage === "started"
        ? WorkflowEventType.ACTIVITY_STARTED
        : WorkflowEventType.ACTIVITY_COMPLETED,
    hook_trigger: input.hookTrigger,
    run_id: activityContext.runId,
    source: "workflow-telemetry",
    span_count: 1,
    spans: [input.span],
    task_queue: activityContext.taskQueue,
    timestamp: new Date().toISOString(),
    workflow_id: activityContext.workflowId,
    workflow_type: activityContext.workflowType
  };

  if (typeof activityContext.attempt === "number") {
    payload.attempt = activityContext.attempt;
  }

  if (activityContext.activityInput !== undefined) {
    payload.activity_input = activityContext.activityInput;
  }

  let verdict;

  try {
    verdict = await hookGovernance.client.evaluate(payload);
  } catch (error) {
    if (hookGovernance.onApiError === "fail_open") {
      return;
    }

    throw new GovernanceHaltError(
      `Governance API error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (
    !verdict ||
    (!Verdict.shouldStop(verdict.verdict) &&
      !Verdict.requiresApproval(verdict.verdict))
  ) {
    return;
  }

  const reason = verdict.reason ?? "Hook blocked by governance";

  const abortReason = Verdict.requiresApproval(verdict.verdict)
    ? `${APPROVAL_ABORT_PREFIX}${reason}`
    : reason;

  hookGovernance.spanProcessor.setActivityAbort(
    activityContext.workflowId,
    activityContext.activityId,
    abortReason
  );

  if (Verdict.requiresApproval(verdict.verdict)) {
    throw new ApprovalPendingError(reason);
  }

  if (verdict.verdict === Verdict.HALT) {
    hookGovernance.spanProcessor.setHaltRequested(
      activityContext.workflowId,
      activityContext.activityId,
      reason
    );
  }

  throw new GovernanceHaltError(`Governance blocked: ${reason}`);
}

function resolveActivityContext(
  spanProcessor: OpenBoxSpanProcessor,
  traceId: string
): {
  activityId: string;
  activityInput?: unknown;
  activityType: string;
  attempt?: number;
  runId: string;
  taskQueue: string;
  workflowId: string;
  workflowType: string;
} | undefined {
  const executionContext = getOpenBoxExecutionContext();

  if (
    executionContext?.activityId &&
    executionContext.activityType &&
    executionContext.workflowId &&
    executionContext.workflowType &&
    executionContext.runId
  ) {
    const spanActivityContext = spanProcessor.getActivityContext(
      executionContext.workflowId,
      executionContext.activityId
    );

    return {
      activityId: executionContext.activityId,
      ...(spanActivityContext &&
      Object.prototype.hasOwnProperty.call(spanActivityContext, "activity_input")
        ? {
            activityInput: spanActivityContext.activity_input
          }
        : {}),
      activityType: executionContext.activityType,
      runId: executionContext.runId,
      taskQueue: executionContext.taskQueue ?? "mastra",
      workflowId: executionContext.workflowId,
      workflowType: executionContext.workflowType,
      ...(typeof executionContext.attempt === "number"
        ? { attempt: executionContext.attempt }
        : {})
    };
  }

  const spanContext = spanProcessor.getActivityContextByTrace(traceId);

  if (!spanContext) {
    return undefined;
  }

  const activityId = toStringValue(spanContext.activity_id);
  const activityType = toStringValue(spanContext.activity_type);
  const workflowId = toStringValue(spanContext.workflow_id);
  const workflowType = toStringValue(spanContext.workflow_type);
  const runId = toStringValue(spanContext.run_id);

  if (!activityId || !activityType || !workflowId || !workflowType || !runId) {
    return undefined;
  }

  return {
    activityId,
    activityInput: spanContext.activity_input,
    activityType,
    runId,
    taskQueue: toStringValue(spanContext.task_queue) ?? "mastra",
    workflowId,
    workflowType,
    ...(typeof spanContext.attempt === "number"
      ? { attempt: spanContext.attempt }
      : {})
  };
}

function createHookSpan(input: {
  attributes: Record<string, unknown>;
  endTimeNs: number;
  kind: string;
  name: string;
  requestBody?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  responseBody?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  semanticType: string;
  stage: "completed" | "started";
  startTimeNs: number;
  traceId: string;
}): Record<string, unknown> {
  const span: Record<string, unknown> = {
    attributes: input.attributes,
    duration_ns: Math.max(0, input.endTimeNs - input.startTimeNs),
    end_time: input.endTimeNs,
    events: [],
    kind: input.kind,
    name: input.name,
    semantic_type: input.semanticType,
    span_id: normalizeHexId(undefined, 16),
    stage: input.stage,
    start_time: input.startTimeNs,
    status: {
      code: "OK"
    },
    trace_id: normalizeHexId(input.traceId, 32)
  };

  if (input.requestBody !== undefined) {
    span.request_body = input.requestBody;
  }

  if (input.responseBody !== undefined) {
    span.response_body = input.responseBody;
  }

  if (input.requestHeaders !== undefined) {
    span.request_headers = input.requestHeaders;
  }

  if (input.responseHeaders !== undefined) {
    span.response_headers = input.responseHeaders;
  }

  return span;
}

function normalizeHexId(
  value: string | undefined,
  width: number
): string {
  const base = (value ?? randomUUID().replaceAll("-", "")).toLowerCase();
  const filtered = base.replace(/[^a-f0-9]/g, "");

  if (filtered.length >= width) {
    return filtered.slice(0, width);
  }

  return filtered.padEnd(width, "0");
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toNumberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getSpanAttribute(
  span: {
    attributes?: Record<string, unknown>;
  },
  key: string
): unknown {
  return span.attributes?.[key];
}

function parseDbOperation(statement: string | undefined): string | undefined {
  if (!statement) {
    return undefined;
  }

  const trimmed = statement.trim();

  if (!trimmed) {
    return undefined;
  }

  const [operation] = trimmed.split(/\s+/);

  return operation?.toUpperCase();
}

function sanitizeForGovernancePayload(value: unknown): unknown {
  const seen = new WeakSet<object>();

  try {
    return JSON.parse(
      JSON.stringify(value, (_key, entry: unknown) => {
        if (typeof entry === "bigint") {
          return entry.toString();
        }

        if (typeof entry === "function") {
          return `[function ${entry.name || "anonymous"}]`;
        }

        if (typeof entry === "symbol") {
          return entry.toString();
        }

        if (entry instanceof Error) {
          return {
            message: entry.message,
            name: entry.name,
            stack: entry.stack
          };
        }

        if (entry && typeof entry === "object") {
          if (seen.has(entry as object)) {
            return "[circular]";
          }

          seen.add(entry as object);
        }

        return entry;
      })
    );
  } catch {
    return String(value);
  }
}

function loadInstrumentation(
  definition: {
    exportName: string;
    moduleName: string;
  },
  config?: unknown
): Instrumentation<InstrumentationConfig> {
  const require = createRequire(import.meta.url);
  const moduleExports = require(definition.moduleName) as Record<
    string,
    new (config?: unknown) => Instrumentation<InstrumentationConfig>
  >;
  const InstrumentationConstructor = moduleExports[definition.exportName];

  if (typeof InstrumentationConstructor !== "function") {
    throw new Error(
      `Instrumentation export ${definition.exportName} was not found in ${definition.moduleName}`
    );
  }

  return new InstrumentationConstructor(config);
}
