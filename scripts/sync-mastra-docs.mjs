#!/usr/bin/env node
// 从 mastra-ai/mastra 官方仓库同步教程文档到本地 docs/en。
// 用法: node scripts/sync-mastra-docs.mjs [--ref main] [--proxy http://127.0.0.1:7890] [--keep-temp]
// --ref   官方仓库的分支或 tag,默认 main
// --proxy 直连失败时使用的代理;不传则依次取 HTTPS_PROXY/HTTP_PROXY 环境变量,最后回退本机 7890

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const UPSTREAM_REPO = "https://github.com/mastra-ai/mastra.git";
const UPSTREAM_DOCS_DIR = "docs/src/content/en";
const LOCAL_DOCS_DIR = join("docs", "en");
const DEFAULT_REF = "main";
const FALLBACK_PROXY = "http://127.0.0.1:7890";

function parseArgs(argv) {
  const options = { ref: DEFAULT_REF, proxy: undefined, keepTemp: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--ref") options.ref = argv[(i += 1)];
    else if (argv[i] === "--proxy") options.proxy = argv[(i += 1)];
    else if (argv[i] === "--keep-temp") options.keepTemp = true;
    else throw new Error(`未知参数: ${argv[i]}`);
  }
  return options;
}

function log(message) {
  console.log(`[sync-mastra-docs] ${message}`);
}

function resolveProxy(options) {
  if (options.proxy) return options.proxy;
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    if (process.env[key]) return process.env[key];
  }
  return FALLBACK_PROXY;
}

function runGit(args, env) {
  const result = spawnSync("git", args, { env, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

// 用 blob 过滤 + 稀疏检出只拉取官方仓库的文档目录,远小于整包源码 zip。
function fetchUpstreamDocs(options) {
  const attempts = [{ label: "直连", proxy: undefined }];
  if (!options.proxy) attempts.push({ label: `代理 ${resolveProxy(options)}`, proxy: resolveProxy(options) });
  else attempts[0].proxy = options.proxy;

  const envBase = { ...process.env };
  let lastError = "";

  for (const attempt of attempts) {
    const env = { ...envBase };
    if (attempt.proxy) {
      for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) env[key] = attempt.proxy;
    }

    const tmpRoot = fs.mkdtempSync(join(os.tmpdir(), "mastra-docs-"));
    const repoDir = join(tmpRoot, "mastra");
    try {
      log(`${attempt.label}:浅克隆 ${UPSTREAM_REPO}(ref=${options.ref})`);
      const clone = runGit(
        ["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", options.ref, UPSTREAM_REPO, repoDir],
        env,
      );
      if (clone.status !== 0) throw new Error(clone.stderr.trim() || `git clone 退出码 ${clone.status}`);

      const sparse = runGit(["-C", repoDir, "sparse-checkout", "set", UPSTREAM_DOCS_DIR], env);
      if (sparse.status !== 0) throw new Error(sparse.stderr.trim() || `sparse-checkout 退出码 ${sparse.status}`);

      const upstreamDir = join(repoDir, ...UPSTREAM_DOCS_DIR.split("/"));
      if (!fs.existsSync(upstreamDir)) throw new Error(`ref ${options.ref} 上不存在 ${UPSTREAM_DOCS_DIR}`);

      const commit = runGit(["-C", repoDir, "rev-parse", "HEAD"], env);
      log(`已获取官方文档,commit ${commit.stdout.trim()}`);
      return { tmpRoot, upstreamDir, commit: commit.stdout.trim() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log(`${attempt.label}失败:${lastError.split("\n")[0]}`);
      removeTemp(tmpRoot);
    }
  }
  throw new Error(`无法拉取官方文档。${lastError}`);
}

function removeTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    if (process.platform === "win32") {
      spawnSync("attrib", ["-R", join(dir, "*"), "/S", "/D"]);
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        return;
      } catch {
        /* 交给调用方提示 */
      }
    }
    console.warn(`[sync-mastra-docs] 临时目录清理失败,可手动删除: ${dir}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// 以 " 相对路径 -> 内容哈希 " 记录目录快照,路径统一用 / 便于跨端比较。
function snapshot(dir) {
  const files = new Map();
  if (!fs.existsSync(dir)) return files;
  const walk = (rel) => {
    for (const entry of fs.readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.set(child, sha256(join(dir, ...child.split("/"))));
    }
  };
  walk("");
  return files;
}

const options = parseArgs(process.argv.slice(2));
const localDocsDir = join(projectRoot, LOCAL_DOCS_DIR);
const before = snapshot(localDocsDir);

const { tmpRoot, upstreamDir, commit } = fetchUpstreamDocs(options);
try {
  // 先复制到暂存目录,再整体替换,避免中途失败留下残缺的 docs/en。
  const stagingDir = join(projectRoot, "docs", ".en-sync-staging");
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.cpSync(upstreamDir, stagingDir, { recursive: true });
  fs.rmSync(localDocsDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, localDocsDir);

  fs.writeFileSync(
    join(projectRoot, "docs", ".mastra-docs-sync.json"),
    `${JSON.stringify({ source: "mastra-ai/mastra", ref: options.ref, commit, syncedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const after = snapshot(localDocsDir);
  let changed = 0;
  for (const [file, hash] of after) {
    if (before.has(file) && before.get(file) !== hash) changed += 1;
  }
  const added = [...after.keys()].filter((file) => !before.has(file)).length;
  const removed = [...before.keys()].filter((file) => !after.has(file)).length;
  log(`同步完成:新增 ${added},更新 ${changed},删除 ${removed},共 ${after.size} 个文件`);
  log(`来源 mastra-ai/mastra@${options.ref}(${commit.slice(0, 12)}),记录见 docs/.mastra-docs-sync.json`);
} finally {
  if (!options.keepTemp) removeTemp(tmpRoot);
  else console.warn(`[sync-mastra-docs] 保留临时目录: ${tmpRoot}`);
}
