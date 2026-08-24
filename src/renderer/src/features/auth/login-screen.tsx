import { ChevronDownIcon, LoaderCircleIcon, LogInIcon, UserPlusIcon } from "lucide-react";
import * as React from "react";
import { submitAuth as submitAuthRequest } from "@/api/auth-api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AUTH_AUTO_LOGIN_KEY, getRememberedAccounts } from "./auth-storage";
import type { AuthSession, RememberedAccount } from "./types";

interface LoginScreenProps {
  onAuthenticated: (session: AuthSession, remember: boolean, autoLogin: boolean) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [mode, setMode] = React.useState<"login" | "register">("login");
  const rememberedAccounts = React.useMemo(() => getRememberedAccounts(), []);
  const [email, setEmail] = React.useState(() => rememberedAccounts[0]?.email ?? "");
  const [name, setName] = React.useState(() => rememberedAccounts[0]?.name ?? "");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [remember, setRemember] = React.useState(() => rememberedAccounts.length > 0);
  const [autoLogin, setAutoLogin] = React.useState(
    () => localStorage.getItem(AUTH_AUTO_LOGIN_KEY) === "true",
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const selectAccount = (account: RememberedAccount) => {
    setEmail(account.email);
    setName(account.name);
    setPassword("");
    setError(null);
  };

  const switchMode = (nextMode: "login" | "register") => {
    setMode(nextMode);
    setError(null);
    setPassword("");
    setConfirmPassword("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const session = await submitAuthRequest(mode, {
        ...(mode === "register" ? { name } : {}),
        email,
        password,
      });
      onAuthenticated(session, remember || autoLogin, autoLogin);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : mode === "login" ? "登录失败" : "注册失败",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-4 sm:p-6">
      <div className="w-full max-w-4xl">
        <Card className="overflow-hidden p-0 shadow-xl">
          <CardContent className="grid min-w-0 p-0 md:grid-cols-2">
            <form className="flex min-w-0 flex-col justify-center p-6 sm:p-8" onSubmit={submit}>
              <FieldGroup>
                <div className="flex flex-col items-center gap-2 text-center">
                  <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                    {mode === "login" ? <LogInIcon /> : <UserPlusIcon />}
                  </div>
                  <h1 className="text-2xl font-bold">
                    {mode === "login" ? "欢迎回来" : "创建账户"}
                  </h1>
                  <p className="text-sm text-balance text-muted-foreground">
                    {mode === "login"
                      ? "登录 MastraWork 继续你的工作"
                      : "注册后即可开始使用 MastraWork"}
                  </p>
                </div>

                {mode === "register" ? (
                  <Field>
                    <FieldLabel htmlFor="auth-name">名称</FieldLabel>
                    <Input
                      id="auth-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="你的名称"
                      autoComplete="name"
                      required
                    />
                  </Field>
                ) : null}

                <Field>
                  <FieldLabel htmlFor="auth-email">邮箱</FieldLabel>
                  <div className="relative flex min-w-0">
                    <Input
                      id="auth-email"
                      className="pr-10"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                      required
                    />
                    {mode === "login" && rememberedAccounts.length > 0 ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="absolute top-1/2 right-1 -translate-y-1/2"
                              aria-label="选择记住的账户"
                            />
                          }
                        >
                          <ChevronDownIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>记住的账户</DropdownMenuLabel>
                            {rememberedAccounts.map((account) => (
                              <DropdownMenuItem
                                key={account.email}
                                onClick={() => selectAccount(account)}
                              >
                                <span className="flex min-w-0 flex-col">
                                  <span className="truncate">{account.name}</span>
                                  <span className="truncate text-xs text-muted-foreground">
                                    {account.email}
                                  </span>
                                </span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </Field>

                <Field>
                  <FieldLabel htmlFor="auth-password">密码</FieldLabel>
                  <Input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    required
                  />
                  {mode === "register" ? (
                    <FieldDescription>密码长度至少为 8 个字符。</FieldDescription>
                  ) : null}
                </Field>

                {mode === "register" ? (
                  <Field>
                    <FieldLabel htmlFor="auth-confirm-password">确认密码</FieldLabel>
                    <Input
                      id="auth-confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      autoComplete="new-password"
                      required
                    />
                  </Field>
                ) : null}

                {mode === "login" ? (
                  <div className="flex flex-wrap items-center justify-center gap-x-20 gap-y-2">
                    <label
                      className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
                      htmlFor="remember-login"
                    >
                      <Checkbox
                        id="remember-login"
                        checked={remember}
                        onCheckedChange={(checked) => {
                          setRemember(Boolean(checked));
                          if (!checked) setAutoLogin(false);
                        }}
                      />
                      记住我
                    </label>
                    <label
                      className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
                      htmlFor="auto-login"
                    >
                      <Checkbox
                        id="auto-login"
                        checked={autoLogin}
                        onCheckedChange={(checked) => {
                          const next = Boolean(checked);
                          setAutoLogin(next);
                          if (next) setRemember(true);
                        }}
                      />
                      自动登录
                    </label>
                  </div>
                ) : null}

                {error ? (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
                  {busy ? "请稍候..." : mode === "login" ? "登录" : "注册"}
                </Button>
                <FieldDescription className="text-center">
                  {mode === "login" ? "还没有账户？" : "已经有账户？"}{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-4"
                    onClick={() => switchMode(mode === "login" ? "register" : "login")}
                  >
                    {mode === "login" ? "立即注册" : "返回登录"}
                  </button>
                </FieldDescription>
              </FieldGroup>
            </form>
            <div className="relative hidden min-h-[480px] overflow-hidden bg-primary md:block">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_20%,hsl(var(--primary-foreground)/.25),transparent_38%),linear-gradient(140deg,hsl(var(--primary)),hsl(var(--primary)/.65))]" />
              <div className="relative flex h-full flex-col justify-between p-8 text-primary-foreground">
                <div className="text-sm font-medium tracking-[0.18em] uppercase">Mastrawork</div>
                <div className="max-w-xs space-y-3">
                  <p className="text-3xl font-semibold leading-tight">
                    把每一次工作，都留在你的空间里。
                  </p>
                  <p className="text-sm text-primary-foreground/75">
                    独立的会话、模型配置、资料库和使用统计，随账户一起安全保存。
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
        <p className="mt-4 px-6 text-center text-xs text-muted-foreground">
          登录即表示你同意 MastraWork 的服务条款和隐私政策。
        </p>
      </div>
    </main>
  );
}
