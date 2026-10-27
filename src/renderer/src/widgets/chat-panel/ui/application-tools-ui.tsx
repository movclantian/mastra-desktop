import {
  BookMarkedIcon,
  ClockIcon,
  LibraryBigIcon,
  NetworkIcon,
  PlugIcon,
  RadioIcon,
  SearchIcon,
  StethoscopeIcon,
} from "lucide-react";
import { useTranslation } from "@/shared/i18n";
import { CodeFile } from "@/shared/ui/code-file";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { asRecord } from "../model/types";
import { MessageLink } from "./message-selection";
import type { ToolUIDescriptor } from "./tool-registry-ui";

const groups = {
  agents: [
    NetworkIcon,
    ["app_read_agents", "app_manage_agent_create", "app_manage_agent_update", "app_delete_agent"],
  ],
  plugins: [
    BookMarkedIcon,
    [
      "app_read_plugins",
      "app_read_plugin_file",
      "app_read_marketplaces",
      "app_read_marketplace_preview",
      "app_manage_marketplace_save",
      "app_delete_marketplace",
      "app_manage_plugin_install",
      "app_manage_plugin_import",
      "app_manage_plugin_enabled",
      "app_manage_plugin_configure",
      "app_manage_plugin_update",
      "app_delete_plugin",
    ],
  ],
  mcp: [
    PlugIcon,
    [
      "app_read_mcp_servers",
      "app_manage_mcp_save",
      "app_manage_mcp_enabled",
      "app_manage_mcp_test",
      "app_manage_mcp_authenticate",
      "app_delete_mcp_server",
    ],
  ],
  library: [
    LibraryBigIcon,
    [
      "app_read_library_list",
      "app_read_library_document",
      "app_edit_library_create_folder",
      "app_edit_library_rename_folder",
      "app_edit_library_create_document",
      "app_edit_library_save_version",
      "app_edit_library_import_file",
      "app_edit_library_add_reference",
      "app_edit_library_rename_document",
      "app_edit_library_reindex",
      "app_delete_library_document",
      "app_delete_library_folder",
    ],
  ],
  schedules: [
    ClockIcon,
    [
      "app_read_schedules",
      "app_manage_schedule_create",
      "app_manage_schedule_update",
      "app_manage_schedule_control",
      "app_delete_schedule",
    ],
  ],
  signals: [
    RadioIcon,
    [
      "app_manage_signal_subscribe",
      "app_manage_signal_unsubscribe",
      "app_read_signal_subscriptions",
    ],
  ],
  diagnostics: [StethoscopeIcon, ["app_read_diagnostics"]],
  discovery: [SearchIcon, ["search_tools", "load_tool"]],
} as const;

const collectionKeys = [
  "agents",
  "plugins",
  "servers",
  "folders",
  "assets",
  "sources",
  "listings",
  "schedules",
  "subscriptions",
  "sections",
  "tools",
];
const fields = [
  "id",
  "pluginId",
  "assetId",
  "folderId",
  "scheduleId",
  "externalResourceId",
  "type",
  "transport",
  "endpoint",
  "command",
  "argumentCount",
  "cron",
  "timezone",
  "enabled",
  "configured",
  "connected",
  "authenticated",
  "ok",
  "deleted",
  "removed",
  "status",
  "toolCount",
  "memberCount",
  "digest",
  "configurationRevision",
  "sha256",
  "byteSize",
  "folderIds",
  "nextRunAt",
  "lastRunAt",
  "nextOffset",
  "totalCharacters",
  "total",
  "refreshing",
  "directory",
  "database",
  "observations",
  "sourceDirectory",
  "checkedAt",
];

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resultRecords(
  output: unknown,
): Array<{ group?: string; record: Record<string, unknown> }> {
  if (Array.isArray(output))
    return output.flatMap((item) => {
      const record = asRecord(item);
      return record ? [{ record }] : [];
    });
  const result = asRecord(output);
  if (!result) return [];
  const collections = collectionKeys.flatMap((key) => {
    const values = result[key];
    return Array.isArray(values)
      ? values.flatMap((item) => {
          const record = asRecord(item);
          return record ? [{ group: key, record }] : [];
        })
      : [];
  });
  if (collections.length) return [{ record: result }, ...collections];
  const nested =
    asRecord(result.profile) ??
    asRecord(result.server) ??
    asRecord(result.folder) ??
    asRecord(result.subscription) ??
    asRecord(result.preview);
  return nested ? [{ record: result }, { record: nested }] : [{ record: result }];
}

function ApplicationRecord({ record, group }: { record: Record<string, unknown>; group?: string }) {
  const { t } = useTranslation();
  const title =
    text(record.displayName) ?? text(record.name) ?? text(record.filename) ?? text(record.section);
  const values = fields.filter((key) => Object.hasOwn(record, key) && record[key] !== undefined);
  const errors = [
    record.error,
    record.indexError,
    record.configurationError,
    record.connectionError,
    ...(Array.isArray(record.issues) ? record.issues : []),
  ].filter((value): value is string => !!text(value));
  const components = Array.isArray(record.components) ? record.components : [];
  const state = record.state;
  const stateRecord = asRecord(state);
  const hasNestedState = stateRecord || Array.isArray(state);
  if (!title && !values.length && !errors.length && !components.length && !hasNestedState)
    return null;
  return (
    <section className="min-w-0 space-y-2 rounded-md border bg-muted/20 p-2 text-xs">
      {group || title ? (
        <p className="font-medium [overflow-wrap:anywhere]">
          {group ? `${t(`chat:trace.applicationFields.${group}`)} · ` : ""}
          {title}
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {values.map((key) => {
          const value = record[key];
          const display =
            value === null
              ? t("chat:trace.applicationUnknown")
              : typeof value === "boolean"
                ? t(value ? "chat:trace.applicationYes" : "chat:trace.applicationNo")
                : Array.isArray(value)
                  ? value.join(", ")
                  : String(value);
          return (
            <div className="contents" key={key}>
              <dt className="text-muted-foreground">{t(`chat:trace.applicationFields.${key}`)}</dt>
              <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{display}</dd>
            </div>
          );
        })}
      </dl>
      {errors.map((error, index) => (
        <p className="whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]" key={index}>
          {error}
        </p>
      ))}
      {components.slice(0, 8).map((item, index) => {
        const component = asRecord(item) ?? {};
        const status = asRecord(component.status);
        return (
          <p className="[overflow-wrap:anywhere]" key={text(component.id) ?? index}>
            {text(component.kind)} · {text(component.name)} ·{" "}
            {text(status?.status) ?? t("chat:trace.applicationUnknown")}
            {text(status?.detail) ? `: ${text(status?.detail)}` : ""}
          </p>
        );
      })}
      {Array.isArray(state) ? (
        state.slice(0, 12).map((item, index) => {
          const record = asRecord(item);
          return record ? <ApplicationRecord key={index} record={record} /> : null;
        })
      ) : stateRecord ? (
        <ApplicationRecord record={stateRecord} />
      ) : null}
      {text(record.next) ? (
        <p className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
          {text(record.next)}
        </p>
      ) : null}
    </section>
  );
}

function ApplicationToolDetail({
  input,
  output,
}: {
  input: Record<string, unknown>;
  output: unknown;
}) {
  const { t } = useTranslation();
  const result = asRecord(output);
  const records = resultRecords(output);
  const content = text(result?.content);
  const authorizationUrl = text(result?.authorizationUrl);
  const emptyCollection =
    result &&
    collectionKeys.some((key) => Array.isArray(result[key])) &&
    !collectionKeys.some((key) => Array.isArray(result[key]) && result[key].length);
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {t("chat:trace.applicationRequest")}
      </p>
      <CodeFile code={JSON.stringify(input, null, 2).slice(0, 12000)} language="json" />
      {output !== undefined ? (
        <p className="text-xs font-medium text-muted-foreground">
          {t("chat:trace.applicationEvidence")}
        </p>
      ) : null}
      {emptyCollection ? (
        <p className="text-xs text-muted-foreground">{t("chat:trace.applicationEmpty")}</p>
      ) : null}
      {records.slice(0, 13).map(({ group, record }, index) => (
        <ApplicationRecord key={index} record={record} group={group} />
      ))}
      {records.length > 13 ? (
        <p className="text-xs text-muted-foreground">
          {t("chat:trace.moreResults", { count: records.length - 13 })}
        </p>
      ) : null}
      {result?.effective === "next_run" ? (
        <p className="text-xs text-muted-foreground">{t("chat:trace.applicationNextRun")}</p>
      ) : null}
      {authorizationUrl && /^https?:\/\//i.test(authorizationUrl) ? (
        <MessageLink href={authorizationUrl}>{t("chat:trace.applicationSignIn")}</MessageLink>
      ) : null}
      {text(result?.next) ? (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {text(result?.next)}
        </p>
      ) : null}
      {content ? <CodeFile code={content.slice(0, 12000)} language="markdown" /> : null}
      {output !== undefined ? (
        <Collapsible className="min-w-0 text-xs">
          <CollapsibleTrigger className="cursor-pointer text-muted-foreground">
            {t("chat:trace.applicationDetails")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CodeFile
              code={(JSON.stringify(output, null, 2) ?? String(output)).slice(0, 24000)}
              language="json"
            />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** Exact coverage, shared domain cards; native trace owns approval, failure and streaming state. */
export const applicationToolUIs: Record<string, ToolUIDescriptor> = Object.fromEntries(
  Object.values(groups).flatMap(([icon, names]) =>
    names.map((name) => [
      name,
      {
        icon,
        labelKey: name,
        summarize: (input: Record<string, unknown>, output: unknown) => {
          const result = asRecord(output);
          const object =
            asRecord(result?.profile) ??
            asRecord(result?.server) ??
            asRecord(result?.folder) ??
            result;
          return {
            chips: [
              text(input.displayName) ??
                text(input.name) ??
                text(input.filename) ??
                text(input.query),
              text(input.action),
              text(input.agentId) ?? text(input.pluginId) ?? text(input.assetId) ?? text(input.id),
              text(object?.displayName) ?? text(object?.name) ?? text(object?.filename),
              text(object?.status),
            ]
              .filter((value): value is string => !!value)
              .slice(0, 4),
            files: text(input.path) ? [String(input.path)] : [],
          };
        },
        detail: ({ input, output }: { input: Record<string, unknown>; output: unknown }) => (
          <ApplicationToolDetail input={input} output={output} />
        ),
      },
    ]),
  ),
);
