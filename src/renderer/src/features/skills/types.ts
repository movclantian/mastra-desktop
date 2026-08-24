import type { McpFormServer } from "@/features/integrations";
import type { SkillAuditItem, SkillMetadata } from "@/features/workbench/types";

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

export interface McpSummary extends Omit<McpFormServer, "headers" | "env"> {
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
