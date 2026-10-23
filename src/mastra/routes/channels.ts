/**
 * 频道路由(/work/channels/*):配置读写、凭据探测、运行期状态,以及平台 Webhook 入口。
 * 官方文档:docs/en/docs/channels.mdx「Webhook routes」「Error handling and delivery」、
 * docs/en/reference/agents/channels.mdx。
 *
 * Webhook 路径固定为 `/api/agent-controllers/workbench/channels/<platform>/webhook`,
 * 与官方 AgentController 约定一致,平台侧直接填这个地址即可。
 * 桌面端是单用户本地服务,Webhook 必须公开(平台不会带桌面登录 Cookie),
 * 因此 requiresAuth: false,靠平台自己的签名 / secret token 校验请求来源。
 */
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { createPublicRoute, createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import {
  CHANNEL_PLATFORM_INFO,
  CHANNEL_PLATFORMS,
  ChannelConfigSchema,
  ChannelTestResultSchema,
} from "../../shared/channel-contract";
import { channelCredentialPurpose } from "../../shared/credential-contract";
import { getChannelConfig, saveChannelConfig } from "../channels/config";
import {
  channelRuntimeStatus,
  getChannelOwner,
  handleChannelWebhook,
  probeChannelAccount,
  setChannelOwner,
  syncChannelRuntime,
} from "../channels/runtime";
import { deleteCredential } from "../credential-broker";
import { workError, workValidationError } from "../errors";

const platformSchema = z.enum(CHANNEL_PLATFORMS);

/** GET /work/channels — 当前配置 + 平台目录 + 运行期状态。 */
export const channelsConfigRoute = createRoute({
  path: "/work/channels",
  method: "GET",
  responseType: "json",
  queryParamSchema: z.object({}).strict(),
  onValidationError: workValidationError,
  handler: async () => {
    const config = await getChannelConfig();
    return {
      config,
      platforms: CHANNEL_PLATFORMS.map((platform) => CHANNEL_PLATFORM_INFO[platform]),
      runtime: channelRuntimeStatus(),
    };
  },
});

/**
 * POST /work/channels — 写入配置并立即重建运行时。
 * 凭据明文已经由渲染层写入主进程金库,这里只接收引用。
 */
export const saveChannelsConfigRoute = createRoute({
  path: "/work/channels",
  method: "POST",
  responseType: "json",
  queryParamSchema: z.object({}).strict(),
  onValidationError: workValidationError,
  bodySchema: z.object({ config: ChannelConfigSchema }).strict(),
  handler: async ({ config, requestContext, mastra }) => {
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    const existingOwner = await getChannelOwner();
    if (existingOwner && existingOwner !== resourceId) throw workError("CHANNEL_OWNER_MISMATCH");
    const saved = await saveChannelConfig(config);
    // 频道线程归属当前登录用户:Webhook 请求没有身份,只能在这里固定租户。
    await setChannelOwner(resourceId);
    await syncChannelRuntime(mastra);
    return { config: saved, runtime: channelRuntimeStatus() };
  },
});

/** POST /work/channels/:platform/probe — 只验证凭据形状,不改变运行中的适配器。 */
export const probeChannelRoute = createRoute({
  path: "/work/channels/:platform/probe",
  method: "POST",
  responseType: "json",
  pathParamSchema: z.object({ platform: platformSchema }),
  queryParamSchema: z.object({}).strict(),
  onValidationError: workValidationError,
  bodySchema: z.object({ account: ChannelConfigSchema.shape.accounts.element }).strict(),
  handler: async ({ account }) => ChannelTestResultSchema.parse(await probeChannelAccount(account)),
});

/** POST /work/channels/:platform/refresh — 手工重建运行时(改完环境或凭据后)。 */
export const refreshChannelsRoute = createRoute({
  path: "/work/channels/refresh",
  method: "POST",
  responseType: "json",
  queryParamSchema: z.object({}).strict(),
  onValidationError: workValidationError,
  handler: async ({ mastra }) => {
    await syncChannelRuntime(mastra);
    return { runtime: channelRuntimeStatus() };
  },
});

/** DELETE /work/channels/:platform/secret/:field — 单独清除一个凭据槽位。 */
export const deleteChannelSecretRoute = createRoute({
  path: "/work/channels/:platform/secret/:field",
  method: "DELETE",
  responseType: "json",
  pathParamSchema: z.object({
    platform: platformSchema,
    field: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  }),
  queryParamSchema: z.object({}).strict(),
  onValidationError: workValidationError,
  handler: async ({ platform, field, mastra }) => {
    const config = await getChannelConfig();
    const account = config.accounts.find((candidate) => candidate.platform === platform);
    const state = account?.secrets[field];
    if (state?.hasCredential) {
      await deleteCredential(state.credentialRef, channelCredentialPurpose(platform, field)).catch(
        () => undefined,
      );
    }
    const next = {
      accounts: config.accounts.map((candidate) =>
        candidate.platform === platform
          ? {
              ...candidate,
              secrets: {
                ...candidate.secrets,
                [field]: { hasCredential: false as const },
              },
            }
          : candidate,
      ),
    };
    const saved = await saveChannelConfig(next);
    await syncChannelRuntime(mastra);
    return { config: saved, runtime: channelRuntimeStatus() };
  },
});

/**
 * Webhook:一个平台一条路由。
 * 用 createPublicRoute 显式绕过桌面登录鉴权 —— 平台无法携带 Cookie,
 * 请求可信度由适配器自己的签名校验决定(失败返回 401,平台会重投)。
 */
export const channelWebhookRoutes = CHANNEL_PLATFORMS.map((platform) =>
  createPublicRoute({
    path: `/agent-controllers/workbench/channels/${platform}/webhook`,
    method: "POST",
    responseType: "datastream-response",
    queryParamSchema: z.object({}).strict(),
    handler: async ({ request }) => {
      if (!request)
        return new Response(JSON.stringify({ error: "Request is unavailable" }), { status: 500 });
      return handleChannelWebhook(platform, request);
    },
  }),
);

/** 平台目录单独取,供 UI 首屏在配置读取失败时也能渲染表单。 */
export const channelPlatformsRoute = registerApiRoute("/work/channels/platforms", {
  method: "GET",
  handler: async () => Response.json({ platforms: Object.values(CHANNEL_PLATFORM_INFO) }),
});
