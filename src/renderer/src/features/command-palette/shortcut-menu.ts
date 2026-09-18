import type { ComponentType } from "react";
import {
  BotIcon,
  CalendarClockIcon,
  FolderOpenIcon,
  KeyboardIcon,
  LaptopIcon,
  LibraryBigIcon,
  MoonIcon,
  NotebookPenIcon,
  PanelBottomOpenIcon,
  PanelRightOpenIcon,
  SearchIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquarePenIcon,
  SunMediumIcon,
  TerminalSquareIcon,
  WaypointsIcon,
} from "lucide-react";

/**
 * 快捷键业务分类
 */
export type ShortcutCategory = "general" | "navigation" | "workbench" | "appearance";

/**
 * 核心快捷键规范定义接口
 */
export interface ShortcutSpec {
  id: string;
  titleKey: string;
  defaultTitle: string;
  descKey: string;
  defaultDesc: string;
  category: ShortcutCategory;
  /** 快捷键组合，例如 ["Mod", "K"] 或 ["Mod", "Shift", "S"] */
  keys: string[];
  /** 备选快捷键组合，例如 ["?"] 或 ["Mod", "J"] */
  secondaryKeys?: string[];
  /** 快捷检索关键词 */
  keywords: string[];
  /** 是否允许在聚焦输入框/文本域时触发 (默认 false) */
  allowInInput?: boolean;
  /** 是否仅在具备激活会话或 /chat 视图下生效 */
  requiresChat?: boolean;
}

/**
 * 平台环境判断：macOS vs Windows/Linux
 */
export function isMacPlatform(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return /macintosh|mac os x/i.test(navigator.userAgent || "");
}

/**
 * 格式化单个按键符号
 */
export function formatKeySymbol(key: string, isMac: boolean): string {
  switch (key.toLowerCase()) {
    case "mod":
      return isMac ? "⌘" : "Ctrl";
    case "shift":
      return isMac ? "⇧" : "Shift";
    case "alt":
    case "opt":
      return isMac ? "⌥" : "Alt";
    case "ctrl":
      return "Ctrl";
    case "meta":
    case "cmd":
      return "⌘";
    case "enter":
      return "↵";
    case "escape":
    case "esc":
      return "Esc";
    case "backspace":
      return "⌫";
    case "arrowup":
    case "up":
      return "↑";
    case "arrowdown":
    case "down":
      return "↓";
    case "arrowleft":
    case "left":
      return "←";
    case "arrowright":
    case "right":
      return "→";
    case "slash":
    case "/":
      return "/";
    case "backquote":
    case "`":
      return "`";
    case "comma":
    case ",":
      return ",";
    case "?":
      return "?";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * 格式化整组快捷键显示文本（Mac 下紧凑符号连接，Win/Linux 下 + 拼接）
 */
export function formatShortcutDisplay(keys: string[], isMac: boolean): string {
  if (!keys || keys.length === 0) return "";
  if (isMac) {
    return keys.map((k) => formatKeySymbol(k, true)).join("");
  }
  return keys.map((k) => formatKeySymbol(k, false)).join("+");
}

/**
 * 判断当前事件触发源是否为输入类控件
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return Boolean(target.closest('.cm-editor, .xterm, [contenteditable="true"]'));
}

/**
 * 聚焦聊天输入框
 */
export function focusChatPromptInput(): boolean {
  if (typeof document === "undefined") return false;
  const promptInput = document.querySelector<HTMLTextAreaElement>(
    'textarea[data-slot="prompt-input"], textarea[name="prompt"], textarea',
  );
  if (promptInput) {
    promptInput.focus();
    const len = promptInput.value.length;
    promptInput.setSelectionRange(len, len);
    return true;
  }
  return false;
}

/**
 * 全键盘快捷键精准匹配检测
 */
export function matchesShortcut(
  event: KeyboardEvent,
  keys: string[],
  isMac: boolean = isMacPlatform(),
): boolean {
  let needsMod = false;
  let needsCtrl = false;
  let needsMeta = false;
  let needsShift = false;
  let needsAlt = false;
  let targetKey = "";

  for (const k of keys) {
    const lower = k.toLowerCase();
    if (lower === "mod") needsMod = true;
    else if (lower === "ctrl" || lower === "control") needsCtrl = true;
    else if (lower === "meta" || lower === "cmd" || lower === "command") needsMeta = true;
    else if (lower === "shift") needsShift = true;
    else if (lower === "alt" || lower === "opt" || lower === "option") needsAlt = true;
    else targetKey = lower;
  }

  // 1. 修饰键判断
  if (needsMod) {
    const hasMod = isMac ? event.metaKey || event.ctrlKey : event.ctrlKey || event.metaKey;
    if (!hasMod) return false;
  } else {
    if (needsCtrl && !event.ctrlKey) return false;
    if (needsMeta && !event.metaKey) return false;
    if (!needsCtrl && !needsMeta && (event.ctrlKey || event.metaKey)) return false;
  }

  if (needsShift) {
    if (!event.shiftKey) return false;
  } else {
    // 若未要求 Shift，但在非 ? 符号下按了 Shift 则不匹配
    if (event.shiftKey && targetKey !== "?") return false;
  }

  if (needsAlt) {
    if (!event.altKey) return false;
  } else {
    if (event.altKey) return false;
  }

  // 2. 主键判定
  if (!targetKey) return true;
  const evtKey = event.key.toLowerCase();
  if (evtKey === targetKey) return true;

  // 符号与键码别名容错
  if (targetKey === "`" && (evtKey === "`" || event.code === "Backquote")) return true;
  if (targetKey === "," && (evtKey === "," || event.code === "Comma")) return true;
  if (targetKey === "/" && (evtKey === "/" || event.code === "Slash")) return true;
  if (
    targetKey === "?" &&
    (evtKey === "?" || (event.shiftKey && (evtKey === "/" || event.code === "Slash")))
  ) {
    return true;
  }
  if (targetKey >= "0" && targetKey <= "9") {
    if (
      evtKey === targetKey ||
      event.code === `Digit${targetKey}` ||
      event.code === `Numpad${targetKey}`
    ) {
      return true;
    }
  }
  if (targetKey.length === 1 && targetKey >= "a" && targetKey <= "z") {
    if (event.code === `Key${targetKey.toUpperCase()}`) return true;
  }

  return false;
}

/**
 * 核心场景快捷键规范库 (Single Source of Truth)
 */
export const CORE_SHORTCUT_SPECS: ShortcutSpec[] = [
  // ---- 核心操作 (General) ------------------------------------------------
  {
    id: "command-palette",
    titleKey: "commandPalette:actionCommandPalette",
    defaultTitle: "打开全局命令面板",
    descKey: "commandPalette:actionCommandPaletteDesc",
    defaultDesc: "快速检索并执行系统命令、跳转页面与功能",
    category: "general",
    keys: ["Mod", "K"],
    keywords: ["command", "palette", "命令", "搜索", "面板", "quick", "action"],
    allowInInput: true,
  },
  {
    id: "new-task",
    titleKey: "commandPalette:actionNewTask",
    defaultTitle: "新建任务 / 会话",
    descKey: "commandPalette:actionNewTaskDesc",
    defaultDesc: "创建一个新的任务会话并进入聊天工作台",
    category: "general",
    keys: ["Mod", "N"],
    keywords: ["new", "task", "chat", "新建", "会话", "任务", "对话"],
    allowInInput: true,
  },
  {
    id: "search-messages",
    titleKey: "commandPalette:actionSearchMessages",
    defaultTitle: "检索会话消息与记忆",
    descKey: "commandPalette:actionSearchMessagesDesc",
    defaultDesc: "使用语义召回与关键词检索历史消息内容",
    category: "general",
    keys: ["Mod", "F"],
    keywords: ["search", "find", "message", "memory", "检索", "查找", "消息", "记忆"],
    allowInInput: true,
  },
  {
    id: "shortcuts-help",
    titleKey: "commandPalette:actionShortcutsHelp",
    defaultTitle: "查看快捷键指南",
    descKey: "commandPalette:actionShortcutsHelpDesc",
    defaultDesc: "查看所有核心场景的键盘加速规范与速查表",
    category: "general",
    keys: ["Mod", "/"],
    secondaryKeys: ["?"],
    keywords: ["shortcut", "keyboard", "help", "快捷键", "帮助", "指南", "速查"],
    allowInInput: false,
  },
  {
    id: "focus-input",
    titleKey: "commandPalette:actionFocusInput",
    defaultTitle: "聚焦对话输入框",
    descKey: "commandPalette:actionFocusInputDesc",
    defaultDesc: "快速将光标聚焦至当前会话的输入文本框",
    category: "general",
    keys: ["Mod", "L"],
    secondaryKeys: ["/"],
    keywords: ["focus", "input", "prompt", "输入框", "聚焦", "提问"],
    allowInInput: false,
    requiresChat: true,
  },

  // ---- 页面导航 (Navigation) ---------------------------------------------
  {
    id: "nav-chat",
    titleKey: "commandPalette:actionNavChat",
    defaultTitle: "前往对话工作台",
    descKey: "commandPalette:actionNavChatDesc",
    defaultDesc: "切换至 Agent 协同对话与任务执行视图",
    category: "navigation",
    keys: ["Mod", "1"],
    keywords: ["chat", "workbench", "对话", "聊天", "工作台"],
    allowInInput: true,
  },
  {
    id: "nav-skills",
    titleKey: "commandPalette:actionNavSkills",
    defaultTitle: "前往技能套件",
    descKey: "commandPalette:actionNavSkillsDesc",
    defaultDesc: "查看与配置已安装的 Agent 扩展技能",
    category: "navigation",
    keys: ["Mod", "2"],
    keywords: ["skill", "hub", "技能", "套件", "工具"],
    allowInInput: true,
  },
  {
    id: "nav-library",
    titleKey: "commandPalette:actionNavLibrary",
    defaultTitle: "前往知识资料库",
    descKey: "commandPalette:actionNavLibraryDesc",
    defaultDesc: "管理知识库向量文档与本地参考资料",
    category: "navigation",
    keys: ["Mod", "3"],
    keywords: ["library", "knowledge", "rag", "资料库", "知识库", "文档"],
    allowInInput: true,
  },
  {
    id: "nav-agents",
    titleKey: "commandPalette:actionNavAgents",
    defaultTitle: "前往智能体专家",
    descKey: "commandPalette:actionNavAgentsDesc",
    defaultDesc: "查看预置与自定义的专用智能体",
    category: "navigation",
    keys: ["Mod", "4"],
    keywords: ["agent", "bot", "智能体", "专家", "助手"],
    allowInInput: true,
  },
  {
    id: "nav-schedules",
    titleKey: "commandPalette:actionNavSchedules",
    defaultTitle: "前往任务调度",
    descKey: "commandPalette:actionNavSchedulesDesc",
    defaultDesc: "管理后台自动执行的 Cron 与定时任务",
    category: "navigation",
    keys: ["Mod", "5"],
    keywords: ["schedule", "cron", "timer", "调度", "定时", "计划"],
    allowInInput: true,
  },
  {
    id: "open-settings",
    titleKey: "commandPalette:actionOpenSettings",
    defaultTitle: "打开系统设置",
    descKey: "commandPalette:actionOpenSettingsDesc",
    defaultDesc: "配置模型供应商、API Key、本地工作区与偏好",
    category: "navigation",
    keys: ["Mod", ","],
    keywords: ["setting", "config", "provider", "设置", "配置", "模型", "首选项"],
    allowInInput: true,
  },

  // ---- 工作台与面板 (Workbench) ------------------------------------------
  {
    id: "toggle-sidebar",
    titleKey: "commandPalette:actionToggleSidebar",
    defaultTitle: "切换主导航侧边栏",
    descKey: "commandPalette:actionToggleSidebarDesc",
    defaultDesc: "展开或收起左侧任务与主导航菜单栏",
    category: "workbench",
    keys: ["Mod", "B"],
    keywords: ["sidebar", "toggle", "侧边栏", "折叠", "展开"],
    allowInInput: true,
  },
  {
    id: "toggle-workspace",
    titleKey: "commandPalette:actionToggleWorkspace",
    defaultTitle: "切换右侧工作区抽屉",
    descKey: "commandPalette:actionToggleWorkspaceDesc",
    defaultDesc: "展开或收起右侧文件树、预览与上下文抽屉",
    category: "workbench",
    keys: ["Mod", "Shift", "E"],
    secondaryKeys: ["Mod", "E"],
    keywords: ["workspace", "drawer", "files", "工作区", "抽屉", "文件树", "预览"],
    allowInInput: true,
    requiresChat: true,
  },
  {
    id: "toggle-terminal",
    titleKey: "commandPalette:actionToggleTerminal",
    defaultTitle: "切换底部终端抽屉",
    descKey: "commandPalette:actionToggleTerminalDesc",
    defaultDesc: "打开或隐藏集成终端命令行面板",
    category: "workbench",
    keys: ["Mod", "`"],
    secondaryKeys: ["Mod", "J"],
    keywords: ["terminal", "console", "cmd", "终端", "命令行", "控制台"],
    allowInInput: true,
    requiresChat: true,
  },
  {
    id: "thread-summary",
    titleKey: "commandPalette:actionThreadSummary",
    defaultTitle: "提取会话纪要与待办",
    descKey: "commandPalette:actionThreadSummaryDesc",
    defaultDesc: "一键提炼整段对话的核心纪要与待办事项",
    category: "workbench",
    keys: ["Mod", "Shift", "S"],
    keywords: ["summary", "todo", "extract", "纪要", "总结", "待办", "提炼"],
    allowInInput: true,
    requiresChat: true,
  },
  {
    id: "open-in-ide",
    titleKey: "commandPalette:actionOpenInIde",
    defaultTitle: "在外部 IDE 打开工作区",
    descKey: "commandPalette:actionOpenInIdeDesc",
    defaultDesc: "在 VS Code 等本地编辑器中打开当前工作区目录",
    category: "workbench",
    keys: ["Mod", "Shift", "O"],
    keywords: ["ide", "vscode", "code", "cursor", "editor", "外部", "编辑器"],
    allowInInput: true,
    requiresChat: true,
  },

  // ---- 外观与偏好 (Appearance) -------------------------------------------
  {
    id: "toggle-theme",
    titleKey: "commandPalette:actionToggleTheme",
    defaultTitle: "切换深色 / 浅色模式",
    descKey: "commandPalette:actionToggleThemeDesc",
    defaultDesc: "在明亮与暗黑色彩模式之间快速切换",
    category: "appearance",
    keys: ["Mod", "Shift", "D"],
    keywords: ["theme", "dark", "light", "color", "mode", "深色", "浅色", "主题", "模式"],
    allowInInput: true,
  },
  {
    id: "theme-customize",
    titleKey: "commandPalette:actionThemeCustomize",
    defaultTitle: "主题参数调优…",
    descKey: "commandPalette:actionThemeCustomizeDesc",
    defaultDesc: "微调界面主题色调、对比度与圆角参数",
    category: "appearance",
    keys: [],
    keywords: ["theme", "preset", "color", "customize", "主题", "配色", "调优"],
    allowInInput: true,
  },
];

/**
 * 命令面板动作执行上下文
 */
export interface CommandActionContext {
  navigate: (params: { to: string; search?: Record<string, unknown> }) => void;
  activeView: string;
  activeThreadId: string | null;
  createNewThread: () => void | Promise<unknown>;
  toggleSidebar: () => void;
  toggleWorkspacePanel: () => void;
  toggleTerminalPanel: () => void;
  openSearchMessages: () => void;
  openShortcutsHelp: () => void;
  openThreadSummary: () => void;
  openInIde: () => void;
  toggleThemeMode: () => void;
  focusChatInput: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  isMac: boolean;
}

/**
 * 命令面板项定义 (与 shadcn CommandItem 对接)
 */
export interface ShortcutMenuItem {
  id: string;
  label: string;
  description?: string;
  icon: ComponentType<{ className?: string }>;
  shortcutDisplay: string;
  shortcutKeys: string[];
  secondaryShortcutDisplay?: string;
  keywords: string[];
  disabled?: boolean;
  category: ShortcutCategory;
  onSelect: () => void;
}

/**
 * 命令面板分组定义 (与 shadcn CommandGroup 对接)
 */
export interface ShortcutMenuGroup {
  id: ShortcutCategory;
  heading: string;
  items: ShortcutMenuItem[];
}

/**
 * 图标映射表
 */
const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  "command-palette": SearchIcon,
  "new-task": SquarePenIcon,
  "search-messages": SearchIcon,
  "shortcuts-help": KeyboardIcon,
  "focus-input": NotebookPenIcon,
  "nav-chat": WaypointsIcon,
  "nav-skills": SparklesIcon,
  "nav-library": LibraryBigIcon,
  "nav-agents": BotIcon,
  "nav-schedules": CalendarClockIcon,
  "open-settings": Settings2Icon,
  "toggle-sidebar": PanelRightOpenIcon,
  "toggle-workspace": FolderOpenIcon,
  "toggle-terminal": TerminalSquareIcon,
  "thread-summary": NotebookPenIcon,
  "open-in-ide": LaptopIcon,
  "toggle-theme": SunMediumIcon,
  "theme-customize": SlidersHorizontalIcon,
};

/**
 * 依据当前运行上下文构建面向 shadcn 命令面板的分组清单
 */
export function buildShortcutMenuGroups(ctx: CommandActionContext): ShortcutMenuGroup[] {
  const { t, isMac, activeView, activeThreadId } = ctx;

  const actionHandlers: Record<string, () => void> = {
    "command-palette": () => {},
    "new-task": () => {
      ctx.navigate({ to: "/chat" });
      void ctx.createNewThread();
    },
    "search-messages": () => {
      ctx.openSearchMessages();
    },
    "shortcuts-help": () => {
      ctx.openShortcutsHelp();
    },
    "focus-input": () => {
      if (activeView !== "chat") {
        ctx.navigate({ to: "/chat" });
        window.setTimeout(() => ctx.focusChatInput(), 100);
      } else {
        ctx.focusChatInput();
      }
    },
    "nav-chat": () => ctx.navigate({ to: "/chat" }),
    "nav-skills": () => ctx.navigate({ to: "/skills" }),
    "nav-library": () => ctx.navigate({ to: "/library" }),
    "nav-agents": () => ctx.navigate({ to: "/agents" }),
    "nav-schedules": () => ctx.navigate({ to: "/schedules" }),
    "open-settings": () => ctx.navigate({ to: "/settings" }),
    "toggle-sidebar": () => ctx.toggleSidebar(),
    "toggle-workspace": () => {
      if (activeView !== "chat") ctx.navigate({ to: "/chat" });
      ctx.toggleWorkspacePanel();
    },
    "toggle-terminal": () => {
      if (activeView !== "chat") ctx.navigate({ to: "/chat" });
      ctx.toggleTerminalPanel();
    },
    "thread-summary": () => {
      if (activeThreadId) {
        ctx.openThreadSummary();
      }
    },
    "open-in-ide": () => {
      ctx.openInIde();
    },
    "toggle-theme": () => {
      ctx.toggleThemeMode();
    },
    "theme-customize": () => {
      ctx.navigate({ to: "/settings", search: { section: "themes" } });
    },
  };

  const groupHeadings: Record<ShortcutCategory, string> = {
    general: t("commandPalette:groupGeneral"),
    navigation: t("commandPalette:groupNavigation"),
    workbench: t("commandPalette:groupWorkbench"),
    appearance: t("commandPalette:groupAppearance"),
  };

  const grouped: Record<ShortcutCategory, ShortcutMenuItem[]> = {
    general: [],
    navigation: [],
    workbench: [],
    appearance: [],
  };

  for (const spec of CORE_SHORTCUT_SPECS) {
    if (spec.id === "command-palette") continue; // 已经在命令面板内部，无需自嵌套

    const label = t(spec.titleKey);
    const description = t(spec.descKey);
    const shortcutDisplay = formatShortcutDisplay(spec.keys, isMac);
    const secondaryShortcutDisplay = spec.secondaryKeys
      ? formatShortcutDisplay(spec.secondaryKeys, isMac)
      : undefined;
    const icon = ICON_MAP[spec.id] || SearchIcon;
    const onSelect = actionHandlers[spec.id] || (() => {});

    let disabled = false;
    if (spec.requiresChat && !activeThreadId && spec.id === "thread-summary") {
      disabled = true;
    }

    grouped[spec.category].push({
      id: spec.id,
      label: label || spec.defaultTitle,
      description: description || spec.defaultDesc,
      icon,
      shortcutDisplay,
      shortcutKeys: spec.keys,
      secondaryShortcutDisplay,
      keywords: spec.keywords,
      disabled,
      category: spec.category,
      onSelect,
    });
  }

  const categoryOrder: ShortcutCategory[] = ["general", "navigation", "workbench", "appearance"];

  return categoryOrder
    .map((cat) => ({
      id: cat,
      heading: groupHeadings[cat] || cat,
      items: grouped[cat],
    }))
    .filter((g) => g.items.length > 0);
}
