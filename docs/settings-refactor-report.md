# Settings Center Refactor Report

## Scope

The settings center now follows task-oriented navigation: General, Memory, Guardrails, Workspace, and Tools are primary; Providers, Themes, Storage, and Usage are grouped under Advanced Settings. The sidebar search indexes localized titles and descriptions and routes directly to the owning section.

## Copy Inventory Summary

| Area | Removed residue | Replacement |
| --- | --- | --- |
| Memory | OM, Observer, Reflector, model implementation names | Automatic memory, saved preferences, conversation context |
| Workspace | BM25, LSP, implementation/document references | Keyword search, code diagnostics, local search paths |
| Guardrails | Processor names, raw strategy expressions, mixed-language labels | Safety checks, full semantic strategy labels, localized option text |
| Theme | CSS/JSON/token labels and parenthetical aliases | Theme configuration, color values, corner/border/shadow controls |
| Storage and Tools | Studio/resource/API implementation copy | Browser management console, user identifier, service address |

## Interaction Inventory

- Extractors use a card list and edit drawer with required-name and required-instruction validation.
- Memory templates use presets, variable insertion buttons, and a live preview. Schemas use field rows and type selectors.
- Environment variables and provider options use key/value editors; common environment keys have quick-add actions.
- Numeric values use unit suffixes, empty/default placeholders where supported, range hints, and preset anchors for thresholds.
- Dependent controls are hidden or collapsed when their master switch is disabled. Automatic memory hides the manually controlled recent-message setting.
- Professional parameters are inside Advanced Settings sections.
- Every settings card has Restore Defaults. Read-only, blocking, and data-clearing actions use confirmation dialogs with impact text.

## Serialization

The backend schema is unchanged. Arrays, maps, templates, schemas, and extractor records are edited in their native shapes and written back through the existing settings API. Existing serialized text is preserved until the user changes that field; structured editors only replace the field after validation.

The static parity check is available at `scripts/check-settings-i18n.mts`. It is intentionally not executed in this pass because repository instructions prohibit automated test execution.

## Acceptance Evidence

| Checklist | Evidence |
| --- | --- |
| No internal documentation/codenames in settings UI | Localized settings copy and settings component scan; implementation-only comments removed from page files |
| zh-CN/en-US parity | `scripts/check-settings-i18n.mts`; all new keys added to both packs |
| Structured editing | `controls.tsx`, `memory-section.tsx`, `workspace-section.tsx`, `guardrails-section.tsx` |
| Units and defaults | `NumberRow`, `SliderRow`, localized unit and hint keys |
| Responsive layout | `SettingCard` declares the field container; `SettingRow` keeps controls inline at container width; `SettingGrid` handles compact two-column groups |
| Dangerous action confirmation | shared `ConfirmDialog`, storage reset dialog, read-only and blocking confirmations |
| Global search | `settings-page.tsx` localized search index and section navigation |

## Twenty-Item Copy Spot Check

| zh-CN | en-US |
| --- | --- |
| 界面语言 | Interface Language |
| 网络代理 | Network Proxy |
| 访问密钥 | Access Key |
| 消息历史 | Message History |
| 记忆模板 | Memory Template |
| 自动记忆 | Automatic Memory |
| 最近消息数 | Recent Messages |
| 关键词搜索 | Keyword Search |
| 代码语义检查 | Code Diagnostics |
| 技能路径 | Skill Paths |
| 命令执行 | Command Execution |
| 安全与合规 | Safety and Compliance |
| 注入检测 | Prompt Injection Detection |
| 个人信息检测 | Personal Information Detection |
| 响应缓存 | Response Cache |
| 高级设置 | Advanced Settings |
| 主题配置 | Theme Configuration |
| 浏览器管理台 | Browser Management Console |
| 恢复默认 | Restore Defaults |
| 访问密钥已配置 | Access key configured |

## Known Limits

The search result navigates to the owning settings section rather than a deep card anchor. Existing server-side serialized fields remain strings where the backend contract requires strings; the UI no longer exposes raw JSON or expression editing for those fields.
