export interface RegistryProvider {
  id: string;
  name: string;
  models: string[];
  apiKeyEnvVar: string;
  docUrl: string;
}

export type GatewayProtocol = "openai" | "anthropic" | "gemini";

export interface EnabledModel {
  id: string;
  name: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  registryId?: string;
  protocol?: GatewayProtocol;
  baseUrl?: string;
  useResponses?: boolean;
  apiKey: string;
  disabled?: boolean;
  enabledModels: EnabledModel[];
}

export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  audio: boolean;
  contextWindow: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface CatalogProvider {
  id: string;
  name: string;
  models: CatalogModel[];
}

export interface ModelCapabilities {
  reasoning: boolean;
  vision: boolean;
  audio: boolean;
  tools: boolean;
}

export type ReasoningEffort =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface RequestModelPayload {
  id: string;
  apiKey: string;
  url?: string;
  protocol?: GatewayProtocol;
  useResponses?: boolean;
}
