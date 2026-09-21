# 代码与文档的表达品味

> 本文描述当前上游基线中已经存在的表达方式，并把建议单独标出。它不是把个人偏好伪装成规范：事实结论都回到仓库文件和行号，建议则说明适用边界。

## 1. 结论摘要

Mastra Desktop 当前最鲜明的品味，是“边界先于实现，证据先于抽象”：

- 进程边界由 README 明确画出，Electron main、本地 Mastra 服务和 React renderer 通过 IPC/HTTP/SSE 协作；`src/shared` 被定义为 IPC 合约的单一事实源（`README.md:17-34`）。
- 输入在边界处解析，类型从 schema 推导，而不是让每层各自猜测数据形状。凭据 IPC 的 preload 入口同时校验请求和返回值（`src/preload/api/credentials.ts:10-26`），共享合约使用严格对象和判别联合（`src/shared/credential-contract.ts:19-84`）。
- UI 采用 Feature-Sliced 目录和语义 token；`DESIGN.md` 明确要求先读取 `docs/examples/`/`docs/aielements/` 对应示例，再写组件（`DESIGN.md:213-223`）。
- 注释倾向解释“为什么”和“依据哪个官方契约”，而不是复述语法。例如聊天路由头部记录 AI SDK 文档、请求上下文和流式输出的关系（`src/mastra/routes/chat.ts:1-8`）。
- 文档分成不同受众：README 面向使用者和贡献者，`DESIGN.md` 是机器可读 token 加人读规范，`docs/examples` 是可直接查看/复制的组件样例。三者不应被合并成一篇无边界的“总说明”。

当前最大的表达风险不是命名混乱，而是规模与重复：若按文件行数看，main 进程、聊天路由和侧栏组件分别达到 1336、1034、776 行。它们仍可保持单一职责，但新增逻辑应优先进入已有的领域模块或明确的 cohesive boundary，不能继续堆叠，也不能反射性地拆成大量微文件（`AGENT.md:3-7`；规模以当前文件为证据）。

## 2. 证据边界与阅读方法

本篇使用四类证据：

1. 约束文件：`AGENT.md`、`DESIGN.md`、`biome.json`。
2. 对外叙事：`README.md` 和 `docs/project-audit/04-review-method.md`。
3. 代表性实现：共享 Zod 合约、preload API、主进程凭据金库、Mastra 路由、React Query mutation。
4. 组件来源样例：`docs/examples/accordion.*`、`button-*`、`sidebar-*`。

`04-review-method.md` 要求重要结论带路径和行号，并区分“已确认”“已验证”“风险提示”“待验证”（`docs/project-audit/04-review-method.md:7-22`）。因此本文只把源码能直接证明的内容写成“现状”；没有运行测试或视觉验收的地方不宣称已验证。

## 3. 当前代码表达的品味

### 3.1 先划清边界，再在边界内实现

README 用三进程图和目录职责表建立全局心智模型：main 负责窗口/服务/终端/凭据，Mastra 负责 agent、工具、RAG、MCP 和 HTTP API，preload 负责 `contextBridge`，shared 负责 contract，renderer 负责 FSD UI（`README.md:17-34`）。这使新代码首先回答“属于哪个边界”，而不是先创建一个名字宽泛的 util。

**可复用判断：** 新功能至少应能回答入口进程、拥有状态的边界、跨边界的数据 contract，以及 renderer 中所属的 FSD slice。若一个 helper 同时处理 IPC、存储和 UI 状态，通常说明边界没有被表达清楚。

### 3.2 合约是代码，不是注释

共享 contract 以常量表达 channel 名，以 Zod 表达校验，以 `z.infer` 导出类型。例如凭据请求使用 `.strict()`，broker 请求使用 `z.discriminatedUnion("operation", ...)`，成功/失败响应使用 `z.discriminatedUnion("ok", ...)`（`src/shared/credential-contract.ts:3-6`、`31-84`）。preload API 在 `ipcRenderer.invoke` 前解析请求，在返回后解析结果（`src/preload/api/credentials.ts:10-26`）。

这是一种很强的项目品味：跨边界错误要在边界处失败，类型定义、运行时校验和 channel 名称放在同一份 contract 中。建议新增 IPC 时沿用同一模式，不要只新增 TypeScript interface，也不要把 `unknown` 直接传给 main handler 后再依赖调用方自觉。

### 3.3 类型命名偏领域化、动作偏明确

共享类型使用 `CredentialPointer`、`CredentialState`、`WorkspaceFileChange` 等领域名；辅助函数使用 `providerCredentialPurpose`、`mcpCredentialPurpose` 等动作+对象命名（`src/shared/credential-contract.ts:86-102`）。workbench 类型把 `MainView`、`WorkThread`、`WorkspaceChangeKind` 等概念集中在实体模型中（`src/renderer/src/entities/workbench/model/types.ts:6-19`、`58-99`）。

**推荐保持：**

- 用业务对象名，而不是 `Data`、`Result`、`Manager` 这种无上下文名。
- 用动词区分读写/验证/归一化：`get`、`save`、`parse`、`normalize`、`resolve`、`invalidate`。
- 常量、schema、类型和由 schema 推导的 type 尽量靠近，方便审查者从入口读到完整 contract。

### 3.4 注释解释约束、来源和失败语义

主进程注释先说明职责，再说明 shutdown token 的安全目的和进程继承关系（`src/main/index.ts:1-3`、`82-99`）。Mastra 路由注释列出官方文档、输入上下文、线程准备和流式输出职责（`src/mastra/routes/chat.ts:1-8`）。代码模式工具注释明确 allow-list 只放适合批量编排的只读能力，并链接官方文档（`src/mastra/tools/code-mode.ts:1-5`、`15-23`）。

这种注释的价值在于记录决策依据，而不只是把 `if` 翻译成中文。新增注释优先回答：

- 这个限制保护了什么不变量？
- 这个数据为何必须在此处归一化？
- 这是哪个框架/官方 API 的约束？
- 失败时为什么要回滚、静默、重试一次或直接抛错？

**现有的反面信号：** `src/mastra/tools/code-mode.ts:1-5` 与 `15-18` 对同一 allow-list 语义有重复说明。重复注释会让后续维护者不知道哪一段是规范来源。建议保留一段完整 rationale，另一段只在确有不同调用语境时补充差异。

### 3.5 资源和安全代码偏向可审计、可回滚

凭据金库用 schema 定义磁盘文档，`atomicWrite` 先写随机临时文件再 rename，并在 finally 清理（`src/main/credential-vault.ts:22-41`）。目录权限、加密可用性、密钥长度、用途匹配、AES-GCM AAD 都有明确检查（`src/main/credential-vault.ts:55-83`、`94-127`、`130-162`）。broker 还按平台选择 named pipe 或 socket，并用 token 和 timing-safe 比较认证（`src/main/credential-vault.ts:165-199`）。

这体现的是“失败路径也要有名字”：写入不是 `writeFile` 一把梭，密钥不是普通字符串，删除前要验证用途，网络/进程 broker 需要认证。相同品味可迁移到设置迁移、导入文件、缓存重建等流程。

### 3.6 归一化集中但允许渐进迁移

`src/mastra/config/normalize.ts` 开头解释该模块同时提供命令式 helper 和声明式 Zod 片段，旧 normalize 可逐字段迁移，新 schema 可直接组合（`src/mastra/config/normalize.ts:1-11`）。实现对 unknown 输入统一做空值、类型、边界、trim、数量限制处理（`src/mastra/config/normalize.ts:15-85`）。

这是“集中语义、分步落地”的例子：不要每个配置表复制一套字符串清洗或数值 clamp，也不要为了迁移一次性引入大抽象。新增配置优先组合现有 schema；只有兼容旧入口时才使用命令式 helper，并在后续变更中减少旧路径。

### 3.7 异步状态表达“乐观更新—失败回滚—服务端真相”

threads query 模块在文件头写出状态约定：`onMutate` 更新缓存、`onError` 回滚、`onSettled` invalidate；实现也按该顺序组织（`src/renderer/src/entities/workbench/model/queries/threads.ts:1-7`、`43-73`）。这比在组件里散落 loading flag 和手写刷新更容易复用和审查。

**可复用判断：** 每个 mutation 要明确本地即时反馈、错误恢复、最终一致性和当前选择状态；若操作不适合乐观更新，应明确说明原因，不要机械套模板。

### 3.8 UI 代码偏语义 token、结构化组件和 FSD

`DESIGN.md` 把 token、层级、布局、圆角和 sidebar 结构写成规范（`DESIGN.md:129-209`），并要求使用 `bg-background`、`text-muted-foreground`、`rounded-xl` 等语义类，不写任意颜色和像素值（`DESIGN.md:226-240`）。实际 Button 组件用 `cva` 管理 variant/size，统一 focus、disabled、icon 和 motion 状态（`src/renderer/src/shared/ui/button.tsx:6-55`）。README 也明确 renderer 按 `app/pages/widgets/features/entities/shared` 组织（`README.md:30-34`）。

UI 改动的表达重点不是“看起来能渲染”，而是把状态、可访问性钩子、slot、token 和响应式边界写清楚。不要为了一个页面复制一份 button/sidebar 实现。

## 4. 当前文档表达的品味

### 4.1 README：短、可执行、面向第一次进入项目的人

README 先用一句话定义产品，再列能力、架构、要求、启动和构建命令；命令和目录职责都能直接行动（`README.md:1-5`、`7-15`、`17-69`）。它还把凭据存储、许可证和第三方清单链接放在可发现的位置（`README.md:71-93`）。

**建议保持：** README 写“用户为什么关心”和“如何开始”，不要把每个实现细节、事故复盘或未验证猜测塞进来。新增命令必须与 `package.json` 的 script 同步（`package.json:17-27`），否则文档会比代码更危险。

### 4.2 DESIGN.md：机器可读 token + 人读规则

文件前段用 YAML frontmatter 规定颜色、字体、间距、圆角和组件 token（`DESIGN.md:1-114`），正文再解释 core tenets、色彩角色、排版、布局和层级（`DESIGN.md:116-209`）。这种结构既可被工具/人检索，又把“为什么”讲清楚。

文档还把前置检索协议写成可执行步骤：基础组件按 `<component_name>-*.tsx` 搜索，AI 组件按 feature 前缀搜索，属性/ARIA/slot 结构要继承（`DESIGN.md:215-223`）。这是一份工程规则，不是审美口号。

### 4.3 docs/examples：按组件状态递进的可复制样例

Accordion 的 MDX 先给组件来源、安装、用法和 composition，再按 Basic、Multiple、Disabled、Borders、Card、RTL 展开状态（`docs/examples/accordion.mdx:1-16`、`61-95`、`97-161`）。实现样例保持数据驱动和最小 JSX：`accordion-basic.tsx` 用 `items.map` 统一渲染三种问答（`docs/examples/accordion-basic.tsx:8-39`），`accordion-card.tsx` 展示 Card 与 Accordion 的组合（`docs/examples/accordion-card.tsx:7-57`）。

Sidebar 示例则从完整可运行结构出发，明确 `SidebarProvider`、header/content/footer、菜单和响应式 dropdown 的组合（`docs/examples/sidebar-demo.tsx:29-68`、`200-276`、`478-504`）。因此这些文件更像“仓库内参考样例”（可能承载上游风格），而不是项目业务文档；修改 UI 前应先读它们，再在业务层做最小适配。

### 4.4 样例风格与源码格式有意分层

仓库 Biome 对 JavaScript 强制双引号和分号（`biome.json:20-55`），但它明确排除整个 `docs`（`biome.json:3-17`）。仓库样例使用无分号风格和 `@/styles/base-nova/ui/*` 导入（`docs/examples/sidebar-demo.tsx:1-68`、`docs/examples/button-default.tsx:1-5`）。这不是让业务源码随意漂移的理由，而是说明“复制上游样例时保留样例语境；新业务代码回到仓库 formatter”。

## 5. 可复用的判断标准

提交前可用下面的六问做快速审查：

| 维度 | 通过标准 | 常见反例 |
| --- | --- | --- |
| 边界 | 能指出进程、领域 slice、状态拥有者和调用链 | 在 renderer 里直接拼 IPC channel 或在 route 里操作组件状态 |
| 合约 | 跨边界请求/响应有共享 schema，入口和出口都 parse | 只写 interface；把 `unknown` 原样向下传 |
| 复用 | 先搜索现有 contract、query、UI primitive 和 docs 示例 | 新建同义 `utils`、第二套 Button、重复清洗逻辑 |
| 失败语义 | 说明回滚、重试、超时、清理、用户可见错误 | 只写 happy path；catch 后静默吞掉关键状态 |
| 表达 | 名称体现领域和动作，注释记录不变量/来源/原因 | `Manager`/`Data` 泛名，注释只复述代码，复制过期链接 |
| 文档 | 面向对应读者，命令可执行，结论带证据和验证状态 | README 记录内部事故细节，审查文档无路径/行号 |

这六问是建议，不是新增运行时约束；它们从 `AGENT.md:1-12`、`DESIGN.md:215-240` 和 `04-review-method.md:15-30` 归纳而来。

## 6. 反模式清单

以下项目应视为不符合当前仓库品味的实现方式：

1. **跨层直连。** React 组件自己拼 IPC 名称、主进程绕开 shared schema、Mastra route 直接依赖 renderer 类型。
2. **契约分叉。** 同一请求在 preload、main、route 各定义一份近似结构，导致校验、字段名和错误语义漂移。
3. **泛工具堆积。** 为少量逻辑创建 `helpers2`、`common-utils` 或微文件，而相关逻辑已有清晰的 domain module；这违反“简单实现、避免碎片化”的工程约束（`AGENT.md:3-7`）。
4. **无界面状态。** 把 query cache、URL、store、localStorage 都当作“真相”，却没有写出优先级和同步策略。现有 threads 模块的 query/invalidate 约定可作为反例对照（`src/renderer/src/entities/workbench/model/queries/threads.ts:1-7`、`202-220`）。
5. **隐式安全边界。** 将 credential、token、文件路径或外部 URL 当普通字符串向下传；凭据金库的 schema、加密、原子写和认证流程说明了本项目对边界的期望（`src/main/credential-vault.ts:22-41`、`55-83`、`165-199`）。
6. **UI 自创一套语言。** 任意颜色/圆角/间距、全局滚动条、无 `ScrollArea` 的长列表、绕过 docs 示例的 slot/ARIA 结构；对应禁用项见 `DESIGN.md:226-240`。
7. **重复 rationale。** 同一限制在同一文件写两段互相可能过时的注释；`code-mode.ts` 的重复头注释是应收敛的实例（`src/mastra/tools/code-mode.ts:1-23`）。
8. **文档无证据。** 只写“应该”“最佳实践”而不写当前事实、路径、行号、验证状态；这违背审查维护约定（`docs/project-audit/04-review-method.md:5-15`）。

## 7. 建议的最小工作流

这是建议流程，不改变代码行为：

1. **定位边界：** 先读 README 架构表、目标领域现有入口和最近的 contract。
2. **查找参考：** UI 改动按 `DESIGN.md:219-223` 的前缀协议读取 docs 示例；非 UI 改动先搜索已有 schema、normalize、query 或 route pattern。
3. **写最小闭环：** 先让入口、contract、实现、错误路径和 UI 消费者形成可读闭环，再添加扩展能力。
4. **核对表达：** 名称是否领域化，注释是否解释不变量，是否引入了第二套 primitive 或重复 helper。
5. **更新对应文档：** 面向用户的行为进 README，设计规则进 DESIGN，组件参考进 docs/examples，审查发现进 project-audit；不要把内部推断写成产品承诺。
6. **声明验证边界：** 没有运行构建/测试/视觉验收时，只写“源码已核对”或“待验证”，不要写“已通过”。

## 8. 维护提示

- `biome.json` 排除 `docs`，所以 docs 示例可以保留上游格式；新建项目业务 TSX 仍应遵守 formatter（`biome.json:3-17`、`50-55`）。
- `src/main/index.ts`、`src/mastra/routes/chat.ts`、`src/renderer/src/widgets/app-sidebar/ui/app-sidebar.tsx` 当前都很大。若继续增长，优先按清晰领域边界抽取 route/handler/view model；不要为了满足行数而创建无语义的碎片。该判断是风险提示，不等于已确认存在运行时缺陷。
- `docs/project-audit` 中的事实会随源码变化；每次架构、构建或 UI 大改后，应按 `04-review-method.md:32-38` 更新受影响行号和验证状态。

导航：[项目审查索引](README.md) · [审查方法](04-review-method.md)
