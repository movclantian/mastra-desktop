/**
 * 技能路由(/work/skills/*):SKILL.md 上传导入、内置技能与市场技能安装。
 * 官方文档:docs/en/docs/skills.mdx;市场实现见 src/mastra/skills/marketplaces.ts。
 */
import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import AdmZip from "adm-zip";
import { workError } from "../../errors";
import {
  categorizeSkillResources,
  getMarketplaceSkillDetail,
  getSkillMarketplaces,
  getSkillsShSkillDetail,
  installMarketplaceSkill,
  installSkillsShSkill,
  listMarketplaceSkills,
  listSkillsShSkills,
  type MarketplaceSkill,
  normalizeMarketplace,
  parseSkillMarkdown,
  type SkillsShSkill,
  saveSkillMarketplaces,
} from "../../skills/marketplaces";
import { getManagedSkillsDirectory } from "../../workspace";

const MAX_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_ENTRIES = 2_000;
const require = createRequire(import.meta.url);

function builtinSkillsDirectory(): string {
  return resolve(dirname(require.resolve("@mastra/editor")), "ee", "workspace", "skills");
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function safeEntryPath(root: string, entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("技能 ZIP 包含不安全的路径");
  }
  const target = resolve(root, normalized);
  if (!isWithin(root, target)) throw new Error("技能 ZIP 路径越界");
  return target;
}

function skillDirectoryName(filename: string, skillDirectory: string): string {
  const source =
    skillDirectory && skillDirectory !== "."
      ? basename(skillDirectory)
      : basename(filename, ".zip");
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `uploaded-${Date.now()}`;
}

async function getDirectoryRelativeFiles(dir: string, base = dir): Promise<string[]> {
  try {
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
  } catch {
    return [];
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
    instructions: content.replace(/^---\s*[\s\S]*?\s*---\s*/, "").trim(),
    references,
    scripts,
    assets,
  };
}

async function unpackSkillArchive(buffer: Buffer, filename: string) {
  const archive = new AdmZip(buffer);
  const entries = archive.getEntries();
  if (entries.length === 0 || entries.length > MAX_SKILL_ENTRIES) {
    throw new Error("技能包文件数量无效");
  }
  const totalBytes = entries.reduce(
    (sum, entry) => sum + (entry.isDirectory ? 0 : entry.header.size),
    0,
  );
  if (totalBytes > MAX_SKILL_UNPACKED_BYTES) throw new Error("解压后的技能包不能超过 100 MB");
  const root = getManagedSkillsDirectory();
  const names = entries.map((entry) => entry.entryName.replaceAll("\\", "/")).filter(Boolean);
  const skillFiles = names.filter((name) => basename(name).toUpperCase() === "SKILL.MD");
  if (skillFiles.length !== 1) throw new Error("ZIP 中必须恰好包含一个 SKILL.md");
  const skillDirectory = dirname(skillFiles[0]).replaceAll("\\", "/");
  const targetRoot = resolve(root, skillDirectoryName(filename, skillDirectory));
  if (!isWithin(root, targetRoot)) throw new Error("技能包路径无效");
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
        await writeFile(target, entry.getData());
      }
    }
    return await readLocalSkill(targetRoot);
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export const skillsRoute = registerApiRoute("/work/skills", {
  method: "GET",
  handler: async (c) => {
    const skills = await c.get("mastra").getAgent("mastraWorkAgent").listSkills();
    return c.json({ skills });
  },
});

export const skillRoute = registerApiRoute("/work/skills/:name", {
  method: "GET",
  handler: async (c) => {
    const skill = await c
      .get("mastra")
      .getAgent("mastraWorkAgent")
      .getSkill(decodeURIComponent(c.req.param("name")));
    if (!skill) throw workError("SKILL_NOT_FOUND");
    return c.json({ skill });
  },
});

export const builtinSkillsRoute = registerApiRoute("/work/skills/registry", {
  method: "GET",
  handler: async (c) => {
    try {
      const root = builtinSkillsDirectory();
      const entries = await readdir(root, { withFileTypes: true });
      const query = (c.req.query("query") ?? "").trim().toLocaleLowerCase();
      const builtinSkills = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => readLocalSkill(resolve(root, entry.name)).catch(() => null)),
      );
      const marketplaces = await getSkillMarketplaces();
      const externalSkills = (
        await Promise.all(
          marketplaces
            .filter((marketplace) => marketplace.enabled)
            .map((marketplace) => listMarketplaceSkills(marketplace, query).catch(() => [])),
        )
      ).flat();
      let skillsSh: SkillsShSkill[] = [];
      let skillsShError: string | undefined;
      try {
        const timeoutPromise = new Promise<SkillsShSkill[]>((_, reject) =>
          setTimeout(() => reject(new Error("skills.sh 响应超时")), 5000),
        );
        skillsSh = await Promise.race([listSkillsShSkills(query), timeoutPromise]);
      } catch (error) {
        skillsShError = error instanceof Error ? error.message : "skills.sh 暂时不可用";
      }
      const skills = [
        ...builtinSkills
          .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
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
          marketplaceName: "skills.sh",
          sourcePath: skill.slug,
          skillsShSource: skill.source,
          skillsShSlug: skill.slug,
          sourceUrl: skill.url || `https://skills.sh/${skill.source}/${skill.slug}`,
        })),
      ];
      return c.json({
        skills: skills.filter(
          (skill) =>
            !query ||
            skill.name.toLocaleLowerCase().includes(query) ||
            skill.description.toLocaleLowerCase().includes(query),
        ),
        ...(skillsShError ? { skillsShError } : {}),
      });
    } catch (error) {
      throw workError("SKILL_READ_FAILED", {
        text: error instanceof Error ? error.message : "读取内置技能失败",
        cause: error,
      });
    }
  },
});

export const builtinSkillRoute = registerApiRoute("/work/skills/registry/:name", {
  method: "GET",
  handler: async (c) => {
    try {
      const name = basename(decodeURIComponent(c.req.param("name")));
      const sourceRoot = builtinSkillsDirectory();
      const source = resolve(sourceRoot, name);
      if (!isWithin(sourceRoot, source) || source === sourceRoot) {
        throw workError("VALIDATION_FAILED", { text: "内置技能路径无效" });
      }
      const skill = await readLocalSkill(source).catch(() => null);
      if (!skill) throw workError("SKILL_NOT_FOUND");
      return c.json({
        skill: {
          ...skill,
          origin: "builtin",
          marketplaceName: "Mastra 内置",
          sourcePath: name,
        },
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "读取内置技能详情失败" },
        500,
      );
    }
  },
});

export const skillMarketplacesRoute = registerApiRoute("/work/skills/marketplaces", {
  method: "GET",
  handler: async (c) => c.json({ marketplaces: await getSkillMarketplaces() }),
});

export const marketplaceSkillRoute = registerApiRoute("/work/skills/marketplaces/:id/skill", {
  method: "GET",
  handler: async (c) => {
    try {
      const sourcePath = c.req.query("path");
      if (!sourcePath) throw workError("VALIDATION_FAILED", { text: "缺少技能路径" });
      return c.json({ skill: await getMarketplaceSkillDetail(c.req.param("id"), sourcePath) });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "读取市场技能详情失败" },
        404,
      );
    }
  },
});

export const skillsShSkillRoute = registerApiRoute("/work/skills/skills-sh/skill", {
  method: "GET",
  handler: async (c) => {
    try {
      const source = c.req.query("source");
      const slug = c.req.query("slug");
      if (!source || !slug) {
        throw workError("VALIDATION_FAILED", { text: "缺少 skills.sh 技能标识" });
      }
      return c.json({
        skill: {
          ...(await getSkillsShSkillDetail(source, slug)),
          origin: "skills-sh",
          marketplaceName: "skills.sh",
          skillsShSource: source,
          skillsShSlug: slug,
        },
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "读取 skills.sh 技能详情失败" },
        404,
      );
    }
  },
});

export const saveSkillMarketplaceRoute = registerApiRoute("/work/skills/marketplaces", {
  method: "POST",
  handler: async (c) => {
    try {
      const marketplace = normalizeMarketplace(await c.req.json());
      const current = await getSkillMarketplaces();
      await saveSkillMarketplaces([
        ...current.filter((item) => item.id !== marketplace.id),
        marketplace,
      ]);
      return c.json({ marketplace }, 201);
    } catch (error) {
      throw workError("VALIDATION_FAILED", {
        text: error instanceof Error ? error.message : "保存技能市场失败",
        cause: error,
      });
    }
  },
});

export const deleteSkillMarketplaceRoute = registerApiRoute("/work/skills/marketplaces/:id", {
  method: "DELETE",
  handler: async (c) => {
    const id = c.req.param("id");
    const current = await getSkillMarketplaces();
    if (!current.some((marketplace) => marketplace.id === id))
      throw workError("SKILL_MARKETPLACE_NOT_FOUND");
    await saveSkillMarketplaces(current.filter((marketplace) => marketplace.id !== id));
    return c.json({ ok: true });
  },
});

export const installMarketplaceSkillRoute = registerApiRoute(
  "/work/skills/marketplaces/:id/install",
  {
    method: "POST",
    handler: async (c) => {
      try {
        const payload = (await c.req.json()) as Partial<MarketplaceSkill>;
        if (
          typeof payload.marketplaceId !== "string" ||
          typeof payload.sourcePath !== "string" ||
          typeof payload.name !== "string"
        ) {
          throw workError("VALIDATION_FAILED", { text: "技能市场条目无效" });
        }
        const root = await installMarketplaceSkill(payload as MarketplaceSkill);
        const skill = await readLocalSkill(root);
        return c.json({ skill }, 201);
      } catch (error) {
        throw workError("SKILL_INSTALL_FAILED", {
          text: error instanceof Error ? error.message : "安装市场技能失败",
          cause: error,
        });
      }
    },
  },
);

export const installBuiltinSkillRoute = registerApiRoute("/work/skills/registry/:name/install", {
  method: "POST",
  handler: async (c) => {
    const name = basename(decodeURIComponent(c.req.param("name")));
    const sourceRoot = builtinSkillsDirectory();
    const source = resolve(sourceRoot, name);
    if (!isWithin(sourceRoot, source) || source === sourceRoot) {
      throw workError("VALIDATION_FAILED", { text: "内置技能路径无效" });
    }
    const targetRoot = resolve(getManagedSkillsDirectory(), name);
    const alreadyInstalled = await access(targetRoot).then(
      () => true,
      () => false,
    );
    if (alreadyInstalled) throw workError("SKILL_ALREADY_INSTALLED");
    try {
      await cp(source, targetRoot, { recursive: true, errorOnExist: true, force: false });
      const skill = await readLocalSkill(targetRoot);
      return c.json({ skill }, 201);
    } catch (error) {
      await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
      throw workError("SKILL_INSTALL_FAILED", {
        text: error instanceof Error ? error.message : "安装技能失败",
        cause: error,
      });
    }
  },
});

export const installSkillsShSkillRoute = registerApiRoute("/work/skills/skills-sh/install", {
  method: "POST",
  handler: async (c) => {
    try {
      const payload = (await c.req.json()) as { source?: unknown; slug?: unknown };
      if (typeof payload.source !== "string" || typeof payload.slug !== "string") {
        throw workError("VALIDATION_FAILED", { text: "skills.sh 技能标识无效" });
      }
      const root = await installSkillsShSkill(payload.source, payload.slug);
      return c.json({ skill: await readLocalSkill(root) }, 201);
    } catch (error) {
      if (error instanceof Error && error.message === "该技能已经安装") {
        throw workError("SKILL_ALREADY_INSTALLED", { cause: error });
      }
      throw workError("SKILL_INSTALL_FAILED", {
        text: error instanceof Error ? error.message : "安装 skills.sh 技能失败",
        cause: error,
      });
    }
  },
});

export const uploadSkillRoute = registerApiRoute("/work/skills", {
  method: "POST",
  handler: async (c) => {
    const form = await c.req.raw.formData();
    const value = form.get("archive");
    if (!(value instanceof File))
      throw workError("VALIDATION_FAILED", { text: "请上传 ZIP 技能包" });
    if (value.size > MAX_SKILL_ARCHIVE_BYTES) throw workError("SKILL_PACKAGE_TOO_LARGE");

    try {
      const skill = await unpackSkillArchive(Buffer.from(await value.arrayBuffer()), value.name);
      if (!skill) throw new Error("解压后未发现有效的 SKILL.md");
      return c.json({ skill }, 201);
    } catch (error) {
      throw workError("SKILL_PACKAGE_INVALID", {
        text: error instanceof Error ? error.message : "技能包解析失败",
        cause: error,
      });
    }
  },
});

export const importSkillRoute = registerApiRoute("/work/skills/import", {
  method: "POST",
  handler: async (c) => {
    try {
      const payload = (await c.req.json()) as { source?: unknown };
      if (typeof payload.source !== "string" || !/^https?:\/\//i.test(payload.source.trim())) {
        throw workError("VALIDATION_FAILED", { text: "请输入有效的 HTTP(S) 技能包地址" });
      }
      const url = new URL(payload.source.trim());
      const candidates = [url.toString()];
      if (
        url.hostname.toLowerCase() === "github.com" &&
        !url.pathname.toLowerCase().endsWith(".zip")
      ) {
        const repository = url.pathname.replace(/\/$/, "");
        candidates.push(`https://github.com${repository}/archive/refs/heads/main.zip`);
        candidates.push(`https://github.com${repository}/archive/refs/heads/master.zip`);
      }
      let response: Response | null = null;
      for (const candidate of candidates) {
        const attempt = await fetch(candidate);
        if (attempt.ok) {
          response = attempt;
          break;
        }
      }
      if (!response)
        return c.json(
          { error: "下载技能包失败，请确认地址指向公开的 GitHub 仓库或 ZIP 文件" },
          400,
        );
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_SKILL_ARCHIVE_BYTES) throw workError("SKILL_PACKAGE_TOO_LARGE");
      const filename = basename(url.pathname) || `${url.hostname}.zip`;
      const skill = await unpackSkillArchive(
        buffer,
        filename.endsWith(".zip") ? filename : `${filename}.zip`,
      );
      return c.json({ skill }, 201);
    } catch (error) {
      throw workError("SKILL_PACKAGE_INVALID", {
        text: error instanceof Error ? error.message : "导入技能失败",
        cause: error,
      });
    }
  },
});

export const deleteSkillRoute = registerApiRoute("/work/skills/:name", {
  method: "DELETE",
  handler: async (c) => {
    const agent = c.get("mastra").getAgent("mastraWorkAgent");
    const skill = await agent.getSkill(decodeURIComponent(c.req.param("name")));
    if (!skill) throw workError("SKILL_NOT_FOUND");
    const root = resolve(getManagedSkillsDirectory());
    const target = isAbsolute(skill.path) ? resolve(skill.path) : resolve(root, skill.path);
    if (!isWithin(root, target) || target === root) throw workError("SKILL_MANAGED_ONLY");
    await rm(target, { recursive: true, force: true });
    return c.json({ ok: true });
  },
});
