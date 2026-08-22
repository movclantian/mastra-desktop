---
version: alpha
name: Mastra Design System
description: High-performance AI agentic workbench visual identity and design system specification
colors:
  primary: "#171717"
  primary-foreground: "#fafafa"
  secondary: "#f5f5f5"
  secondary-foreground: "#171717"
  background: "#ffffff"
  foreground: "#171717"
  sidebar: "#fafafa"
  sidebar-foreground: "#171717"
  sidebar-primary: "#171717"
  sidebar-primary-foreground: "#fafafa"
  sidebar-accent: "#f5f5f5"
  sidebar-accent-foreground: "#171717"
  sidebar-border: "#e5e5e5"
  sidebar-ring: "#a3a3a3"
  muted: "#f5f5f5"
  muted-foreground: "#737373"
  accent: "#f5f5f5"
  accent-foreground: "#171717"
  destructive: "#dc2626"
  destructive-foreground: "#fafafa"
  border: "#e5e5e5"
  input: "#e5e5e5"
  ring: "#a3a3a3"
typography:
  font-sans:
    fontFamily: "Geist Variable, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  font-mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  h1:
    fontFamily: "{typography.font-sans.fontFamily}"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  h2:
    fontFamily: "{typography.font-sans.fontFamily}"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  h3:
    fontFamily: "{typography.font-sans.fontFamily}"
    fontSize: "1.0rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "{typography.font-sans.fontFamily}"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "{typography.font-sans.fontFamily}"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
  code:
    fontFamily: "{typography.font-mono.fontFamily}"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.6
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  header-height: "48px"
  sidebar-width: "256px"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "18px"
  full: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.sidebar-foreground}"
    width: "{spacing.sidebar-width}"
  sidebar-inset:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
  card:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
---

# Mastra Desktop Design System Specification

## Overview

Mastra Desktop is an AI agentic engineering workbench designed for high-throughput coding, system automation, and multi-threaded agent orchestration. The visual identity follows an **agent-native, distraction-free desktop paradigm**.

### Core Tenets
1. **Agent-Native Contract**: All interface decisions are defined in structured machine-readable design tokens and validated by `DESIGN.md`.
2. **Workstation Desk Metaphor**: The outermost frame behaves as a physical desktop mat (`--sidebar` tint), with active workspaces presented as floating cards (`--background` with `rounded-xl`, `border`, and `shadow-sm`).
3. **Information Density & Restraint**: Avoid decorative noise. Utilize progressive disclosure (e.g. `showOnHover` actions), robust flex/grid bounds, and keyboard-first accelerators.

---

## Colors

Colors are systematically defined in hex tokens in YAML frontmatter and mapped to OKLCH custom properties in `src/renderer/src/index.css` for wide-gamut display support.

### Semantic Color Role Matrix

| Token | Light Theme Value | Dark Theme Value | UI Application |
| :--- | :--- | :--- | :--- |
| `background` | `#ffffff` / `oklch(1 0 0)` | `oklch(0.145 0 0)` | Document canvas, chat panel, active workbench card |
| `foreground` | `#171717` / `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | Primary content text, active tab titles |
| `sidebar` | `#fafafa` / `oklch(0.985 0 0)` | `oklch(0.205 0 0)` | Window mat, sidebar container, foundational underlay |
| `sidebar-accent` | `#f5f5f5` / `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Active thread highlight, sidebar hover states |
| `primary` | `#171717` / `oklch(0.205 0 0)` | `oklch(0.922 0 0)` | Primary action buttons, prominent callouts |
| `secondary` | `#f5f5f5` / `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Secondary buttons, filter chips, background tags |
| `muted` | `#f5f5f5` / `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Card containers, skeleton loaders, subtle tracks |
| `muted-foreground`| `#737373` / `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | Timestamps, placeholder labels, inactive icons |
| `destructive` | `#dc2626` / `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | Destructive triggers, error indicators |
| `border` | `#e5e5e5` / `oklch(0.922 0 0)` | `oklch(1 0 0 / 10%)` | Clean dividers, panel borders, card outlines |

---

## Typography

Typography uses the variable sans-serif font family `Geist Variable` alongside a monospace font for technical data streams.

### Typographic Hierarchy

- **H1 (`text-2xl font-semibold tracking-tight`)**: Large panel view titles, welcome headers.
- **H2 (`text-xl font-semibold`)**: Major modal headers, section groups.
- **H3 (`text-base font-semibold`)**: Sub-panel titles, card titles.
- **Body (`text-sm font-normal`)**: Standard message content, thread names, input text.
- **Caption (`text-xs text-muted-foreground`)**: Metadata, status badges, secondary notes.
- **Code (`font-mono text-[13px]`)**: Terminal output, code blocks, diff markers.

**Data Alignment Rule**: All streaming counters, dates, currencies, and numeric metrics **must** apply `tabular-nums` to guarantee fixed-width character stability.

---

## Layout

### 1. Viewport Boundaries
- The application root is fixed to `h-svh min-h-0 w-full overflow-hidden`.
- Body-level or window-level scrolling is disallowed. All scrollable areas reside in localized `ScrollArea` or `overflow-auto` containers.

### 2. Sidebar & Workbench Layout
- **Sidebar Shell**: Uses `collapsible="offcanvas"` and `variant="inset"`.
  - In open state: fixed at `16rem` (256px).
  - In collapsed state: completely slides off-canvas, maximizing code/chat surface.
  - Brand item in sidebar header toggles sidebar collapse via `onClick={toggleSidebar}`.
- **Floating Main Card (`SidebarInset`)**:
  - Encloses `PanelHeader` + Chat + Terminal + Workspace Panel.
  - Styled with `rounded-xl`, `border`, `shadow-sm`, `bg-background`, and dynamic margins (`m-2 ml-0` expanded, `m-2 ml-2` collapsed).
- **Top Header (`PanelHeader`)**:
  - Fixed height `h-12` (48px) with `px-4`.
  - Integrates `<SidebarTrigger className="-ml-1" />` followed by vertical `<Separator orientation="vertical" className="mx-1 h-4" />` and the truncated title.

---

## Elevation & Depth

Visual hierarchy is communicated through card surfaces and subtle shadows rather than dense borders:

1. **Base Surface (Level 0)**: `bg-sidebar` (window mat underlay).
2. **Active Surface (Level 1)**: `SidebarInset` (`bg-background rounded-xl border shadow-sm`).
3. **Nested Cards & Menus (Level 2)**: Floating menus, inner cards, and popovers (`shadow-xs` / `shadow-md`).
4. **Dialogs & Overlays (Level 3)**: Modals and command overlays (`shadow-lg ring-1 ring-border/50`).

---

## Shapes

All UI radii strictly follow the mathematical scale derived from `--radius: 0.625rem` (10px):

```
--radius-sm:  calc(var(--radius) * 0.6)  =  6px   (Badges, inner mini-icons)
--radius-md:  calc(var(--radius) * 0.8)  =  8px   (Buttons, inputs, dropdown items)
--radius-lg:  var(--radius)              = 10px   (Inner cards, dialog modals)
--radius-xl:  calc(var(--radius) * 1.4)  = 14px   (Main SidebarInset floating card)
--radius-2xl: calc(var(--radius) * 1.8)  = 18px   (Outer drawers, master sheets)
--radius-full: 9999px                             (Pills, status avatars)
```

---

## Components

### Mandatory Pre-Modification Rule (前置检索约束)

> **核心约束**：在编写或修改任何前端组件前，**AI Agent 必须先在 `docs/examples/` 与 `docs/aielements/` 目录下按通用前缀查找并读取对应的官方示例组件**，严禁凭空臆造组件结构。

#### 前缀匹配与检索协议：
1. **通用 UI 基础组件**：在 `docs/examples/` 目录下，直接匹配 `<component_name>-*.tsx`（例如需使用对话框，搜索 `docs/examples/dialog-*`；使用表格，搜索 `docs/examples/table-*`；使用折叠面板，搜索 `docs/examples/collapsible-*`）。
2. **AI / 交互流专有组件**：在 `docs/aielements/` 目录下，直接匹配 `<feature_name>*.tsx`（例如对话流 `conversation.tsx`、输入框 `prompt-input*.tsx`、文件树 `file-tree*.tsx`、终端 `terminal.tsx`、代码制品 `artifact.tsx`）。
3. **参数继承**：完整复用官方示例中的属性名、ARIA 标注、槽位命名 (`data-slot`) 与嵌套结构。

---

## Do's and Don'ts

### Do's
- **DO** verify and read `docs/examples/` prefix matches before writing UI code.
- **DO** use semantic design token variables (`bg-background`, `bg-sidebar`, `text-muted-foreground`, `rounded-xl`).
- **DO** apply `tabular-nums` on all numbers, latency metrics, and timestamps.
- **DO** wrap long content in `ScrollArea` or `min-h-0 flex-1 overflow-auto` to prevent viewport overflows.
- **DO** use `showOnHover` on list item actions to keep interfaces clean and noise-free.

### Don'ts
- **DON'T** use `collapsible="icon"` for the primary navigation; use `collapsible="offcanvas"` with `variant="inset"`.
- **DON'T** allow the window root or `body` to display global scrollbars.
- **DON'T** hardcode arbitrary colors or pixel sizes when design tokens exist.
- **DON'T** create micro-component files under 100 lines when logic can reside within its parent module.
- **DON'T** retain dead compatibility fallbacks.