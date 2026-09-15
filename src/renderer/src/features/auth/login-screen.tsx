import { ChevronDownIcon, EyeIcon, EyeOffIcon, LogInIcon, UserPlusIcon } from "lucide-react";
import * as React from "react";
import { useTheme } from "@/shared/theme";
import { AnimatedThemeToggler } from "@/shared/ui/animated-theme-toggler";
import { Card, CardContent } from "@/shared/ui/card";
import { Checkbox } from "@/shared/ui/checkbox";
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/shared/ui/field";
import { HyperText } from "@/shared/ui/hyper-text";
import { Input } from "@/shared/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/shared/ui/input-group";
import { Meteors } from "@/shared/ui/meteors";
import { Particles } from "@/shared/ui/particles";
import { ShimmerButton } from "@/shared/ui/shimmer-button";
import { submitAuth as submitAuthRequest } from "./auth-api";
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
  const [showPassword, setShowPassword] = React.useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false);

  const { setMode: setThemeMode, isDark, activePreset } = useTheme();

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
    <main className="relative flex min-h-svh items-center justify-center bg-background p-4 sm:p-6 select-none">
      {/* 顶部右上角主题深浅色切换 */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <AnimatedThemeToggler
          theme={isDark ? "dark" : "light"}
          onThemeChange={(next) => setThemeMode(next)}
          className="size-9 rounded-xl border border-border bg-card/80 p-2 shadow-xs backdrop-blur-md hover:bg-accent text-foreground transition-colors cursor-pointer"
        />
      </div>

      <div className="w-full max-w-4xl">
        <Card className="overflow-hidden p-0 shadow-xl border-border bg-card text-card-foreground">
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
                  <InputGroup>
                    <InputGroupInput
                      id="auth-email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                      required
                    />
                    {mode === "login" && rememberedAccounts.length > 0 ? (
                      <InputGroupAddon align="inline-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <InputGroupButton
                                variant="ghost"
                                size="icon-xs"
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
                      </InputGroupAddon>
                    ) : null}
                  </InputGroup>
                </Field>

                <Field>
                  <FieldLabel htmlFor="auth-password">密码</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="auth-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      required
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        aria-label={showPassword ? "隐藏密码" : "显示密码"}
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => setShowPassword((show) => !show)}
                      >
                        {showPassword ? <EyeIcon /> : <EyeOffIcon />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  {mode === "register" ? (
                    <FieldDescription>密码长度至少为 8 个字符。</FieldDescription>
                  ) : null}
                </Field>

                {mode === "register" ? (
                  <Field>
                    <FieldLabel htmlFor="auth-confirm-password">确认密码</FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id="auth-confirm-password"
                        type={showConfirmPassword ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        autoComplete="new-password"
                        required
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          aria-label={showConfirmPassword ? "隐藏密码" : "显示密码"}
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => setShowConfirmPassword((show) => !show)}
                        >
                          {showConfirmPassword ? <EyeIcon /> : <EyeOffIcon />}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                ) : null}

                {mode === "login" ? (
                  <div className="flex flex-wrap items-center justify-center gap-x-20 gap-y-2">
                    <Field orientation="horizontal">
                      <Checkbox
                        id="remember-login"
                        checked={remember}
                        onCheckedChange={(checked) => {
                          setRemember(Boolean(checked));
                          if (!checked) setAutoLogin(false);
                        }}
                      />
                      <FieldLabel htmlFor="remember-login" className="font-normal">
                        记住我
                      </FieldLabel>
                    </Field>
                    <Field orientation="horizontal">
                      <Checkbox
                        id="auto-login"
                        checked={autoLogin}
                        onCheckedChange={(checked) => {
                          const next = Boolean(checked);
                          setAutoLogin(next);
                          if (next) setRemember(true);
                        }}
                      />
                      <FieldLabel htmlFor="auto-login" className="font-normal">
                        自动登录
                      </FieldLabel>
                    </Field>
                  </div>
                ) : null}

                {error ? <FieldError className="text-center">{error}</FieldError> : null}
                {/* 首要 CTA:金属扫光。颜色全部走主题 token,不用组件默认的黑底白字 */}
                <ShimmerButton
                  type="submit"
                  disabled={busy}
                  borderRadius="0.625rem"
                  shimmerDuration="2.6s"
                  shimmerColor="var(--primary-foreground)"
                  background="var(--primary)"
                  className="w-full gap-2 border-primary/20 py-2.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" /> : null}
                  {busy ? "请稍候..." : mode === "login" ? "登录" : "注册"}
                </ShimmerButton>
                <FieldDescription className="text-center">
                  {mode === "login" ? "还没有账户？" : "已经有账户？"}{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-4 cursor-pointer"
                    onClick={() => switchMode(mode === "login" ? "register" : "login")}
                  >
                    {mode === "login" ? "立即注册" : "返回登录"}
                  </button>
                </FieldDescription>
              </FieldGroup>
            </form>
            <div className="relative hidden min-h-[480px] overflow-hidden bg-primary md:block">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_20%,color-mix(in_oklch,var(--primary-foreground)_20%,transparent),transparent_40%),linear-gradient(140deg,var(--primary),color-mix(in_oklch,var(--primary)_70%,black))]" />
              {/* 品牌区环境层:粒子跟随光标、流星斜掠。登录后整屏卸载,无长期开销 */}
              <Particles
                className="pointer-events-none absolute inset-0"
                quantity={90}
                staticity={38}
                ease={60}
                size={0.5}
                color="#ffffff"
              />
              <Meteors
                className="pointer-events-none"
                number={12}
                minDelay={0.4}
                maxDelay={3.2}
                minDuration={3}
                maxDuration={9}
              />
              <div className="relative flex h-full flex-col justify-between p-8 text-primary-foreground">
                <div className="flex items-center justify-between text-sm font-medium tracking-[0.18em] uppercase">
                  {/* 品牌字解码:悬停时逐字符乱码收敛,呼应产品的"工程感" */}
                  <HyperText
                    as="span"
                    className="p-0 text-sm font-medium tracking-[0.18em] uppercase"
                    duration={700}
                    startOnView
                  >
                    Mastrawork
                  </HyperText>
                  {activePreset ? (
                    <span className="text-xs font-normal tracking-normal opacity-75">
                      {activePreset.name}
                    </span>
                  ) : null}
                </div>
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
