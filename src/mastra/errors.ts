/**
 * 工作台统一错误注册表。
 * 官方文档:docs/en/reference/configuration.mdx「server.onError」(全局错误出站)、
 * @mastra/core/error 的 MastraError({ id, domain, category, text } + toJSON())。
 *
 * 约定:
 * - 路由与业务层只 throw workError("<CODE>") / WorkApiError,不再手写
 *   c.json({ error }, status);HTTP 状态与响应形状由 onError 统一决定:
 *   { error: message, code, domain, category, details? } —— error 字段保持
 *   旧契约(前端现有读取不受影响),code 供渲染层翻译成用户语言。
 * - 错误码按模块分组命名:<模块>_<情况>;官方 ErrorDomain 对齐模块归属,
 *   ErrorCategory 对齐 USER(请求侧问题)/ SYSTEM(服务侧问题)/
 *   THIRD_PARTY(上游服务问题)。
 */
import { ErrorCategory, ErrorDomain, MastraError } from "@mastra/core/error";

interface WorkErrorDefinition {
  /** 官方错误域(ErrorDomain) */
  domain: ErrorDomain;
  /** 官方错误类别(ErrorCategory) */
  category: ErrorCategory;
  /** HTTP 状态码(onError 出站用,Hono ContentfulStatusCode 字面量联合) */
  status: WorkHttpStatus;
  /** 默认错误文本;可用 workError(code, { text }) 覆盖为动态详情 */
  text: string;
}

/** 本注册表允许的 HTTP 状态(Hono c.json 的 ContentfulStatusCode 子集) */
type WorkHttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502;

// ---------------------------------------------------------------------------
// 按模块注册(与 src/mastra 的目录结构一一对应)
// ---------------------------------------------------------------------------

export const WORK_ERRORS = {
  // ---- 通用校验(server/,所有路由共用的入参检查)------------------------
  VALIDATION_RESOURCE_ID_REQUIRED: {
    domain: ErrorDomain.MASTRA_SERVER,
    category: ErrorCategory.USER,
    status: 400,
    text: "resourceId is required",
  },
  VALIDATION_INVALID_JSON: {
    domain: ErrorDomain.MASTRA_SERVER,
    category: ErrorCategory.USER,
    status: 400,
    text: "请求体必须是 JSON",
  },
  VALIDATION_FAILED: {
    domain: ErrorDomain.MASTRA_SERVER,
    category: ErrorCategory.USER,
    status: 400,
    text: "请求参数无效",
  },
  AUTH_REQUIRED: {
    domain: ErrorDomain.MASTRA_SERVER,
    category: ErrorCategory.USER,
    status: 401,
    text: "需要登录",
  },
  AUTH_INVALID_CREDENTIALS: {
    domain: ErrorDomain.MASTRA_SERVER,
    category: ErrorCategory.USER,
    status: 401,
    text: "邮箱或密码错误",
  },
  AUTH_EMAIL_EXISTS: {
    domain: ErrorDomain.MASTRA_SERVER,
    category: ErrorCategory.USER,
    status: 409,
    text: "该邮箱已经注册",
  },
  AUTH_VALIDATION: {
    domain: ErrorDomain.MASTRA_SERVER,
    category: ErrorCategory.USER,
    status: 400,
    text: "注册信息无效",
  },

  // ---- 线程与记忆(server/routes/threads)-------------------------------
  THREAD_NOT_FOUND: {
    domain: ErrorDomain.MASTRA_MEMORY,
    category: ErrorCategory.USER,
    status: 404,
    text: "Thread not found",
  },
  MESSAGE_NOT_FOUND: {
    domain: ErrorDomain.MASTRA_MEMORY,
    category: ErrorCategory.USER,
    status: 404,
    text: "Message not found",
  },
  MESSAGE_EDIT_COMPACTED_ONLY: {
    domain: ErrorDomain.MASTRA_MEMORY,
    category: ErrorCategory.USER,
    status: 400,
    text: "Only compacted user messages can be edited",
  },
  MESSAGE_NOT_LATEST_COMPACTED: {
    domain: ErrorDomain.MASTRA_MEMORY,
    category: ErrorCategory.USER,
    status: 409,
    text: "Message is not part of the latest compacted history",
  },
  WORKING_MEMORY_REQUIRED: {
    domain: ErrorDomain.MASTRA_MEMORY,
    category: ErrorCategory.USER,
    status: 400,
    text: "workingMemory is required",
  },

  // ---- 会话运行时(server/routes/session,harness agent-controller)------
  SESSION_INPUT_REQUIRED: {
    domain: ErrorDomain.AGENT,
    category: ErrorCategory.USER,
    status: 400,
    text: "content is required",
  },
  SESSION_MESSAGE_REJECTED: {
    domain: ErrorDomain.AGENT,
    category: ErrorCategory.USER,
    status: 409,
    text: "The session could not start this message",
  },
  SESSION_RUN_ACTIVE: {
    domain: ErrorDomain.AGENT,
    category: ErrorCategory.USER,
    status: 409,
    text: "The previous run has not released the thread yet",
  },
  SESSION_FOLLOW_UP_BLOCKED: {
    domain: ErrorDomain.AGENT,
    category: ErrorCategory.USER,
    status: 409,
    text: "The follow-up was cancelled before it could be queued",
  },
  BACKGROUND_TASKS_DISABLED: {
    domain: ErrorDomain.AGENT,
    category: ErrorCategory.SYSTEM,
    status: 409,
    text: "Background tasks are not enabled",
  },
  BACKGROUND_TASK_NOT_FOUND: {
    domain: ErrorDomain.AGENT,
    category: ErrorCategory.USER,
    status: 404,
    text: "Background task not found",
  },
  WORKFLOW_NOT_FOUND: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 404,
    text: "Workflow not found",
  },
  WORKFLOW_RUN_NOT_FOUND: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 404,
    text: "Workflow run not found",
  },
  WORKFLOW_RUN_INVALID_STATE: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 409,
    text: "Workflow run cannot perform this operation in its current state",
  },

  // ---- 模型与供应商(models/)--------------------------------------------
  MODEL_NOT_CONFIGURED: {
    domain: ErrorDomain.MODEL_ROUTER,
    category: ErrorCategory.USER,
    status: 400,
    text: "所选模型未在服务端供应商配置中找到,请重新选择模型",
  },
  MODEL_SELECTION_REQUIRED: {
    domain: ErrorDomain.MODEL_ROUTER,
    category: ErrorCategory.USER,
    status: 400,
    text: "selection is required",
  },
  PROVIDER_MODELS_FETCH_FAILED: {
    domain: ErrorDomain.MODEL_ROUTER,
    category: ErrorCategory.THIRD_PARTY,
    status: 502,
    text: "拉取模型列表失败",
  },
  PROVIDER_CATALOG_UNAVAILABLE: {
    domain: ErrorDomain.MODEL_ROUTER,
    category: ErrorCategory.THIRD_PARTY,
    status: 502,
    text: "模型能力目录不可用",
  },

  // ---- 资料库(server/routes/library + rag/)----------------------------
  LIBRARY_ASSET_NOT_FOUND: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 404,
    text: "Asset not found",
  },
  LIBRARY_FOLDER_NOT_FOUND: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 404,
    text: "Folder not found",
  },
  LIBRARY_UPLOAD_SESSION_NOT_FOUND: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 404,
    text: "Upload session not found",
  },
  LIBRARY_FILE_TOO_LARGE: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 413,
    text: "File is too large",
  },
  LIBRARY_UPLOAD_FAILED: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 400,
    text: "上传失败",
  },

  // ---- 工作区(server/routes/workspace + workspace/)--------------------
  WORKSPACE_NOT_BROWSABLE: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 404,
    text: "Thread has no browsable workspace",
  },
  WORKSPACE_PATH_INVALID: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 400,
    text: "Invalid file path",
  },
  WORKSPACE_PATH_REQUIRED: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 400,
    text: "workspacePath must be an existing directory",
  },
  WORKSPACE_FILE_NOT_FOUND: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 404,
    text: "File not readable",
  },
  WORKSPACE_FILE_NOT_EDITABLE: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 400,
    text: "Path is not a file",
  },
  WORKSPACE_FILE_SAVE_FAILED: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 400,
    text: "File could not be saved",
  },
  WORKSPACE_FILE_BINARY: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 415,
    text: "Binary files cannot be edited",
  },
  WORKSPACE_FILE_TOO_LARGE: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 413,
    text: "File is too large to edit",
  },
  WORKSPACE_READ_ONLY: {
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    status: 403,
    text: "Workspace is read-only",
  },

  // ---- 技能(server/routes/skills + skills/)----------------------------
  SKILL_NOT_FOUND: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 404,
    text: "技能不存在",
  },
  SKILL_MARKETPLACE_NOT_FOUND: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 404,
    text: "技能市场不存在",
  },
  SKILL_ALREADY_INSTALLED: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 409,
    text: "该技能已经安装",
  },
  SKILL_PACKAGE_INVALID: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 400,
    text: "技能包无效",
  },
  SKILL_PACKAGE_TOO_LARGE: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 413,
    text: "技能包不能超过 25 MB",
  },
  SKILL_MANAGED_ONLY: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 403,
    text: "只能删除受管技能",
  },
  SKILL_INSTALL_FAILED: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.USER,
    status: 400,
    text: "安装技能失败",
  },
  SKILL_READ_FAILED: {
    domain: ErrorDomain.MASTRA,
    category: ErrorCategory.SYSTEM,
    status: 500,
    text: "读取技能失败",
  },

  // ---- MCP 连接(connections/)------------------------------------------
  MCP_CONFIG_MISSING: {
    domain: ErrorDomain.MCP,
    category: ErrorCategory.USER,
    status: 400,
    text: "缺少 MCP 服务配置",
  },
  MCP_CONFIG_INVALID: {
    domain: ErrorDomain.MCP,
    category: ErrorCategory.USER,
    status: 400,
    text: "MCP 配置无效",
  },
  MCP_SERVER_NOT_FOUND: {
    domain: ErrorDomain.MCP,
    category: ErrorCategory.USER,
    status: 404,
    text: "MCP 服务不存在",
  },
  MCP_CONNECTION_FAILED: {
    domain: ErrorDomain.MCP,
    category: ErrorCategory.THIRD_PARTY,
    status: 502,
    text: "MCP 服务连接失败",
  },

  // ---- 浏览器(server/routes/browser)-----------------------------------
  BROWSER_ACTION_UNSUPPORTED: {
    domain: ErrorDomain.TOOL,
    category: ErrorCategory.USER,
    status: 400,
    text: "Unsupported browser action",
  },
  BROWSER_SESSION_NOT_FOUND: {
    domain: ErrorDomain.TOOL,
    category: ErrorCategory.USER,
    status: 404,
    text: "Browser session not found",
  },
} as const satisfies Record<string, WorkErrorDefinition>;

export type WorkErrorCode = keyof typeof WORK_ERRORS;

/**
 * 带 HTTP 状态的 MastraError:路由 throw,onError 统一序列化。
 * text/details 可覆盖默认文案,用于携带动态上下文(上游 URL、原因等)。
 */
export class WorkApiError extends MastraError {
  readonly status: WorkHttpStatus;
  constructor(
    code: WorkErrorCode,
    options: { text?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    const definition = WORK_ERRORS[code];
    super(
      {
        id: code,
        domain: definition.domain,
        category: definition.category,
        ...(options.text ? { text: options.text } : {}),
        ...(options.details ? { details: options.details as Record<string, never> } : {}),
      },
      options.cause,
    );
    this.status = definition.status;
  }
}

/** 路由与业务层的统一抛错入口:throw workError("THREAD_NOT_FOUND") */
export function workError(
  code: WorkErrorCode,
  options: { text?: string; details?: Record<string, unknown>; cause?: unknown } = {},
): WorkApiError {
  return new WorkApiError(code, options);
}
