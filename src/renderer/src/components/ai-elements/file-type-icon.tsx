import { icons } from "@iconify-json/vscode-icons";
import { FileCode2Icon } from "lucide-react";
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
  js: "file-type-js-official",
  jsx: "file-type-reactjs",
  ts: "file-type-typescript-official",
  tsx: "file-type-reactts",
  mjs: "file-type-js-official",
  cjs: "file-type-js-official",
  json: "file-type-json-official",
  jsonc: "file-type-json-official",
  md: "file-type-markdown",
  mdx: "file-type-mdx",
  txt: "file-type-text",
  csv: "file-type-excel",
  tsv: "file-type-excel",
  log: "file-type-log",
  pdf: "file-type-pdf2",
  doc: "file-type-word",
  docx: "file-type-word",
  dot: "file-type-word",
  dotx: "file-type-word",
  rtf: "file-type-word",
  odt: "file-type-libreoffice-writer",
  xls: "file-type-excel",
  xlsx: "file-type-excel",
  xlsb: "file-type-excel",
  xlsm: "file-type-excel",
  ods: "file-type-libreoffice-calc",
  ppt: "file-type-powerpoint",
  pptx: "file-type-powerpoint",
  pptm: "file-type-powerpoint",
  pps: "file-type-powerpoint",
  ppsx: "file-type-powerpoint",
  odp: "file-type-libreoffice-impress",
  py: "file-type-python",
  css: "file-type-css",
  scss: "file-type-scss",
  less: "file-type-less",
  html: "file-type-html",
  htm: "file-type-html",
  xml: "file-type-xml",
  yml: "file-type-yaml",
  yaml: "file-type-yaml",
  toml: "file-type-toml",
  ini: "file-type-config",
  conf: "file-type-config",
  env: "file-type-dotenv",
  sh: "file-type-shell",
  bash: "file-type-shell",
  zsh: "file-type-shell",
  ps1: "file-type-powershell",
  sql: "file-type-sql",
  sqlite: "file-type-sqlite",
  db: "file-type-db",
  rs: "file-type-rust",
  java: "file-type-java",
  go: "file-type-go",
  php: "file-type-php",
  rb: "file-type-ruby",
  cs: "file-type-csharp",
  cpp: "file-type-cpp",
  c: "file-type-c",
  swift: "file-type-swift",
  kt: "file-type-kotlin",
  dart: "file-type-dartlang",
  vue: "file-type-vue",
  svelte: "file-type-svelte",
  svg: "file-type-svg",
  png: "file-type-image",
  jpg: "file-type-image",
  jpeg: "file-type-image",
  gif: "file-type-image",
  webp: "file-type-webp",
  ico: "file-type-image",
  avif: "file-type-image",
  bmp: "file-type-image",
  heic: "file-type-image",
  tif: "file-type-image",
  tiff: "file-type-image",
  mp3: "file-type-audio",
  wav: "file-type-audio",
  ogg: "file-type-audio",
  aac: "file-type-audio",
  flac: "file-type-audio",
  m4a: "file-type-audio",
  opus: "file-type-audio",
  mp4: "file-type-video",
  webm: "file-type-video",
  mov: "file-type-video",
  avi: "file-type-video",
  m4v: "file-type-video",
  mkv: "file-type-video",
  mpeg: "file-type-video",
  mpg: "file-type-video",
  wmv: "file-type-video",
  zip: "file-type-zip",
  tar: "file-type-zip",
  gz: "file-type-zip",
  tgz: "file-type-zip",
  rar: "file-type-zip",
  "7z": "file-type-zip",
  epub: "file-type-epub",
  azw: "file-type-epub",
  azw3: "file-type-epub",
  mobi: "file-type-epub",
  woff: "file-type-font",
  woff2: "file-type-font",
  ttf: "file-type-font",
};

const EXACT_FILE_ICONS: Record<string, string> = {
  "package.json": "file-type-npm",
  "pnpm-lock.yaml": "file-type-pnpm",
  "pnpm-workspace.yaml": "file-type-pnpm",
  "tsconfig.json": "file-type-tsconfig-official",
  "biome.json": "file-type-biome",
  ".gitignore": "file-type-git",
  ".gitattributes": "file-type-git",
  ".env": "file-type-dotenv",
  "agents.md": "file-type-agents",
  dockerfile: "file-type-docker",
};

const MIME_ICONS: Record<string, string> = {
  "application/pdf": "file-type-pdf2",
  "application/rtf": "file-type-word",
  "application/msword": "file-type-word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "file-type-word",
  "application/vnd.ms-excel": "file-type-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "file-type-excel",
  "application/vnd.ms-powerpoint": "file-type-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "file-type-powerpoint",
  "application/epub+zip": "file-type-epub",
  "application/json": "file-type-json-official",
  "application/sql": "file-type-sql",
};

const FOLDER_ICONS: Record<string, string> = {
  src: "folder-type-src",
  components: "folder-type-component",
  docs: "folder-type-docs",
  tests: "folder-type-test",
  test: "folder-type-test",
  assets: "folder-type-asset",
  public: "folder-type-public",
  routes: "folder-type-route",
  scripts: "folder-type-script",
  packages: "folder-type-package",
  node_modules: "folder-type-node",
  library: "folder-type-library",
  资料库: "folder-type-library",
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

export function VscodeIcon({
  name,
  className,
  ...props
}: { name: string; className?: string } & SVGProps<SVGSVGElement>) {
  const source = iconSource(name) ?? iconSource("default-file");
  if (!source) return <FileCode2Icon className={cn("size-4", className)} {...props} />;
  const width = source.width ?? icons.width ?? 32;
  const height = source.height ?? icons.height ?? 32;
  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      viewBox={`${source.left ?? 0} ${source.top ?? 0} ${width} ${height}`}
      {...props}
      dangerouslySetInnerHTML={{ __html: source.body }}
    />
  );
}

function mimeIcon(mediaType?: string) {
  if (!mediaType) return undefined;
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    MIME_ICONS[normalized] ??
    (normalized.startsWith("image/")
      ? "file-type-image"
      : normalized.startsWith("audio/")
        ? "file-type-audio"
        : normalized.startsWith("video/")
          ? "file-type-video"
          : normalized.startsWith("text/")
            ? "file-type-text"
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
    (lower.startsWith(".env.") ? "file-type-dotenv" : undefined) ??
    (lower.startsWith("dockerfile.") ? "file-type-docker" : undefined);
  return (
    <VscodeIcon
      className={className}
      name={exactIcon ?? FILE_ICONS[extension] ?? mimeIcon(mediaType) ?? "default-file"}
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
  const base = FOLDER_ICONS[name.toLowerCase()] ?? "default-folder";
  const iconName =
    open && base !== "default-folder" ? `${base}-opened` : open ? "default-folder-opened" : base;
  return <VscodeIcon className={className} name={iconName} />;
}
