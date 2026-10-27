import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  ListIcon,
  LoaderCircleIcon,
  PlusIcon,
  ServerIcon,
  SparklesIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  type EnabledModel,
  fetchProviderModels,
  GATEWAY_PROTOCOLS,
  type GatewayProtocol,
  type ProviderConfig,
  qk,
  type RegistryProvider,
  testProviderModel,
  useProviderConfigQuery,
  useRegistry,
} from "@/entities/workbench";
import { saveProviderConfig } from "@/entities/workbench/api/workbench-api";
import type { ModelSelection } from "@/entities/workbench/model/types";
import { useTranslation } from "@/shared/i18n";
import { cn, toastError } from "@/shared/lib";
import { ModelSelectorLogo } from "@/shared/ui/ai-elements/model-selector";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Command, CommandInput } from "@/shared/ui/command";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { WindowTitleBar } from "@/shared/ui/panel";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { inferModelKind } from "../../../../shared/agent-contract";
import { providerCredentialPurpose } from "../../../../shared/credential-contract";
import { normalizeProviderUrl } from "../../../../shared/provider-url";

type Step = "provider" | "model";

/** A lightweight CSS version of Magic UI's floating 3D particle background. */
function Floating3DParticles() {
  const variant = React.useMemo(
    () =>
      [
        { count: 36, tones: ["var(--primary-foreground)", "#fcd34d", "#67e8f9"] },
        { count: 52, tones: ["#fda4af", "#c4b5fd", "var(--primary-foreground)"] },
        { count: 44, tones: ["#86efac", "#93c5fd", "#fde68a"] },
      ][Math.floor(Math.random() * 3)],
    [],
  );
  const particles = React.useMemo(
    () =>
      Array.from({ length: variant.count }, (_, index) => ({
        id: index,
        x: Math.round(Math.random() * 100),
        y: Math.round(Math.random() * 100),
        z: Math.round(Math.random() * 80) - 40,
        size: Math.round((Math.random() * 2.4 + 1.4) * 10) / 10,
        delay: Math.round(Math.random() * 8 * 10) / 10,
        duration: Math.round((8 + Math.random() * 10) * 10) / 10,
        tone: variant.tones[index % variant.tones.length],
      })),
    [variant],
  );

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden [perspective:900px]"
    >
      {particles.map((particle) => (
        <span
          key={particle.id}
          className="absolute rounded-full shadow-[0_0_14px_color-mix(in_oklab,var(--primary-foreground)_60%,transparent)] [animation:float-3d_var(--duration)_ease-in-out_var(--delay)_infinite]"
          style={
            {
              left: `${particle.x}%`,
              top: `${particle.y}%`,
              width: `${particle.size}px`,
              height: `${particle.size}px`,
              "--z": `${particle.z}px`,
              "--delay": `${particle.delay}s`,
              "--duration": `${particle.duration}s`,
              backgroundColor: particle.tone,
            } as React.CSSProperties
          }
        />
      ))}
      <style>{`
        @keyframes float-3d {
          0%, 100% { transform: translate3d(0, 0, var(--z)); opacity: .25; }
          50% { transform: translate3d(18px, -26px, calc(var(--z) + 90px)); opacity: .95; }
        }
      `}</style>
    </div>
  );
}

function TextHighlighter({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative inline-block px-1.5 py-0.5">
      <span className="absolute inset-x-0 bottom-0.5 h-[0.55em] -rotate-1 rounded-sm bg-amber-300/70" />
      <span className="relative">{children}</span>
    </span>
  );
}

function Text3DFlip({ words }: { words: string[] }) {
  const [index, setIndex] = React.useState(0);
  React.useEffect(() => {
    if (words.length < 2) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % words.length),
      2200,
    );
    return () => window.clearInterval(timer);
  }, [words.length]);
  return (
    <span className="inline-grid min-w-28 [perspective:500px]">
      <span
        key={words[index]}
        className="col-start-1 row-start-1 font-semibold text-primary [animation:text-3d-flip_500ms_ease-out]"
      >
        {words[index]}
      </span>
      <style>{`
        @keyframes text-3d-flip { from { opacity: 0; transform: rotateX(-82deg) translateY(8px); } to { opacity: 1; transform: rotateX(0) translateY(0); } }
      `}</style>
    </span>
  );
}

function DiaTextReveal({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-2 gap-y-1 text-center text-3xl font-semibold tracking-tight sm:text-5xl">
      {String(children)
        .split(" ")
        .map((word, index) => (
          <span
            key={`${word}-${index}`}
            className="inline-block [animation:dia-reveal_700ms_cubic-bezier(.22,1,.36,1)_both]"
            style={{ animationDelay: `${index * 85}ms` }}
          >
            {word}
          </span>
        ))}
      <style>{`
        @keyframes dia-reveal { from { opacity: 0; transform: translateY(22px) rotate(2deg); filter: blur(8px); } to { opacity: 1; transform: translateY(0) rotate(0); filter: blur(0); } }
      `}</style>
    </div>
  );
}

function Celebration({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  React.useEffect(() => {
    const timer = window.setTimeout(onContinue, 2200);
    return () => window.clearTimeout(timer);
  }, [onContinue]);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/92 p-6 backdrop-blur-xl">
      <div className="flex max-w-2xl flex-col items-center gap-7 text-center">
        <div className="flex size-16 items-center justify-center rounded-3xl bg-primary/12 text-primary shadow-[0_0_70px_color-mix(in_oklab,var(--primary)_35%,transparent)]">
          <CheckCircle2Icon className="size-9" />
        </div>
        <DiaTextReveal>{t("auth:onboarding.celebration")}</DiaTextReveal>
        <p className="max-w-md text-sm leading-6 text-muted-foreground">
          {t("auth:onboarding.celebrationHint")}
        </p>
        <Button variant="ghost" onClick={onContinue}>
          {t("auth:onboarding.enterNow")}
          <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

function providerModels(provider: RegistryProvider): EnabledModel[] {
  return provider.models.map((id) => ({ id, name: id }));
}

function ProviderMark({ provider }: { provider: string }) {
  const [failed, setFailed] = React.useState(false);
  return failed ? (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <ServerIcon className="size-3.5" />
    </span>
  ) : (
    <ModelSelectorLogo
      provider={provider}
      className="size-5 shrink-0"
      onError={() => setFailed(true)}
    />
  );
}

function isLanguageModel(model: EnabledModel): boolean {
  return (model.kind ?? inferModelKind(model.id)) === "language";
}

function sameProviderConnection(
  left: ProviderConfig,
  right: Pick<ProviderConfig, "registryId" | "protocol" | "baseUrl">,
): boolean {
  if (right.registryId) return left.registryId === right.registryId;
  const leftBaseUrl = left.baseUrl?.replace(/\/+$/, "");
  const rightBaseUrl = right.baseUrl?.replace(/\/+$/, "");
  return Boolean(
    !left.registryId &&
      (left.protocol ?? "openai") === (right.protocol ?? "openai") &&
      leftBaseUrl &&
      rightBaseUrl &&
      leftBaseUrl === rightBaseUrl,
  );
}

export function ModelOnboardingPage({
  userId,
  onComplete,
}: {
  userId: string;
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const configQuery = useProviderConfigQuery();
  const registry = useRegistry();
  const [step, setStep] = React.useState<Step>("provider");
  const [selectedProvider, setSelectedProvider] = React.useState<RegistryProvider | null>(null);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customProtocol, setCustomProtocol] = React.useState<GatewayProtocol>("openai");
  const [customBaseUrl, setCustomBaseUrl] = React.useState("");
  const [providerQuery, setProviderQuery] = React.useState("");
  const [providerView, setProviderView] = React.useState<"grid" | "list">("grid");
  const [apiKey, setApiKey] = React.useState("");
  const [provider, setProvider] = React.useState<ProviderConfig | null>(null);
  const [models, setModels] = React.useState<EnabledModel[]>([]);
  const [selectedModelId, setSelectedModelId] = React.useState("");
  const [modelQuery, setModelQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [skipForever, setSkipForever] = React.useState(false);
  const [celebrating, setCelebrating] = React.useState(false);

  const languageModels = React.useMemo(() => models.filter(isLanguageModel), [models]);
  const filteredLanguageModels = React.useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    if (!query) return languageModels;
    return languageModels.filter((model) =>
      `${model.name} ${model.id}`.toLocaleLowerCase().includes(query),
    );
  }, [languageModels, modelQuery]);
  const filteredRegistry = React.useMemo(() => {
    const query = providerQuery.trim().toLocaleLowerCase();
    if (!query) return registry;
    return registry.filter((item) => `${item.name} ${item.id}`.toLocaleLowerCase().includes(query));
  }, [providerQuery, registry]);

  const finish = React.useCallback(() => {
    if (skipForever) localStorage.setItem(`mastra-work:model-onboarding-skipped:${userId}`, "true");
    const celebrationKey = `mastra-work:model-onboarding-celebrated:${userId}`;
    if (localStorage.getItem(celebrationKey) === "true") {
      onComplete();
      return;
    }
    localStorage.setItem(celebrationKey, "true");
    setCelebrating(true);
  }, [onComplete, skipForever, userId]);

  const handleSkip = () => finish();

  const startCustomProvider = () => {
    setSelectedProvider(null);
    setCustomOpen(true);
    setApiKey("");
  };

  const addProvider = async () => {
    if (!selectedProvider || !apiKey.trim()) return;
    setBusy(true);
    try {
      const currentProviders = configQuery.data?.providers ?? [];
      const existing = currentProviders.find((item) => item.registryId === selectedProvider.id);
      const id = existing?.id ?? `provider-${crypto.randomUUID().slice(0, 8)}`;
      const credential = await window.api.credentials.put({
        purpose: providerCredentialPurpose(id),
        value: apiKey.trim(),
      });
      const nextProvider: ProviderConfig = {
        id,
        name: selectedProvider.name,
        registryId: selectedProvider.id,
        ...credential,
        enabledModels: [],
      };
      const discovered = providerModels(selectedProvider);
      const languageModel = discovered.find(isLanguageModel);
      if (!languageModel) throw new Error(t("auth:onboarding.noModels"));
      setProvider(nextProvider);
      setModels(discovered);
      setSelectedModelId(languageModel.id);
      setStep("model");
    } catch (error) {
      toastError(error, t("auth:onboarding.addFailed"));
    } finally {
      setBusy(false);
    }
  };

  const addCustomProvider = async () => {
    if (!customName.trim() || !customBaseUrl.trim() || !apiKey.trim()) return;
    setBusy(true);
    try {
      const baseUrl = normalizeProviderUrl(customBaseUrl, customProtocol);
      const currentProviders = configQuery.data?.providers ?? [];
      const existing = currentProviders.find((item) =>
        sameProviderConnection(item, { protocol: customProtocol, baseUrl }),
      );
      const id = existing?.id ?? `provider-${crypto.randomUUID().slice(0, 8)}`;
      const credential = await window.api.credentials.put({
        purpose: providerCredentialPurpose(id),
        value: apiKey.trim(),
      });
      const nextProvider: ProviderConfig = {
        id,
        name: customName.trim(),
        protocol: customProtocol,
        baseUrl,
        ...credential,
        enabledModels: [],
      };
      const discovered = await fetchProviderModels(nextProvider, registry);
      const languageModel = discovered.find(isLanguageModel);
      if (!languageModel) throw new Error(t("auth:onboarding.noModels"));
      setProvider(nextProvider);
      setModels(discovered);
      setSelectedModelId(languageModel.id);
      setStep("model");
    } catch (error) {
      toastError(error, t("auth:onboarding.addFailed"));
    } finally {
      setBusy(false);
    }
  };

  const testAndEnable = async () => {
    if (!provider || !selectedModelId) return;
    setBusy(true);
    try {
      const result = await testProviderModel(provider, selectedModelId);
      if (!result.ok) throw new Error(result.error || t("auth:onboarding.testFailed"));
      const selected = models.find((model) => model.id === selectedModelId) ?? {
        id: selectedModelId,
        name: selectedModelId,
      };
      const nextProvider = { ...provider, enabledModels: [selected] };
      const selection: ModelSelection = {
        providerId: provider.id,
        modelId: selected.id,
        modelName: selected.name,
        reasoningEffort: "provider-default",
      };
      const currentProviders = configQuery.data?.providers ?? [];
      const providers = [
        nextProvider,
        ...currentProviders.filter(
          (item) => item.id !== provider.id && !sameProviderConnection(item, nextProvider),
        ),
      ];
      await saveProviderConfig({ providers, modelSelection: selection });
      queryClient.setQueryData(qk.providerConfig(), { providers, modelSelection: selection });
      toast.success(t("auth:onboarding.testSuccess"));
      finish();
    } catch (error) {
      toastError(error, t("auth:onboarding.testFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-svh min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowTitleBar>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">MastraWork</span>
      </WindowTitleBar>
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4 sm:p-8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_42%),radial-gradient(circle_at_90%_90%,color-mix(in_oklab,var(--accent)_24%,transparent),transparent_38%)]" />
        <Floating3DParticles />
        <div className="relative z-10 grid h-full max-h-full min-h-0 w-full max-w-5xl overflow-hidden rounded-[2rem] border border-border/70 bg-card/88 shadow-2xl shadow-primary/10 backdrop-blur-xl lg:grid-cols-[0.84fr_1.16fr]">
          <aside className="hidden flex-col justify-between border-r border-border/60 bg-primary/[0.06] p-8 lg:flex">
            <div>
              <div className="mb-10 flex items-center gap-2 text-sm font-semibold tracking-[0.16em] uppercase">
                <SparklesIcon className="size-4 text-primary" /> MastraWork
              </div>
              <h1 className="max-w-sm text-4xl font-semibold leading-[1.05] tracking-tight">
                {t("auth:onboarding.title")}{" "}
                <TextHighlighter>{t("auth:onboarding.highlight")}</TextHighlighter>
              </h1>
              <p className="mt-5 max-w-sm text-sm leading-6 text-muted-foreground">
                {t("auth:onboarding.subtitle")}
              </p>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("auth:onboarding.flipPrefix")}{" "}
              <Text3DFlip words={t("auth:onboarding.flipWords").split(",")} />
            </p>
          </aside>

          <main className="flex min-h-0 min-w-0 flex-col overflow-hidden p-6 sm:p-10">
            <div className="mb-8 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium tracking-[0.18em] text-primary uppercase">
                  {t("auth:onboarding.step", { current: step === "provider" ? 1 : 2, total: 2 })}
                </p>
                <h2 className="mt-2 text-xl font-semibold">
                  {step === "provider"
                    ? t("auth:onboarding.chooseProvider")
                    : t("auth:onboarding.chooseModel")}
                </h2>
              </div>
              <span className="text-xs text-muted-foreground">{t("auth:onboarding.safeHint")}</span>
            </div>

            {step === "provider" ? (
              <div className="flex min-h-0 flex-1 flex-col gap-5">
                <p className="text-sm text-muted-foreground">{t("auth:onboarding.providerHint")}</p>
                <div className="flex min-w-0 items-center gap-2">
                  <Command className="h-10! min-h-0 min-w-0 flex-1 rounded-xl bg-muted/30 p-0">
                    <CommandInput
                      value={providerQuery}
                      onValueChange={setProviderQuery}
                      placeholder={t("auth:onboarding.searchProviders")}
                    />
                  </Command>
                  <ToggleGroup
                    variant="outline"
                    size="sm"
                    value={[providerView]}
                    onValueChange={(values) => {
                      const value = values[0];
                      if (value === "grid" || value === "list") setProviderView(value);
                    }}
                    aria-label={t("auth:onboarding.providerView")}
                  >
                    <ToggleGroupItem value="grid" aria-label={t("auth:onboarding.gridView")}>
                      <LayoutGridIcon />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="list" aria-label={t("auth:onboarding.listView")}>
                      <ListIcon />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <ScrollArea className="min-h-0 flex-1 pr-1">
                  <div
                    className={cn(
                      providerView === "grid"
                        ? "grid grid-cols-2 gap-2 sm:grid-cols-3"
                        : "flex flex-col gap-2",
                    )}
                  >
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "h-auto min-h-14 justify-start gap-3 rounded-2xl border-dashed p-3 text-left",
                        providerView === "grid" && "col-span-2 sm:col-span-3",
                      )}
                      aria-pressed={customOpen}
                      onClick={startCustomProvider}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <PlusIcon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {t("auth:onboarding.customProvider")}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {t("auth:onboarding.customProviderHint")}
                        </span>
                      </span>
                    </Button>

                    {filteredRegistry.map((item) => (
                      <Button
                        key={item.id}
                        type="button"
                        variant="ghost"
                        aria-pressed={!customOpen && selectedProvider?.id === item.id}
                        title={item.name}
                        className={cn(
                          "group h-auto min-h-20 min-w-0 rounded-2xl border p-3 text-left whitespace-normal transition hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/[0.05]",
                          providerView === "grid"
                            ? "flex-col items-start justify-between"
                            : "items-center",
                          !customOpen &&
                            selectedProvider?.id === item.id &&
                            "border-primary bg-primary/[0.08] ring-2 ring-primary/20",
                        )}
                        onClick={() => {
                          setCustomOpen(false);
                          setSelectedProvider(item);
                        }}
                      >
                        <span className="flex w-full min-w-0 items-center gap-2">
                          <ProviderMark provider={item.id} />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {item.name}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "flex items-center gap-1 text-[11px] text-muted-foreground",
                            providerView === "grid" ? "mt-3 w-full" : "ml-auto shrink-0",
                          )}
                        >
                          {item.models.length} {t("auth:onboarding.models")}
                          {!customOpen && selectedProvider?.id === item.id ? (
                            <CheckCircle2Icon className="size-3.5 text-primary" />
                          ) : null}
                        </span>
                      </Button>
                    ))}
                    {filteredRegistry.length === 0 ? (
                      <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
                        {t("auth:onboarding.noProviderMatch")}
                      </p>
                    ) : null}
                  </div>
                </ScrollArea>
                {customOpen ? (
                  <div className="rounded-2xl border border-primary/30 bg-muted/30 p-4">
                    <div className="mb-3 flex items-center gap-2">
                      <ServerIcon className="size-4 text-primary" />
                      <p className="text-sm font-medium">{t("auth:onboarding.customProvider")}</p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        value={customName}
                        onChange={(event) => setCustomName(event.target.value)}
                        placeholder={t("auth:onboarding.customNamePlaceholder")}
                      />
                      <Select
                        items={GATEWAY_PROTOCOLS.map((item) => ({
                          value: item.value,
                          label: item.label,
                        }))}
                        value={customProtocol}
                        onValueChange={(value) =>
                          setCustomProtocol((value ?? "openai") as GatewayProtocol)
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GATEWAY_PROTOCOLS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        className="sm:col-span-2"
                        value={customBaseUrl}
                        onChange={(event) => setCustomBaseUrl(event.target.value)}
                        placeholder={t("auth:onboarding.customBaseUrlPlaceholder")}
                      />
                      <div className="flex gap-2 sm:col-span-2">
                        <Input
                          className="min-w-0 flex-1"
                          type="password"
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          placeholder={t("auth:onboarding.accessKeyPlaceholder")}
                        />
                        <Button
                          onClick={() => void addCustomProvider()}
                          disabled={
                            busy || !customName.trim() || !customBaseUrl.trim() || !apiKey.trim()
                          }
                        >
                          {busy ? <LoaderCircleIcon className="animate-spin" /> : <KeyRoundIcon />}
                          {t("auth:onboarding.continue")}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : selectedProvider ? (
                  <div className="rounded-2xl border border-border/70 bg-muted/30 p-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <Label htmlFor="onboarding-api-key" className="text-sm font-medium">
                        {t("auth:onboarding.apiKey", { name: selectedProvider.name })}
                      </Label>
                      {selectedProvider.docUrl ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => window.api.workspace.openExternal(selectedProvider.docUrl)}
                        >
                          <ExternalLinkIcon /> {t("auth:onboarding.docs")}
                        </Button>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        id="onboarding-api-key"
                        type="password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={selectedProvider.apiKeyEnvVar}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void addProvider();
                        }}
                      />
                      <Button onClick={() => void addProvider()} disabled={busy || !apiKey.trim()}>
                        {busy ? <LoaderCircleIcon className="animate-spin" /> : <KeyRoundIcon />}
                        {t("auth:onboarding.continue")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-5">
                <p className="text-sm text-muted-foreground">{t("auth:onboarding.modelHint")}</p>
                <Command className="h-10! min-h-0 shrink-0 rounded-xl bg-muted/30 p-0">
                  <CommandInput
                    value={modelQuery}
                    onValueChange={setModelQuery}
                    placeholder={t("auth:onboarding.searchModels")}
                  />
                </Command>
                <ScrollArea className="min-h-0 flex-1 rounded-2xl border border-border/70 p-2">
                  {filteredLanguageModels.map((model) => (
                    <Button
                      key={model.id}
                      type="button"
                      variant="ghost"
                      aria-pressed={selectedModelId === model.id}
                      className={cn(
                        "h-auto w-full items-center justify-between rounded-xl px-3 py-3 text-left transition hover:bg-muted",
                        selectedModelId === model.id && "bg-primary/[0.1] text-primary",
                      )}
                      onClick={() => setSelectedModelId(model.id)}
                    >
                      <span className="min-w-0 truncate text-sm font-medium">
                        {model.name || model.id}
                      </span>
                      <span className="ml-3 max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                        {model.id}
                      </span>
                    </Button>
                  ))}
                  {filteredLanguageModels.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {t("auth:onboarding.noModelMatch")}
                    </p>
                  ) : null}
                </ScrollArea>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Button variant="ghost" onClick={() => setStep("provider")} disabled={busy}>
                    {t("auth:onboarding.back")}
                  </Button>
                  <Button onClick={() => void testAndEnable()} disabled={busy || !selectedModelId}>
                    {busy ? <LoaderCircleIcon className="animate-spin" /> : <CheckCircle2Icon />}
                    {t("auth:onboarding.testAndEnter")}
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-7 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={handleSkip} disabled={celebrating}>
                  {t("auth:onboarding.skip")}
                </Button>
                <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={skipForever}
                    onCheckedChange={(checked) => setSkipForever(Boolean(checked))}
                  />
                  {t("auth:onboarding.neverAgain")}
                </Label>
              </div>
            </div>
          </main>
        </div>
        {celebrating ? <Celebration onContinue={onComplete} /> : null}
      </div>
    </div>
  );
}
