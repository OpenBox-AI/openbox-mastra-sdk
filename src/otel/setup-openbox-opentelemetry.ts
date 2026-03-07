import { createRequire, syncBuiltinESMExports } from "node:module";

import { context, trace } from "@opentelemetry/api";
import type {
  Instrumentation,
  InstrumentationConfig
} from "@opentelemetry/instrumentation";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { OpenBoxSpanProcessor } from "../span/index.js";

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
  ignoredUrls?: string[] | undefined;
  instrumentDatabases?: boolean | undefined;
  instrumentFileIo?: boolean | undefined;
  spanProcessor: OpenBoxSpanProcessor;
}

export interface OpenBoxTelemetryController {
  instrumentations: Instrumentation<InstrumentationConfig>[];
  shutdown: () => Promise<void>;
  tracerProvider: NodeTracerProvider;
}

let activeFetchRestore: (() => void) | undefined;
let activeFileRestore: (() => void) | undefined;
let activeUnregister: (() => void) | undefined;

export function setupOpenBoxOpenTelemetry({
  captureHttpBodies = true,
  dbLibraries,
  fileSkipPatterns = DEFAULT_FILE_SKIP_PATTERNS,
  ignoredUrls = [],
  instrumentDatabases = true,
  instrumentFileIo = false,
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

  const instrumentations: Instrumentation<InstrumentationConfig>[] = [
    ...selectHttpInstrumentations(ignoredUrls, captureHttpBodies),
    ...selectDatabaseInstrumentations(instrumentDatabases, dbLibraries),
    ...selectFileInstrumentation(instrumentFileIo, fileSkipPatterns)
  ];

  activeUnregister = registerInstrumentations({
    instrumentations,
    tracerProvider
  });

  if (captureHttpBodies) {
    activeFetchRestore = patchFetch(spanProcessor, ignoredUrls);
  }

  if (instrumentFileIo) {
    activeFileRestore = patchFileIo(fileSkipPatterns);
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
  dbLibraries?: ReadonlySet<string>
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

  return definitions.map(definition => loadInstrumentation(definition));
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

function patchFetch(
  spanProcessor: OpenBoxSpanProcessor,
  ignoredUrls: string[]
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
    const response = await originalFetch(request);
    const responseHeaders = headersToRecord(response.headers);
    const responseBody = await captureResponseBody(response);
    const spanContext = activeSpan.spanContext();

    spanProcessor.storeTraceBody(spanContext.traceId, {
      method: request.method,
      requestBody,
      requestHeaders,
      responseBody,
      responseHeaders,
      url
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
  activeUnregister?.();
  activeUnregister = undefined;
}

function disableGlobalTraceApi(): void {
  const traceApi = trace as unknown as { disable?: () => void };
  traceApi.disable?.();
}

function patchFileIo(fileSkipPatterns: string[]): () => void {
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

        try {
          const result = await originalReadFile(...args);
          span.setAttribute("file.bytes", getByteLength(result));

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
        span.setAttribute("file.bytes", getByteLength(data));

        try {
          return await originalWriteFile(...args);
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
