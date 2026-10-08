import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import {
  marketplaceQuerySchema,
  marketplaceSourceSchema,
  pluginConfigurationPatchSchema,
  pluginIdSchema,
  pluginSourceSchema,
} from "../../shared/plugin-contract";
import { workError, workValidationError } from "../errors";
import {
  getMarketplaceListing,
  getMarketplaceStatuses,
  getPluginCatalog,
  getPluginMarketplaces,
  removePluginMarketplace,
  savePluginMarketplace,
} from "../plugins/marketplaces";
import {
  archiveFiles,
  describePackage,
  MAX_PACKAGE_BYTES,
  packagePath,
  selectPackageRoot,
  withinRoot,
} from "../plugins/packages";

import {
  checkPluginUpdate,
  createLocalPluginCopy,
  fetchPluginFiles,
  getInstalledPlugin,
  installPlugin,
  listInstalledPlugins,
  listPluginSkills,
  pluginVersionDirectory,
  previewPluginUpload,
  rollbackPlugin,
  savePluginConfiguration,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
} from "../plugins/registry";
import { getSkillsShAudit } from "../skills/marketplaces";
import { type RequestContextLike, userIdFromContext } from "../storage/database";

function owner(context: RequestContextLike): string {
  const id = userIdFromContext(context);
  if (!id) throw workError("AUTH_REQUIRED");
  return id;
}
const idPath = z.object({ id: pluginIdSchema });

async function readPluginUpload(request: Request) {
  if (!request.body) throw workError("VALIDATION_FAILED", { text: "Missing plugin ZIP" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > MAX_PACKAGE_BYTES + 1024 * 1024)
      throw workError("VALIDATION_FAILED", { text: "Plugin upload exceeds 25 MB" });
    chunks.push(chunk);
  }
  const form = await new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: Buffer.concat(chunks, size),
  }).formData();
  const file = form.get("archive");
  for (const key of form.keys())
    if (key !== "archive" && key !== "digest")
      throw workError("VALIDATION_FAILED", { text: "Unknown plugin upload field" });
  if (!(file instanceof File) || file.size > MAX_PACKAGE_BYTES)
    throw workError("VALIDATION_FAILED", { text: "Upload a plugin ZIP smaller than 25 MB" });
  return {
    file,
    files: selectPackageRoot(archiveFiles(Buffer.from(await file.arrayBuffer()))),
    digest: form.get("digest"),
  };
}
const common = { responseType: "json", onValidationError: workValidationError } as const;

export const pluginRoutes = [
  createRoute({
    ...common,
    path: "/work/plugins/skills-sh/audit",
    method: "GET",
    queryParamSchema: z.object({
      source: z.string().trim().min(1).max(180),
      slug: z.string().trim().min(1).max(180),
    }),
    handler: async ({ source, slug }) => ({ audits: await getSkillsShAudit(source, slug) }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins",
    method: "GET",
    queryParamSchema: z.object({}).strict(),
    handler: async ({ requestContext }) => ({
      plugins: await listInstalledPlugins(owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/skills",
    method: "GET",
    queryParamSchema: z.object({}).strict(),
    handler: async ({ requestContext }) => ({
      skills: await listPluginSkills(owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/marketplaces",
    method: "GET",
    queryParamSchema: z.object({}).strict(),
    handler: async ({ requestContext }) => {
      const resourceId = owner(requestContext);
      const sources = await getPluginMarketplaces(resourceId);
      return { sources, statuses: await getMarketplaceStatuses(sources, resourceId) };
    },
  }),
  createRoute({
    ...common,
    path: "/work/plugins/marketplaces",
    method: "POST",
    bodySchema: z.object({ source: marketplaceSourceSchema }),
    handler: async ({ source, requestContext }) => ({
      source: await savePluginMarketplace(source, owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/marketplaces/:id",
    method: "DELETE",
    pathParamSchema: idPath,
    handler: async ({ id, requestContext }) => {
      await removePluginMarketplace(id, owner(requestContext));
      return { ok: true };
    },
  }),
  createRoute({
    ...common,
    path: "/work/plugins/marketplaces/:id/catalog",
    method: "GET",
    pathParamSchema: idPath,
    queryParamSchema: marketplaceQuerySchema.extend({ refresh: z.enum(["0", "1"]).default("0") }),
    handler: ({ id, refresh, requestContext, view, page, curated, owner: ownerFilter, query }) =>
      getPluginCatalog(id, owner(requestContext), refresh === "1", {
        view,
        page,
        curated,
        owner: ownerFilter,
        query,
      }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/marketplaces/:id/preview",
    method: "GET",
    pathParamSchema: idPath,
    queryParamSchema: z.object({ key: z.string().min(1) }),
    handler: async ({ id, key, requestContext, abortSignal }) => {
      const listing = await getMarketplaceListing(id, key, owner(requestContext));
      const acquired = await fetchPluginFiles(listing.source, abortSignal);
      return { listing, preview: describePackage(acquired.files, listing.id, listing) };
    },
  }),
  createRoute({
    ...common,
    path: "/work/plugins/install",
    method: "POST",
    bodySchema: z.object({ source: pluginSourceSchema }),
    handler: async ({ source, requestContext }) => ({
      plugin: await installPlugin({ source }, owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/marketplaces/:id/install",
    method: "POST",
    pathParamSchema: idPath,
    bodySchema: z.object({ key: z.string().min(1) }),
    handler: async ({ id, key, requestContext }) => {
      const resourceId = owner(requestContext);
      const listing = await getMarketplaceListing(id, key, resourceId);
      return { plugin: await installPlugin({ source: listing.source, listing }, resourceId) };
    },
  }),
  registerApiRoute("/work/plugins/upload", {
    method: "POST",
    handler: async (c) => {
      const resourceId = owner(c.get("requestContext"));
      const { file, files } = await readPluginUpload(c.req.raw);
      return c.json(
        {
          plugin: await installPlugin(
            { source: { kind: "upload", filename: file.name }, files },
            resourceId,
          ),
        },
        201,
      );
    },
  }),
  registerApiRoute("/work/plugins/:id/upload", {
    method: "POST",
    handler: async (c) => {
      const resourceId = owner(c.get("requestContext"));
      const id = pluginIdSchema.parse(c.req.param("id"));
      const plugin = await getInstalledPlugin(id, resourceId);
      if (plugin?.source.kind !== "upload")
        throw workError("VALIDATION_FAILED", { text: "Select an installed ZIP plugin" });
      const { files, digest } = await readPluginUpload(c.req.raw);
      if (digest !== null)
        return c.json({
          plugin: await updatePlugin(
            id,
            z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(digest),
            resourceId,
            files,
          ),
        });
      return c.json(await previewPluginUpload(id, files, resourceId));
    },
  }),
  createRoute({
    ...common,
    path: "/work/plugins/check-updates",
    method: "POST",
    handler: async ({ requestContext }) => {
      const resourceId = owner(requestContext);
      const plugins = await listInstalledPlugins(resourceId);
      const results = [];
      for (const plugin of plugins) results.push(await checkPluginUpdate(plugin.id, resourceId));
      return { plugins: results };
    },
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id",
    method: "GET",
    pathParamSchema: idPath,
    handler: async ({ id, requestContext }) => {
      const plugin = await getInstalledPlugin(id, owner(requestContext));
      if (!plugin) throw workError("SKILL_NOT_FOUND");
      return { plugin };
    },
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id/enabled",
    method: "PUT",
    pathParamSchema: idPath,
    bodySchema: z.object({ enabled: z.boolean(), componentId: pluginIdSchema.optional() }),
    handler: async ({ id, enabled, componentId, requestContext }) => ({
      plugin: await setPluginEnabled(id, enabled, componentId, owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id/configuration",
    method: "PUT",
    pathParamSchema: idPath,
    bodySchema: pluginConfigurationPatchSchema,
    handler: async ({ id, requestContext, digest, revision, values, secretPatch }) => ({
      plugin: await savePluginConfiguration(
        id,
        { digest, revision, values, secretPatch },
        owner(requestContext),
      ),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id/check-update",
    method: "POST",
    pathParamSchema: idPath,
    handler: async ({ id, requestContext }) => ({
      plugin: await checkPluginUpdate(id, owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id/update",
    method: "POST",
    pathParamSchema: idPath,
    bodySchema: z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }),
    handler: async ({ id, digest, requestContext }) => ({
      plugin: await updatePlugin(id, digest, owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id/rollback",
    method: "POST",
    pathParamSchema: idPath,
    handler: async ({ id, requestContext }) => ({
      plugin: await rollbackPlugin(id, owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id",
    method: "DELETE",
    pathParamSchema: idPath,
    queryParamSchema: z.object({ removeData: z.enum(["0", "1"]).default("0") }),
    handler: async ({ id, removeData, requestContext }) => {
      await uninstallPlugin(id, removeData === "1", owner(requestContext));
      return { ok: true };
    },
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id/local-copy",
    method: "POST",
    pathParamSchema: idPath,
    bodySchema: z.object({ target: z.string().min(1) }).strict(),
    handler: async ({ id, target, requestContext }) => ({
      path: await createLocalPluginCopy(id, target, owner(requestContext)),
    }),
  }),
  createRoute({
    ...common,
    path: "/work/plugins/:id/file",
    method: "GET",
    pathParamSchema: idPath,
    queryParamSchema: z.object({ path: z.string().min(1) }),
    handler: async ({ id, path, requestContext }) => {
      const resourceId = owner(requestContext);
      const plugin = await getInstalledPlugin(id, resourceId);
      if (!plugin) throw workError("SKILL_NOT_FOUND");
      const file = withinRoot(
        join(pluginVersionDirectory(plugin, resourceId), "source"),
        packagePath(path),
      );
      const content = await readFile(file);
      if (content.length > 1024 * 1024)
        throw workError("VALIDATION_FAILED", { text: "Preview is limited to 1 MB" });
      return { content: content.toString("utf8") };
    },
  }),
];
