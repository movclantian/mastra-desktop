import { ExternalLinkIcon, InfoIcon } from "lucide-react";
import { APP_NAME, APP_VERSION, packageVersion } from "@/shared/app-metadata";
import { useTranslation } from "@/shared/i18n";
import { SettingCard } from "../controls";

const RESOURCES = [
  {
    id: "mastra",
    kind: "framework",
    name: "Mastra",
    packageName: "@mastra/core",
    source: "https://mastra.ai",
    license: "Apache-2.0",
  },
  {
    id: "electron",
    kind: "runtime",
    name: "Electron",
    packageName: "electron",
    source: "https://www.electronjs.org",
    license: "MIT",
  },
  {
    id: "react",
    kind: "framework",
    name: "React",
    packageName: "react",
    source: "https://react.dev",
    license: "MIT",
  },
  {
    id: "typescript",
    kind: "tool",
    name: "TypeScript",
    packageName: "typescript",
    source: "https://www.typescriptlang.org",
    license: "Apache-2.0",
  },
  {
    id: "electronVite",
    kind: "tool",
    name: "Electron Vite",
    packageName: "electron-vite",
    source: "https://electron-vite.org",
    license: "MIT",
  },
  {
    id: "aiSdk",
    kind: "library",
    name: "Vercel AI SDK",
    packageName: "ai",
    source: "https://sdk.vercel.ai",
    license: "Apache-2.0",
  },
  {
    id: "mcp",
    kind: "tool",
    name: "Mastra MCP",
    packageName: "@mastra/mcp",
    source: "https://mastra.ai/docs/mcp/overview",
    license: "Apache-2.0",
  },
  {
    id: "tailwind",
    kind: "library",
    name: "Tailwind CSS",
    packageName: "tailwindcss",
    source: "https://tailwindcss.com",
    license: "MIT",
  },
  {
    id: "baseUi",
    kind: "component",
    name: "Base UI / shadcn/ui",
    packageName: "@base-ui/react",
    source: "https://ui.shadcn.com",
    license: "MIT",
  },
  {
    id: "lucide",
    kind: "library",
    name: "Lucide",
    packageName: "lucide-react",
    source: "https://lucide.dev",
    license: "ISC",
  },
  {
    id: "modelsDev",
    kind: "data",
    name: "models.dev",
    packageName: undefined,
    source: "https://models.dev",
    license: "Public catalog; see source terms",
  },
  {
    id: "searchServices",
    kind: "service",
    name: "Tavily / Firecrawl / AnySearch",
    packageName: undefined,
    source: "https://tavily.com",
    license: "Third-party service terms",
  },
  {
    id: "providerModels",
    kind: "model",
    name: "User-configured AI models",
    packageName: undefined,
    source: "https://models.dev",
    license: "Provider terms / BYOK",
  },
  {
    id: "fastEmbed",
    kind: "library",
    name: "FastEmbed / ONNX Runtime",
    packageName: "@mastra/fastembed",
    source: "https://github.com/massdriver-ai/fastembed",
    license: "Apache-2.0 / MIT components",
  },
  {
    id: "assets",
    kind: "asset",
    name: "Fontsource and project icons",
    packageName: "@fontsource-variable/geist",
    source: "https://fontsource.org",
    license: "OFL-1.1 / project asset terms",
  },
  {
    id: "userData",
    kind: "data",
    name: "User-provided files and local data",
    packageName: undefined,
    source: "Local workspace and storage",
    license: "User-owned / user-authorized",
  },
] as const;

export function AboutSection() {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SettingCard title={t("settings:about.title")} description={t("settings:about.description")}>
        <div className="flex items-center gap-3 py-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <InfoIcon className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold">{APP_NAME}</p>
            <p className="text-xs text-muted-foreground">
              {t("settings:about.version", { version: APP_VERSION })}
            </p>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        title={t("settings:about.resourcesTitle")}
        description={t("settings:about.resourcesDescription")}
      >
        <div className="divide-y divide-border/60">
          {RESOURCES.map((resource) => (
            <article key={resource.id} className="min-w-0 py-4 first:pt-3 last:pb-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-medium">{resource.name}</h3>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {t(`settings:about.resources.${resource.id}.usage`)}
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {resource.packageName
                    ? packageVersion(resource.packageName)
                    : t("settings:about.included")}
                </span>
              </div>
              <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs @md/field-group:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">{t("settings:about.type")}</dt>
                  <dd className="mt-0.5 break-words">
                    {t(`settings:about.kinds.${resource.kind}`)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">{t("settings:about.source")}</dt>
                  <dd className="mt-0.5 min-w-0 truncate">
                    <a
                      href={resource.source}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-auto max-w-full items-center justify-start truncate text-primary underline-offset-4 hover:underline"
                    >
                      <span className="truncate">{resource.source}</span>
                      <ExternalLinkIcon className="ml-1 size-3 shrink-0" />
                    </a>
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">{t("settings:about.license")}</dt>
                  <dd className="mt-0.5 break-words">{resource.license}</dd>
                </div>
              </dl>
              <p className="mt-2 break-words text-[11px] leading-relaxed text-muted-foreground">
                {t("settings:about.licenseNote")}
              </p>
            </article>
          ))}
        </div>
      </SettingCard>
    </div>
  );
}
