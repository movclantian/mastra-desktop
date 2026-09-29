# 浏览器产品与实现边界

## 产品语义

- MastraWork 的 Browser 面板是用户可见的网页浏览器；输入网址或搜索词后，实际页面在 Electron 原生 Chromium `WebContentsView` 中加载。
- 页面、标签和导航状态由 Electron 主进程管理。用户与 Agent 在同一线程操作同一个当前可见页面，不启动隐藏的第二个 Agent 浏览器。
- 搜索引擎是地址栏对普通搜索词的解析选项；Bing 是可配置搜索目标，不是浏览器首页，也不是 Agent 专用页面。

## Agent 边界

- Mastra 保留 `@mastra/agent-browser` 的工具名称和 schema；桌面运行时将受限命令经本机 token 鉴权 IPC/broker 交给主进程。
- broker 按认证请求的 resource/thread 选择已存在且可见的页面；不能借 Agent 命令创建隐藏页或跨线程访问。
- refs 仅在当前页面快照上下文有效；导航、标签切换或页面隐藏会使在途命令失效，并要求重新 snapshot。
- Agent 页面命令受 deadline 限制；超时后递增 generation、清除 refs，并停止正在加载的页面，避免迟到结果被当作有效成功。
- Electron 主进程仍是页面生命周期和标签状态的唯一事实源。页面脚本执行属于网页上下文，不能把它当作可信系统操作。

## 验收声明

- 单测和隔离 Electron fixture 验证的是实现路径；生产应用登录态网站、任意站点兼容、性能/闪烁和 Codex 对照需要单独证据。
- 不静默回退到截图/SSE 页面操作；不以“浏览器工具存在”或“面板打开”代替成功操作证据。
- Mastra/AgentBrowser 的参数语义若未由实现与测试覆盖，必须明确标注，不能宣称完全兼容。
