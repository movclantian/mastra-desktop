import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/features/auth";
import { ThemeProvider } from "@/shared/theme";

/**
 * 模块级 QueryClient:非组件层(命令式乐观更新、登出清理)直接引用,
 * 不经 React context 转发。桌面端后端是本机进程:失败即真实失败(retry 0),
 * 新鲜度由 mutation invalidation 保证,窗口聚焦不自动重拉。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 300_000,
      retry: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

function InnerProviders({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <ThemeProvider userId={user?.id} defaultTheme="light">
      {children}
    </ThemeProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <InnerProviders>{children}</InnerProviders>
      </AuthProvider>
    </QueryClientProvider>
  );
}
