# 下一轮推送目标、成果与验收计划

日期：2026-09-21  
基线：`origin/main@7281626064ca35a881a86e5ae757c30a222f3b9a`  
状态：规划与验证中；本文件不代表已产生新的业务代码或已推送新的提交。

## 1. 当前基线结果

| 检查 | 当前结果 | 结论 |
| --- | --- | --- |
| `pnpm run typecheck` | PASS | 类型层无新增阻断；Node 24/pnpm 11 与项目声明 Node 22/pnpm 12 不一致 |
| `pnpm run test:regression` | 34/34 PASS | 流、任务、Provider、上传、chunker、工具投影、grep、Windows 编码门禁通过 |
| `pnpm run verify:release` | PASS | 源码、图标、打包 guard 通过 |
| 主分支状态 | `origin/main == HEAD` | 上一轮成果已合并；当前无新的代码差异 |
| fresh review | 待本轮独立复核 | 只读 review，不改代码 |

这些结果只能证明当前基线的自动化门禁通过，不能替代桌面窗口中的长任务、滚动、鼠标和真实 Provider 验收。

## 2. 下一轮推送目标

### P1-A：真实桌面长任务验收与证据闭环

目标：确认上一轮针对卡顿、流中断和任务记录停滞的修复在真实 Electron 窗口成立。

验收场景：

1. 新会话执行单次工具调用，确认流式文本和工具结果完整收敛。
2. 同一会话连续执行两轮工具链，不切换会话、不刷新页面。
3. 运行 10 个以上工具步骤，观察鼠标、滚动、任务卡状态和最终文本。
4. 计划提交、批准、拒绝、重新提交各执行一次，确认按钮状态不会永久灰掉。
5. 记录主进程、Mastra、renderer 的同一时间窗日志；失败时保留第一处错误，不重复盲扫。

通过标准：连续 3 次完成；无 `Maximum update depth exceeded`、重复 `toolCallId`、网络流中断后永久卡住；滚动和鼠标在任务执行期间仍可操作。

### P1-B：Provider 与协议矩阵

目标：确认 DeepSeek 修复没有破坏其他 Provider。

矩阵至少覆盖：

- DeepSeek thinking：`reasoning_content` 多轮工具请求。
- OpenAI-compatible：自定义 `baseUrl`、401/402/429/5xx 原样保留。
- 其他 registry Provider：registry URL 不回退到 `api.openai.com`。
- 取消、超时和重试：不重复发送已完成工具调用，不丢失最终状态。

通过标准：每个 Provider 都记录最终请求端点、HTTP 状态、重试次数和终态；密钥只在本机输入，不进入日志、测试夹具或提交。

### P1-C：上传与媒体真实边界

目标：确认 20MB 分片协议、失败清理和媒体读取在实际文件上成立。

验收场景：5MB、20MB、略超 20MB；并发 2–4 个上传；中途取消；磁盘写入失败；视频/图片预览；ZIP 明确提示“不支持聊天模型链路”，不误报为可解析。

通过标准：成功资产可读取，失败资产不产生孤儿记录；新会话不被清理任务阻塞；提示与后端真实能力一致。

### P2-A：发布与安装闭环

目标：在代码和桌面 P1 通过后，再验证最新产物。

- 干净 `dist` 构建，记录 commit、Node/pnpm、产物 SHA256。
- `verify:package:dir` 与 `verify:package`。
- 安装后启动、`/health`、关闭进程树。
- 扫描 Enterprise/EE 路径、旧 source map、重复 runtime。
- 只验证确定可裁剪资源，不以包体变小作为唯一成功标准。

### P2-B：CI/Release 真实运行

目标：确认 PR check、tag build、Release 权限和产物上传链路，不把本地 `verify:release` 当云端成功。

## 3. 明确暂缓

- 不继续盲目修改 React 状态链，除非 P1-A 获取到新的组件栈或时间窗证据。
- 不强制安装包瘦身；Chromium、ffmpeg、native runtime 先按消费者矩阵判断。
- 不开展安全专项，不 force-push，不改写已合并历史。

## 4. 本轮 review 结论模板

独立 reviewer 必须分别回答：

1. 当前基线是否仍可从 `origin/main@7281626` 重现 34/34？
2. P1-A 的自动化证据是否足以替代真实桌面？如果不能，缺哪一段日志/截图？
3. Provider、上传、技能能力变化中，哪些是我们引入的回归风险？
4. 是否存在新的 P0/P1 阻断？没有证据时标记 `unknown`，不写成 PASS。

## 5. 下一次提交边界

下一轮只允许包含：

- P1-A/B/C 中由新证据直接支持的最小修复；
- 对应回归测试和验收记录；
- 必要的 CI/发布门禁调整。

不混入无关重构、截图、用户数据、凭据、`node_modules`、`dist` 或本机绝对路径。

