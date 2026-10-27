import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { useProviderConfigQuery } from "@/entities/workbench/model/queries/config";
import { resetWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { LoginScreen, useAuth } from "@/features/auth";
import { ModelOnboardingPage } from "@/features/model-onboarding";
import { useTranslation } from "@/shared/i18n";
import { ConfirmationDialog } from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { AppProviders, queryClient } from "./app-providers";
import { router } from "./router";

export default function RendererApp(): React.JSX.Element {
  return (
    <AppProviders>
      <AuthGate />
    </AppProviders>
  );
}

/** 登录门:未登录渲染登录屏;登录后挂路由(router 为模块级单例,hash 跨会话复用) */
function AuthGate() {
  const { user, token, setSession } = useAuth();
  const previousUserId = React.useRef(user?.id ?? null);

  React.useEffect(() => {
    if (previousUserId.current && !user) {
      queryClient.clear();
      resetWorkbenchStore();
      void router.navigate({ to: "/chat" });
    }
    previousUserId.current = user?.id ?? null;
  }, [user]);

  if (!user || !token) {
    return (
      <TooltipProvider>
        <LoginScreen onAuthenticated={setSession} />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    );
  }

  return <AuthenticatedApp userId={user.id} />;
}

function AuthenticatedApp({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const providerConfig = useProviderConfigQuery();
  const [dismissed, setDismissed] = React.useState(false);
  const [needsOnboarding, setNeedsOnboarding] = React.useState<boolean | null>(null);
  const completeOnboarding = React.useCallback(() => {
    setDismissed(true);
    void router.navigate({ to: "/chat" });
  }, []);
  const skipKey = `mastra-work:model-onboarding-skipped:${userId}`;
  const hasUsableModel = (providerConfig.data?.providers ?? []).some(
    (provider) => !provider.disabled && provider.enabledModels.length > 0,
  );

  React.useEffect(() => {
    if (providerConfig.isPending || providerConfig.isError) return;
    setNeedsOnboarding(
      (current) => current ?? (!hasUsableModel && localStorage.getItem(skipKey) !== "true"),
    );
  }, [hasUsableModel, providerConfig.isError, providerConfig.isPending, skipKey]);

  if (providerConfig.isPending) {
    return (
      <TooltipProvider>
        <div className="flex h-svh items-center justify-center bg-background text-xs text-muted-foreground">
          正在准备工作台…
        </div>
        <Toaster position="bottom-right" />
      </TooltipProvider>
    );
  }

  if (providerConfig.isError) {
    return (
      <TooltipProvider>
        <div className="flex h-svh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          <p className="text-sm font-medium">{t("settings:api.fetchProvidersFailed")}</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {providerConfig.error instanceof Error
              ? providerConfig.error.message
              : t("common:unknown")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void providerConfig.refetch()}>
            {t("common:retry")}
          </Button>
        </div>
        <Toaster position="bottom-right" />
      </TooltipProvider>
    );
  }

  if (needsOnboarding === null) {
    return (
      <TooltipProvider>
        <div className="flex h-svh items-center justify-center bg-background text-xs text-muted-foreground">
          正在准备引导…
        </div>
        <Toaster position="bottom-right" />
      </TooltipProvider>
    );
  }

  if (needsOnboarding && !dismissed) {
    return (
      <TooltipProvider>
        <ModelOnboardingPage userId={userId} onComplete={completeOnboarding} />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <RouterProvider router={router} />
      <ConfirmationDialog key={userId} />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
