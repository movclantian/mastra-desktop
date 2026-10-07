import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, FolderOpenIcon, PlusIcon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  authenticateMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  type McpSummary,
  type SkillAuditItem,
  setMcpServerEnabled,
} from "@/entities/skill";
import { getAuthToken, useAuth } from "@/features/auth";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { McpDialog } from "@/widgets/mcp-dialog";
import type {
  InstalledPlugin,
  MarketplaceCatalog,
  MarketplaceListing,
  MarketplaceSource,
  PluginSource,
  PluginVersion,
} from "../../../../../shared/plugin-contract";

async function pluginRequest<T>(
  path: string,
  method = "GET",
  body?: Record<string, unknown> | FormData,
): Promise<T> {
  const response = await apiFetch(`${MASTRA_SERVER_URL}/work/plugins${path}`, {
    method,
    ...(body ? { body } : {}),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload.message ?? payload.error?.message ?? `HTTP ${response.status}`);
  return payload as T;
}

function sourceFromInput(value: string, ref = "HEAD", path = "", transport = "auto"): PluginSource {
  if (!/^https?:\/\//i.test(value)) return { kind: "local", path: value };
  const url = new URL(value);
  return transport === "git" ||
    (transport === "auto" && (url.hostname === "github.com" || url.pathname.endsWith(".git")))
    ? { kind: "git", url: value, ref, path }
    : { kind: "archive", url: value, path };
}

export function PluginHubPage() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState<"discover" | "installed" | "sources">("discover");
  const [filter, setFilter] = React.useState<"plugins" | "skill" | "mcp">("plugins");
  const [componentFilter, setComponentFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const query = React.useDeferredValue(search.trim().toLocaleLowerCase());
  const [sourceId, setSourceId] = React.useState("");
  const [leaderboardView, setLeaderboardView] = React.useState("all-time");
  const [curated, setCurated] = React.useState(false);
  const [ownerFilter, setOwnerFilter] = React.useState("");
  const [catalogPage, setCatalogPage] = React.useState(0);
  const [selection, setSelection] = React.useState<{
    id?: string;
    listing?: MarketplaceListing;
  } | null>(null);
  const [skillPath, setSkillPath] = React.useState<string | null>(null);
  const [localCopyPath, setLocalCopyPath] = React.useState("");
  const [copying, setCopying] = React.useState(false);
  const [keepData, setKeepData] = React.useState(true);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importUrl, setImportUrl] = React.useState("");
  const [importTransport, setImportTransport] = React.useState("auto");
  const [importRef, setImportRef] = React.useState("HEAD");
  const [importPath, setImportPath] = React.useState("");
  const [editingSource, setEditingSource] = React.useState<MarketplaceSource | "new" | null>(null);
  const [mcpDialog, setMcpDialog] = React.useState<McpSummary | "new" | null>(null);
  const uploadRef = React.useRef<HTMLInputElement>(null);
  const installed = useQuery({
    queryKey: ["plugins", user?.id],
    queryFn: () => pluginRequest<{ plugins: InstalledPlugin[] }>(""),
  });
  const sources = useQuery({
    queryKey: ["plugin-sources", user?.id],
    queryFn: () =>
      pluginRequest<{
        sources: MarketplaceSource[];
        statuses: Array<{ sourceId: string; fetchedAt?: string; error?: string }>;
      }>("/marketplaces"),
  });
  const selectedSource =
    sources.data?.sources.find((source) => source.id === sourceId && source.enabled) ??
    sources.data?.sources.find((source) => source.enabled);
  const catalog = useQuery({
    queryKey: [
      "plugin-catalog",
      user?.id,
      selectedSource?.id,
      selectedSource?.format === "skills-sh"
        ? [leaderboardView, curated, ownerFilter, query, catalogPage]
        : null,
    ],
    enabled: !!selectedSource && tab === "discover",
    refetchInterval: (state) => (state.state.data?.refreshing ? 1000 : false),
    queryFn: () =>
      pluginRequest<MarketplaceCatalog>(
        `/marketplaces/${selectedSource?.id}/catalog?${new URLSearchParams({ view: leaderboardView, curated: curated ? "1" : "0", owner: ownerFilter.trim(), query, page: String(catalogPage) })}`,
      ),
  });
  const mcp = useQuery({ queryKey: ["plugin-mcp", user?.id], queryFn: fetchMcpServers });
  const invalidate = () =>
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey.some((key) => typeof key === "string" && /plugin|skill|mcp/i.test(key)),
    });
  const action = useMutation({
    mutationFn: ({
      path,
      method = "POST",
      body,
    }: {
      path: string;
      method?: string;
      body?: Record<string, unknown> | FormData;
    }) => {
      if (!token || getAuthToken() !== token) throw new Error("Session changed");
      return pluginRequest<{ plugin?: InstalledPlugin }>(path, method, body);
    },
    onSuccess: async (result) => {
      await invalidate();
      if (result.plugin) setSelection({ id: result.plugin.id });
      toast.success(t("plugins:saved"));
    },
    onError: (error) => toast.error(error.message),
  });
  const refresh = useMutation({
    mutationFn: ({ id, params }: { id: string; params: URLSearchParams }) =>
      pluginRequest<MarketplaceCatalog>(`/marketplaces/${id}/catalog?refresh=1&${params}`),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const nativeMcp = useMutation({
    mutationFn: (operation: () => Promise<unknown>) => operation(),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  const active = installed.data?.plugins.find(
    (plugin) =>
      plugin.id === selection?.id ||
      (selection?.listing && plugin.listing?.id === selection.listing.id),
  );
  const preview = useQuery({
    queryKey: ["plugin-preview", user?.id, selection?.listing?.id],
    enabled: !!selection?.listing && !active,
    queryFn: () =>
      pluginRequest<{ preview: PluginVersion }>(
        `/marketplaces/${selection?.listing?.sourceId}/preview?key=${encodeURIComponent(selection?.listing?.key ?? "")}`,
      ),
  });
  const version = active?.current ?? preview.data?.preview;
  const detailSource = active?.source ?? selection?.listing?.source;
  const audits = useQuery({
    queryKey: ["plugin-audits", user?.id, detailSource],
    enabled: !!selection && detailSource?.kind === "skills-sh",
    queryFn: () => {
      if (detailSource?.kind !== "skills-sh") throw new Error("Invalid audit source");
      return pluginRequest<{ audits: SkillAuditItem[] }>(
        `/skills-sh/audit?${new URLSearchParams({ source: detailSource.source, slug: detailSource.slug })}`,
      );
    },
  });
  const content = useQuery({
    queryKey: ["plugin-file", user?.id, active?.id, active?.current.digest, skillPath],
    enabled: !!active && !!skillPath,
    queryFn: () =>
      pluginRequest<{ content: string }>(
        `/${active?.id}/file?path=${encodeURIComponent(skillPath ?? "")}`,
      ),
  });
  const listingInstalled = new Map(
    installed.data?.plugins
      .filter((plugin) => plugin.listing)
      .map((plugin) => [plugin.listing?.id, plugin]),
  );
  const visiblePlugins =
    installed.data?.plugins.filter(
      (plugin) =>
        (filter === "plugins" ||
          plugin.current.components.some((component) => component.kind === filter)) &&
        `${plugin.current.name} ${plugin.current.description} ${plugin.current.components.map((component) => component.name).join(" ")}`
          .toLocaleLowerCase()
          .includes(query),
    ) ?? [];
  const listings =
    catalog.data?.listings.filter(
      (listing) =>
        (componentFilter === "all" ||
          (
            listingInstalled.get(listing.id)?.current.components ??
            queryClient.getQueryData<{ preview: PluginVersion }>([
              "plugin-preview",
              user?.id,
              listing.id,
            ])?.preview.components ??
            (listing.format === "skills" ? [{ kind: "skill" }] : [])
          ).some((component) => component.kind === componentFilter)) &&
        `${listing.name} ${listing.description} ${listing.category ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
    ) ?? [];
  const busy = action.isPending;
  const select = (next: NonNullable<typeof selection>) => {
    setSelection(next);
    setSkillPath(null);
    setLocalCopyPath("");
  };
  const installListing = (listing: MarketplaceListing) =>
    action.mutate({
      path: `/marketplaces/${listing.sourceId}/install`,
      body: { key: listing.key },
    });
  const upload = async (file?: File) => {
    if (!file) return;
    const body = new FormData();
    body.set("archive", file);
    await action.mutateAsync({ path: "/upload", body });
    setTab("installed");
    setImportOpen(false);
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-4">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">{t("plugins:title")}</h1>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <DownloadIcon />
          {t("plugins:import")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => action.mutate({ path: "/check-updates" })}
        >
          <RefreshCwIcon />
          {t("plugins:checkUpdates")}
        </Button>
      </header>
      <nav className="flex flex-wrap gap-1" aria-label={t("plugins:title")}>
        {(["discover", "installed", "sources"] as const).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={tab === item ? "secondary" : "ghost"}
            aria-pressed={tab === item}
            onClick={() => setTab(item)}
          >
            {t(`plugins:${item}`)}
          </Button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Input
          className="min-w-40 flex-1"
          aria-label={t("plugins:search")}
          placeholder={t("plugins:search")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setCatalogPage(0);
          }}
        />
        {tab === "discover" ? (
          <>
            <Select
              value={selectedSource?.id ?? null}
              onValueChange={(value) => {
                setSourceId(value ?? "");
                setCatalogPage(0);
              }}
              disabled={!sources.data?.sources.some((source) => source.enabled)}
            >
              <SelectTrigger
                className="h-auto min-h-8 w-full min-w-0 whitespace-normal *:data-[slot=select-value]:line-clamp-none sm:w-64"
                aria-label={t("plugins:source")}
              >
                <SelectValue className="break-words" placeholder={t("plugins:source")} />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                {sources.data?.sources
                  .filter((source) => source.enabled)
                  .map((source) => (
                    <SelectItem
                      key={source.id}
                      value={source.id}
                      className="[&>span:first-child]:min-w-0 [&>span:first-child]:shrink [&>span:first-child]:whitespace-normal"
                    >
                      <span className="min-w-0 whitespace-normal break-words">{source.name}</span>
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={!selectedSource || refresh.isPending}
              onClick={() =>
                selectedSource &&
                refresh.mutate({
                  id: selectedSource.id,
                  params: new URLSearchParams({
                    view: leaderboardView,
                    curated: curated ? "1" : "0",
                    owner: ownerFilter.trim(),
                    query,
                    page: String(catalogPage),
                  }),
                })
              }
            >
              <RefreshCwIcon />
              {t("plugins:refresh")}
            </Button>
            <Select
              value={componentFilter}
              onValueChange={(value) => value && setComponentFilter(value)}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label={t("plugins:components")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("plugins:all")}</SelectItem>
                <SelectItem value="skill">{t("plugins:skill")}</SelectItem>
                <SelectItem value="mcp">{t("plugins:mcp")}</SelectItem>
              </SelectContent>
            </Select>
          </>
        ) : tab === "installed" ? (
          <>
            {(["plugins", "skill", "mcp"] as const).map((item) => (
              <Button
                key={item}
                variant={filter === item ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setFilter(item)}
              >
                {t(`plugins:${item}`)}
              </Button>
            ))}
            {filter === "mcp" ? (
              <Button size="sm" variant="outline" onClick={() => setMcpDialog("new")}>
                <PlusIcon />
                {t("plugins:addMcp")}
              </Button>
            ) : null}
          </>
        ) : (
          <Button size="sm" onClick={() => setEditingSource("new")}>
            <PlusIcon />
            {t("plugins:addSource")}
          </Button>
        )}
      </div>
      {tab === "discover" && selectedSource?.format === "skills-sh" ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {(["all-time", "trending", "hot"] as const).map((view) => (
            <Button
              key={view}
              size="sm"
              variant={!curated && leaderboardView === view ? "secondary" : "ghost"}
              aria-pressed={!curated && leaderboardView === view}
              onClick={() => {
                setLeaderboardView(view);
                setCurated(false);
                setCatalogPage(0);
              }}
            >
              {t(`plugins:leaderboard.${view}`)}
            </Button>
          ))}
          <Button
            size="sm"
            variant={curated ? "secondary" : "ghost"}
            aria-pressed={curated}
            onClick={() => {
              setCurated(true);
              setCatalogPage(0);
            }}
          >
            {t("plugins:curated")}
          </Button>
          <Input
            className="min-w-0 flex-1 basis-40"
            aria-label={t("plugins:ownerFilter")}
            placeholder={t("plugins:ownerFilter")}
            value={ownerFilter}
            onChange={(event) => {
              setOwnerFilter(event.target.value);
              setCatalogPage(0);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!catalogPage || catalog.isFetching}
            onClick={() => setCatalogPage((page) => page - 1)}
          >
            {t("common:prevPage")}
          </Button>
          <span className="text-xs">
            {catalogPage + 1}
            {catalog.data?.total !== undefined ? ` · ${catalog.data.total.toLocaleString()}` : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!catalog.data?.hasMore || catalog.isFetching}
            onClick={() => setCatalogPage((page) => page + 1)}
          >
            {t("common:nextPage")}
          </Button>
        </div>
      ) : null}
      {[installed.error, sources.error, tab === "discover" ? catalog.error : null]
        .filter(Boolean)
        .map((error) => (
          <div
            role="alert"
            key={error?.message}
            className="flex flex-wrap items-center gap-2 text-sm text-destructive"
          >
            <span className="min-w-0 break-words">{error?.message}</span>
            <Button variant="outline" size="sm" onClick={() => void invalidate()}>
              {t("plugins:retry")}
            </Button>
          </div>
        ))}
      {tab === "discover" && componentFilter !== "all" ? (
        <p className="break-words text-xs text-muted-foreground">
          {t("plugins:knownComponentFilter")}
        </p>
      ) : null}
      {tab === "discover" && catalog.data ? (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {catalog.data.fetchedAt ? (
            <span>
              {t("plugins:cachedAt")}: {new Date(catalog.data.fetchedAt).toLocaleString()}
            </span>
          ) : null}
          {catalog.data.error ? (
            <span role="alert" className="break-words text-destructive">
              {catalog.data.error}
            </span>
          ) : null}
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        {tab === "discover" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3 pb-3">
            {catalog.isFetching && !catalog.data ? (
              <p className="text-sm text-muted-foreground">{t("plugins:loading")}</p>
            ) : null}
            {listings.map((listing) => (
              <article
                key={listing.id}
                className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
              >
                <button
                  className="text-left font-medium break-words hover:underline"
                  onClick={() => select({ listing })}
                >
                  {listing.name}
                </button>
                <p className="line-clamp-3 min-w-0 flex-1 text-sm break-words text-muted-foreground">
                  {listing.description}
                </p>
                <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <span>{selectedSource?.name}</span>
                  {listing.category ? <Badge variant="outline">{listing.category}</Badge> : null}
                  {listing.installs ? <span>↓ {listing.installs.toLocaleString()}</span> : null}
                </div>
                {listing.blockedReason ? (
                  <p className="text-xs break-words text-destructive">{listing.blockedReason}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => select({ listing })}>
                    {t("plugins:detail")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || !!listing.blockedReason || listingInstalled.has(listing.id)}
                    onClick={() => select({ listing })}
                  >
                    {t(listingInstalled.has(listing.id) ? "plugins:installed" : "plugins:install")}
                  </Button>
                </div>
              </article>
            ))}
            {!catalog.isPending && !listings.length ? (
              <p className="text-sm text-muted-foreground">{t("plugins:empty")}</p>
            ) : null}
          </div>
        ) : tab === "sources" ? (
          <div className="flex flex-col gap-2 pb-3">
            {sources.data?.sources
              .filter((source) => source.name.toLocaleLowerCase().includes(query))
              .map((source) => (
                <section
                  key={source.id}
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">
                      {source.name}{" "}
                      {source.builtin ? (
                        <Badge variant="outline">{t("plugins:builtin")}</Badge>
                      ) : null}
                    </p>
                    <p className="text-xs break-all text-muted-foreground">
                      {source.source.kind === "local"
                        ? source.source.path
                        : "url" in source.source
                          ? source.source.url
                          : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">{source.format}</p>
                    <p className="text-xs break-words text-muted-foreground">
                      {t("plugins:cachedAt")}:{" "}
                      {sources.data?.statuses.find((status) => status.sourceId === source.id)
                        ?.fetchedAt
                        ? new Date(
                            sources.data.statuses.find((status) => status.sourceId === source.id)
                              ?.fetchedAt ?? "",
                          ).toLocaleString()
                        : t("plugins:noCache")}
                    </p>
                    {sources.data?.statuses.find((status) => status.sourceId === source.id)
                      ?.error ? (
                      <p role="alert" className="text-xs break-words text-destructive">
                        {
                          sources.data.statuses.find((status) => status.sourceId === source.id)
                            ?.error
                        }
                      </p>
                    ) : null}
                  </div>
                  <Switch
                    aria-label={`${t("plugins:enable")} ${source.name}`}
                    checked={source.enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) =>
                      action.mutate({
                        path: "/marketplaces",
                        body: { source: { ...source, enabled } },
                      })
                    }
                  />
                  <Button variant="outline" size="sm" onClick={() => setEditingSource(source)}>
                    {t("plugins:editSource")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !source.enabled}
                    onClick={() =>
                      action.mutate({
                        path: `/marketplaces/${source.id}/catalog?refresh=1`,
                        method: "GET",
                      })
                    }
                  >
                    {t("plugins:refresh")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      action.mutate({ path: `/marketplaces/${source.id}`, method: "DELETE" })
                    }
                  >
                    {t(source.builtin ? "plugins:disable" : "plugins:remove")}
                  </Button>
                </section>
              ))}
          </div>
        ) : filter === "mcp" ? (
          <div className="flex flex-col gap-2 pb-3">
            {mcp.data
              ?.filter((server) => server.name.toLocaleLowerCase().includes(query))
              .map((server) => (
                <section
                  key={server.id}
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">{server.name}</p>
                    <p className="text-xs break-words text-muted-foreground">
                      {server.transport} ·{" "}
                      {t(server.enabled ? "plugins:enabled" : "plugins:disabled")}
                    </p>
                    {server.connectionError ? (
                      <p className="break-words text-xs text-destructive">
                        {server.connectionError}
                      </p>
                    ) : null}
                    {server.configurationError ? (
                      <p role="alert" className="break-words text-xs text-destructive">
                        {t("plugins:missingConfig")}: {server.configurationError}
                      </p>
                    ) : null}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setMcpDialog(server)}>
                    <Settings2Icon />
                    {t("plugins:configure")}
                  </Button>
                  <Switch
                    aria-label={`${t("plugins:enable")} ${server.name}`}
                    checked={server.enabled}
                    disabled={nativeMcp.isPending || !!server.plugin}
                    onCheckedChange={(enabled) =>
                      nativeMcp.mutate(() => setMcpServerEnabled(server.id, enabled))
                    }
                  />
                  {server.oauth?.enabled ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        nativeMcp.mutate(async () => {
                          const result = await authenticateMcpServer(server.id);
                          if (result.authorizationUrl)
                            await window.api.workspace.openExternal(result.authorizationUrl);
                        })
                      }
                    >
                      {t("plugins:authenticate")}
                    </Button>
                  ) : null}
                  {!server.builtin && !server.plugin ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(t("mcp:deleteConfirm", { name: server.name })))
                          nativeMcp.mutate(() => deleteMcpServer(server.id));
                      }}
                    >
                      {t("plugins:remove")}
                    </Button>
                  ) : null}
                </section>
              ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2 pb-3">
            {visiblePlugins.map((plugin) => (
              <section
                key={plugin.id}
                className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <button
                    className="min-w-0 flex-1 text-left font-medium break-words hover:underline"
                    onClick={() => select({ id: plugin.id })}
                  >
                    {plugin.current.name}
                  </button>
                  <Badge variant="outline">
                    {plugin.current.version ?? plugin.current.digest.slice(0, 8)}
                  </Badge>
                  <Switch
                    aria-label={`${t("plugins:enable")} ${plugin.current.name}`}
                    checked={plugin.enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) =>
                      action.mutate({
                        path: `/${plugin.id}/enabled`,
                        method: "PUT",
                        body: { enabled },
                      })
                    }
                  />
                </div>
                <p className="text-sm break-words text-muted-foreground">
                  {plugin.current.description}
                </p>
                <div className="flex flex-wrap gap-1">
                  {plugin.current.components
                    .filter((component) => filter === "plugins" || component.kind === filter)
                    .map((component) => (
                      <Badge key={component.id} variant="outline">
                        {component.kind} · {component.name}
                        {!component.supported ? ` · ${t("plugins:unsupported")}` : ""}
                      </Badge>
                    ))}
                </div>
                <Button
                  className="self-start"
                  size="sm"
                  variant="outline"
                  onClick={() => select({ id: plugin.id })}
                >
                  {t("plugins:detail")}
                </Button>
              </section>
            ))}
            {!installed.isPending && !visiblePlugins.length ? (
              <p className="text-sm text-muted-foreground">{t("plugins:empty")}</p>
            ) : null}
          </div>
        )}
      </ScrollArea>
      <Dialog
        open={!!selection}
        onOpenChange={(open) => {
          if (!open) {
            setSelection(null);
            setSkillPath(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[85dvh] min-w-0 flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="break-words">
              {version?.name ?? selection?.listing?.name ?? t("plugins:detail")}
            </DialogTitle>
            <DialogDescription className="break-words">
              {version?.description ?? selection?.listing?.description}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex min-w-0 flex-col gap-3 pr-3">
              {preview.isFetching && !version ? <p>{t("plugins:loading")}</p> : null}
              {preview.error ? (
                <div className="grid gap-2">
                  <p role="alert" className="break-words text-destructive">
                    {preview.error.message}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="justify-self-start"
                    onClick={() => void preview.refetch()}
                  >
                    {t("plugins:retry")}
                  </Button>
                </div>
              ) : null}
              {(selection?.listing?.blockedReason ?? active?.listing?.blockedReason) ? (
                <p role="alert" className="break-words text-sm text-destructive">
                  {selection?.listing?.blockedReason ?? active?.listing?.blockedReason}
                </p>
              ) : null}
              {detailSource?.kind === "skills-sh" ? (
                <section className="grid min-w-0 gap-2 rounded-md border p-3">
                  <h3 className="text-sm font-medium">{t("plugins:audits")}</h3>
                  {audits.isPending ? (
                    <p role="status" className="text-xs">
                      {t("plugins:loading")}
                    </p>
                  ) : null}
                  {audits.error ? (
                    <div className="grid gap-2">
                      <p role="alert" className="break-words text-xs text-destructive">
                        {audits.error.message}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="justify-self-start"
                        onClick={() => void audits.refetch()}
                      >
                        {t("plugins:retry")}
                      </Button>
                    </div>
                  ) : null}
                  {audits.data?.audits.map((audit) => (
                    <div key={`${audit.provider}:${audit.slug}`} className="grid gap-1 text-xs">
                      <p className="break-words">
                        {audit.provider} · {audit.status}
                        {audit.riskLevel ? ` · ${audit.riskLevel}` : ""}
                      </p>
                      <p className="break-words">{audit.summary}</p>
                      {audit.auditedAt ? <p>{new Date(audit.auditedAt).toLocaleString()}</p> : null}
                    </div>
                  ))}
                  {audits.data && !audits.data.audits.length ? (
                    <p className="text-xs text-muted-foreground">{t("plugins:noAudits")}</p>
                  ) : null}
                </section>
              ) : null}
              {version ? (
                <>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{version.format}</span>
                    <Badge variant="outline">
                      {t(
                        version.components.every((component) => component.supported)
                          ? "plugins:supported"
                          : version.components.some((component) => component.supported)
                            ? "plugins:partial"
                            : "plugins:unsupported",
                      )}
                    </Badge>
                    {version.version ? (
                      <span>
                        {t("plugins:version")}: {version.version}
                      </span>
                    ) : null}
                    {version.author ? <span>{version.author}</span> : null}
                    {version.license ? <span>{version.license}</span> : null}
                    <span>
                      {t("plugins:revision")}: {version.digest.slice(0, 12)}
                    </span>
                  </div>
                  {version.issues.map((issue) => (
                    <p key={issue} className="text-sm break-words text-destructive">
                      {issue}
                    </p>
                  ))}
                  {version.components.map((component) => (
                    <section
                      key={component.id}
                      className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 break-words font-medium">
                          {component.name}
                        </span>
                        <Badge variant="outline">{component.kind}</Badge>
                        {active && component.supported ? (
                          <Switch
                            checked={active.componentEnabled[component.id] !== false}
                            disabled={busy || !active.enabled}
                            aria-label={`${t("plugins:enable")} ${component.name}`}
                            onCheckedChange={(enabled) =>
                              action.mutate({
                                path: `/${active.id}/enabled`,
                                method: "PUT",
                                body: { enabled, componentId: component.id },
                              })
                            }
                          />
                        ) : null}
                      </div>
                      <p className="text-sm break-words text-muted-foreground">
                        {component.description}
                      </p>
                      {component.issues.map((issue) => (
                        <p key={issue} className="text-xs break-words text-destructive">
                          {issue}
                        </p>
                      ))}
                      {component.configurationKeys?.length ? (
                        <p className="break-all text-xs text-muted-foreground">
                          {t("plugins:requiredVariables")}: {component.configurationKeys.join(", ")}
                        </p>
                      ) : null}
                      {active && component.kind === "mcp" && component.supported ? (
                        <div className="grid min-w-0 gap-2">
                          {mcp.data?.find((item) => item.id === component.id)
                            ?.configurationError ? (
                            <p className="break-words text-xs text-destructive">
                              {
                                mcp.data.find((item) => item.id === component.id)
                                  ?.configurationError
                              }
                            </p>
                          ) : null}
                          {mcp.data?.find((item) => item.id === component.id)?.connectionError ? (
                            <p className="break-words text-xs text-destructive">
                              {mcp.data.find((item) => item.id === component.id)?.connectionError}
                            </p>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            className="self-start"
                            onClick={() => {
                              const server = mcp.data?.find((item) => item.id === component.id);
                              if (server) setMcpDialog(server);
                            }}
                          >
                            {t("plugins:configure")}
                          </Button>
                        </div>
                      ) : null}
                      {active && component.path ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="self-start"
                          onClick={() => setSkillPath(component.path ?? null)}
                        >
                          {t("plugins:preview")}
                        </Button>
                      ) : null}
                    </section>
                  ))}
                </>
              ) : null}
              {content.isFetching ? <p>{t("plugins:loading")}</p> : null}
              {content.error ? (
                <p role="alert" className="text-destructive">
                  {content.error.message}
                </p>
              ) : null}
              {skillPath && content.data ? (
                <div className="min-w-0 overflow-hidden rounded-md border p-3">
                  <MessageResponse>{content.data.content}</MessageResponse>
                </div>
              ) : null}
              {localCopyPath ? (
                <div className="grid min-w-0 gap-2 rounded-md border p-3">
                  <p className="break-all text-sm">
                    {t("plugins:localCopyCreated")}: {localCopyPath}
                  </p>
                  <Button
                    size="sm"
                    className="justify-self-start"
                    disabled={busy}
                    onClick={() =>
                      action.mutate({
                        path: "/install",
                        body: { source: { kind: "local", path: localCopyPath } },
                      })
                    }
                  >
                    {t("plugins:importLocalCopy")}
                  </Button>
                </div>
              ) : null}
              {active?.update ? (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="break-words">
                    {active.update.error ??
                      (active.update.available
                        ? `${t("plugins:update")}: ${active.update.version ?? active.update.digest?.slice(0, 8)}`
                        : t("plugins:noUpdates"))}
                  </p>
                  {active.update.changes?.map((change) => (
                    <p key={`${change.componentId}:${change.kind}`} className="break-words">
                      {t(`plugins:changes.${change.kind}`, {
                        name: change.name,
                        keys: change.keys?.join(", "),
                      })}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </ScrollArea>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            {active ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || copying}
                  onClick={() => {
                    setCopying(true);
                    void window.api.filesystem
                      .pickDirectory()
                      .then(async (target) => {
                        if (!target) return;
                        const copy = await pluginRequest<{ path: string }>(
                          `/${active.id}/local-copy`,
                          "POST",
                          { target },
                        );
                        setLocalCopyPath(copy.path);
                      })
                      .catch((error: Error) => toast.error(error.message))
                      .finally(() => setCopying(false));
                  }}
                >
                  {t("plugins:localCopy")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => action.mutate({ path: `/${active.id}/check-update` })}
                >
                  {t("plugins:checkUpdates")}
                </Button>
                {active.update?.available && active.update.digest ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `${t("plugins:updateConfirm")}\n${active.update?.changes?.map((change) => t(`plugins:changes.${change.kind}`, { name: change.name, keys: change.keys?.join(", ") })).join("\n") ?? ""}`,
                        )
                      )
                        action.mutate({
                          path: `/${active.id}/update`,
                          body: { digest: active.update?.digest },
                        });
                    }}
                  >
                    {t("plugins:update")}
                  </Button>
                ) : null}
                {active.previous ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => action.mutate({ path: `/${active.id}/rollback` })}
                  >
                    {t("plugins:rollback")}
                  </Button>
                ) : null}
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={keepData}
                    onChange={(event) => setKeepData(event.target.checked)}
                  />
                  {t("plugins:keepData")}
                </label>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t("plugins:uninstallConfirm")))
                      action.mutate(
                        {
                          path: `/${active.id}?removeData=${keepData ? "0" : "1"}`,
                          method: "DELETE",
                        },
                        { onSuccess: () => setSelection(null) },
                      );
                  }}
                >
                  {t("plugins:uninstall")}
                </Button>
              </>
            ) : selection?.listing ? (
              <Button
                size="sm"
                disabled={
                  busy ||
                  !!selection.listing.blockedReason ||
                  !version?.components.some((component) => component.supported)
                }
                onClick={() => selection.listing && installListing(selection.listing)}
              >
                {t("plugins:install")}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("plugins:import")}</DialogTitle>
            <DialogDescription>{t("plugins:importHint")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => uploadRef.current?.click()}
                >
                  <DownloadIcon />
                  {t("plugins:upload")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void window.api.filesystem
                      .pickDirectory()
                      .then((directory) => {
                        if (directory)
                          action.mutate(
                            {
                              path: "/install",
                              body: { source: { kind: "local", path: directory } },
                            },
                            {
                              onSuccess: () => {
                                setImportOpen(false);
                                setTab("installed");
                              },
                            },
                          );
                      })
                      .catch((error: Error) => toast.error(error.message));
                  }}
                >
                  <FolderOpenIcon />
                  {t("plugins:local")}
                </Button>
              </div>
              <label htmlFor="plugin-import-url" className="text-sm">
                {t("plugins:remote")}
              </label>
              <Select
                value={importTransport}
                onValueChange={(value) => value && setImportTransport(value)}
              >
                <SelectTrigger aria-label={t("plugins:transport")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("plugins:autoDetect")}</SelectItem>
                  <SelectItem value="git">Git</SelectItem>
                  <SelectItem value="archive">HTTP ZIP</SelectItem>
                </SelectContent>
              </Select>
              <Input
                id="plugin-import-url"
                value={importUrl}
                onChange={(event) => setImportUrl(event.target.value)}
              />
              <label htmlFor="plugin-import-ref" className="text-sm">
                {t("plugins:branch")}
              </label>
              <Input
                id="plugin-import-ref"
                value={importRef}
                onChange={(event) => setImportRef(event.target.value)}
              />
              <label htmlFor="plugin-import-path" className="text-sm">
                {t("plugins:packagePath")}
              </label>
              <Input
                id="plugin-import-path"
                value={importPath}
                onChange={(event) => setImportPath(event.target.value)}
              />
              <Button
                disabled={busy || !importUrl.trim()}
                onClick={() => {
                  try {
                    action.mutate(
                      {
                        path: "/install",
                        body: {
                          source: sourceFromInput(
                            importUrl.trim(),
                            importRef,
                            importPath,
                            importTransport,
                          ),
                        },
                      },
                      {
                        onSuccess: () => {
                          setImportOpen(false);
                          setTab("installed");
                        },
                      },
                    );
                  } catch (error) {
                    toast.error(String(error));
                  }
                }}
              >
                {t("plugins:install")}
              </Button>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <input
        ref={uploadRef}
        className="hidden"
        type="file"
        accept=".zip"
        aria-label={t("plugins:upload")}
        onChange={(event) => {
          void upload(event.target.files?.[0]).catch(() => undefined);
          event.target.value = "";
        }}
      />
      {editingSource ? (
        <MarketplaceEditor
          key={editingSource === "new" ? "new" : editingSource.id}
          source={editingSource === "new" ? undefined : editingSource}
          onClose={() => setEditingSource(null)}
          onSave={(source) =>
            action
              .mutateAsync({ path: "/marketplaces", body: { source } })
              .then(() => setEditingSource(null))
          }
        />
      ) : null}
      <McpDialog
        open={!!mcpDialog}
        server={mcpDialog === "new" ? undefined : mcpDialog}
        onOpenChange={(open) => {
          if (!open) setMcpDialog(null);
        }}
        onSaved={() => {
          void invalidate();
        }}
      />
    </div>
  );
}

function MarketplaceEditor({
  source,
  onClose,
  onSave,
}: {
  source?: MarketplaceSource;
  onClose: () => void;
  onSave: (source: MarketplaceSource) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(source?.name ?? "");
  const [url, setUrl] = React.useState(
    source?.source.kind === "local"
      ? source.source.path
      : source && "url" in source.source
        ? source.source.url
        : "",
  );
  const [format, setFormat] = React.useState<MarketplaceSource["format"]>(
    source?.format ?? "claude",
  );
  const [path, setPath] = React.useState(source?.catalogPath ?? ".claude-plugin/marketplace.json");
  const [ref, setRef] = React.useState(source?.source.kind === "git" ? source.source.ref : "main");
  const [packageRoot, setPackageRoot] = React.useState(
    source && "path" in source.source && source.source.kind !== "local" ? source.source.path : "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(source ? "plugins:editSource" : "plugins:addSource")}</DialogTitle>
          <DialogDescription>{t("plugins:sourceHint")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setSaving(true);
              setError("");
              void Promise.resolve()
                .then(() =>
                  onSave({
                    id: source?.id ?? crypto.randomUUID(),
                    name,
                    source: sourceFromInput(url, ref, packageRoot),
                    format,
                    catalogPath: path,
                    category: source?.category ?? "personal",
                    enabled: source?.enabled ?? true,
                    builtin: source?.builtin ?? false,
                  }),
                )
                .catch((failure: Error) => setError(failure.message))
                .finally(() => setSaving(false));
            }}
          >
            <label htmlFor="marketplace-name">{t("plugins:name")}</label>
            <Input
              id="marketplace-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <label htmlFor="marketplace-url">{t("plugins:url")}</label>
            <Input
              id="marketplace-url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <label htmlFor="marketplace-format">{t("plugins:format")}</label>
            <Select
              value={format}
              onValueChange={(value: MarketplaceSource["format"] | null) => {
                if (!value) return;
                setFormat(value);
                setPath(
                  value === "codex"
                    ? ".agents/plugins/marketplace.json"
                    : value === "claude"
                      ? ".claude-plugin/marketplace.json"
                      : "",
                );
              }}
            >
              <SelectTrigger id="marketplace-format" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="skills">{t("plugins:skillDirectory")}</SelectItem>
                <SelectItem value="skills-sh">skills.sh</SelectItem>
              </SelectContent>
            </Select>
            <label htmlFor="marketplace-path">{t("plugins:catalogPath")}</label>
            <Input
              id="marketplace-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
            <label htmlFor="marketplace-root">{t("plugins:packagePath")}</label>
            <Input
              id="marketplace-root"
              value={packageRoot}
              onChange={(event) => setPackageRoot(event.target.value)}
            />
            <label htmlFor="marketplace-ref">{t("plugins:branch")}</label>
            <Input
              id="marketplace-ref"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            />
            {error ? (
              <p role="alert" className="break-words text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={saving}>
              {t("plugins:save")}
            </Button>
          </form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
