---
name: Mastra Desktop
version: 0.0.5
description: >-
  Design system for mastra-desktop, a local-first multi-agent coding workbench
  (Electron + React + Mastra). UI is built on shadcn/ui "base-nova" over
  @base-ui/react (NOT Radix) with Tailwind CSS v4 and OKLCH/neutral semantic
  tokens. A runtime theme engine swaps 18+ presets via [data-theme-style].
  MANDATORY RULE / 强制规则: before writing ANY UI code you MUST retrieve and read
  the prefix-matching component under docs/examples/ (the <name>.mdx spec plus
  every <name>-*.tsx demo). 在写 UI 代码前必须检索并阅读 docs/examples/ 下的前缀匹配组件。
colors:
  background: "#ffffff"
  foreground: "#171717"
  primary: "#171717"
  on-primary: "#fafafa"
  secondary: "#f5f5f5"
  on-secondary: "#171717"
  muted: "#f5f5f5"
  on-muted: "#737373"
  accent: "#f5f5f5"
  on-accent: "#171717"
  destructive: "#dc2626"
  on-destructive: "#fafafa"
  border: "#e5e5e5"
  input: "#e5e5e5"
  ring: "#a3a3a3"
  card: "#ffffff"
  on-card: "#171717"
  popover: "#ffffff"
  on-popover: "#171717"
  sidebar: "#fafafa"
  on-sidebar: "#171717"
  sidebar-border: "#e5e5e5"
typography:
  h1:
    fontFamily: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
    fontSize: 1.5rem
    fontWeight: "600"
    letterSpacing: -0.015em
  h2:
    fontFamily: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
    fontSize: 1.25rem
    fontWeight: "600"
    letterSpacing: -0.015em
  h3:
    fontFamily: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
    fontSize: 1rem
    fontWeight: "600"
    letterSpacing: -0.015em
  body-md:
    fontFamily: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
    fontSize: 0.875rem
    fontWeight: "400"
    letterSpacing: -0.015em
  body-sm:
    fontFamily: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
    fontSize: 0.75rem
    fontWeight: "400"
    letterSpacing: -0.015em
  code:
    fontFamily: '"JetBrains Mono", "SF Mono", Consolas, monospace'
    fontSize: 0.8125rem
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  2xl: 18px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  app-shell:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    padding: "{spacing.lg}"
  page-heading:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.h1}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: 36px
    padding: "{spacing.lg}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: 36px
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.on-destructive}"
    rounded: "{rounded.md}"
    height: 36px
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.on-card}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
    typography: "{typography.h3}"
  dialog:
    backgroundColor: "{colors.card}"
    textColor: "{colors.on-card}"
    rounded: "{rounded.xl}"
    padding: "{spacing.2xl}"
    typography: "{typography.h2}"
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.on-popover}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  menu-item:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: 36px
    padding: "{spacing.md}"
    typography: "{typography.body-md}"
  badge:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    typography: "{typography.body-sm}"
    padding: "{spacing.xs}"
  chip-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary}"
    rounded: "{rounded.sm}"
  chip-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
  muted-text:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-muted}"
    typography: "{typography.body-sm}"
  muted-panel:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.on-sidebar}"
    width: 256px
    padding: "{spacing.md}"
    typography: "{typography.body-md}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
    width: 100%
  code-block:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
    typography: "{typography.code}"
  panel-raised:
    backgroundColor: "{colors.card}"
    textColor: "{colors.on-card}"
    rounded: "{rounded.2xl}"
    padding: "{spacing.xs}"
---

# Mastra Desktop — DESIGN.md

> Format: [`@google/design.md`](https://github.com/google-labs-code/design.md) (Google Stitch open standard).
> Validate with `npx @google/design.md lint DESIGN.md`
> (on Windows use `npx -p @google/design.md designmd lint DESIGN.md`).

## ⛔ MANDATORY WORKFLOW — READ BEFORE WRITING ANY UI CODE

**在写 UI 代码前，必须检索并阅读 `docs/examples/` 下的前缀匹配组件。**
Before writing, editing, or reviewing ANY UI code, you MUST first retrieve and
read the prefix-matching component examples under `docs/examples/`. This is a
hard gate, not a suggestion — the answers below are derived from those files,
which are the authoritative source of truth for this project's component API.

Given a target component named `<name>` (e.g. `button`, `data-table`, `input-group`):

1. **Locate the spec** — read `docs/examples/<name>.mdx`. It carries the YAML
   frontmatter (`title`, `description`, `base`, `component`), the variant
   gallery, the install command (`npx shadcn@latest add <name>`), and the
   **API Reference** prop table. This table is the contract — never guess props.
2. **Read every demo by prefix** — read all files matching `docs/examples/<name>-*.tsx`
   (e.g. for `button`: `button-demo.tsx`, `button-size.tsx`, `button-outline.tsx`,
   `button-spinner.tsx`, … 24 files). Copy official best-practice usage directly;
   do not reinvent patterns that already exist in these demos.
3. **Match the longest prefix first** — `input` vs `input-group` vs `input-otp`
   are three distinct components. When several prefixes match, read the most
   specific one plus its `.mdx`. `alert` vs `alert-dialog`, `button` vs
   `button-group`, `toggle` vs `toggle-group`, `message` vs `message-scroller`
   are all separate families.
4. **Then map to the real source** — the runnable component lives at
   `src/renderer/src/shared/ui/<name>.tsx` (alias `@/shared/ui/<name>`). Import
   from the alias, never from `@/components/ui/*` shown in the shadcn docs.

If no `<name>.mdx` exists in `docs/examples/` (e.g. Magic UI effects like
`animated-*`, `marquee`, `meteors`, `particles`; or `ai-elements/*` chat parts
such as `prompt-input`, `reasoning`, `tool`, `chain-of-thought`), read the
component source under `src/renderer/src/shared/ui/` directly before use.

**Never write UI code from memory or from generic shadcn/Radix knowledge.** This
project uses the `base-nova` style on `@base-ui/react`, whose prop names and
`data-slot`/`data-*` state attributes differ from Radix. The examples are the only
reliable reference.

## Overview

mastra-desktop is a local-first, multi-agent coding workbench: an Electron shell
with a persistent sidebar, resizable panels, a streaming chat/agent surface, and
dense tooling views (code, diffs, file trees, task queues). The visual language is
**shadcn/ui "base-nova"** — clean, neutral, information-dense, and calm by default,
but fully re-skinnable at runtime.

Design priorities, in order:

1. **Legibility & density over decoration.** This is a pro tool; prefer compact
   spacing, clear hierarchy, and `tabular-nums` for numeric/terminal data.
2. **Reuse the documented component.** Every primitive already exists in
   `@/shared/ui` with a spec in `docs/examples/`. Compose before you create.
3. **Theme-agnostic markup.** A runtime engine swaps 18+ presets
   (`default`, `neobrutalism`, `glasscn`, `thegridcn`, `8bitcn`, `pouf`, …) by
   setting CSS variables and a `[data-theme-style]` attribute on `<html>`. Write
   components with semantic tokens (`bg-background`, `text-foreground`,
   `border-border`) so they adapt to every preset and to light/dark automatically.
4. **No overflow.** The desktop shell sets `body { overflow: hidden }`. Every
   scrollable region must use `ScrollArea` / `ScrollAreaViewport`; enforce text
   wrapping and flex/grid responsive structures so nothing clips.

Stack: Electron + React 19 + TypeScript, Tailwind CSS v4 (`@import "tailwindcss"`,
`@theme inline`, `@custom-variant dark`), `@base-ui/react` primitives, `lucide-react`
icons, `sonner` for toasts, CodeMirror for editors, Magic UI / animate-ui /
dotmatrix registries for effects and loaders.

## Colors

Colors are **semantic roles**, not raw hues. Always consume them through Tailwind
token utilities so the active preset and light/dark mode apply automatically.

Default preset ("Mastra Clean", neutral base) — light values in the frontmatter
above; the CSS layer (`src/renderer/src/styles/globals.css`) defines the same
roles in **OKLCH**. Dark mode is driven by the `.dark` class on `<html>`
(`@custom-variant dark (&:is(.dark *))`), toggled by `ThemeProvider` — never by
`prefers-color-scheme` directly.

Role usage:

- `background` / `foreground` — app shell base surface and its default text.
- `card` / `popover` (+ `-foreground`) — elevated containers, dialogs, menus.
- `primary` / `primary-foreground` — the single strongest action (default button,
  active nav). Neutral near-black in light, near-white in dark.
- `secondary` / `muted` / `accent` (+ `-foreground`) — quiet fills, hover states,
  subdued panels. `muted-foreground` is the standard de-emphasized text color.
- `destructive` / `destructive-foreground` — danger only (delete, drop DB, errors).
  Never decorative.
- `border` / `input` / `ring` — hairline dividers, form control borders, and the
  focus ring. `border` is the global default border color (`* { border-color }`).
- `sidebar*` — the navigation rail has its own parallel token set.
- `--color-1 … --color-5` — the Magic UI gradient/rainbow accent ramp, reserved
  for effect components (`animated-gradient-text`, `rainbow-button`, `shine-border`).

Rules:

- **Do not hardcode hex/rgb/hsl** in components. Use `bg-*`, `text-*`, `border-*`
  semantic utilities, or `var(--token)` / `color-mix(in oklab, …)` when a raw
  reference is unavoidable (as the theme CSS does).
- Every foreground must pair with its background token to preserve contrast.
  Target **WCAG AA** (≥ 4.5:1 body text, ≥ 3:1 large text & UI borders).
- For per-preset accent color swaps use the `ThemeInspirationPalette` presets
  (`cyber-yellow`, `terminal-green`, `tron-ares`, `nordic-aurora`, …) — do not
  invent one-off brand colors inline.
- `input`, `ring`, and `sidebar-border` are **line / focus roles, not fills**. They
  are consumed through Tailwind utilities (`border-input`, `ring-ring`,
  `border-sidebar-border`) and the global `* { border-color: var(--color-border) }`
  rule, never as a component's `backgroundColor`/`textColor`. Because the
  `@google/design.md` component schema only models fill/text/typography/shape/spacing
  sub-tokens, these three legitimately surface as `orphaned-tokens` **warnings** on
  `lint` (0 errors). Keep them — do not delete real tokens just to silence a warning.

## Typography

Two families, both theme-overridable via CSS variables set by `apply-theme.ts`:

- **Sans** — `--theme-font-sans`, default `system-ui, -apple-system, "Segoe UI",
  Roboto, "Helvetica Neue", sans-serif`. Applied to `body`.
- **Mono** — `--theme-font-mono`, default `"JetBrains Mono", "SF Mono", Consolas,
  monospace`. Applied to `code, pre, kbd, samp` and all code/terminal surfaces.

Scale (Tailwind v4 rem base, 1rem = 16px):

| Role        | Size       | Weight | Notes                                  |
| ----------- | ---------- | ------ | -------------------------------------- |
| Page title  | `text-2xl`/`text-3xl` | `--theme-heading-weight` (600) | headings use `letter-spacing: -0.02em` |
| Section (h2)| `text-xl`  | 600    | tight tracking                         |
| Card title  | `text-base`| 600    | `[data-slot="card-title"]`             |
| Body        | `text-sm` (14px) | 400 | the app's default reading size         |
| Caption/muted | `text-xs` (12px) | 400 | labels, timestamps, meta             |
| Code        | `text-[13px]` mono | 400 | CodeMirror / `<pre>` / `kbd`         |

Rules:

- Headings (`h1–h6`) inherit `font-weight: var(--theme-heading-weight)` and
  `letter-spacing: var(--theme-letter-spacing)` — do not override per component.
- Global body letter-spacing is `var(--theme-letter-spacing, normal)`
  (default preset `-0.015em`). Some presets widen it (`thegridcn` +0.05em,
  pixel themes +0.02em). Respect the variable; never hardcode `tracking-*` on
  body text.
- Use **mono** for anything machine-generated: code, diffs, paths, logs, IDs,
  token counts, and terminal output. Enable `tabular-nums` for aligned numbers.
- The `typography` component (`docs/examples/typography-*.tsx`, 14 demos) is the
  reference for prose styling — read it before laying out long-form text.

## Layout

The app is a fixed desktop shell: `html, body, #root { height: 100% }` and
`body { overflow: hidden }`. Layouts are composed with flexbox/grid and must never
rely on document scrolling.

Structure & key measures:

- **Sidebar** — width `--sidebar-width: 16rem` (256px), collapsed
  `--sidebar-width-icon: 3rem` (48px). Build with the `sidebar` family
  (`docs/examples/sidebar-*.tsx`, 13 demos).
- **Panels** — resizable split panes via `resizable` / `panel`
  (`react-resizable-panels`); see `docs/examples/resizable-*.tsx`.
- **Spacing scale** — Tailwind v4 default, 4px base
  (`gap-1`=4, `gap-2`=8, `gap-3`=12, `gap-4`=16, `gap-6`=24, `gap-8`=32). Prefer
  `gap-*` on flex/grid containers over per-child margins.
- **Padding** — cards `p-6` (24px) by default; dense tool rows `px-2 py-1`/`px-3 py-2`.
  Keep it tight: this is a pro tool, avoid marketing-scale whitespace.

Rules:

- **Every scrollable region uses `ScrollArea`** (`@/shared/ui/scroll-area`), never
  a raw `overflow-auto` div, so the themed slim scrollbar applies. Horizontal
  scrollbars are 2px, vertical 6px.
- Enforce text wrapping (`break-words` / `overflow-wrap`) on any user- or
  model-generated string; truncate with `truncate` + a `Tooltip` for full value.
- Compose responsive rows with `flex` + `min-w-0` on flexible children to prevent
  overflow blowouts; use `grid` for aligned card/table layouts.
- Anchor transient UI (menus, popovers, dialogs, sheets, drawers) to the correct
  edge and let Base UI handle positioning — read the matching example first.
- Use `.no-scrollbar` only where a scrollbar must be hidden but scroll retained.

## Elevation & Depth

Depth is expressed through **borders first, shadows second**, and both are
theme-driven so presets can radically change the feel.

Tokens set at runtime by `apply-theme.ts`:

- `--radius` (default `10px`) drives the whole rounded scale (see Shapes).
- `--theme-border-width` (default `1px`; brutalism/pixel presets force `2px`).
  Global `.border*` utilities read this variable.
- `--theme-shadow-hard` — the preset's signature shadow. When `shadowDepth === 0`
  (default preset) it resolves to a soft `0 1px 2px 0 rgb(0 0 0 / 0.05)`; otherwise
  an offset hard shadow `Nx N 0px var(--border)`.

Shadow conventions by theme family (all in `globals.css`):

- **Default / SaaS / whiskeyjack** — flat, hairline borders, near-invisible soft shadow.
- **Brutalism** (`boldkit`, `neobrutalism`, `retroui`, `saaskit`) — solid borders +
  hard offset shadows; buttons translate on `:active`; `neobrutalism` lifts on `:hover`.
- **Clay / Glass / Skeuomorphic** (`pouf`, `glasscn`, `einui`, `sabraman`) — layered
  soft shadows, `backdrop-filter: blur()`, inset highlights, larger radii.
- **Sci-fi / neon** (`thegridcn`, `gymnopedies`, `atroui`, `usva`) — colored glow
  (`box-shadow: 0 0 Npx <accent>`), grid/scanline ambient overlays.
- **Pixel** (`8bitcn`, `pixelact`) — `border-radius: 0`, `image-rendering: pixelated`,
  hard `2–3px` black/border shadows, **no transitions** (instant state jumps).

Rules:

- Reach for `border-border` before `shadow-*`. Reserve elevation for genuine
  layering: `popover`/`dropdown`/`dialog`/`sheet`/`tooltip` above page content.
- Use the standard shadow utilities (`shadow-xs/sm/md/lg`) — they are remapped per
  preset, so a single class yields the correct look everywhere.
- Do not hardcode `box-shadow` values in components; extend the theme CSS instead.

## Shapes

Corner radius derives from one variable, `--radius` (default `0.625rem` = `10px`),
mapped in `@theme inline`:

| Token        | Formula              | Default | Tailwind class |
| ------------ | -------------------- | ------- | -------------- |
| `rounded-sm` | `--radius × 0.6`     | 6px     | `rounded-sm`   |
| `rounded-md` | `--radius × 0.8`     | 8px     | `rounded-md`   |
| `rounded-lg` | `--radius × 1`       | 10px    | `rounded-lg`   |
| `rounded-xl` | `--radius × 1.4`     | 14px    | `rounded-xl`   |
| `rounded-2xl`| `--radius × 1.8`     | 18px    | `rounded-2xl`  |
| `rounded-3xl`| `--radius × 2.2`     | 22px    | `rounded-3xl`  |
| `rounded-4xl`| `--radius × 2.6`     | 26px    | `rounded-4xl`  |
| `rounded-full` | —                  | 9999px  | pills, avatars |

Conventions:

- Controls (button, input, select) → `rounded-md`. Cards, dialogs, popovers →
  `rounded-lg`/`rounded-xl`. Badges, avatars, pill toggles → `rounded-full`.
- Presets override these: pixel themes force `0`; `pouf`/`washiveil` buttons force
  `rounded-full`; `thegridcn` forces `0.25rem`. Because overrides key off
  `[data-slot="…"]`, **always render the correct `data-slot`** so theming applies.
- Scrollbar thumbs are `rounded-full` (9999px) except pixel themes.

## Components

**Every component below is documented in `docs/examples/`. Per the mandatory
workflow, read `<name>.mdx` + all `<name>-*.tsx` before touching it.** Import from
`@/shared/ui/<name>`. The `base` is `@base-ui/react`, so state attributes are
`data-open` / `data-closed` / `data-panel-open` / `data-state` — copy them from the
demos, do not assume Radix's `data-state="open|closed"` everywhere.

Documented families (64) with demo counts — use this as the prefix-match index:

- **Actions & input**: `button` (24), `button-group` (11), `toggle` (12),
  `toggle-group` (7), `input` (46), `input-group` (23), `input-otp` (9),
  `textarea` (5), `native-select` (4), `select` (6), `combobox` (11),
  `checkbox` (7), `radio-group` (6), `switch` (6), `slider` (6), `field` (12),
  `label` (1), `date-picker` (7), `calendar` (11), `kbd` (5).
- **Navigation & structure**: `sidebar` (13), `breadcrumb` (6), `navigation-menu` (1),
  `menubar` (5), `pagination` (3), `tabs` (5), `command` (6), `dropdown-menu` (12),
  `context-menu` (10), `separator` (4), `resizable` (3), `direction` (0), `item` (10).
- **Overlays & feedback**: `dialog` (5), `alert-dialog` (6), `sheet` (3),
  `drawer` (7), `popover` (4), `hover-card` (2), `tooltip` (4), `toast` (3),
  `alert` (11), `progress` (3), `spinner` (7), `skeleton` (6), `empty` (7).
- **Data & content**: `table` (3), `data-table` (1), `card` (5), `accordion` (6),
  `collapsible` (4), `avatar` (9), `badge` (6), `aspect-ratio` (3), `carousel` (7),
  `chart` (7), `scroll-area` (2), `typography` (14).
- **AI / chat surface** (this product's core — read carefully): `message` (19),
  `message-scroller` (12), `bubble` (10), `marker` (8), `attachment` (6),
  `questionnaire` (14).

Not in `docs/examples/` — read the source under `src/renderer/src/shared/ui/`:

- **Magic UI / animate-ui effects**: `animated-beam`, `animated-gradient-text`,
  `animated-list`, `animated-shiny-text`, `animated-tabs`, `blur-fade`,
  `code-comparison`, `dot-pattern`, `flickering-grid`, `grid-pattern`,
  `hyper-text`, `interactive-hover-button`, `magic-card`, `marquee`, `meteors`,
  `neon-gradient-card`, `number-ticker`, `orbiting-circles`, `particles`,
  `pulsating-button`, `rainbow-button`, `ripple`, `shimmer-button`,
  `shine-border`, `sliding-number`, `sparkles-text`, `smooth-cursor`, `panel`.
- **`ai-elements/`** (chat building blocks): `prompt-input`, `reasoning`, `tool`,
  `task`, `chain-of-thought`, `code-block`, `context`, `file-tree`,
  `file-type-icon`, `inline-citation`, `model-selector`, `plan`, `queue`,
  `sandbox`, `shimmer`, `stack-trace`, `web-preview`, `attachments`, `message`.
- **`visual/dotmatrix/`** loaders (`dotm-*`, `core.tsx`, `hooks.ts`, `loader.css`).

Component authoring rules:

- Every rendered sub-element carries its `data-slot="<slot>"` attribute — the theme
  engine targets these selectors (`[data-slot="card"]`, `[data-slot="button"]`, …).
  Omitting `data-slot` silently breaks preset styling.
- Buttons: use the `variant` (`default | outline | ghost | destructive | secondary | link`)
  and `size` (`default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg`) props
  from `button.mdx`. For icon spacing add `data-icon="inline-start|inline-end"`.
  To render a link styled as a button use the `buttonVariants` helper on a plain
  `<a>` — **never** `<Button render={<a />} nativeButton={false} />` (Base UI forces
  `role="button"` and overrides link semantics).
- Loading state = a `<Spinner />` inside the control, per `button-spinner.tsx`.
- Prefer composing existing primitives (e.g. `InputGroup`, `Field`, `Item`) over
  writing bespoke markup.

## Do's and Don'ts

**Do**

- ✅ **Retrieve and read the prefix-matching `docs/examples/<name>.mdx` +
  `<name>-*.tsx` before writing any UI code.** 在写 UI 代码前必须检索并阅读
  `docs/examples/` 下的前缀匹配组件。 This is non-negotiable.
- ✅ Import from `@/shared/ui/<name>` and `@/shared/lib/utils` (`cn`).
- ✅ Use semantic color/spacing/radius tokens so all 18+ presets and light/dark adapt.
- ✅ Preserve `data-slot` and Base UI `data-*` state attributes exactly as in the demos.
- ✅ Use `ScrollArea` for every scrollable region; enforce wrapping and `min-w-0`.
- ✅ Use `lucide-react` for icons and `sonner`/`toast` for notifications.
- ✅ Run `pnpm format`, `pnpm lint`, `pnpm typecheck` after changes (Biome).
- ✅ Validate this file after edits: `npx @google/design.md lint DESIGN.md`.

**Don't**

- ❌ Don't write UI from generic shadcn/Radix memory — this project is `base-nova`
  on `@base-ui/react`; props and state attributes differ.
- ❌ Don't hardcode hex/rgb colors, `box-shadow`, `letter-spacing`, or `border-radius`
  in components — use tokens / theme variables.
- ❌ Don't rely on `@/components/ui/*` paths from the shadcn docs; they don't exist here.
- ❌ Don't use raw `overflow-auto` or document scrolling (the shell is `overflow: hidden`).
- ❌ Don't add speculative abstractions or new deps when a documented component covers it.
- ❌ Don't use `destructive` styling for non-destructive actions.
- ❌ Don't start dev servers or run the app to "check" UI — verification is manual
  by the user; rely on the examples + `typecheck`.
- ❌ Don't confuse similar prefixes (`input`/`input-group`/`input-otp`,
  `alert`/`alert-dialog`, `message`/`message-scroller`, `toggle`/`toggle-group`) —
  match the longest correct prefix.
