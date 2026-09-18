export interface SkillAuditItem {
  provider: string;
  slug: string;
  status: "pass" | "warn" | "fail" | string;
  summary: string;
  auditedAt?: string;
  riskLevel?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | string;
  categories?: string[];
}

export interface SkillMetadata {
  name: string;
  path: string;
  description: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
  origin?: "builtin" | "marketplace" | "skills-sh" | "installed";
  marketplaceId?: string;
  marketplaceName?: string;
  sourcePath?: string;
  branch?: string;
  skillsShSource?: string;
  skillsShSlug?: string;
  installs?: number;
  sourceUrl?: string;
  change?: number;
  installsYesterday?: number;
  isOfficial?: boolean;
  owner?: string;
  audits?: SkillAuditItem[];
}

export interface SkillDetail extends SkillMetadata {
  instructions: string;
  references: string[];
  scripts: string[];
  assets: string[];
  audits?: SkillAuditItem[];
}

export interface CuratedSkill {
  id?: string;
  slug: string;
  name: string;
  source: string;
  installs?: number;
  installUrl?: string | null;
  url?: string;
  description?: string;
  change?: number;
  installsYesterday?: number;
  isOfficial?: boolean;
  owner?: string;
}

export interface CuratedOwner {
  owner: string;
  totalInstalls: number;
  featuredRepo?: string;
  featuredSkill?: string;
  skills: CuratedSkill[];
}

export interface McpFormServer {
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
  headerKeys: string[];
  envKeys: string[];
}

export interface SkillMarketplace {
  id: string;
  name: string;
  url: string;
  branch: string;
  path?: string;
  enabled: boolean;
}

export type SkillSection = "public" | "personal" | "mcp";
export type MarketCategory = "official" | "leaderboard" | "builtin" | "marketplace";
export type LeaderboardView = "all-time" | "trending" | "hot";

import type { CredentialPointer } from "../../../../../shared/credential-contract";
