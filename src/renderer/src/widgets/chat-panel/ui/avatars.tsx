import type { BotAvatarState } from "bot-avatars";
import { useTranslation } from "@/shared/i18n";
import { GeneratedAvatar } from "@/shared/ui/avatar";
import { DEFAULT_AGENT_PROFILE_ID } from "../../../../../shared/agent-contract";

export function AssistantAvatar({ state }: { state?: BotAvatarState }) {
  return <GeneratedAvatar seed={DEFAULT_AGENT_PROFILE_ID} name="MastraWork" state={state} />;
}

export function UserAvatar({ userId }: { userId: string }) {
  const { t } = useTranslation();
  return (
    <GeneratedAvatar seed={`mastra-work:user:${userId}`} name={t("chat:avatars.userAvatar")} />
  );
}
