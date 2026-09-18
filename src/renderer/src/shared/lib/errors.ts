/**
 * 渲染层统一错误处理:错码翻译 + toast 出口 + 响应载荷解析。
 * 与后端契约一一对应:src/mastra/errors.ts(WORK_ERRORS 注册表)经官方
 * server.onError(docs/en/reference/configuration.mdx)出站为
 * { error, code, domain, category, details? }。
 */
import { toast } from "sonner";
import { i18n } from "@/shared/i18n";

/** 后端错误响应载荷(server.onError 出站形状) */
export interface WorkErrorPayload {
  error?: string;
  code?: string;
  domain?: string;
  category?: string;
  details?: Record<string, unknown>;
}

/** 解析失败的 HTTP 响应,取出服务端统一错误载荷(兼容旧的无 code 形状);error 恒有值 */
export async function readErrorPayload(
  response: Response,
  fallback: string,
): Promise<WorkErrorPayload & { error: string; fallback: string }> {
  try {
    const body = (await response.json()) as WorkErrorPayload;
    if (body && typeof body === "object" && typeof body.error === "string" && body.error) {
      return { ...body, error: body.error, fallback };
    }
  } catch {
    // 非 JSON 响应(代理错误页等),退回状态码
  }
  return { error: `${fallback}（HTTP ${response.status}）`, fallback };
}

/** 把响应载荷包装成携带 code 的 Error(throw 后由 toastError 翻译) */
export function apiError(payload: WorkErrorPayload, fallback: string): Error & WorkErrorPayload {
  const error = new Error(payload.error || fallback) as Error & WorkErrorPayload;
  if (payload.code) error.code = payload.code;
  if (payload.domain) error.domain = payload.domain;
  if (payload.category) error.category = payload.category;
  return error;
}

export interface DescribedError {
  /** 面向用户的主标题(翻译后) */
  title: string;
  /** 可行动的提示(可选) */
  hint?: string;
  /** 原始错误详情(上游报文等,展示为次要行) */
  detail?: string;
}

/** 把错误载荷 / Error / 未知错误翻译成用户可读的 { title, hint, detail } */
export function describeError(payload: WorkErrorPayload | unknown): DescribedError {
  const body = (payload ?? {}) as WorkErrorPayload;
  const rawMessage =
    typeof body.error === "string" && body.error
      ? body.error
      : payload instanceof Error && payload.message
        ? payload.message
        : undefined;

  let translated: { title: string; hint?: string } | undefined;
  if (body.code && i18n.exists(`errors:${body.code}.title`)) {
    translated = {
      title: i18n.t(`errors:${body.code}.title`),
      hint: i18n.exists(`errors:${body.code}.hint`)
        ? i18n.t(`errors:${body.code}.hint`)
        : undefined,
    };
  }

  const detail =
    translated && rawMessage && translated.title !== rawMessage ? rawMessage : undefined;
  if (translated) return detail ? { ...translated, detail } : translated;
  return { title: rawMessage ?? i18n.t("errors:unknownError") };
}

/**
 * 统一错误 toast 出口。
 */
export function toastError(error: unknown, context?: string): DescribedError {
  const described = describeError(error);
  const title =
    context && context !== described.title ? `${context}：${described.title}` : described.title;
  const lines = [title];
  if (described.hint) lines.push(described.hint);
  if (described.detail) lines.push(described.detail);
  toast.error(lines.join("\n"));
  console.error("[work-error]", {
    title,
    hint: described.hint,
    detail: described.detail,
    raw: error,
  });
  return described;
}
