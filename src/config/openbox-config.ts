import { z } from "zod";

import type { OpenBoxConfig as BaseOpenBoxConfig } from "@openbox-ai/openbox-sdk/config";

import { OpenBoxClient, type OpenBoxApiErrorPolicy } from "../client/index.js";
import {
  identityOptionsFromConfig,
  redactConfig,
  resolveBaseOpenBoxConfig,
  type OpenBoxIdentityOptions
} from "./base-config.js";

import { OpenBoxConfigError, OpenBoxInsecureURLError } from "../types/index.js";

export type {
  AgentIdentityMethod,
  OpenBoxIdentityOptions
} from "./base-config.js";

// Verified byte-identical to base's internal pattern (`config/index.ts`
// `\w` === `[A-Za-z0-9_]`). Kept local: base does not export this regex
// standalone (only reachable indirectly via the throwing `OpenBoxConfig.
// resolve()`), and `validateApiKeyFormat` below is a boolean predicate, not a
// throwing validator, so it cannot delegate to base's throwing check either.
export const API_KEY_PATTERN = /^obx_(live|test)_[a-zA-Z0-9_]+$/;

export interface OpenBoxMultiAgentSessionContext {
  runId: string;
  workflowId: string;
  workflowType: string;
}

export type OpenBoxMultiAgentSessionIdResolver = (
  context: OpenBoxMultiAgentSessionContext
) => string | undefined;

export interface OpenBoxMultiAgentInput {
  enabled?: boolean | undefined;
  multiAgentSessionId?: string | OpenBoxMultiAgentSessionIdResolver | undefined;
}

export interface OpenBoxMultiAgentConfig {
  enabled: boolean;
  multiAgentSessionId: string | OpenBoxMultiAgentSessionIdResolver | undefined;
}

export interface OpenBoxConfigInput extends OpenBoxIdentityOptions {
  envPrefix?: string | undefined;
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  evaluateMaxRetries?: number | undefined;
  evaluateRetryBaseDelayMs?: number | undefined;
  governanceTimeout?: number | undefined;
  hitlEnabled?: boolean | undefined;
  httpCapture?: boolean | undefined;
  instrumentDatabases?: boolean | undefined;
  instrumentFileIo?: boolean | undefined;
  maxEvaluatePayloadBytes?: number | undefined;
  multiAgent?: OpenBoxMultiAgentInput | undefined;
  onApiError?: OpenBoxApiErrorPolicy | undefined;
  sendActivityStartEvent?: boolean | undefined;
  sendStartEvent?: boolean | undefined;
  skipActivityTypes?: Iterable<string> | undefined;
  skipHitlActivityTypes?: Iterable<string> | undefined;
  skipSignals?: Iterable<string> | undefined;
  skipWorkflowTypes?: Iterable<string> | undefined;
}

export interface OpenBoxConfig extends OpenBoxIdentityOptions {
  agentDid: string | undefined;
  agentPrivateKey: string | undefined;
  apiKey: string;
  apiUrl: string;
  evaluateMaxRetries: number;
  evaluateRetryBaseDelayMs: number;
  governanceTimeout: number;
  hitlEnabled: boolean;
  httpCapture: boolean;
  instrumentDatabases: boolean;
  instrumentFileIo: boolean;
  maxEvaluatePayloadBytes: number;
  multiAgent: OpenBoxMultiAgentConfig;
  onApiError: OpenBoxApiErrorPolicy;
  sendActivityStartEvent: boolean;
  sendStartEvent: boolean;
  skipActivityTypes: Set<string>;
  skipHitlActivityTypes: Set<string>;
  skipSignals: Set<string>;
  skipWorkflowTypes: Set<string>;
}

const OPENBOX_CONFIG_SCHEMA = z.object({
  agentDid: z.string().optional(),
  agentPrivateKey: z.string().optional(),
  apiKey: z.string().regex(API_KEY_PATTERN, {
    message: "Invalid API key format. Expected 'obx_live_*' or 'obx_test_*'."
  }),
  apiUrl: z.string().min(1),
  evaluateMaxRetries: z.number().int().nonnegative().default(2),
  evaluateRetryBaseDelayMs: z.number().int().nonnegative().default(150),
  governanceTimeout: z.number().nonnegative().default(30),
  hitlEnabled: z.boolean().default(true),
  httpCapture: z.boolean().default(true),
  instrumentDatabases: z.boolean().default(true),
  instrumentFileIo: z.boolean().default(false),
  maxEvaluatePayloadBytes: z.number().int().positive().default(256_000),
  onApiError: z.enum(["fail_open", "fail_closed"]).default("fail_open"),
  sendActivityStartEvent: z.boolean().default(true),
  sendStartEvent: z.boolean().default(true),
  skipActivityTypes: z
    .set(z.string())
    .default(new Set(["send_governance_event"])),
  skipHitlActivityTypes: z
    .set(z.string())
    .default(new Set(["send_governance_event"])),
  skipSignals: z.set(z.string()).default(new Set()),
  skipWorkflowTypes: z.set(z.string()).default(new Set())
});

let globalConfig: OpenBoxConfig | undefined;

export function validateApiKeyFormat(apiKey: string): boolean {
  return API_KEY_PATTERN.test(apiKey);
}

// Verified byte-identical to base's internal `validateUrlSecurity`
// (`config/index.ts`) — same WHATWG `URL` parse, bracket-stripped hostname,
// exact-match localhost set, and message text. Base does not export this
// helper standalone (only reachable via the throwing `OpenBoxConfig.
// resolve()`/`.normalized()`), so it is kept as a local pure copy for
// Mastra's synchronous public helper; `parseOpenBoxConfig` below ALSO runs
// base's authoritative version via `BaseOpenBoxConfig.resolve()`, so the real
// validation path exercised by config construction is base's.
export function validateUrlSecurity(apiUrl: string): void {
  const url = new URL(apiUrl);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const isLocalhost =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (url.protocol === "http:" && !isLocalhost) {
    throw new OpenBoxInsecureURLError(
      `Insecure HTTP URL detected: ${apiUrl}. Use HTTPS for non-localhost URLs to protect API keys in transit.`
    );
  }
}

export function parseOpenBoxConfig(
  input: OpenBoxConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
  // A runtime with an injected client uses that client's identity unchanged.
  connectionConfig?: BaseOpenBoxConfig
): OpenBoxConfig {
  const multiAgent = parseMultiAgentConfig(input.multiAgent, env);
  const baseConfig =
    connectionConfig ??
    resolveBaseOpenBoxConfig(
      {
        ...input,
        timeoutSeconds:
          input.governanceTimeout ??
          parseNumber(env.OPENBOX_GOVERNANCE_TIMEOUT, 30),
        onApiError:
          input.onApiError ??
          parsePolicy(env.OPENBOX_GOVERNANCE_POLICY, "fail_open")
      },
      env
    );
  const identity = identityOptionsFromConfig(baseConfig);

  const parsed = OPENBOX_CONFIG_SCHEMA.parse({
    agentDid: baseConfig.agentDid ?? undefined,
    agentPrivateKey: baseConfig.agentPrivateKey ?? undefined,
    apiKey: baseConfig.apiKey,
    apiUrl: baseConfig.apiUrl,
    evaluateMaxRetries:
      input.evaluateMaxRetries ??
      parseInteger(env.OPENBOX_EVALUATE_MAX_RETRIES, 2),
    evaluateRetryBaseDelayMs:
      input.evaluateRetryBaseDelayMs ??
      parseInteger(env.OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS, 150),
    governanceTimeout: baseConfig.timeoutSeconds,
    hitlEnabled:
      input.hitlEnabled ?? parseBoolean(env.OPENBOX_HITL_ENABLED, true),
    httpCapture:
      input.httpCapture ?? parseBoolean(env.OPENBOX_HTTP_CAPTURE, true),
    instrumentDatabases:
      input.instrumentDatabases ??
      parseBoolean(env.OPENBOX_INSTRUMENT_DATABASES, true),
    instrumentFileIo:
      input.instrumentFileIo ??
      parseBoolean(env.OPENBOX_INSTRUMENT_FILE_IO, false),
    maxEvaluatePayloadBytes:
      input.maxEvaluatePayloadBytes ??
      parseInteger(env.OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES, 256_000),
    onApiError: baseConfig.onApiError,
    sendActivityStartEvent:
      input.sendActivityStartEvent ??
      parseBoolean(env.OPENBOX_SEND_ACTIVITY_START_EVENT, true),
    sendStartEvent:
      input.sendStartEvent ?? parseBoolean(env.OPENBOX_SEND_START_EVENT, true),
    skipActivityTypes:
      iterableToSet(input.skipActivityTypes) ??
      parseCsvSet(env.OPENBOX_SKIP_ACTIVITY_TYPES, ["send_governance_event"]),
    skipHitlActivityTypes:
      iterableToSet(input.skipHitlActivityTypes) ??
      parseCsvSet(env.OPENBOX_SKIP_HITL_ACTIVITY_TYPES, [
        "send_governance_event"
      ]),
    skipSignals:
      iterableToSet(input.skipSignals) ?? parseCsvSet(env.OPENBOX_SKIP_SIGNALS),
    skipWorkflowTypes:
      iterableToSet(input.skipWorkflowTypes) ??
      parseCsvSet(env.OPENBOX_SKIP_WORKFLOW_TYPES)
  });

  return redactConfig({
    ...parsed,
    ...identity,
    agentDid: baseConfig.agentDid ?? undefined,
    agentPrivateKey: baseConfig.agentPrivateKey ?? undefined,
    multiAgent
  });
}

export function resolveOpenBoxMultiAgentSessionId(
  config: Pick<OpenBoxConfig, "multiAgent">,
  context: OpenBoxMultiAgentSessionContext
): string | undefined {
  if (!config.multiAgent.enabled) {
    return undefined;
  }

  const configuredSessionId = config.multiAgent.multiAgentSessionId;

  if (typeof configuredSessionId === "function") {
    return normalizeOptionalString(configuredSessionId(context));
  }

  if (typeof configuredSessionId === "string") {
    return normalizeOptionalString(configuredSessionId);
  }

  return `mas:${context.runId}`;
}

export async function initializeOpenBox(
  input: OpenBoxConfigInput = {}
): Promise<OpenBoxConfig> {
  const config = parseOpenBoxConfig(input);

  const client = OpenBoxClient.fromConfig(config);
  try {
    await client.validateApiKey();
  } finally {
    client.close();
  }

  globalConfig = config;

  return config;
}

export function getOpenBoxConfig(): OpenBoxConfig | undefined {
  return globalConfig;
}

export function setOpenBoxConfig(config: OpenBoxConfig): void {
  globalConfig = config;
}

function parseMultiAgentConfig(
  input: OpenBoxMultiAgentInput | undefined,
  env: NodeJS.ProcessEnv
): OpenBoxMultiAgentConfig {
  return {
    enabled:
      input?.enabled ??
      parseOptionalBoolean(env.OPENBOX_MULTI_AGENT_ENABLED) ??
      false,
    multiAgentSessionId:
      input?.multiAgentSessionId ??
      normalizeOptionalString(env.OPENBOX_MULTI_AGENT_SESSION_ID)
  };
}

function normalizeOptionalString(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value == null ? undefined : parseBoolean(value, false);
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean
): boolean {
  if (value == null) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new OpenBoxConfigError(`Invalid boolean value: ${value}`);
}

function parseCsvSet(
  value: string | undefined,
  defaults: Iterable<string> = []
): Set<string> {
  if (!value) {
    return new Set(defaults);
  }

  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new OpenBoxConfigError(`Invalid numeric value: ${value}`);
  }

  return parsed;
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new OpenBoxConfigError(`Invalid integer value: ${value}`);
  }

  return parsed;
}

function parsePolicy(
  value: string | undefined,
  defaultValue: OpenBoxApiErrorPolicy
): OpenBoxApiErrorPolicy {
  if (!value) {
    return defaultValue;
  }

  if (value === "fail_open" || value === "fail_closed") {
    return value;
  }

  throw new OpenBoxConfigError(`Invalid OpenBox governance policy: ${value}`);
}

function iterableToSet(
  value: Iterable<string> | undefined
): Set<string> | undefined {
  return value ? new Set(value) : undefined;
}
