import { icons } from "@iconify-json/material-icon-theme";
import {
  FileCode2Icon,
  FolderArchiveIcon,
  FolderCodeIcon,
  FolderCogIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react";
import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type IconSource = {
  body: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

type IconAlias = {
  parent: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

const FILE_ICONS: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  ts: "typescript",
  tsx: "react-ts",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  mdx: "markdown",
  txt: "document",
  text: "document",
  log: "log",
  pdf: "pdf",
  doc: "word",
  docx: "word",
  dot: "word",
  dotx: "word",
  rtf: "word",
  odt: "word",
  xls: "table",
  xlsx: "table",
  xlsb: "table",
  xlsm: "table",
  ods: "table",
  csv: "table",
  tsv: "table",
  ppt: "powerpoint",
  pptx: "powerpoint",
  pptm: "powerpoint",
  pps: "powerpoint",
  ppsx: "powerpoint",
  odp: "powerpoint",
  py: "python",
  ipynb: "python",
  css: "css",
  scss: "sass",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "settings",
  conf: "settings",
  cfg: "settings",
  env: "tune",
  sh: "console",
  bash: "console",
  zsh: "console",
  ps1: "powershell",
  sql: "database",
  sqlite: "database",
  db: "database",
  rs: "rust",
  java: "java",
  go: "go",
  php: "php",
  rb: "ruby",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  graphql: "graphql",
  gql: "graphql",
  prisma: "prisma",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  avif: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  aac: "audio",
  flac: "audio",
  m4a: "audio",
  opus: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
  avi: "video",
  m4v: "video",
  mkv: "video",
  mpeg: "video",
  mpg: "video",
  wmv: "video",
  zip: "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  rar: "zip",
  "7z": "zip",
  epub: "document",
  azw: "document",
  azw3: "document",
  mobi: "document",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
};

const EXACT_FILE_ICONS: Record<string, string> = {
  "package.json": "nodejs",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "tsconfig.json": "tsconfig",
  "biome.json": "biome",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".env": "tune",
  dockerfile: "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "readme.md": "readme",
  "readme.txt": "readme",
  readme: "readme",
  license: "license",
  "license.md": "license",
  "license.txt": "license",
  "vite.config.ts": "vite",
  "vite.config.js": "vite",
  "vite.config.mjs": "vite",
  "tailwind.config.js": "tailwindcss",
  "tailwind.config.ts": "tailwindcss",
  "tailwind.config.mjs": "tailwindcss",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.js": "eslint",
  ".prettierrc": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.js": "prettier",
  "next.config.js": "next",
  "next.config.mjs": "next",
  "next.config.ts": "next",
  "astro.config.mjs": "astro",
  "astro.config.ts": "astro",
};

const MIME_ICONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/rtf": "word",
  "application/msword": "word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word",
  "application/vnd.ms-excel": "table",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "table",
  "application/vnd.ms-powerpoint": "powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "powerpoint",
  "application/epub+zip": "document",
  "application/json": "json",
  "application/sql": "database",
};

function iconSource(name: string, visited = new Set<string>()): IconSource | undefined {
  const source = icons.icons[name] as IconSource | undefined;
  if (source) return source;
  if (visited.has(name)) return undefined;
  const alias = icons.aliases?.[name] as IconAlias | undefined;
  if (!alias) return undefined;
  visited.add(name);
  const parent = iconSource(alias.parent, visited);
  return parent
    ? {
        body: parent.body,
        left: alias.left ?? parent.left,
        top: alias.top ?? parent.top,
        width: alias.width ?? parent.width,
        height: alias.height ?? parent.height,
      }
    : undefined;
}

export function MaterialIcon({
  name,
  className,
  ...props
}: { name: string; className?: string } & SVGProps<SVGSVGElement>) {
  const source = iconSource(name) ?? iconSource("document");
  if (!source)
    return (
      <FileCode2Icon
        className={cn("size-4 shrink-0 text-muted-foreground", className)}
        {...props}
      />
    );
  const width = source.width ?? icons.width ?? 24;
  const height = source.height ?? icons.height ?? 24;
  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 shrink-0 inline-block align-middle select-none", className)}
      viewBox={`${source.left ?? 0} ${source.top ?? 0} ${width} ${height}`}
      {...props}
      dangerouslySetInnerHTML={{ __html: source.body }}
    />
  );
}

/** 兼容别名 */
export const VscodeIcon = MaterialIcon;

function mimeIcon(mediaType?: string) {
  if (!mediaType) return undefined;
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    MIME_ICONS[normalized] ??
    (normalized.startsWith("image/")
      ? "image"
      : normalized.startsWith("audio/")
        ? "audio"
        : normalized.startsWith("video/")
          ? "video"
          : normalized.startsWith("text/")
            ? "document"
            : undefined)
  );
}

export function FileTypeIcon({
  name,
  mediaType,
  className,
}: {
  name: string;
  mediaType?: string;
  className?: string;
}) {
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const exactIcon =
    EXACT_FILE_ICONS[lower] ??
    (lower.startsWith(".env.") ? "tune" : undefined) ??
    (lower.startsWith("dockerfile.") ? "docker" : undefined);
  return (
    <MaterialIcon
      className={className}
      name={exactIcon ?? FILE_ICONS[extension] ?? mimeIcon(mediaType) ?? "document"}
    />
  );
}

export function FolderTypeIcon({
  name,
  open = false,
  className,
}: {
  name: string;
  open?: boolean;
  className?: string;
}) {
  const lower = name.toLowerCase();

  if (lower === ".git" || lower === ".github") {
    return <FolderGit2Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
  }
  if (
    lower === "library" ||
    lower === "资料库" ||
    lower === "archive" ||
    lower === "archives" ||
    lower === "assets"
  ) {
    return <FolderArchiveIcon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
  }
  if (lower === "src" || lower === "components" || lower === "lib" || lower === "app") {
    return <FolderCodeIcon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
  }
  if (
    lower === "scripts" ||
    lower === "tools" ||
    lower === "config" ||
    lower === "configs" ||
    lower === "settings"
  ) {
    return <FolderCogIcon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
  }

  if (open) {
    return <FolderOpenIcon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
  }
  return <FolderIcon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}
