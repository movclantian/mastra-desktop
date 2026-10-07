export interface SkillAuditItem {
  provider: string;
  slug: string;
  status: "pass" | "warn" | "fail" | string;
  summary: string;
  auditedAt?: string;
  riskLevel?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | string;
  categories?: string[];
}

export interface McpFormServer {
  clientId?: string;
  serverName?: string;
  builtin?: "anysearch";
  plugin?: { id: string; componentId: string; digest: string };
  status?: "draft" | "published" | "archived";
  version?: string;
  timeout?: number;
  tools?: Record<string, { description?: string }>;
  id: string;
  name: string;
  transport: "http" | "stdio";
  oauth?: {
    enabled: boolean;
    redirectUrl?: string;
    clientName?: string;
    clientId?: string;
    clientSecretCredential?: CredentialPointer;
    scopes?: string[];
  };
  url?: string;
  allowedHosts?: string[];
  command?: string;
  args?: string[];
  headerCredential?: CredentialPointer;
  headerKeys?: string[];
  envCredential?: CredentialPointer;
  envKeys?: string[];
  inheritDefaultEnv?: boolean;
  requireToolApproval?: boolean;
  enabled: boolean;
}

export interface McpSummary extends McpFormServer {
  configurationError?: string;
  configurationKeys?: string[];
  connectionError?: string;
  toolCount?: number;
  headerKeys: string[];
  envKeys: string[];
}

import type { CredentialPointer } from "../../../../../shared/credential-contract";
