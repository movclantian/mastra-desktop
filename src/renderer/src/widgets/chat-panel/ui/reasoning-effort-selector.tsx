import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  getModelCapabilities,
  getReasoningEfforts,
  REASONING_EFFORT_LABELS,
  type ReasoningEffort,
} from "@/entities/workbench";
import { useCatalogQuery } from "@/entities/workbench/model/queries/config";
import { useSessionSettings } from "@/entities/workbench/model/use-session-settings";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { PromptInputButton } from "@/shared/ui/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/**
 * 思考力度菜单(官方 Model Selector pattern 的第二个菜单):
 * 模型菜单选「跑哪个模型」,本菜单选「想多深」。仅对支持推理的模型出现。
 * 拆成独立菜单后,切换力度不必先打开模型面板 —— 与官方两个并列菜单一致。
 */
export function ReasoningEffortSelector({ threadId }: { threadId: string | null }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const catalog = useCatalogQuery().data ?? [];
  const { providers, modelSelection, setModelSelection } = useSessionSettings(
    user?.id ?? "anonymous",
    threadId,
  );

  const provider = providers.find((item) => item.id === modelSelection?.providerId);
  const model = provider?.enabledModels.find((item) => item.id === modelSelection?.modelId);
  if (!provider || !model || !modelSelection) return null;

  const caps = getModelCapabilities(provider, model.id, catalog);
  const efforts = getReasoningEfforts(provider);
  if (!caps.reasoning || efforts.length === 0) return null;

  const current = modelSelection.reasoningEffort;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label={t("chat:models.reasoningEffort")}
            className="min-w-0 shrink-0"
            size="sm"
            title={t("chat:models.reasoningEffort")}
            variant="outline"
          />
        }
      >
        <BrainIcon className="size-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 truncate @max-[36rem]/prompt-footer:sr-only">
          {t(`chat:models.efforts.${current === "off" ? "none" : (current ?? "provider-default")}`)}
        </span>
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={current ?? ""}
          onValueChange={(effort) => {
            if (!efforts.includes(effort as ReasoningEffort)) return;
            setModelSelection({
              providerId: provider.id,
              modelId: model.id,
              modelName: model.name,
              reasoningEffort: effort as ReasoningEffort,
            });
          }}
        >
          {efforts.map((effort) => (
            <DropdownMenuRadioItem key={effort} value={effort} closeOnClick>
              {t(`chat:models.efforts.${effort}`, REASONING_EFFORT_LABELS[effort])}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
