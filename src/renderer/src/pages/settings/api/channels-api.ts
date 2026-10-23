import { requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";
import type {
  ChannelConfig,
  ChannelPlatformInfo,
  ChannelRuntimeStatus,
} from "../../../../../shared/channel-contract";

export interface ChannelsPayload {
  config: ChannelConfig;
  platforms: ChannelPlatformInfo[];
  runtime: ChannelRuntimeStatus[];
}

export function fetchChannels(): Promise<ChannelsPayload> {
  return requestJson<ChannelsPayload>("/work/channels", {}, i18n.t("settings:channels.loadFailed"));
}

export function saveChannelsConfig(config: ChannelConfig): Promise<ChannelsPayload> {
  return requestJson<ChannelsPayload>(
    "/work/channels",
    { method: "POST", body: { config } },
    i18n.t("settings:channels.saveFailed"),
  );
}
