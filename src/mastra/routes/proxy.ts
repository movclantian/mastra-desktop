/**
 * 网络代理运行时路由(/work/proxy/*):查询当前生效代理、动态切换全局 Dispatcher、出站连通性测试。
 */
import { registerApiRoute } from "@mastra/core/server";
import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from "undici";
import { errorText } from "../errors";

let currentProxyUrl: string | undefined =
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy;

export const proxyGetRoute = registerApiRoute("/work/proxy", {
  method: "GET",
  handler: async (c) => {
    return c.json({
      active: Boolean(currentProxyUrl),
      proxyUrl: currentProxyUrl ?? null,
    });
  },
});

export const proxySetRoute = registerApiRoute("/work/proxy", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as { mode?: "system" | "direct" | "manual"; url?: string };
    const mode = body.mode ?? "system";
    const url = body.url?.trim();

    if (mode === "direct" || (!url && mode === "manual")) {
      currentProxyUrl = undefined;
      for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
        delete process.env[key];
      }
      setGlobalDispatcher(new Agent());
    } else if (url) {
      currentProxyUrl = url;
      process.env.HTTPS_PROXY = url;
      process.env.HTTP_PROXY = url;
      process.env.https_proxy = url;
      process.env.http_proxy = url;
      setGlobalDispatcher(new EnvHttpProxyAgent());
    } else {
      // system: EnvHttpProxyAgent 会自动根据环境中的系统代理配置分发
      setGlobalDispatcher(new EnvHttpProxyAgent());
    }
    return c.json({
      ok: true,
      active: Boolean(currentProxyUrl),
      proxyUrl: currentProxyUrl ?? null,
    });
  },
});

export const proxyTestRoute = registerApiRoute("/work/proxy/test", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as { url?: string };
    const proxyUrl = body.url?.trim();
    const testUrl = "https://models.dev/api.json";
    const start = Date.now();
    try {
      const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new EnvHttpProxyAgent();
      const resp = await fetch(testUrl, {
        dispatcher,
        signal: AbortSignal.timeout(8_000),
      } as RequestInit);
      const latencyMs = Date.now() - start;
      if (resp.ok || resp.status < 500) {
        return c.json({ ok: true, latencyMs });
      }
      return c.json({ ok: false, error: `HTTP ${resp.status} ${resp.statusText}` }, 400);
    } catch (error) {
      return c.json({ ok: false, error: errorText(error, "代理连通性测试失败") }, 400);
    }
  },
});

export const proxyRoutes = [proxyGetRoute, proxySetRoute, proxyTestRoute];
