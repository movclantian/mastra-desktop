/**
 * 技能市场(docs/en/docs/skills.mdx):GitHub 仓库形式的技能来源,
 * 配置存 app_config(key = "skill-marketplaces"),安装 = 检出 SKILL.md 目录。
 */
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAppConfig, getStorageDirectory, PROJECT_ROOT, setAppConfig } from "../storage";

interface SkillMarketplace {
  id: string;
  name: string;
  url: string;
  branch: string;
  path?: string;
  enabled: boolean;
}

export interface MarketplaceSkill {
  name: string;
  path: string;
  description: string;
  license?: string;
  metadata?: Record<string, unknown>;
  marketplaceId: string;
  marketplaceName: string;
  sourceUrl: string;
  sourcePath: string;
  branch: string;
}

const MARKETPLACES_KEY = "skill-marketplaces";
const DEFAULT_BRANCH = "main";

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function parseGithubRepository(value: string): {
  owner: string;
  repo: string;
  branch: string;
  path: string;
} {
  const trimmed = value.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2], branch: DEFAULT_BRANCH, path: "" };
  const url = new URL(trimmed);
  if (url.hostname.toLowerCase() !== "github.com")
    throw new Error("技能市场目前只支持 GitHub 仓库地址");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("GitHub 地址必须包含 owner/repository");
  let branch = DEFAULT_BRANCH;
  let path = "";
  if (parts[2] === "tree" && parts[3]) {
    branch = parts[3];
    path = parts.slice(4).join("/");
  }
  return { owner: parts[0], repo: parts[1], branch, path };
}

function repositoryUrl(marketplace: SkillMarketplace) {
  const repository = parseGithubRepository(marketplace.url);
  return { ...repository, path: marketplace.path ?? repository.path };
}

function normalizeRepositoryPath(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  if (normalized.split("/").includes("..")) throw new Error("技能市场路径无效");
  return normalized;
}

function validateSkillPath(sourcePath: string, configuredPath?: string): string {
  const normalized = normalizeRepositoryPath(sourcePath);
  if (!normalized || !/(^|\/)SKILL\.md$/i.test(normalized)) {
    throw new Error("市场技能必须指向 SKILL.md");
  }
  if (
    configuredPath &&
    normalized !== configuredPath &&
    !normalized.startsWith(`${configuredPath}/`)
  ) {
    throw new Error("技能路径不属于配置的技能市场目录");
  }
  return normalized;
}

export function normalizeMarketplace(input: unknown): SkillMarketplace {
  if (!input || typeof input !== "object") throw new Error("技能市场配置无效");
  const raw = input as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const repository = parseGithubRepository(url);
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : `${repository.owner}/${repository.repo}`;
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? slug(raw.id)
      : slug(`${repository.owner}-${repository.repo}`);
  if (!id) throw new Error("技能市场 ID 无效");
  return {
    id,
    name,
    url: `https://github.com/${repository.owner}/${repository.repo}`,
    branch:
      typeof raw.branch === "string" && raw.branch.trim() ? raw.branch.trim() : repository.branch,
    path:
      typeof raw.path === "string" && raw.path.trim()
        ? normalizeRepositoryPath(raw.path)
        : repository.path || undefined,
    enabled: raw.enabled !== false,
  };
}

export async function getSkillMarketplaces(): Promise<SkillMarketplace[]> {
  const raw = await getAppConfig(MARKETPLACES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { marketplaces?: unknown };
    if (!Array.isArray(parsed.marketplaces)) return [];
    return parsed.marketplaces.map(normalizeMarketplace);
  } catch {
    return [];
  }
}

export async function saveSkillMarketplaces(marketplaces: SkillMarketplace[]): Promise<void> {
  const normalized = marketplaces.map(normalizeMarketplace);
  if (new Set(normalized.map((marketplace) => marketplace.id)).size !== normalized.length) {
    throw new Error("技能市场 ID 不能重复");
  }
  await setAppConfig(MARKETPLACES_KEY, JSON.stringify({ marketplaces: normalized }, null, 2));
}

export function parseSkillMarkdown(content: string, fallbackName: string) {
  const match = content.match(/^---\s*([\s\S]*?)\s*---/);
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const field = line.match(/^([\w-]+):\s*["']?(.+?)["']?\s*$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  return {
    name: fields.name || fallbackName,
    description: fields.description || "未提供描述",
    license: fields.license,
    metadata:
      fields.category || fields.icon
        ? {
            ...(fields.category ? { category: fields.category } : {}),
            ...(fields.icon ? { icon: fields.icon } : {}),
          }
        : undefined,
  };
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "MastraWork-Skill-Marketplace",
    },
  });
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）`);
  return (await response.json()) as T;
}

async function githubText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github.raw", "User-Agent": "MastraWork-Skill-Marketplace" },
  });
  if (!response.ok) throw new Error(`读取技能文件失败（${response.status}）`);
  return response.text();
}

interface GitTreeItem {
  path: string;
  type: string;
}

export async function listMarketplaceSkills(
  marketplace: SkillMarketplace,
  query = "",
): Promise<MarketplaceSkill[]> {
  if (!marketplace.enabled) return [];
  const { owner, repo, branch, path: configuredPath } = repositoryUrl(marketplace);
  const effectiveBranch = marketplace.branch || branch;
  const tree = await githubJson<{ tree?: GitTreeItem[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(effectiveBranch)}?recursive=1`,
  );
  const skillFiles = (tree.tree ?? []).filter(
    (item) =>
      item.type === "blob" &&
      /(^|\/)SKILL\.md$/i.test(item.path) &&
      (!configuredPath || item.path.startsWith(`${configuredPath}/`)),
  );
  const needle = query.trim().toLocaleLowerCase();
  const skills = await Promise.all(
    skillFiles.map(async (file) => {
      const parent = file.path.split("/").at(-2) || basename(file.path, ".md");
      const sourcePath = validateSkillPath(file.path, configuredPath);
      const raw = await githubText(
        `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(effectiveBranch)}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
      );
      const parsed = parseSkillMarkdown(raw, parent);
      return {
        ...parsed,
        path: `marketplace:${marketplace.id}:${file.path}`,
        marketplaceId: marketplace.id,
        marketplaceName: marketplace.name,
        sourceUrl: marketplace.url,
        sourcePath,
        branch: effectiveBranch,
      } satisfies MarketplaceSkill;
    }),
  );
  return skills.filter(
    (skill) =>
      !needle ||
      `${skill.name} ${skill.description} ${skill.marketplaceName}`
        .toLocaleLowerCase()
        .includes(needle),
  );
}

export async function getMarketplaceSkillDetail(marketplaceId: string, sourcePath: string) {
  const marketplace = (await getSkillMarketplaces()).find((item) => item.id === marketplaceId);
  if (!marketplace) throw new Error("技能市场不存在");
  const { owner, repo, path: configuredPath } = repositoryUrl(marketplace);
  const branch = marketplace.branch || DEFAULT_BRANCH;
  const normalizedSourcePath = validateSkillPath(sourcePath, configuredPath);
  const raw = await githubText(
    `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${normalizedSourcePath.split("/").map(encodeURIComponent).join("/")}`,
  );
  const parent = normalizedSourcePath.split("/").at(-2) || basename(normalizedSourcePath, ".md");
  const parsed = parseSkillMarkdown(raw, parent);
  const prefix = normalizedSourcePath.slice(0, -"SKILL.md".length);
  const tree = await githubJson<{ tree?: GitTreeItem[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  const resources = (tree.tree ?? [])
    .filter(
      (item) =>
        item.type === "blob" && item.path.startsWith(prefix) && item.path !== normalizedSourcePath,
    )
    .map((item) => item.path.slice(prefix.length))
    .filter(Boolean);
  return {
    ...parsed,
    path: `marketplace:${marketplace.id}:${normalizedSourcePath}`,
    instructions: raw.replace(/^---\s*[\s\S]*?\s*---\s*/, "").trim(),
    references: resources
      .filter((item) => item.startsWith("references/"))
      .map((item) => item.slice("references/".length)),
    scripts: resources
      .filter((item) => item.startsWith("scripts/"))
      .map((item) => item.slice("scripts/".length)),
    assets: resources
      .filter((item) => item.startsWith("assets/"))
      .map((item) => item.slice("assets/".length)),
    marketplaceId: marketplace.id,
    marketplaceName: marketplace.name,
    sourceUrl: marketplace.url,
    sourcePath: normalizedSourcePath,
    branch,
  };
}

export async function installMarketplaceSkill(skill: MarketplaceSkill): Promise<string> {
  const marketplaces = await getSkillMarketplaces();
  const marketplace = marketplaces.find((item) => item.id === skill.marketplaceId);
  if (!marketplace) throw new Error("技能市场不存在或已被删除");
  const { owner, repo, path: configuredPath } = repositoryUrl(marketplace);
  const branch = marketplace.branch || DEFAULT_BRANCH;
  const sourcePath = validateSkillPath(skill.sourcePath, configuredPath);
  const root = join(getStorageDirectory() || PROJECT_ROOT, "skills", slug(skill.name));
  if (
    await access(root).then(
      () => true,
      () => false,
    )
  )
    throw new Error("该技能已经安装");
  await mkdir(root, { recursive: true });
  try {
    const raw = await githubText(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
    );
    await writeFile(join(root, "SKILL.md"), raw, "utf8");
    const fileBase = sourcePath.slice(0, -"SKILL.md".length);
    const tree = await githubJson<{ tree?: GitTreeItem[] }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    for (const item of tree.tree ?? []) {
      if (item.type !== "blob" || !item.path.startsWith(fileBase) || item.path === sourcePath)
        continue;
      const relativePath = item.path.slice(fileBase.length);
      if (!relativePath || relativePath.includes("..")) continue;
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        await githubText(
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
        ),
      );
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
