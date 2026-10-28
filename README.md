<div align="center">

<img src="docs/assets/banner.svg" alt="MastraWork 开源桌面 AI 工作台" width="100%">

</div>

<p align="center">
<a href="https://github.com/movclantian/mastra-desktop/releases/tag/v0.0.8"><img src="https://img.shields.io/badge/Release-v0.0.8-4C47C3?style=flat-square" alt="Release v0.0.8"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-2ea44f?style=flat-square" alt="License Apache-2.0"></a>
<a href="https://github.com/movclantian/mastra-desktop/stargazers"><img src="https://img.shields.io/github/stars/movclantian/mastra-desktop?style=flat-square" alt="Stars"></a>
<img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0ea5e9?style=flat-square" alt="Platform Windows macOS Linux">
<img src="https://img.shields.io/badge/Node-22.x-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 22.x">
<img src="https://img.shields.io/badge/pnpm-12.15.0-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm 12.15.0">
<a href="https://github.com/movclantian/mastra-desktop/issues"><img src="https://img.shields.io/badge/Issues-%E6%AC%A2%E8%BF%8E%E5%8F%8D%E9%A6%88-e11d48?style=flat-square" alt="Issues 欢迎反馈"></a>
</p>

<p align="center">
<a href="#它是什么"><strong>它是什么</strong></a> · <a href="#功能特性">功能特性</a> · <a href="#一个任务是怎么走完的">任务流程</a> · <a href="#界面截图">界面截图</a> · <a href="#它是怎么搭起来的">架构</a> · <a href="#快速开始">快速开始</a> · <a href="#安全与边界">安全与边界</a> · <a href="#开发">开发</a> · <a href="#贡献与反馈">贡献与反馈</a> · <a href="#star-历史">Star 历史</a>
</p>

---

> 项目处于持续开源迭代状态。本文档描述当前公开的 `v0.0.8` 发行基线，功能、依赖、平台支持和界面会随后续版本变化。

## 它是什么

MastraWork 是一个开源的桌面 AI 工作台，底层是 [Mastra](https://mastra.ai) 框架和 Electron。它想解决的事情很具体。现在多数 AI 工具给你一段回答，事情就停在那儿。代码改到一半让它继续，它常常重新读一遍文件，从接不上的地方往下编。MastraWork 把一次 Agent 运行组织成一个任务。任务落在具体的工作区里，长在线程上，每一步都留下痕迹。它能暂停，能回头检查，也能交给团队里的其他成员接着看。

这东西做给软件工程和知识工作用。Agent、团队、工作区、终端、浏览器、MCP、技能和资料库收在同一个应用里，围着同一个任务转。你在主窗口和一个主 Agent 对话，也可以拉一支专家团队，把读代码、查资料、跑命令、写文档这类活分出去，每一步都留在现场。

模型推理走哪个服务由你自己配置。「本地优先」说的是桌面宿主、默认工作区和本地数据边界优先留在本机，不表示所有推理都在本地完成。

## 功能特性

下面这些能力在 `v0.0.8` 里都能直接用到。

<table style="border-collapse:separate;border-spacing:14px">
<tr>
<td align="center" width="50%" style="padding:22px;border:2px solid #2c2c2c;border-radius:255px 15px 225px 15px/15px 225px 15px 255px;box-shadow:4px 4px 0 rgba(44,44,44,0.9);background:#fffef5">
<h3 style="font-family:'Segoe Print','Comic Sans MS','Xingkai SC','KaiTi',cursive;color:#2c2c2c">🧭 工程任务</h3>
<p style="color:#2c2c2c">读取代码、全局搜索、编辑与 AST 修改、运行命令、查看差异、调用 LSP。读、写、执行分开授权，每一步都有记录。</p>
</td>
<td align="center" width="50%" style="padding:22px;border:2px solid #2c2c2c;border-radius:255px 15px 225px 15px/15px 225px 15px 255px;box-shadow:4px 4px 0 rgba(44,44,44,0.9);background:#fffef5">
<h3 style="font-family:'Segoe Print','Comic Sans MS','Xingkai SC','KaiTi',cursive;color:#2c2c2c">🛡️ 受控执行</h3>
<p style="color:#2c2c2c">计划、构建、复查三种模式，切的是 Agent 能碰什么。人工询问和批准留在流程里，不靠自觉。</p>
</td>
</tr>
<tr>
<td align="center" width="50%" style="padding:22px;border:2px solid #2c2c2c;border-radius:255px 15px 225px 15px/15px 225px 15px 255px;box-shadow:4px 4px 0 rgba(44,44,44,0.9);background:#fffef5">
<h3 style="font-family:'Segoe Print','Comic Sans MS','Xingkai SC','KaiTi',cursive;color:#2c2c2c">👥 Agent 团队</h3>
<p style="color:#2c2c2c">主 Agent 通过 Mastra 原生 agent-* 工具委派给专家成员，支持并行和嵌套委派，执行以 subagent invocation 展示。</p>
</td>
<td align="center" width="50%" style="padding:22px;border:2px solid #2c2c2c;border-radius:255px 15px 225px 15px/15px 225px 15px 255px;box-shadow:4px 4px 0 rgba(44,44,44,0.9);background:#fffef5">
<h3 style="font-family:'Segoe Print','Comic Sans MS','Xingkai SC','KaiTi',cursive;color:#2c2c2c">🧩 开放扩展</h3>
<p style="color:#2c2c2c">模型 Provider、MCP Server、技能与插件、浏览器、资料库、记忆和网页检索，按需接入，不绑定一家。</p>
</td>
</tr>
<tr>
<td align="center" width="50%" style="padding:22px;border:2px solid #2c2c2c;border-radius:255px 15px 225px 15px/15px 225px 15px 255px;box-shadow:4px 4px 0 rgba(44,44,44,0.9);background:#fffef5">
<h3 style="font-family:'Segoe Print','Comic Sans MS','Xingkai SC','KaiTi',cursive;color:#2c2c2c">🖥️ 桌面集成</h3>
<p style="color:#2c2c2c">Electron 主进程、原生浏览器视图、PTY 终端、系统通知、凭据保险库，Windows、macOS、Linux 三个平台都有安装包。</p>
</td>
<td align="center" width="50%" style="padding:22px;border:2px solid #2c2c2c;border-radius:255px 15px 225px 15px/15px 225px 15px 255px;box-shadow:4px 4px 0 rgba(44,44,44,0.9);background:#fffef5">
<h3 style="font-family:'Segoe Print','Comic Sans MS','Xingkai SC','KaiTi',cursive;color:#2c2c2c">📚 记忆与资料库</h3>
<p style="color:#2c2c2c">记忆跨会话保留，资料库统一收文档、表格和网页。用量、费用和历史数据随时可查。</p>
</td>
</tr>
</table>

## 一个任务是怎么走完的

<div align="center">

<img src="docs/assets/task-flow.svg" alt="任务流程" width="100%">

</div>

一个任务从开工到验收，Agent 手里的权限是变的。计划、构建、复查三种模式，对读、编辑、执行和外部工具各有一套策略。人工询问和批准留在流程里，高风险的动作等人确认了再动。

计划阶段先把事情想清楚，读代码、查资料、出方案。方案定了再切到构建，改代码、跑命令、推进任务，每一步都留下记录，随时可以停下来回头看。复查阶段对照差异和工作记录验收，高风险的操作在这里需要人批准。图里画的是主干流程，每个模式具体放开了哪些工具，以应用内的实际设置和服务端检查为准。

## 界面截图

<details open>
<summary><strong>工作台与对话</strong></summary>

主窗口的默认样子，右侧文件面板、命令搜索和工具入口都在这一组。

<table>
<tr>
<td align="center"><img src="docs/image/空态首页.png" alt="空态首页" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>空态首页</sub></td>
<td align="center"><img src="docs/image/完整工作界面(打开右侧文件面板).png" alt="完整工作界面" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>完整工作界面</sub></td>
<td align="center"><img src="docs/image/对话与常规.png" alt="对话与常规" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>对话与常规</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/image/文件与执行.png" alt="文件与执行" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>文件与执行</sub></td>
<td align="center"><img src="docs/image/搜索与工具.png" alt="搜索与工具" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>搜索与工具</sub></td>
<td align="center"><img src="docs/image/命令搜索.png" alt="命令搜索" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>命令搜索</sub></td>
</tr>
</table>

</details>

<details>
<summary><strong>模型与连接</strong></summary>

登录之后先配模型。Provider、密钥和连接状态，都在这几页里。

<table>
<tr>
<td align="center"><img src="docs/image/登录.png" alt="登录" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>登录</sub></td>
<td align="center"><img src="docs/image/模型选择器.png" alt="模型选择器" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>模型选择器</sub></td>
<td align="center"><img src="docs/image/模型与连接.png" alt="模型与连接" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>模型与连接</sub></td>
</tr>
</table>

</details>

<details>
<summary><strong>Agent 与自动化</strong></summary>

团队怎么建、专家怎么配、任务怎么委派，浏览器和电脑控制的入口也在这组。

<table>
<tr>
<td align="center"><img src="docs/image/智能体团队创建.png" alt="智能体团队创建" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>智能体团队创建</sub></td>
<td align="center"><img src="docs/image/专家.png" alt="专家" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>专家成员</sub></td>
<td align="center"><img src="docs/image/启用专家团队与目标模式.png" alt="启用专家团队与目标模式" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>团队与目标模式</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/image/主代理构建task并委派子代理.png" alt="主代理委派子代理" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>主代理委派子代理</sub></td>
<td align="center"><img src="docs/image/代理主动Ask工具.png" alt="代理主动 Ask 工具" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>主动 Ask 工具</sub></td>
<td align="center"><img src="docs/image/已安排.png" alt="已安排" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>已安排任务</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/image/浏览器自动化.png" alt="浏览器自动化" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>浏览器自动化</sub></td>
<td align="center"><img src="docs/image/浏览器执行.png" alt="浏览器执行" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>浏览器执行</sub></td>
<td align="center"><img src="docs/image/电脑控制.png" alt="电脑控制" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>电脑控制</sub></td>
</tr>
</table>

浏览器自动化和电脑控制的截图放在最后。这些能力都要单独配置凭据，配好之后才会在任务里出现。

</details>

<details>
<summary><strong>知识与个性化</strong></summary>

资料库、技能套件、记忆、用量费用和外观主题，日常设置都收在这里。

<table>
<tr>
<td align="center"><img src="docs/image/资料库.png" alt="资料库" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>资料库</sub></td>
<td align="center"><img src="docs/image/技能套件.png" alt="技能套件" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>技能套件</sub></td>
<td align="center"><img src="docs/image/记忆与个性化.png" alt="记忆与个性化" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>记忆与个性化</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/image/数据与历史.png" alt="数据与历史" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>数据与历史</sub></td>
<td align="center"><img src="docs/image/用量与费用.png" alt="用量与费用" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>用量与费用</sub></td>
<td align="center"><img src="docs/image/外观主题.png" alt="外观主题" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>外观主题</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/image/快捷键指南.png" alt="快捷键指南" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>快捷键指南</sub></td>
<td align="center"><img src="docs/image/安全与合规.png" alt="安全与合规" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>安全与合规</sub></td>
<td align="center"><img src="docs/image/附件菜单.png" alt="附件菜单" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>附件菜单</sub></td>
</tr>
</table>

最后一张是关于与版本页面，应用版本、构建编号和系统信息都在这里。碰到问题提 Issue 的时候，把这一页的信息捎上，排查会快很多。

<table>
<tr>
<td align="center"><img src="docs/image/关于.png" alt="关于" width="260" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"><br><sub>关于与版本</sub></td>
<td></td>
<td></td>
</tr>
</table>

资料库和技能套件的截图在这组。记忆与个性化的选项比较多，刚上手建议先看外观主题和快捷键指南。

</details>

## 它是怎么搭起来的

<div align="center">

<img src="docs/assets/architecture.svg" alt="架构总览" width="100%">

</div>

整个应用分四层。最外面是桌面集成层，Electron 主进程在这儿管窗口、原生浏览器视图、PTY 终端、系统通知和凭据保险库。往下是 Agent 运行层，Mastra 撑起的 Agent 运行时在这层，主 Agent 和专家成员的原生委派、并行与调用记录都发生在这里，三种执行模式也在这层落地。再往下是框架层，Mastra 的记忆、RAG、MCP 和可观测性模块，加上编辑器 AST 修改和沙箱执行，都归这层。最底下是扩展层，模型 Provider、MCP Server、技能、资料库和网页检索从这儿接进来。

一个任务的走向是这样的。你在桌面层发起任务，Agent 运行层组织 Agent 和模式，框架层提供记忆和工具，扩展层补上模型和外部服务。数据默认留在本机，Mastra 服务跑在本机 `4111` 端口。

主要选型列在下面。

| 部分       | 选型                                                      |
| ---------- | --------------------------------------------------------- |
| 桌面外壳   | Electron 45、electron-vite、electron-builder              |
| 界面       | React 19、TypeScript、Tailwind CSS 4、CodeMirror 6、xterm |
| Agent 框架 | Mastra 1.79（core、memory、rag、mcp、observability）      |
| 数据与检索 | libsql、DuckDB、fastembed 本地向量                        |
| 代码与文档 | Shiki 高亮、Mermaid、KaTeX、PDF 与 Office 解析            |
| 工具链     | Biome、Knip、pnpm workspace                               |

<div align="center">

<img src="docs/assets/divider.svg" alt="分隔" width="100%">

</div>

## 快速开始

### 直接下载

| 平台    | 安装包                                                                       |
| ------- | ---------------------------------------------------------------------------- |
| Windows | `MastraWork-0.0.8-setup.exe`                                                 |
| macOS   | `MastraWork-0.0.8.dmg`                                                       |
| Linux   | `MastraWork-0.0.8.AppImage`、`MastraWork-0.0.8.deb`、`MastraWork-0.0.8.snap` |



### 从源码运行

需要 Windows、macOS 或 Linux，Node.js `>=22.19.0`，pnpm `12.15.0`。推荐用 Corepack 把 pnpm 版本钉死，免得升级后对不上。

```sh
corepack enable
corepack prepare pnpm@12.15.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

打包三个平台的安装包。

```sh
pnpm build
pnpm build:win
pnpm build:mac
pnpm build:linux
```


### 首次配置

1. 启动后打开模型或连接设置，配一个可用的模型 Provider。
2. 选一个工作区目录。Agent 的读写和命令工具，以当前工作区与会话策略为边界。
3. 需要网页检索、浏览器、MCP 或技能时，再按实际服务分别配置凭据和授权。
4. 模型服务会收到你发过去的提示词和选定的上下文。用之前请读一遍对应模型或 API 的服务条款和数据处理政策。

默认本地数据目录是 `~/.mastrawork`。Mastra 服务默认监听本机 `4111` 端口，存储服务可以经 `MASTRA_STORAGE_URL` 调整。具体配置以当前版本的设置页面和源码为准。

## 安全与边界

- 计划、构建和复查模式对读、编辑、执行和外部工具采用不同策略。截图展示的是入口，实际安全性以服务端权限检查和测试记录为准。
- API Key、OAuth token 和 Cookie 由桌面主进程的凭据保险库保管，公开材料里不含任何真实凭据。
- 工作区、用户、线程、资料对象和扩展配置按资源 ID 关联。高风险代码、生产数据、个人信息，以及法律、医疗、金融领域的决策，仍要人来审。
- 公开网页上的内容，不自动等于可以复制、训练、改编或再分发。MCP Server、模型、字体、图标、网页内容和用户资料，各适用自己的许可或服务条款。

## 开发

先把 Node 和 pnpm 装好，版本见上文，然后执行下面的命令。

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
```

## 贡献与反馈

问题请走 [GitHub Issues](https://github.com/movclantian/mastra-desktop/issues)。可复现的问题最受欢迎，附上版本、系统、步骤、预期行为和实际行为，日志记得脱敏。项目按公开仓库的节奏持续迭代，不同发行版之间的行为和兼容性可能有变化，升级前请看 Release 说明。

## 许可证

项目自有代码、文档和配置以 [Apache-2.0](LICENSE) 发布。第三方组件和资源遵循各自的许可。


<div align="center">

<img src="docs/assets/divider.svg" alt="分隔" width="100%">

</div>

## Star 历史

<div align="center">

<a href="https://www.star-history.com/#movclantian/mastra-desktop&Date"><img src="https://api.star-history.com/svg?repos=movclantian/mastra-desktop&type=Date" alt="Star History Chart" width="720" style="border:2px solid #2c2c2c;border-radius:10px;box-shadow:3px 3px 0 rgba(44,44,44,0.85);background:#fffef5"></a>

</div>

感谢读到这里。项目还在早期，用着顺手或者踩到坑，都欢迎来 Issues 说一声。
