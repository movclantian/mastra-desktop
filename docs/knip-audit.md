# Knip 瘦身记录与后续安排

日期：2026-10-08。

## 工具与检查边界

`@knip/config` 在 npm 官方源和项目配置的镜像均返回 404。实际安装的是官方检查工具 `knip@6.40.0`，配置为根目录 `knip.json`。Knip 自身 README 列出的配置生成器名称是 `@knip/create-config`；本项目直接维护明确的配置，不额外安装生成器。

检查覆盖 Electron 主进程、preload、React 渲染器、Mastra、共享协议、CSS、构建配置和维护脚本。Electron/Vite 插件识别其入口；Mastra 和 CSS 入口在配置中明确补充。文档示例、`.vscode` 参考仓库、第三方依赖和生成产物不作为应用源码清理。

统一使用完整项目检查：

```sh
pnpm knip
pnpm knip:cycles
pnpm format
pnpm lint
pnpm typecheck
```

不提供单独的 `knip --production` npm 脚本：该模式排除构建配置，会把 Vite 注入的字体地址、动态调用的 Mastra CLI 和本地预览命令报告为未使用。完整项目扫描同时覆盖运行代码与构建用途，更符合这个 Electron 应用的实际依赖关系。

## 已完成的清理

首次扫描发现 24 个无引用文件、374 个未被外部引用的值导出、106 个未被外部引用的类型导出。导出数不等于可删除实现数：内部仍使用的声明保留为模块私有；真正无调用方的声明继续通过 TypeScript 的未使用局部变量检查确认并删除。

- 删除 24 个无引用 UI 文件，原始源码合计 73,079 字节。包括未接入的 accordion、combobox、menubar、navigation-menu、input-otp、重复 toast，以及一批未使用的动画组件。
- 删除 14 个无使用路径的直接运行依赖：`@ai-sdk/react`、`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`、`@rive-app/react-webgl2`、`@tavily/core`、`@xyflow/react`、`ansi-to-react`、`framer-motion`、`input-otp`、`media-chrome`、`next-themes`、`react-jsx-parser`、`use-stick-to-bottom`。
- 删除无使用路径的开发依赖 `concurrently`。该次 pnpm 删除操作实际移除了 37 个已安装包；这不是整个会话的净包数变化。
- 首轮最终扫描曾移除当时没有调用方的 `bot-avatars`；后续工作区已将其接入头像和运行状态展示并恢复依赖。复查确认应保留，因此首轮删除清单中目前仍应删除的是 14 个直接运行依赖和 1 个开发依赖，不能继续按 15 个宣传。
- 保留正在使用的 `motion`、Tailwind、`@mastra/tavily`、`@mastra/quickjs` 等能力。QuickJS 在本次工作期间接入 Code Mode，最终扫描已确认其引用。
- 将直接导入但未声明的 `@mastra/loggers@1.3.5` 补入运行依赖。
- 彩虹按钮的调用方没有使用 `asChild`，删除该未使用分支及未声明的 Radix Slot 导入，保留原生按钮和现有样式。
- 删除旧模型选择器子组件、重复的费用计算函数、未使用的 UI 子部件、API 包装函数及其关联类型与导入。
- 点阵动画公共模块由 1719 行缩至 1092 行；模型选择器公共模块由 175 行缩至 83 行；供应商前端模块由 697 行缩至 564 行。行数是清理后格式化时的记录，不是性能测量。
- 消除 4 条前端循环引用路径：终端快捷键不再经命令面板总入口导入；聊天消息和聊天面板不再通过本目录的汇总入口导入自身依赖。
- 为 Mastra TypeScript 配置启用 `noUnusedLocals`，避免只移除导出、却把死实现留在文件里。

## 明确保留的例外

没有对整个 UI 目录、所有导出或所有依赖设置忽略。

- `attrib`、`wt.exe`、`x-terminal-emulator` 是现有跨平台维护或终端功能调用的系统命令，不是遗漏安装的 npm 包。
- 仅在 `credential-contract.ts`、`filesystem-contract.ts`、`workspace-contract.ts` 中忽略 `duplicates`。这些文件使用同一个 Zod Schema 对象表达字段约束和 IPC 请求/结果约束，例如 `CredentialPutResultSchema = CredentialPointerSchema`；并不存在两份校验实现。它们的未使用导出、依赖和其他问题仍然检查。

## 后续安排

### 功能接入复查（2026-10-08）

Knip 的“无引用”只描述当前依赖图，不证明产品不需要。复查结合删除前源码与当前入口，区分功能缺失、已有实现承接和可选的组件复用；没有运行应用验证交互。

| 删除项或候选 | 当前功能路径与判断 |
| --- | --- |
| `bot-avatars` | 当前 `shared/ui/avatar.tsx`、`shared/lib/utils.ts` 和 Agent 头像已真实引用；依赖已在工作区恢复，必须保留。首轮扫描结论不能覆盖后续接入。 |
| `kbd.tsx` | `features/command-palette/command-palette.tsx` 有六处原生 `kbd` 标签，快捷键展示存在，但公共组件未接入。属于复用机会，不能称为“产品不需要”；可在现有命令面板模块收敛重复样式，无须为了恢复文件增加一层模块。 |
| `combobox.tsx`、旧模型选择器弹窗子组件 | 插件市场已用共享 `Select`；聊天模型使用 `DropdownMenu` 与推理等级子菜单。不是选择入口被删，但聊天模型列表没有搜索输入，模型很多时可评估接入 Combobox。恢复未引用文件本身不会增加搜索功能。 |
| `radio-group.tsx` | 问卷通过 `@shadcn/react/questionnaire` 的 `ChoiceInput` 承接单选/多选，设置使用 Select/ToggleGroup，模型推理等级使用 DropdownMenuRadioGroup；未发现仅靠视觉圆点冒充问卷单选的情况。 |
| `toast.tsx`、`alert.tsx` | 应用挂载 Sonner Toaster，错误位置使用 `role="alert"`、FieldError 或对话框。旧 toast 并非当前通知链路；Alert 组件可统一外观，但不是缺失通知的证据。 |
| `accordion.tsx`、`animated-collapsible.tsx` | 当前已有共享 Collapsible，调用方包括工具轨迹和工作流步骤。无需为独立折叠区域重新引入 Accordion。 |
| `menubar.tsx`、`navigation-menu.tsx` | 导航由 Sidebar、命令面板和路由承接，操作菜单使用 DropdownMenu/ContextMenu；未发现删除后缺失的导航入口。 |
| `aspect-ratio.tsx`、`spinner.tsx`、`dotm-square-18.tsx` | 图片/附件已有尺寸约束，加载状态使用现有图标及点阵组件。删除的是另一种展示封装，不是整个加载或预览能力。 |
| `direction.tsx`、`input-otp.tsx` / `input-otp` | 当前语言为中英文，未发现 RTL 入口或一次性验证码流程。没有当前必需的接入点。 |
| 其余装饰组件 | animated-beam、animated-gradient-text、animated-icon、animated-list、interactive-hover-button、magic-card、marker、marquee、neon-gradient-card、orbiting-circles：未发现业务入口依赖这些特定效果；现有动画仍由 `motion/react` 等承接。 |
| `use-stick-to-bottom` | 聊天使用 `@shadcn/react/message-scroller`，包括锚点、跟随滚动和手动脱离；不应同时引入第二套滚动控制。 |
| `@ai-sdk/react` | 当前会话走 Mastra Session 流及 `use-thread-sessions.ts`，没有缺失的 useChat 调用；恢复依赖并不能修复消息时序。 |
| `@tavily/core` | `src/mastra/tools/web-search.ts` 使用 `@mastra/tavily` 的官方搜索和提取工具，能力仍接入。 |
| `framer-motion`、`next-themes` | 分别由实际使用的 `motion/react` 和支持主题预设、用户定制的现有 ThemeProvider 承接。 |
| `ansi-to-react`、`media-chrome` | 终端使用 Xterm；资料预览通过 Open File Viewer 注册 audio/video 插件。未发现这两项删除造成的预览入口缺失。 |
| 三项 `@dnd-kit/*` | 工作区标签已有原生拖拽与 `reorderPanelTab`，不是没有排序实现。不过排序交互仍应专门人工验证键盘与触摸支持；没有静态引用不能证明这部分体验完整，重新安装库也不会自动补齐。 |
| `@xyflow/react`、`@rive-app/react-webgl2`、`react-jsx-parser`、`concurrently` | 当前流程展示为步骤列表，没有发现必须由图编辑器、Rive、动态 JSX 或该进程调度工具承接的现有入口。 |
| 消息和引用子组件 | 当前 `message-list.tsx` 使用共享 MessageHeader/MessageContent；`citations.tsx` 仍接入 InlineCitation、悬浮卡、轮播及引用原文。删除的 InlineCitationText 是可选文本高亮包装，不是引用解析或点击处理。 |
| 旧 ThreadFolder | 归档会话由 `app-sidebar.tsx` 的归档视图直接展示，不依赖被删除的文件夹封装。 |

复查结论：应撤回“所有无引用项都不需要”的推断；当前确认保留 bot-avatars，记录快捷键复用、模型搜索和排序可访问性三个具体审查点。没有证据时不把可选设计调整称为误删故障，也不通过恢复空闲组件或忽略 Knip 报告来假装完成接入。

### 复查后的实际完善

- 命令面板六处快捷键标签统一使用该模块内的 `Kbd`，统一字号、边框与间距，没有增加微型文件。
- 聊天模型选择改用现有 Popover + Command：按供应商名称、模型名称和 ID 搜索，保留供应商分组、当前模型标记、能力与上下文信息。选择后面板保持打开，可直接调整当前模型的推理等级，再点击关闭或按 Escape；重复选择当前模型不重置其推理等级。增加无匹配提示与供应商设置入口。
- 工作区本地标签复用 `reorderPanelTab`，增加左右移动按钮、右键菜单和 `Alt+Shift+ArrowLeft/ArrowRight`。按钮支持触摸点击；边界禁用，键盘焦点仍属于原标签，使用 live region 播报新位置。服务端浏览器标签不属于该排序列表。
- 不添加依赖、不恢复闲置组件，不引入第二套滚动或拖拽状态管理。

手动验收：

1. 搜索供应商、模型显示名、完整或部分模型 ID，检查分组过滤、空结果及清空搜索后的恢复；按上下键和 Enter 选择，检查能力与上下文展示。
2. 调整当前模型推理等级，再次选择同一模型，确认等级保留；切换模型后确认设置对应新模型。关闭再打开选择器，检查焦点与搜索状态。
3. 至少打开三个本地工作区标签，分别用移动按钮、右键菜单、Alt+Shift+方向键排序，检查当前内容不变、边界不可越过；用触摸点击移动按钮，检查无需拖拽即可排序。
4. 检查命令面板按钮、底部键盘提示与快捷键指南的标签样式，以及小窗口下模型面板滚动和标签栏宽度。

实现通过静态检查；上述交互仍由用户手动验收，本次未启动应用或执行自动测试。

| 优先级 | 工作 | 完成依据 |
| --- | --- | --- |
| 已完成 | 删除无引用文件、依赖、导出和局部死代码；修正循环引用 | 完整 Knip、循环检查与三个 TypeScript 项目检查通过 |
| P1，手动验证 | 检查聊天流式输出与引用、队列、终端快捷键、Agent 创建按钮、插件管理、代码编辑与文档预览 | 实际界面和操作正常；本次没有启动应用或执行自动测试 |
| P1，手动打包 | 在相同平台与打包选项下比较安装包、`app.asar`、`app.asar.unpacked` 和渲染资源大小 | 记录实际字节数；不能用源码删减量推算安装包减少量 |
| P2，依据产物分析 | 核实仅由渲染器使用且已经打包的依赖能否移至 devDependencies | 先确认主进程、Mastra 生成产物、动态 require 和运行时资源读取均不需要它们，再调整依赖分类 |
| P2，依据资源分析 | 检查删除组件后遗留的 CSS、字体和静态资源 | 同时核对动态类名、主题切换、语言与字体覆盖；Knip 不证明 CSS 选择器无用 |

本次未更改数据库或业务数据，未运行应用、模型调用或自动测试，也未测量安装包、启动时间、内存或渲染性能。
