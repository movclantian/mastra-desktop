import { BotIcon, UsersRoundIcon } from "lucide-react";
import * as React from "react";
import { DEFAULT_AGENT_PROFILE, useWorkbench } from "@/entities/workbench";
import { PromptInputButton } from "@/shared/ui/ai-elements/prompt-input";
import { Badge } from "@/shared/ui/badge";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/shared/ui/combobox";

export function ChatAgentSelector() {
  const { agents, agentSelection, setAgentSelection } = useWorkbench();
  const selected = agentSelection;
  const defaultAgent =
    agents.find((agent) => agent.id === DEFAULT_AGENT_PROFILE.id) ?? DEFAULT_AGENT_PROFILE;
  const personal = agents.filter(
    (agent) => agent.id !== DEFAULT_AGENT_PROFILE.id && agent.type === "agent",
  );
  const teams = agents.filter((agent) => agent.type === "team");

  const groups = React.useMemo(
    () => [
      { label: "默认 Agent", items: [defaultAgent] },
      ...(personal.length > 0 ? [{ label: "我的 Agent", items: personal }] : []),
      ...(teams.length > 0 ? [{ label: "Agent 团队", items: teams }] : []),
    ],
    [defaultAgent, personal, teams],
  );

  return (
    <Combobox
      items={groups}
      value={selected}
      onValueChange={(profile) => {
        if (profile) void setAgentSelection(profile);
      }}
      itemToStringValue={(profile) =>
        profile
          ? `${profile.displayName} ${profile.profession || ""} ${profile.description || ""}`
          : ""
      }
    >
      <ComboboxTrigger
        render={
          <PromptInputButton
            aria-label="选择 Agent 或 Agent 团队"
            className="min-w-0"
            size="sm"
            title={`${selected.type === "team" ? "Agent 团队" : "Agent"}: ${selected.displayName}`}
            type="button"
            variant="outline"
          />
        }
      >
        {selected.type === "team" ? (
          <UsersRoundIcon className="text-primary" />
        ) : (
          <BotIcon className="text-primary" />
        )}
        <span className="max-w-28 truncate text-xs">{selected.displayName}</span>
      </ComboboxTrigger>
      <ComboboxContent align="start" className="w-80 max-w-[min(90vw,24rem)] p-1">
        <ComboboxInput showTrigger={false} placeholder="搜索 Agent 或团队..." autoFocus />
        <ComboboxEmpty className="py-4 text-xs text-center text-muted-foreground">
          未找到匹配的 Agent
        </ComboboxEmpty>
        <ComboboxList className="max-h-[min(60vh,26rem)]">
          {(group, index) => (
            <ComboboxGroup key={group.label} items={group.items}>
              <ComboboxLabel>{group.label}</ComboboxLabel>
              <ComboboxCollection>
                {(profile) => (
                  <ComboboxItem
                    key={profile.id}
                    value={profile}
                    className="items-start gap-2 py-1.5"
                  >
                    {profile.type === "team" ? (
                      <UsersRoundIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{profile.displayName}</span>
                      </span>
                      {profile.profession || profile.description ? (
                        <span className="block whitespace-normal break-words text-[11px] text-muted-foreground">
                          {profile.profession || profile.description}
                        </span>
                      ) : null}
                    </span>
                    {profile.type === "team" ? (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        团队
                      </Badge>
                    ) : null}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
              {index < groups.length - 1 && <ComboboxSeparator />}
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
