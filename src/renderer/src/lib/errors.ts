/**
 * 渲染层统一错误处理:错码翻译 + toast 出口 + 响应载荷解析。
 * 与后端契约一一对应:src/mastra/errors.ts(WORK_ERRORS 注册表)经官方
 * server.onError(docs/en/reference/configuration.mdx)出站为
 * { error, code, domain, category, details? }。
 *
 * 用法:catch 里调 toastError(error, "可选的中文上下文前缀")——
 * 有 code 走翻译表给用户可读的标题与行动建议,无 code 回落原始 message;
 * 开发日志(console.error)也集中在这里,业务组件不再各自 console/toast。
 */
import { toast } from "sonner";

/** 后端错误响应载荷(server.onError 出站形状) */
export interface WorkErrorPayload {
  error?: string;
  code?: string;
  domain?: string;
  category?: string;
  details?: Record<string, unknown>;
}

/** 错码 → 面向用户的标题与行动建议(按模块分组,与后端注册表同步维护) */
const ERROR_TRANSLATIONS: Record<string, { title: string; hint?: string }> = {
  // ---- 通用校验 ----------------------------------------------------------
  VALIDATION_RESOURCE_ID_REQUIRED: { title: "请求缺少用户标识,请刷新页面后重试" },
  VALIDATION_INVALID_JSON: { title: "请求格式错误", hint: "请刷新页面后重试" },
  VALIDATION_FAILED: { title: "请求参数无效" },

  // ---- 线程与记忆 --------------------------------------------------------
  THREAD_NOT_FOUND: { title: "会话不存在或已被删除", hint: "请回到会话列表重新打开" },
  MESSAGE_NOT_FOUND: { title: "消息不存在或已被删除" },
  MESSAGE_EDIT_COMPACTED_ONLY: {
    title: "只能编辑压缩历史里的用户消息",
    hint: "请选择未压缩的普通消息重试",
  },
  MESSAGE_NOT_LATEST_COMPACTED: {
    title: "这条消息不在最新的压缩历史里",
    hint: "压缩记录已更新,请刷新会话后重试",
  },
  WORKING_MEMORY_REQUIRED: { title: "缺少工作记忆内容" },

  // ---- 会话运行时 --------------------------------------------------------
  SESSION_INPUT_REQUIRED: { title: "消息内容不能为空" },
  SESSION_MESSAGE_REJECTED: {
    title: "会话暂时无法接收这条消息",
    hint: "上一次运行可能尚未结束,请稍候或先停止当前运行",
  },
  SESSION_RUN_ACTIVE: {
    title: "上一条消息还在处理中",
    hint: "等待完成、停止当前运行,或使用追加消息排队",
  },
  SESSION_FOLLOW_UP_BLOCKED: { title: "追加消息未能加入队列", hint: "请稍后重试" },

  // ---- 模型与供应商 ------------------------------------------------------
  MODEL_NOT_CONFIGURED: {
    title: "所选模型不可用",
    hint: "请到「设置 → 模型供应商」重新选择或配置模型",
  },
  MODEL_SELECTION_REQUIRED: { title: "请先选择一个模型" },
  PROVIDER_MODELS_FETCH_FAILED: {
    title: "拉取模型列表失败",
    hint: "检查 API Key、Base URL 与网络代理后重试",
  },
  PROVIDER_CATALOG_UNAVAILABLE: {
    title: "模型能力目录暂不可用",
    hint: "不影响模型使用,仅缺少能力徽章",
  },

  // ---- 资料库 ------------------------------------------------------------
  LIBRARY_ASSET_NOT_FOUND: { title: "文件不存在或已被删除" },
  LIBRARY_FOLDER_NOT_FOUND: { title: "文件夹不存在或已被删除" },
  LIBRARY_UPLOAD_SESSION_NOT_FOUND: { title: "上传会话已失效", hint: "请重新上传" },
  LIBRARY_FILE_TOO_LARGE: { title: "文件超出大小限制" },
  LIBRARY_UPLOAD_FAILED: { title: "上传失败", hint: "请重试;持续失败请检查存储位置" },

  // ---- 工作区 ------------------------------------------------------------
  WORKSPACE_NOT_BROWSABLE: {
    title: "该会话没有可浏览的工作区",
    hint: "发送首条消息时选择本地目录后才能浏览文件",
  },
  WORKSPACE_PATH_INVALID: { title: "文件路径无效" },
  WORKSPACE_PATH_REQUIRED: { title: "工作区目录不存在", hint: "请重新选择目录" },
  WORKSPACE_FILE_NOT_FOUND: { title: "文件不存在或不可读" },
  WORKSPACE_FILE_NOT_EDITABLE: { title: "该路径不是可编辑的文件" },
  WORKSPACE_FILE_SAVE_FAILED: { title: "保存失败", hint: "请检查文件权限后重试" },
  WORKSPACE_FILE_TOO_LARGE: { title: "文件过大,编辑器无法打开" },
  WORKSPACE_FILE_BINARY: { title: "二进制文件不能在编辑器中打开" },
  WORKSPACE_READ_ONLY: { title: "工作区处于只读模式", hint: "到「设置 → 工作区」关闭只读" },

  // ---- 技能 --------------------------------------------------------------
  SKILL_NOT_FOUND: { title: "技能不存在或已被删除" },
  SKILL_MARKETPLACE_NOT_FOUND: { title: "技能市场不存在或已被删除" },
  SKILL_ALREADY_INSTALLED: { title: "该技能已安装" },
  SKILL_PACKAGE_INVALID: { title: "技能包无效", hint: "请确认包内含 SKILL.md 且结构完整" },
  SKILL_PACKAGE_TOO_LARGE: { title: "技能包不能超过 25 MB" },
  SKILL_MANAGED_ONLY: { title: "只能删除通过应用安装的受管技能" },
  SKILL_INSTALL_FAILED: { title: "安装技能失败", hint: "请重试或更换技能来源" },
  SKILL_READ_FAILED: { title: "读取技能失败" },

  // ---- MCP 连接 ----------------------------------------------------------
  MCP_CONFIG_MISSING: { title: "缺少 MCP 服务配置" },
  MCP_CONFIG_INVALID: { title: "MCP 配置无效", hint: "请检查地址、命令与参数格式" },
  MCP_SERVER_NOT_FOUND: { title: "MCP 服务不存在或已被删除" },
  MCP_CONNECTION_FAILED: { title: "MCP 服务连接失败", hint: "检查网络与凭据后重新测试" },

  // ---- 浏览器 ------------------------------------------------------------
  BROWSER_ACTION_UNSUPPORTED: { title: "不支持的浏览器操作" },
  BROWSER_SESSION_NOT_FOUND: { title: "浏览器会话不存在", hint: "请先让助手启动浏览器" },

  // ---- 内部错误 ----------------------------------------------------------
  INTERNAL_ERROR: { title: "服务内部错误", hint: "请重试;持续出现请重启应用" },
};

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
  const translated = body.code ? ERROR_TRANSLATIONS[body.code] : undefined;
  // 翻译标题与原始报文一致时(注册表默认文案原样透出),不重复展示 detail
  const detail =
    translated && rawMessage && translated.title !== rawMessage ? rawMessage : undefined;
  if (translated) return detail ? { ...translated, detail } : translated;
  return { title: rawMessage ?? "发生未知错误" };
}

/**
 * 统一错误 toast 出口。
 * @param error Error / WorkErrorPayload / 字符串
 * @param context 可选的中文上下文前缀,如 "删除技能失败"(显示为「删除技能失败：标题」)
 */
export function toastError(error: unknown, context?: string): DescribedError {
  const described = describeError(error);
  const title = context ? `${context}：${described.title}` : described.title;
  const lines = [title];
  if (described.hint) lines.push(described.hint);
  if (described.detail) lines.push(described.detail);
  toast.error(lines.join("\n"));
  // 开发日志集中于此:业务组件不再各自 console.error
  console.error("[work-error]", {
    title,
    hint: described.hint,
    detail: described.detail,
    raw: error,
  });
  return described;
}
