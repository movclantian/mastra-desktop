/** skills.sh discovery endpoints; installation belongs to the plugin lifecycle. */
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import { workValidationError } from "../errors";
import {
  getSkillsShAudit,
  getSkillsShCurated,
  getSkillsShSkillDetail,
  listSkillsShSkillsWithOptions,
} from "../skills/marketplaces";

const skillsShIdentitySchema = z.object({
  source: z.string().trim().min(1).max(180),
  slug: z.string().trim().min(1).max(180),
});
export const skillsShSkillRoute = createRoute({
  path: "/work/plugins/skills-sh/skill",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: skillsShIdentitySchema,
  handler: async ({ source, slug }) => {
    const detail = await getSkillsShSkillDetail(source, slug);
    return {
      skill: {
        ...detail,
        origin: "skills-sh",
        marketplaceName: "skills.sh",
        skillsShSource: source,
        skillsShSlug: slug,
      },
    };
  },
});

export const skillsShCuratedRoute = createRoute({
  path: "/work/plugins/skills-sh/curated",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({}).strict(),
  handler: () => getSkillsShCurated(),
});

export const skillsShAuditRoute = createRoute({
  path: "/work/plugins/skills-sh/audit",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: skillsShIdentitySchema,
  handler: async ({ source, slug }) => ({ audits: await getSkillsShAudit(source, slug) }),
});

export const skillsShListRoute = createRoute({
  path: "/work/plugins/skills-sh/list",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({
    view: z.enum(["all-time", "trending", "hot"]).default("all-time"),
    curated: z
      .enum(["0", "1", "false", "true"])
      .default("0")
      .transform((value) => value === "1" || value === "true"),
    owner: z.string().trim().min(1).optional(),
    page: z.coerce.number().int().min(0).default(0),
    perPage: z.coerce.number().int().min(1).max(100).default(50),
    query: z.string().trim().default(""),
    refresh: z.enum(["0", "1"]).default("0"),
  }),
  handler: async ({ view, curated, owner, page, perPage, query, refresh }) => {
    const result = await listSkillsShSkillsWithOptions({
      view,
      curated,
      owner,
      page,
      perPage,
      query,
      force: refresh === "1",
    });
    return {
      ...result,
      skills: result.skills.map((skill) => ({
        ...skill,
        path: `skills-sh:${skill.source}/${skill.slug}`,
        description: skill.description || "来自 skills.sh 的社区技能",
        origin: "skills-sh" as const,
        marketplaceName: skill.isOfficial ? "skills.sh 官方认证" : "skills.sh",
        sourcePath: skill.slug,
        skillsShSource: skill.source,
        skillsShSlug: skill.slug,
        sourceUrl: skill.url || `https://skills.sh/${skill.source}/${skill.slug}`,
      })),
    };
  },
});
