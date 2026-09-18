import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { resetWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { LoginScreen, useAuth } from "@/features/auth";
import { SmoothCursor } from "@/shared/ui/smooth-cursor";
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
        <SmoothCursor />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <RouterProvider router={router} />
      <SmoothCursor />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
