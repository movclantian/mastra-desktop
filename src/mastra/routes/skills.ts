/**
 * 技能路由(/work/skills/*):SKILL.md 上传导入、内置技能与市场技能安装。
 * 官方文档:docs/en/docs/skills.mdx;市场实现见 src/mastra/skills/marketplaces.ts。
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import { validateSkillContent } from "@mastra/core/skills";
import { createRoute, HTTPException } from "@mastra/server/server-adapter";
import AdmZip from "adm-zip";
import matter from "gray-matter";
import { z } from "zod";
import { errorText, workError, workValidationError } from "../errors";
import {
  categorizeSkillResources,
  getMarketplaceSkillDetail,
  getSkillMarketplaces,
  getSkillsShAudit,
  getSkillsShCurated,
  getSkillsShSkillDetail,
  installMarketplaceSkill,
  installSkillsShSkill,
  listMarketplaceSkills,
  listSkillsShSkills,
  listSkillsShSkillsWithOptions,
  normalizeMarketplace,
  parseSkillMarkdown,
  type SkillsShSkill,
  saveSkillMarketplaces,
} from "../skills/marketplaces";
import { resourceIdFromContext } from "../storage";
import { getManagedSkillsDirectory } from "../workspace";

const MAX_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_ENTRIES = 2_000;
function builtinSkillsDirectory(): string {
  // Built-ins are shipped from this repository. Do not reach into @mastra/editor/ee:
  // that directory is covered by a separate Enterprise Edition license.
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath) return resolve(dirname(browsersPath), "builtin-skills");
  return resolve(process.cwd(), "resources", "builtin-skills");
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function safeEntryPath(root: string, entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw workError("SKILL_PACKAGE_INVALID", { text: "技能 ZIP 包含不安全的路径" });
  }
  const target = resolve(root, normalized);
  if (!isWithin(root, target))
    throw workError("SKILL_PACKAGE_INVALID", { text: "技能 ZIP 路径越界" });
  return target;
}

async function getDirectoryRelativeFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      const subFiles = await getDirectoryRelativeFiles(fullPath, base);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      const rel = relative(base, fullPath).replaceAll("\\", "/");
      if (rel.toUpperCase() !== "SKILL.MD") results.push(rel);
    }
  }
  return results;
}

function skillArchiveData(entry: AdmZip.IZipEntry): Buffer {
  try {
    return entry.getData();
  } catch (error) {
    throw workError("SKILL_PACKAGE_INVALID", { cause: error });
  }
}

async function readLocalSkill(directory: string) {
  const content = await readFile(resolve(directory, "SKILL.md"), "utf8");
  const parsed = parseSkillMarkdown(content, basename(directory));
  const relativeFiles = await getDirectoryRelativeFiles(directory);
  const { references, scripts, assets } = categorizeSkillResources(relativeFiles);
  return {
    ...parsed,
    path: directory,
    references,
    scripts,
    assets,
  };
}

async function unpackSkillArchive(buffer: Buffer, resourceId?: string) {
  let archive: AdmZip;
  try {
    archive = new AdmZip(buffer);
  } catch (error) {
    throw workError("SKILL_PACKAGE_INVALID", { cause: error });
  }
  const entries = archive.getEntries();
  if (entries.length === 0 || entries.length > MAX_SKILL_ENTRIES) {
    throw workError("SKILL_PACKAGE_INVALID", { text: "技能包文件数量无效" });
  }
  const totalBytes = entries.reduce(
    (sum, entry) => sum + (entry.isDirectory ? 0 : entry.header.size),
    0,
  );
  if (totalBytes > MAX_SKILL_UNPACKED_BYTES)
    throw workError("SKILL_PACKAGE_TOO_LARGE", { text: "解压后的技能包不能超过 100 MB" });
  const root = getManagedSkillsDirectory(resourceId);
  const names = entries.map((entry) => entry.entryName.replaceAll("\\", "/")).filter(Boolean);
  const skillFiles = names.filter((name) => basename(name).toUpperCase() === "SKILL.MD");
  if (skillFiles.length !== 1)
    throw workError("SKILL_PACKAGE_INVALID", { text: "ZIP 中必须恰好包含一个 SKILL.md" });
  const skillDirectory = dirname(skillFiles[0]).replaceAll("\\", "/");
  const skillEntry = entries.find(
    (entry) => entry.entryName.replaceAll("\\", "/") === skillFiles[0],
  );
  if (!skillEntry) throw workError("SKILL_PACKAGE_INVALID", { text: "未发现 SKILL.md" });
  const content = skillArchiveData(skillEntry).toString("utf8");
  const validation = validateSkillContent({ content });
  if (!validation.valid || typeof validation.metadata?.name !== "string")
    throw workError("SKILL_PACKAGE_INVALID", { text: validation.errors.join("\n") });
  const targetRoot = resolve(root, validation.metadata.name);
  if (!isWithin(root, targetRoot) || targetRoot === root)
    throw workError("SKILL_PACKAGE_INVALID", { text: "技能包路径无效" });
  await mkdir(targetRoot).catch(installConflict);
  try {
    for (const entry of entries) {
      const normalized = entry.entryName.replaceAll("\\", "/");
      const relativeEntry =
        skillDirectory === "."
          ? normalized
          : normalized.startsWith(`${skillDirectory}/`)
            ? normalized.slice(skillDirectory.length + 1)
            : "";
      if (!relativeEntry) continue;
      const target = safeEntryPath(targetRoot, relativeEntry);
      if (entry.isDirectory) await mkdir(target, { recursive: true });
      else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, skillArchiveData(entry));
      }
    }
    return await readLocalSkill(targetRoot);
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const skillPathSchema = z.object({ name: skillNameSchema });
const marketplaceIdSchema = z.object({ id: z.string().trim().min(1) });
const skillsShIdentitySchema = z.object({
  source: z
    .string()
    .trim()
    .max(180)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/),
  slug: z
    .string()
    .trim()
    .max(180)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
});
const marketplaceSourcePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (path) =>
      !path.replaceAll("\\", "/").split("/").includes("..") && /(^|\/)SKILL\.md$/i.test(path),
    "市场技能必须指向 SKILL.md",
  );
const marketplaceSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    url: z.string().trim().min(1),
    branch: z.string().optional(),
    path: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .transform((input, context) => {
    try {
      return { marketplace: normalizeMarketplace(input) };
    } catch (error) {
      context.addIssue({ code: "custom", message: errorText(error, "技能市场配置无效") });
      return z.NEVER;
    }
  });

function missingSkill(error: unknown): null {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
  throw error;
}

function installConflict(error: unknown): never {
  if (error instanceof Error && "code" in error && error.code === "EEXIST")
    throw workError("SKILL_ALREADY_INSTALLED", { cause: error });
  throw error;
}

export const skillsRoute = createRoute({
  path: "/work/skills",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({}).strict(),
  handler: async ({ requestContext }) => {
    const root = getManagedSkillsDirectory(resourceIdFromContext(requestContext));
    const entries = await readdir(root, { withFileTypes: true });
    const skills = (
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => readLocalSkill(resolve(root, entry.name)).catch(missingSkill)),
      )
    ).filter((skill): skill is NonNullable<typeof skill> => skill !== null);
    return { skills };
  },
});

export const skillRoute = createRoute({
  path: "/work/skills/:name",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: skillPathSchema,
  queryParamSchema: z.object({}).strict(),
  handler: async ({ name, requestContext }) => {
    const skill = await readLocalSkill(
      resolve(getManagedSkillsDirectory(resourceIdFromContext(requestContext)), name),
    ).catch(missingSkill);
    if (!skill) throw workError("SKILL_NOT_FOUND");
    return { skill };
  },
});

export const builtinSkillsRoute = createRoute({
  path: "/work/skills/registry",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({
    query: z.string().trim().default(""),
    refresh: z.enum(["0", "1"]).default("0"),
  }),
  handler: async ({ query: rawQuery, refresh, requestContext }) => {
    const root = builtinSkillsDirectory();
    const entries = await readdir(root, { withFileTypes: true });
    const query = rawQuery.toLocaleLowerCase();
    const builtinSkills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readLocalSkill(resolve(root, entry.name)).catch(missingSkill)),
    );
    const marketplaces = await getSkillMarketplaces(resourceIdFromContext(requestContext));
    const externalSkills = (
      await Promise.all(
        marketplaces
          .filter((marketplace) => marketplace.enabled)
          .map((marketplace) => listMarketplaceSkills(marketplace, query)),
      )
    ).flat();
    let skillsSh: SkillsShSkill[] = [];
    let skillsShError: string | undefined;
    // This combined catalogue deliberately displays the remaining sources with an explicit error.
    try {
      skillsSh = await listSkillsShSkills(query, refresh === "1");
    } catch (error) {
      skillsShError = errorText(error, "skills.sh 暂时不可用");
    }
    const skills = [
      ...builtinSkills
        .filter((skill): skill is NonNullable<typeof skill> => skill !== null)
        .map((skill) => ({
          ...skill,
          origin: "builtin" as const,
          marketplaceName: "Mastra 内置",
          sourcePath: basename(skill.path),
        })),
      ...externalSkills.map((skill) => ({ ...skill, origin: "marketplace" as const })),
      ...skillsSh.map((skill) => ({
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
    ];
    return {
      skills: skills.filter(
        (skill) =>
          !query ||
          skill.name.toLocaleLowerCase().includes(query) ||
          skill.description.toLocaleLowerCase().includes(query),
      ),
      ...(skillsShError ? { skillsShError } : {}),
    };
  },
});

export const builtinSkillRoute = createRoute({
  path: "/work/skills/registry/:name",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: skillPathSchema,
  queryParamSchema: z.object({}).strict(),
  handler: async ({ name }) => {
    const skill = await readLocalSkill(resolve(builtinSkillsDirectory(), name)).catch(missingSkill);
    if (!skill) throw workError("SKILL_NOT_FOUND");
    return {
      skill: { ...skill, origin: "builtin", marketplaceName: "Mastra 内置", sourcePath: name },
    };
  },
});

export const skillMarketplacesRoute = createRoute({
  path: "/work/skills/marketplaces",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({}).strict(),
  handler: async ({ requestContext }) => ({
    marketplaces: await getSkillMarketplaces(resourceIdFromContext(requestContext)),
  }),
});

export const marketplaceSkillRoute = createRoute({
  path: "/work/skills/marketplaces/:id/skill",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: marketplaceIdSchema,
  queryParamSchema: z.object({ path: marketplaceSourcePathSchema }),
  handler: async ({ id, path, requestContext }) => {
    const resourceId = resourceIdFromContext(requestContext);
    if (!(await getSkillMarketplaces(resourceId)).some((marketplace) => marketplace.id === id))
      throw workError("SKILL_MARKETPLACE_NOT_FOUND");
    return { skill: await getMarketplaceSkillDetail(id, path, resourceId) };
  },
});

export const skillsShSkillRoute = createRoute({
  path: "/work/skills/skills-sh/skill",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: skillsShIdentitySchema,
  handler: async ({ source, slug }) => {
    const { files: _files, ...detail } = await getSkillsShSkillDetail(source, slug);
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
  path: "/work/skills/skills-sh/curated",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({}).strict(),
  handler: () => getSkillsShCurated(),
});

export const skillsShAuditRoute = createRoute({
  path: "/work/skills/skills-sh/audit",
  method: "GET",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: skillsShIdentitySchema,
  handler: async ({ source, slug }) => ({ audits: await getSkillsShAudit(source, slug) }),
});

export const skillsShListRoute = createRoute({
  path: "/work/skills/skills-sh/list",
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

export const saveSkillMarketplaceRoute = createRoute({
  path: "/work/skills/marketplaces",
  method: "POST",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({}).strict(),
  bodySchema: marketplaceSchema,
  handler: async ({ marketplace, requestContext }) => {
    const resourceId = resourceIdFromContext(requestContext);
    const current = await getSkillMarketplaces(resourceId);
    await saveSkillMarketplaces(
      [...current.filter((item) => item.id !== marketplace.id), marketplace],
      resourceId,
    );
    return { marketplace };
  },
});

export const deleteSkillMarketplaceRoute = createRoute({
  path: "/work/skills/marketplaces/:id",
  method: "DELETE",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: marketplaceIdSchema,
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({}).strict().optional(),
  handler: async ({ id, requestContext }) => {
    const resourceId = resourceIdFromContext(requestContext);
    const current = await getSkillMarketplaces(resourceId);
    if (!current.some((marketplace) => marketplace.id === id))
      throw workError("SKILL_MARKETPLACE_NOT_FOUND");
    await saveSkillMarketplaces(
      current.filter((marketplace) => marketplace.id !== id),
      resourceId,
    );
    return { ok: true };
  },
});

export const installMarketplaceSkillRoute = createRoute({
  path: "/work/skills/marketplaces/:id/install",
  method: "POST",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: marketplaceIdSchema,
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({ path: marketplaceSourcePathSchema }),
  handler: async ({ id, path, requestContext }) => {
    const resourceId = resourceIdFromContext(requestContext);
    if (!(await getSkillMarketplaces(resourceId)).some((marketplace) => marketplace.id === id))
      throw workError("SKILL_MARKETPLACE_NOT_FOUND");
    const root = await installMarketplaceSkill(id, path, resourceId).catch(installConflict);
    return { skill: await readLocalSkill(root) };
  },
});

export const installBuiltinSkillRoute = createRoute({
  path: "/work/skills/registry/:name/install",
  method: "POST",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: skillPathSchema,
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({}).strict().optional(),
  handler: async ({ name, requestContext }) => {
    const source = resolve(builtinSkillsDirectory(), name);
    const content = await readFile(resolve(source, "SKILL.md"), "utf8").catch(missingSkill);
    if (content === null) throw workError("SKILL_NOT_FOUND");
    const validation = validateSkillContent({ content, directoryName: name });
    if (!validation.valid)
      throw workError("SKILL_PACKAGE_INVALID", { text: validation.errors.join("\n") });
    const targetRoot = resolve(
      getManagedSkillsDirectory(resourceIdFromContext(requestContext)),
      name,
    );
    await mkdir(targetRoot).catch(installConflict);
    try {
      await cp(source, targetRoot, { recursive: true, errorOnExist: true, force: false });
      return { skill: await readLocalSkill(targetRoot) };
    } catch (error) {
      await rm(targetRoot, { recursive: true, force: true });
      throw error;
    }
  },
});

export const installSkillsShSkillRoute = createRoute({
  path: "/work/skills/skills-sh/install",
  method: "POST",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({}).strict(),
  bodySchema: skillsShIdentitySchema,
  handler: async ({ source, slug, requestContext }) => {
    const root = await installSkillsShSkill(
      source,
      slug,
      resourceIdFromContext(requestContext),
    ).catch(installConflict);
    return { skill: await readLocalSkill(root) };
  },
});

// Multipart data is intentionally handled by the raw-request route.
export const uploadSkillRoute = registerApiRoute("/work/skills", {
  method: "POST",
  handler: async (c) => {
    const form = await c.req.raw.formData();
    const value = form.get("archive");
    if (!(value instanceof File))
      throw workError("VALIDATION_FAILED", { text: "请上传 ZIP 技能包" });
    if (value.size > MAX_SKILL_ARCHIVE_BYTES) throw workError("SKILL_PACKAGE_TOO_LARGE");
    const skill = await unpackSkillArchive(
      Buffer.from(await value.arrayBuffer()),
      resourceIdFromContext(c.get("requestContext")),
    );
    return c.json({ skill }, 201);
  },
});

export const importSkillRoute = createRoute({
  path: "/work/skills/import",
  method: "POST",
  responseType: "json",
  onValidationError: workValidationError,
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({ source: z.url({ protocol: /^https?$/ }) }),
  handler: async ({ source, requestContext, abortSignal }) => {
    const url = new URL(source);
    if (url.hostname.toLowerCase() === "github.com" && /^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/archive/HEAD.zip`;
    }
    const response = await fetch(url, { signal: abortSignal });
    if (!response.ok)
      throw new HTTPException(502, { message: `下载技能包失败（HTTP ${response.status}）` });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_SKILL_ARCHIVE_BYTES) throw workError("SKILL_PACKAGE_TOO_LARGE");
    return { skill: await unpackSkillArchive(buffer, resourceIdFromContext(requestContext)) };
  },
});

export const deleteSkillRoute = createRoute({
  path: "/work/skills/:name",
  method: "DELETE",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: skillPathSchema,
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({}).strict().optional(),
  handler: async ({ name, requestContext }) => {
    const target = resolve(getManagedSkillsDirectory(resourceIdFromContext(requestContext)), name);
    await rm(target, { recursive: true, force: true });
    return { ok: true };
  },
});

export const updateSkillRoute = createRoute({
  path: "/work/skills/:name",
  method: "PUT",
  responseType: "json",
  onValidationError: workValidationError,
  pathParamSchema: skillPathSchema,
  queryParamSchema: z.object({}).strict(),
  bodySchema: z
    .object({
      description: z.string().optional(),
      instructions: z.string().optional(),
      enabled: z.boolean().optional(),
    })
    .transform((updates) => ({ updates })),
  handler: async ({ name, updates, requestContext }) => {
    const target = resolve(getManagedSkillsDirectory(resourceIdFromContext(requestContext)), name);
    const skillMdPath = resolve(target, "SKILL.md");
    const existingContent = await readFile(skillMdPath, "utf8").catch(missingSkill);
    if (existingContent === null) throw workError("SKILL_NOT_FOUND");
    const parsed = matter(existingContent);
    if (updates.description !== undefined) parsed.data.description = updates.description;
    if (updates.enabled !== undefined) parsed.data.enabled = updates.enabled;
    const content = matter.stringify(updates.instructions ?? parsed.content, parsed.data);
    const validation = validateSkillContent({ content, directoryName: name });
    if (!validation.valid)
      throw workError("VALIDATION_FAILED", { text: validation.errors.join("\n") });
    await writeFile(skillMdPath, content, "utf8");
    return { skill: await readLocalSkill(target) };
  },
});
