import { useTranslation } from "@/shared/i18n";
import { GeneratedAvatar } from "@/shared/ui/avatar";

export function AssistantAvatar() {
  return <GeneratedAvatar seed="mastra-work:assistant" name="MastraWork" />;
}

export function UserAvatar({ userId }: { userId: string }) {
  const { t } = useTranslation();
  return (
    <GeneratedAvatar seed={`mastra-work:user:${userId}`} name={t("chat:avatars.userAvatar")} />
  );
}
