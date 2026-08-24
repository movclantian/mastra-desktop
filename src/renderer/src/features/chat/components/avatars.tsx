import { WaypointsIcon } from "lucide-react";
import * as React from "react";
import { apiFetch } from "@/api/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

// ---------------------------------------------------------------------------
// 随机头像:https://v2.xxapi.cn/api/head 返回 JSON 包装
// { code, data: "https://images.xxapi.cn/..." },需先取 data 再渲染图片 URL。
// URL 按缓存键持久化到 localStorage(跨会话稳定,重启不再请求 API);图片用
// <img> 直接加载 —— <img> 不受 CORS 约束(该 CDN 不带 Access-Control-Allow-
// Origin,fetch 会失败),多实例渲染同一 URL 由浏览器 HTTP 缓存去重,仅一次
// 网络请求。助手固定一张;用户按 userId 分键,同一账号始终同一张。
// ---------------------------------------------------------------------------

function loadCachedHeadUrl(cacheKey: string): string | null {
  try {
    return localStorage.getItem(cacheKey);
  } catch {
    return null;
  }
}

const headUrlMemory = new Map<string, string>();
const headUrlPromises = new Map<string, Promise<string | null>>();
/** 已因图片加载失败重取过一次的键 —— 坏 URL 不该把请求拖成无限循环 */
const headUrlRetried = new Set<string>();

/** 丢弃某个键上已记住的 URL,下次挂载会重新向 API 取一张 */
function forgetHeadUrl(cacheKey: string) {
  try {
    localStorage.removeItem(cacheKey);
  } catch {
    /* 存储不可用时无需清理 */
  }
  headUrlMemory.delete(cacheKey);
  headUrlPromises.delete(cacheKey);
}

function fetchRandomHeadUrl(cacheKey: string): Promise<string | null> {
  let promise = headUrlPromises.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      // 已有持久化 URL(上次会话取到的)则直接复用,不请求随机头像 API
      const remoteUrl =
        loadCachedHeadUrl(cacheKey) ??
        (await apiFetch("https://v2.xxapi.cn/api/head")
          .then((r) => r.json() as Promise<{ data?: string }>)
          .then((body) => body.data ?? null)
          .catch(() => null));
      if (!remoteUrl) return null;
      try {
        localStorage.setItem(cacheKey, remoteUrl);
      } catch {
        /* 存储不可用时仅内存缓存 */
      }
      headUrlMemory.set(cacheKey, remoteUrl); // 后续挂载的实例同步命中,不闪 fallback 图标
      return remoteUrl;
    })();
    // 失败(null)不缓存 Promise:一次网络抖动/CSP 拦截不该把整个会话钉死在
    // fallback,下次组件挂载(或换线程)重新请求
    void promise.then((url) => {
      if (!url) headUrlPromises.delete(cacheKey);
    });
    headUrlPromises.set(cacheKey, promise);
  }
  return promise;
}

const RandomHeadAvatar = React.memo(function RandomHeadAvatar({
  alt,
  cacheKey,
  fallback,
  fallbackClassName,
}: {
  alt: string;
  cacheKey: string;
  fallback: React.ReactNode;
  fallbackClassName: string;
}) {
  const [headUrl, setHeadUrl] = React.useState<string | null>(headUrlMemory.get(cacheKey) ?? null);
  React.useEffect(() => {
    if (!headUrl) void fetchRandomHeadUrl(cacheKey).then(setHeadUrl);
  }, [cacheKey, headUrl]);

  return (
    <Avatar>
      {headUrl ? (
        <AvatarImage
          alt={alt}
          onError={() => {
            // 记住的 URL 指向第三方 CDN,它不保证长期有效。图挂了就丢掉这条记录
            // 重取一张,否则一次 404 会把这个键永久钉在 fallback 图标上。
            // 只重取一次:新取的还是坏图就安静退回 fallback,不做无限重试。
            if (headUrlRetried.has(cacheKey)) return;
            headUrlRetried.add(cacheKey);
            forgetHeadUrl(cacheKey);
            setHeadUrl(null);
          }}
          src={headUrl}
        />
      ) : null}
      <AvatarFallback className={fallbackClassName}>{fallback}</AvatarFallback>
    </Avatar>
  );
});

export const AssistantAvatar = React.memo(function AssistantAvatar() {
  return (
    <RandomHeadAvatar
      alt="MastraWork"
      cacheKey="mastra-work:assistant-head-url"
      fallback={<WaypointsIcon className="size-4" />}
      fallbackClassName="bg-sidebar-primary text-sidebar-primary-foreground"
    />
  );
});

export function UserAvatar({ userId }: { userId: string }) {
  return (
    <RandomHeadAvatar
      alt="用户头像"
      cacheKey={`mastra-work:user-head-url:${userId}`}
      fallback="我"
      fallbackClassName="bg-primary text-primary-foreground"
    />
  );
}
