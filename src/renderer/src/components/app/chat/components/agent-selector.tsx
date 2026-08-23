import { BotIcon, CheckIcon, UsersRoundIcon } from "lucide-react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DEFAULT_AGENT_PROFILE, useWorkbench } from "@/lib/workbench";

export function ChatAgentSelector() {
  const { agents, agentSelection, setAgentSelection } = useWorkbench();
  const selected = agentSelection;
  const defaultAgent =
    agents.find((agent) => agent.id === DEFAULT_AGENT_PROFILE.id) ?? DEFAULT_AGENT_PROFILE;
  const personal = agents.filter(
    (agent) => agent.id !== DEFAULT_AGENT_PROFILE.id && agent.type === "agent",
  );
  const teams = agents.filter((agent) => agent.type === "team");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
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
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-w-[min(90vw,24rem)] p-1">
        <ScrollArea className="max-h-[min(60vh,26rem)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>默认 Agent</DropdownMenuLabel>
            <ProfileItem
              profile={defaultAgent}
              selected={selected.id}
              onSelect={setAgentSelection}
            />
            {personal.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>我的 Agent</DropdownMenuLabel>
                {personal.map((profile) => (
                  <ProfileItem
                    key={profile.id}
                    profile={profile}
                    selected={selected.id}
                    onSelect={setAgentSelection}
                  />
                ))}
              </>
            ) : null}
            {teams.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Agent 团队</DropdownMenuLabel>
                {teams.map((profile) => (
                  <ProfileItem
                    key={profile.id}
                    profile={profile}
                    selected={selected.id}
                    onSelect={setAgentSelection}
                  />
                ))}
              </>
            ) : null}
          </DropdownMenuGroup>
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProfileItem({
  profile,
  selected,
  onSelect,
}: {
  profile?: ReturnType<typeof useWorkbench>["agentSelection"];
  selected: string;
  onSelect: (
    profile: NonNullable<ReturnType<typeof useWorkbench>["agents"]>[number],
  ) => Promise<void>;
}) {
  if (!profile) return null;
  return (
    <DropdownMenuItem className="items-start gap-2" onClick={() => void onSelect(profile)}>
      {profile.type === "team" ? (
        <UsersRoundIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate">{profile.displayName}</span>
          {selected === profile.id ? <CheckIcon className="ml-auto size-3.5" /> : null}
        </span>
        <span className="block whitespace-normal break-words text-[11px] text-muted-foreground">
          {profile.profession || profile.description}
        </span>
      </span>
      {profile.type === "team" ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          团队
        </Badge>
      ) : null}
    </DropdownMenuItem>
  );
}
