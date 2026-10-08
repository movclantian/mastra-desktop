/**
 * 网络代理运行时路由(/work/proxy/*):查询当前生效代理、动态切换全局 Dispatcher、出站连通性测试。
 */
import { createRoute } from "@mastra/server/server-adapter";
import { Agent, EnvHttpProxyAgent, fetch, ProxyAgent, setGlobalDispatcher } from "undici";
import { z } from "zod";
import { MODELS_DEV_API_URL, TestProxyRequestSchema } from "../../shared/proxy-contract";
import { errorText, workValidationError } from "../errors";

let currentProxyUrl: string | undefined =
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy;

const proxyGetRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/proxy",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async () => {
    return {
      active: Boolean(currentProxyUrl),
      proxyUrl: currentProxyUrl ?? null,
    };
  },
});

const proxySetRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/proxy",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: TestProxyRequestSchema,
  handler: async (params) => {
    // Electron resolves system/manual/direct mode to this effective proxy URL.
    const { url } = params;
    for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      if (url) process.env[key] = url;
      else delete process.env[key];
    }
    setGlobalDispatcher(url ? new EnvHttpProxyAgent() : new Agent());
    currentProxyUrl = url;
    return {
      ok: true,
      active: Boolean(currentProxyUrl),
      proxyUrl: currentProxyUrl ?? null,
    };
  },
});

const proxyTestRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/proxy/test",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: TestProxyRequestSchema,
  handler: async (params) => {
    const proxyUrl = params.url;
    const testUrl = MODELS_DEV_API_URL;
    const start = Date.now();
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new EnvHttpProxyAgent();
    try {
      const resp = await fetch(testUrl, {
        dispatcher,
        signal: AbortSignal.timeout(8_000),
      });
      await resp.body?.cancel();
      const latencyMs = Date.now() - start;
      if (resp.ok || resp.status < 500) {
        return { ok: true, latencyMs };
      }
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    } catch (error) {
      return { ok: false, error: errorText(error, "代理连通性测试失败") };
    } finally {
      await dispatcher.close();
    }
  },
});

export const proxyRoutes = [proxyGetRoute, proxySetRoute, proxyTestRoute];
