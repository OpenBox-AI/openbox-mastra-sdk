import { z } from "zod";

import { OpenBoxClient, type OpenBoxApiErrorPolicy } from "../client/index.js";
import { validateAgentIdentityConfig } from "../identity/index.js";
import {
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxInsecureURLError
} from "../types/index.js";

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
  multiAgentSessionId?:
    | string
    | OpenBoxMultiAgentSessionIdResolver
    | undefined;
}

export interface OpenBoxMultiAgentConfig {
  enabled: boolean;
  multiAgentSessionId:
    | string
    | OpenBoxMultiAgentSessionIdResolver
    | undefined;
}

export interface OpenBoxConfigInput {
  agentDid?: string | undefined;
  agentPrivateKey?: string | undefined;
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
  validate?: boolean | undefined;
}

export interface OpenBoxConfig {
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
  validate: boolean;
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
  skipActivityTypes: z.set(z.string()).default(new Set(["send_governance_event"])),
  skipHitlActivityTypes: z
    .set(z.string())
    .default(new Set(["send_governance_event"])),
  skipSignals: z.set(z.string()).default(new Set()),
  skipWorkflowTypes: z.set(z.string()).default(new Set()),
  validate: z.boolean().default(true)
});

let globalConfig: OpenBoxConfig | undefined;

export function validateApiKeyFormat(apiKey: string): boolean {
  return API_KEY_PATTERN.test(apiKey);
}

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
  env: NodeJS.ProcessEnv = process.env
): OpenBoxConfig {
  const apiUrl = input.apiUrl ?? env.OPENBOX_URL;
  const apiKey = input.apiKey ?? env.OPENBOX_API_KEY;
  const agentIdentity = parseAgentIdentityConfig(
    input.agentDid ?? env.OPENBOX_AGENT_DID,
    input.agentPrivateKey ?? env.OPENBOX_AGENT_PRIVATE_KEY
  );
  const multiAgent = parseMultiAgentConfig(input.multiAgent, env);

  if (!apiUrl || !apiKey) {
    throw new OpenBoxConfigError(
      "Missing OpenBox configuration. Both OPENBOX_URL and OPENBOX_API_KEY are required."
    );
  }

  if (!validateApiKeyFormat(apiKey)) {
    throw new OpenBoxAuthError(
      "Invalid API key format. Expected 'obx_live_*' or 'obx_test_*'."
    );
  }

  validateUrlSecurity(apiUrl);

  const parsed = OPENBOX_CONFIG_SCHEMA.parse({
    agentDid: agentIdentity?.did,
    agentPrivateKey: agentIdentity?.privateKey,
    apiKey,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    evaluateMaxRetries:
      input.evaluateMaxRetries ??
      parseInteger(env.OPENBOX_EVALUATE_MAX_RETRIES, 2),
    evaluateRetryBaseDelayMs:
      input.evaluateRetryBaseDelayMs ??
      parseInteger(env.OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS, 150),
    governanceTimeout:
      input.governanceTimeout ?? parseNumber(env.OPENBOX_GOVERNANCE_TIMEOUT, 30),
    hitlEnabled: input.hitlEnabled ?? parseBoolean(env.OPENBOX_HITL_ENABLED, true),
    httpCapture: input.httpCapture ?? parseBoolean(env.OPENBOX_HTTP_CAPTURE, true),
    instrumentDatabases:
      input.instrumentDatabases ??
      parseBoolean(env.OPENBOX_INSTRUMENT_DATABASES, true),
    instrumentFileIo:
      input.instrumentFileIo ?? parseBoolean(env.OPENBOX_INSTRUMENT_FILE_IO, false),
    maxEvaluatePayloadBytes:
      input.maxEvaluatePayloadBytes ??
      parseInteger(env.OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES, 256_000),
    onApiError:
      input.onApiError ??
      parsePolicy(env.OPENBOX_GOVERNANCE_POLICY, "fail_open"),
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
      parseCsvSet(env.OPENBOX_SKIP_HITL_ACTIVITY_TYPES, ["send_governance_event"]),
    skipSignals:
      iterableToSet(input.skipSignals) ?? parseCsvSet(env.OPENBOX_SKIP_SIGNALS),
    skipWorkflowTypes:
      iterableToSet(input.skipWorkflowTypes) ??
      parseCsvSet(env.OPENBOX_SKIP_WORKFLOW_TYPES),
    validate: input.validate ?? parseBoolean(env.OPENBOX_VALIDATE, true)
  });

  return {
    ...parsed,
    agentDid: agentIdentity?.did,
    agentPrivateKey: agentIdentity?.privateKey,
    multiAgent
  };
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

  if (config.validate) {
    const client = new OpenBoxClient({
      agentDid: config.agentDid,
      agentPrivateKey: config.agentPrivateKey,
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      timeoutSeconds: config.governanceTimeout
    });

    await client.validateApiKey();
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

function parseAgentIdentityConfig(
  agentDidValue: string | undefined,
  agentPrivateKeyValue: string | undefined
): { did: string; privateKey: string } | undefined {
  const agentDid = normalizeOptionalString(agentDidValue);
  const agentPrivateKey = normalizeOptionalString(agentPrivateKeyValue);

  if (!agentDid && !agentPrivateKey) {
    return undefined;
  }

  if (!agentDid || !agentPrivateKey) {
    throw new OpenBoxConfigError(
      "Both OPENBOX_AGENT_DID and OPENBOX_AGENT_PRIVATE_KEY are required when configuring OpenBox agent identity."
    );
  }

  return validateAgentIdentityConfig({
    did: agentDid,
    privateKey: agentPrivateKey
  });
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

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value == null ? undefined : parseBoolean(value, false);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
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
      .map(item => item.trim())
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
