import type { AgentIdentityMethod } from "@openbox-ai/openbox-sdk";
import { OpenBoxConfig as BaseOpenBoxConfig } from "@openbox-ai/openbox-sdk/config";

import { SDK_VERSION } from "../version.js";

export type { AgentIdentityMethod };

/** Identity inputs are validated and resolved exclusively by the base SDK. */
export interface OpenBoxIdentityOptions {
  agentDid?: string | undefined;
  agentPrivateKey?: string | undefined;
  identityMethod?: AgentIdentityMethod | undefined;
  agentId?: string | undefined;
  organizationId?: string | undefined;
  deploymentId?: string | undefined;
  agentProofAudience?: string | undefined;
  oktaAgentId?: string | undefined;
  oktaAgentKeyId?: string | undefined;
  oktaAgentPrivateKey?: string | undefined;
  oktaAgentAlgorithm?: string | undefined;
  workloadPrivateKey?: string | null | undefined;
}

const IDENTITY_FIELDS = [
  "agentDid",
  "agentPrivateKey",
  "identityMethod",
  "agentId",
  "organizationId",
  "deploymentId",
  "agentProofAudience",
  "oktaAgentId",
  "oktaAgentKeyId",
  "oktaAgentPrivateKey",
  "oktaAgentAlgorithm",
  "workloadPrivateKey"
] as const;

export function identityOptionsFromConfig(
  config: BaseOpenBoxConfig
): OpenBoxIdentityOptions {
  return Object.fromEntries(
    IDENTITY_FIELDS.map((key) => [key, config[key] ?? undefined])
  );
}

export function resolveBaseOpenBoxConfig(
  input: OpenBoxIdentityOptions & {
    apiUrl?: string | undefined;
    apiKey?: string | undefined;
    envPrefix?: string | undefined;
    timeoutSeconds?: number | undefined;
    onApiError?: "fail_open" | "fail_closed" | undefined;
  },
  env: NodeJS.ProcessEnv
): BaseOpenBoxConfig {
  const envPrefix = input.envPrefix ?? "OPENBOX_MASTRA";
  // Keep OPENBOX_URL as a legacy global alias, below the SDK-specific layer.
  const apiUrl =
    input.apiUrl ??
    nonBlank(env[`${envPrefix}_API_URL`]) ??
    nonBlank(env.OPENBOX_URL) ??
    nonBlank(env.OPENBOX_API_URL);
  const config = BaseOpenBoxConfig.resolve({
    ...Object.fromEntries(
      IDENTITY_FIELDS.map((key) => [key, input[key] ?? null])
    ),
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.timeoutSeconds !== undefined
      ? { timeoutSeconds: input.timeoutSeconds }
      : {}),
    ...(input.onApiError !== undefined ? { onApiError: input.onApiError } : {}),
    environ: env,
    envPrefix,
    sdkEngine: "mastra",
    sdkLanguage: "typescript",
    sdkVersion: SDK_VERSION
  });
  // Preserve eager validation of a DID private key at config-parse time.
  if (config.agentDid) config.loadIdentity();
  return config;
}

function nonBlank(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** Redact the plain Mastra config just as the base SDK redacts its config. */
export function redactConfig<T extends object>(config: T): T {
  const view = () => {
    const result = { ...config } as Record<string, unknown>;
    for (const key of [
      "apiKey",
      "agentPrivateKey",
      "oktaAgentPrivateKey",
      "workloadPrivateKey"
    ]) {
      if (result[key]) result[key] = "[REDACTED]";
    }
    return result;
  };
  Object.defineProperties(config, {
    toJSON: { value: view },
    [Symbol.for("nodejs.util.inspect.custom")]: { value: view }
  });
  return config;
}
