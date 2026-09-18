import {
  CheckIcon,
  CopyIcon,
  LaptopIcon,
  PaletteIcon,
  PanelLeftIcon,
  RotateCcwIcon,
  SearchIcon,
  SparklesIcon,
  TypeIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import type { ThemeColorTokens } from "@/shared/theme";
import { THEME_INSPIRATIONS, useTheme } from "@/shared/theme";
import { AnimatedThemeToggler } from "@/shared/ui/animated-theme-toggler";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/shared/ui/input-group";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/shared/ui/sidebar";
import { Slider } from "@/shared/ui/slider";

// 预设快速色彩选项
const getQuickColorSwatches = (t: (k: string) => string) => [
  { label: t("settings:themes.swatchBlack"), color: "#000000" },
  { label: t("settings:themes.swatchCarbon"), color: "#18181b" },
  { label: t("settings:themes.swatchBlazeOrange"), color: "#ff5400" },
  { label: t("settings:themes.swatchCyberYellow"), color: "#facc15" },
  { label: t("settings:themes.swatchVintageAmber"), color: "#d97706" },
  { label: t("settings:themes.swatchElectricBlue"), color: "#4f46e5" },
  { label: t("settings:themes.swatchNeonGreen"), color: "#22c55e" },
  { label: t("settings:themes.swatchNeonPink"), color: "#f43f5e" },
  { label: t("settings:themes.swatchGeekCyan"), color: "#06b6d4" },
  { label: t("settings:themes.swatchWarmWhite"), color: "#fefcf6" },
  { label: t("settings:themes.swatchPureWhite"), color: "#ffffff" },
];

interface ColorFieldProps {
  label: string;
  description: string;
  value: string;
  onChange: (val: string) => void;
  recommendedSwatches?: string[];
}

function ColorField({ label, description, value, onChange, recommendedSwatches }: ColorFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card/60 p-3 shadow-xs transition-colors hover:bg-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-semibold text-foreground">{label}</span>
          <span className="whitespace-normal break-words text-[11px] text-muted-foreground">
            {description}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <label
            className="relative flex size-6 cursor-pointer items-center justify-center rounded-md border shadow-xs overflow-hidden"
            style={{ backgroundColor: value }}
            title={t("settings:themes.colorPickTitle")}
          >
            <input
              type="color"
              value={value.startsWith("#") ? value : "#000000"}
              onChange={(e) => onChange(e.target.value)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-20 px-1.5 font-mono text-xs uppercase"
            maxLength={9}
          />
        </div>
      </div>
      {recommendedSwatches && recommendedSwatches.length > 0 ? (
        <div className="flex items-center gap-1 pt-1 overflow-x-auto">
          {recommendedSwatches.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              className={cn(
                "size-4 shrink-0 rounded-full border transition-transform hover:scale-125 focus-visible:outline-hidden",
                value.toLowerCase() === c.toLowerCase() && "ring-2 ring-primary ring-offset-1",
              )}
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ThemeSection() {
  const { t } = useTranslation();
  const {
    mode,
    setMode,
    activePresetId,
    activePreset,
    setPreset,
    presets,
    resolvedColors,
    resolvedGeometry,
    resolvedTypography,
    updateActiveCustomization,
    resetActiveCustomization,
    isDark,
  } = useTheme();

  const quickSwatches = React.useMemo(() => getQuickColorSwatches(t), [t]);
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<
    | "all"
    | "brutalism"
    | "clay_glass"
    | "scifi_dark"
    | "pixel_retro"
    | "oriental_desktop"
    | "modern"
  >("all");

  const filteredPresets = React.useMemo(() => {
    return presets.filter((p) => {
      const matchSearch =
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.englishName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.registrySource.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.description.toLowerCase().includes(searchQuery.toLowerCase());

      const matchCategory =
        categoryFilter === "all" ||
        (categoryFilter === "brutalism" &&
          (p.category === "brutalism" || p.category === "soft_brutalism")) ||
        (categoryFilter === "clay_glass" &&
          (p.category === "clay_glass" || p.category === "skeuomorphism")) ||
        (categoryFilter === "scifi_dark" && p.category === "scifi_dark") ||
        (categoryFilter === "pixel_retro" && p.category === "pixel_retro") ||
        (categoryFilter === "oriental_desktop" && p.category === "oriental_desktop") ||
        (categoryFilter === "modern" && p.category === "modern");

      return matchSearch && matchCategory;
    });
  }, [presets, searchQuery, categoryFilter]);

  const handleColorChange = (key: keyof ThemeColorTokens, val: string) => {
    if (isDark) {
      updateActiveCustomization({
        darkColors: { [key]: val },
      });
    } else {
      updateActiveCustomization({
        lightColors: { [key]: val },
      });
    }
  };

  const handleCopyThemeJson = () => {
    const payload = {
      preset: activePreset.id,
      name: activePreset.name,
      mode,
      geometry: resolvedGeometry,
      typography: resolvedTypography,
      colors: resolvedColors,
    };
    void navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast.success(t("settings:themes.copiedConfig"));
  };

  return (
    <div className="flex h-full flex-1 w-full min-h-0 min-w-0 overflow-hidden bg-background">
      {/* ========================================================================= */}
      {/* 左列: 主题选择列表侧边栏 (可收起为 Icon 状态) */}
      {/* ========================================================================= */}
      <aside
        data-state={sidebarOpen ? "expanded" : "collapsed"}
        data-collapsible={sidebarOpen ? "" : "icon"}
        data-slot="sidebar"
        data-sidebar="sidebar"
        className={cn(
          "group/sidebar group relative flex h-full min-h-0 flex-col border-r bg-sidebar transition-[width] duration-200 ease-linear overflow-hidden shrink-0",
          sidebarOpen ? "w-56 md:w-64" : "w-12",
        )}
      >
        <div className="flex h-full w-full min-h-0 shrink-0 flex-col">
          {/* 顶栏: 搜索与折叠切换 */}
          <div className="border-b border-sidebar-border p-2 shrink-0 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1.5 min-w-0 group-data-[collapsible=icon]/sidebar:hidden">
                <PaletteIcon className="size-4 text-primary shrink-0" />
                <span className="text-xs font-semibold truncate">
                  {t("settings:themes.selectStyle")}
                </span>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-7 shrink-0"
                onClick={() => setSidebarOpen(!sidebarOpen)}
                title={
                  sidebarOpen ? t("settings:themes.collapseList") : t("settings:themes.expandList")
                }
              >
                <PanelLeftIcon className="size-4" />
              </Button>
            </div>

            {sidebarOpen ? (
              <div className="space-y-1.5">
                <InputGroup className="h-7 bg-background">
                  <InputGroupAddon>
                    <SearchIcon className="size-3.5 text-muted-foreground" />
                  </InputGroupAddon>
                  <InputGroupInput
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t("settings:themes.searchPlaceholder")}
                    className="text-xs"
                  />
                </InputGroup>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="xs"
                    variant={categoryFilter === "all" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("all")}
                  >
                    {t("settings:themes.all")} ({presets.length})
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "brutalism" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("brutalism")}
                  >
                    {t("settings:themes.categories.brutalism")}
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "clay_glass" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("clay_glass")}
                  >
                    {t("settings:themes.categories.clay_glass")}
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "scifi_dark" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("scifi_dark")}
                  >
                    {t("settings:themes.categories.scifi_dark")}
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "pixel_retro" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("pixel_retro")}
                  >
                    {t("settings:themes.categories.pixel_retro")}
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "oriental_desktop" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("oriental_desktop")}
                  >
                    {t("settings:themes.categoryOrientalDesktop")}
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "modern" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("modern")}
                  >
                    {t("settings:themes.categoryModern")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {/* 主题列表 */}
          <ScrollArea className="min-h-0 flex-1 p-2">
            <SidebarMenu>
              {filteredPresets.map((preset) => {
                const isActive = activePresetId === preset.id;
                const colors = isDark ? preset.dark : preset.light;
                return (
                  <SidebarMenuItem key={preset.id}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setPreset(preset.id)}
                      tooltip={preset.name}
                      className={cn(
                        "h-auto py-2 px-2 flex-col items-start gap-1 cursor-pointer transition-colors",
                        isActive && "bg-sidebar-accent border border-sidebar-border shadow-xs",
                      )}
                    >
                      <div className="flex w-full items-center justify-between gap-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          {/* 缩略色块三色 Pill */}
                          <div
                            className="flex h-4 w-6 shrink-0 overflow-hidden rounded-xs border"
                            style={{ borderColor: colors.border }}
                          >
                            <span
                              className="w-1/3 h-full"
                              style={{ backgroundColor: colors.background }}
                            />
                            <span
                              className="w-1/3 h-full"
                              style={{ backgroundColor: colors.primary }}
                            />
                            <span
                              className="w-1/3 h-full"
                              style={{ backgroundColor: colors.accent }}
                            />
                          </div>
                          <span className="font-semibold text-xs truncate group-data-[collapsible=icon]/sidebar:hidden">
                            {preset.name}
                          </span>
                        </div>
                        {isActive ? (
                          <CheckIcon className="size-3.5 text-primary shrink-0 group-data-[collapsible=icon]/sidebar:hidden" />
                        ) : null}
                      </div>

                      <div className="flex w-full items-center justify-between gap-1 text-[11px] text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
                        <span className="truncate">{preset.englishName}</span>
                        <Badge
                          variant={preset.category === "brutalism" ? "default" : "secondary"}
                          className="h-4 text-[10px] px-1 font-mono shrink-0"
                        >
                          {preset.registrySource}
                        </Badge>
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </ScrollArea>

          {/* 底栏: 深色 / 浅色 / 跟随系统 快捷切换 */}
          <div className="border-t border-sidebar-border p-2 shrink-0 bg-sidebar-accent/30">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-medium text-muted-foreground group-data-[collapsible=icon]/sidebar:hidden">
                {t("settings:themes.colorMode")}
              </span>
              <div className="flex items-center gap-1 group-data-[collapsible=icon]/sidebar:mx-auto">
                <AnimatedThemeToggler
                  theme={isDark ? "dark" : "light"}
                  onThemeChange={setMode}
                  className="size-6 rounded-md p-1 border-transparent hover:border-sidebar-border"
                  title={t("settings:themes.viewportToggleTitle")}
                />
                <Button
                  size="icon-xs"
                  variant={mode === "system" ? "default" : "ghost"}
                  onClick={() => setMode("system")}
                  title={t("settings:themes.followSystem")}
                  className="size-6"
                >
                  <LaptopIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* ========================================================================= */}
      {/* 右列: 当前主题详细调参面板 + 实时交互预览沙盒 */}
      {/* ========================================================================= */}
      <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-background">
        {/* 顶部标题栏与快捷操作 */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b bg-muted/20 px-4">
          <div className="flex items-center gap-2 min-w-0">
            {!sidebarOpen ? (
              <Button
                size="icon-sm"
                variant="ghost"
                className="-ml-1"
                onClick={() => setSidebarOpen(true)}
                title={t("settings:themes.expandList")}
              >
                <PanelLeftIcon />
              </Button>
            ) : null}
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold truncate text-foreground">
                {activePreset.name}
              </span>
              <Badge variant="outline" className="text-xs">
                {activePreset.categoryLabel}
              </Badge>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="xs"
              variant="outline"
              onClick={resetActiveCustomization}
              title={t("settings:themes.resetDefaultTitle")}
              className="gap-1 text-xs"
            >
              <RotateCcwIcon className="size-3.5" />
              {t("settings:themes.resetDefault")}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={handleCopyThemeJson}
              title={t("settings:themes.copyConfigTitle")}
              className="gap-1 text-xs"
            >
              <CopyIcon className="size-3.5" />
              {t("settings:themes.copyConfig")}
            </Button>
          </div>
        </header>

        {/* 调参主滚动区:卡片自适应铺满整个宽度,不再限宽留白 */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 px-4 pt-3 pb-6">
            {/* ------------------------------------------------------------- */}
            {/* 模块 1: 几何形态与空间尺度 (圆角 / 边框厚度 / 硬阴影) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">
                  {t("settings:themes.geometryTitle")}
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("settings:themes.geometryDesc")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-4 pb-4">
                {/* 1. 圆角 Radius */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">
                      {t("settings:themes.radiusTitle")}
                    </span>
                    <span className="font-mono text-primary font-bold tabular-nums">
                      {resolvedGeometry.radius} {t("settings:themes.pixelUnit")}
                    </span>
                  </div>
                  <Slider
                    value={[resolvedGeometry.radius]}
                    min={0}
                    max={20}
                    step={1}
                    onValueChange={(val) =>
                      updateActiveCustomization({
                        geometry: { radius: val[0] },
                      })
                    }
                    className="py-1"
                  />
                  <div className="flex items-center gap-1 pt-1 overflow-x-auto">
                    {[
                      { label: t("settings:themes.radius0"), val: 0 },
                      { label: t("settings:themes.radius4"), val: 4 },
                      { label: t("settings:themes.radius6"), val: 6 },
                      { label: t("settings:themes.radius10"), val: 10 },
                      { label: t("settings:themes.radius14"), val: 14 },
                      { label: t("settings:themes.radius18"), val: 18 },
                    ].map((item) => (
                      <Button
                        key={item.val}
                        size="xs"
                        variant={resolvedGeometry.radius === item.val ? "default" : "outline"}
                        className="h-6 text-[11px] px-2 shrink-0"
                        onClick={() =>
                          updateActiveCustomization({
                            geometry: { radius: item.val },
                          })
                        }
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* 2. 边框厚度 Border Width */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">
                      {t("settings:themes.borderWidthTitle")}
                    </span>
                    <span className="font-mono text-primary font-bold tabular-nums">
                      {resolvedGeometry.borderWidth} {t("settings:themes.pixelUnit")}
                    </span>
                  </div>
                  <Slider
                    value={[resolvedGeometry.borderWidth]}
                    min={1}
                    max={3.5}
                    step={0.5}
                    onValueChange={(val) =>
                      updateActiveCustomization({
                        geometry: { borderWidth: val[0] },
                      })
                    }
                    className="py-1"
                  />
                  <div className="flex items-center gap-1 pt-1 overflow-x-auto">
                    {[
                      { label: t("settings:themes.border1"), val: 1 },
                      { label: t("settings:themes.border15"), val: 1.5 },
                      { label: t("settings:themes.border2"), val: 2 },
                      { label: t("settings:themes.border25"), val: 2.5 },
                      { label: t("settings:themes.border3"), val: 3 },
                    ].map((item) => (
                      <Button
                        key={item.val}
                        size="xs"
                        variant={resolvedGeometry.borderWidth === item.val ? "default" : "outline"}
                        className="h-6 text-[11px] px-2 shrink-0"
                        onClick={() =>
                          updateActiveCustomization({
                            geometry: { borderWidth: item.val },
                          })
                        }
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* 3. 实体硬阴影深度 Shadow Depth */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">
                      {t("settings:themes.shadowDepthTitle")}
                    </span>
                    <span className="font-mono text-primary font-bold tabular-nums">
                      {resolvedGeometry.shadowDepth} {t("settings:themes.pixelUnit")}
                    </span>
                  </div>
                  <Slider
                    value={[resolvedGeometry.shadowDepth]}
                    min={0}
                    max={6}
                    step={1}
                    onValueChange={(val) =>
                      updateActiveCustomization({
                        geometry: { shadowDepth: val[0] },
                      })
                    }
                    className="py-1"
                  />
                  <div className="flex items-center gap-1 pt-1 overflow-x-auto">
                    {[
                      { label: t("settings:themes.shadow0"), val: 0 },
                      { label: t("settings:themes.shadow2"), val: 2 },
                      { label: t("settings:themes.shadow3"), val: 3 },
                      { label: t("settings:themes.shadow4"), val: 4 },
                      { label: t("settings:themes.shadow6"), val: 6 },
                    ].map((item) => (
                      <Button
                        key={item.val}
                        size="xs"
                        variant={resolvedGeometry.shadowDepth === item.val ? "default" : "outline"}
                        className="h-6 text-[11px] px-2 shrink-0"
                        onClick={() =>
                          updateActiveCustomization({
                            geometry: { shadowDepth: item.val },
                          })
                        }
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ------------------------------------------------------------- */}
            {/* 模块 2: 字体排版与文字规范 (Typography System) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <TypeIcon className="size-4 text-primary" />
                    <span>{t("settings:themes.typographyTitle")}</span>
                  </div>
                  <Badge variant="outline" className="text-xs font-mono">
                    {activePreset.typography.headingWeight} Weight |{" "}
                    {activePreset.typography.letterSpacing}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("settings:themes.typographyDesc")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-4 pb-4">
                {/* 字体栈选择 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">
                      {t("settings:themes.sansFontStackTitle")}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground truncate max-w-[200px]">
                      {resolvedTypography.fontSans.split(",")[0]}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1">
                    {[
                      {
                        label: t("settings:themes.fonts.spaceGrotesk"),
                        sans: '"Space Grotesk", "Public Sans", "Inter", -apple-system, sans-serif',
                        mono: '"Space Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.bricolage"),
                        sans: '"Bricolage Grotesque", "Plus Jakarta Sans", -apple-system, sans-serif',
                        mono: '"Space Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.orbitron"),
                        sans: '"Orbitron", "Rajdhani", "Space Grotesk", sans-serif',
                        mono: '"Space Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.cormorant"),
                        sans: '"Cormorant Garamond", "Cinzel", Georgia, serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.pressStart"),
                        sans: '"Press Start 2P", "Silkscreen", "Space Mono", monospace',
                        mono: '"Press Start 2P", "Space Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.vt323"),
                        sans: '"VT323", "Silkscreen", "Space Mono", monospace',
                        mono: '"VT323", "Space Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.notoSerif"),
                        sans: '"Noto Serif SC", "Songti SC", "Cormorant Garamond", serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.shippori"),
                        sans: '"Shippori Mincho", "Noto Serif SC", serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.nunito"),
                        sans: '"Nunito", "Plus Jakarta Sans", -apple-system, sans-serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.sfPro"),
                        sans: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Plus Jakarta Sans", "Inter", system-ui, sans-serif',
                        mono: '"SF Mono", "JetBrains Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.plusJakarta"),
                        sans: '"Plus Jakarta Sans", "Inter", -apple-system, sans-serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: t("settings:themes.fonts.helvetica"),
                        sans: '"Helvetica Neue", "Lucida Grande", "Segoe UI", Arial, sans-serif',
                        mono: 'Consolas, "Courier New", monospace',
                      },
                    ].map((item) => (
                      <Button
                        key={item.label}
                        size="xs"
                        variant={resolvedTypography.fontSans === item.sans ? "default" : "outline"}
                        className="h-7 text-[11px] px-2 truncate justify-start"
                        onClick={() =>
                          updateActiveCustomization({
                            typography: {
                              fontSans: item.sans,
                              fontMono: item.mono,
                            },
                          })
                        }
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* 标题字重 & 字符间距 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-2.5">
                    <span className="text-xs font-medium text-foreground">
                      {t("settings:themes.headingWeightTitle")}
                    </span>
                    <div className="flex items-center gap-1">
                      {[
                        { label: t("settings:themes.weight600"), val: "600" },
                        { label: t("settings:themes.weight700"), val: "700" },
                        { label: t("settings:themes.weight800"), val: "800" },
                      ].map((item) => (
                        <Button
                          key={item.val}
                          size="xs"
                          variant={
                            resolvedTypography.headingWeight === item.val ? "default" : "outline"
                          }
                          className="h-6 text-[11px] px-2 flex-1"
                          onClick={() =>
                            updateActiveCustomization({
                              typography: { headingWeight: item.val },
                            })
                          }
                        >
                          {item.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-2.5">
                    <span className="text-xs font-medium text-foreground">
                      {t("settings:themes.letterSpacingTitle")}
                    </span>
                    <div className="flex items-center gap-1">
                      {[
                        { label: t("settings:themes.spacingTight"), val: "-0.03em" },
                        { label: t("settings:themes.spacingCompact"), val: "-0.015em" },
                        { label: t("settings:themes.spacingNormal"), val: "0" },
                        { label: t("settings:themes.spacingLoose"), val: "0.01em" },
                      ].map((item) => (
                        <Button
                          key={item.val}
                          size="xs"
                          variant={
                            resolvedTypography.letterSpacing === item.val ? "default" : "outline"
                          }
                          className="h-6 text-[11px] px-1.5 flex-1"
                          onClick={() =>
                            updateActiveCustomization({
                              typography: { letterSpacing: item.val },
                            })
                          }
                        >
                          {item.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ------------------------------------------------------------- */}
            {/* 模块 3: 调色板灵感预设 (1-Click Color Presets) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                  <SparklesIcon className="size-4 text-primary" />
                  <span>{t("settings:themes.colorPaletteTitle")}</span>
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("settings:themes.colorPaletteDesc")}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 px-4 pb-4">
                {THEME_INSPIRATIONS.map((insp) => (
                  <button
                    key={insp.id}
                    type="button"
                    onClick={() => {
                      if (isDark) {
                        updateActiveCustomization({
                          darkColors: {
                            primary: insp.primary,
                            secondary: insp.secondary,
                            accent: insp.accent,
                            ...(insp.border ? { border: insp.border } : {}),
                          },
                        });
                      } else {
                        updateActiveCustomization({
                          lightColors: {
                            primary: insp.primary,
                            secondary: insp.secondary,
                            accent: insp.accent,
                            ...(insp.border ? { border: insp.border } : {}),
                          },
                        });
                      }
                      toast.success(t("settings:themes.appliedPalette", { name: insp.name }));
                    }}
                    className="flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-left transition-all hover:border-primary hover:shadow-xs focus-visible:outline-hidden"
                  >
                    <div className="flex h-5 w-full overflow-hidden rounded-md border">
                      <span className="w-1/3 h-full" style={{ backgroundColor: insp.primary }} />
                      <span className="w-1/3 h-full" style={{ backgroundColor: insp.secondary }} />
                      <span className="w-1/3 h-full" style={{ backgroundColor: insp.accent }} />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold">{insp.name}</span>
                      <span className="whitespace-normal break-words text-[10px] text-muted-foreground">
                        {insp.description}
                      </span>
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* ------------------------------------------------------------- */}
            {/* 模块 3: 核心色彩精细调控 (Fine-Grained Color Tuning) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <span>
                    {t("settings:themes.colorTuningTitle", {
                      mode: isDark ? t("settings:themes.modeDark") : t("settings:themes.modeLight"),
                    })}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {t("settings:themes.liveEffective")}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("settings:themes.colorTuningDesc")}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-4 pb-4">
                <ColorField
                  label={t("settings:themes.tokenPrimary")}
                  description={t("settings:themes.tokenPrimaryDesc")}
                  value={resolvedColors.primary}
                  onChange={(v) => handleColorChange("primary", v)}
                  recommendedSwatches={quickSwatches.map((s) => s.color)}
                />
                <ColorField
                  label={t("settings:themes.tokenSecondary")}
                  description={t("settings:themes.tokenSecondaryDesc")}
                  value={resolvedColors.secondary}
                  onChange={(v) => handleColorChange("secondary", v)}
                  recommendedSwatches={quickSwatches.map((s) => s.color)}
                />
                <ColorField
                  label={t("settings:themes.tokenAccent")}
                  description={t("settings:themes.tokenAccentDesc")}
                  value={resolvedColors.accent}
                  onChange={(v) => handleColorChange("accent", v)}
                  recommendedSwatches={quickSwatches.map((s) => s.color)}
                />
                <ColorField
                  label={t("settings:themes.tokenBorder")}
                  description={t("settings:themes.tokenBorderDesc")}
                  value={resolvedColors.border}
                  onChange={(v) => {
                    handleColorChange("border", v);
                    handleColorChange("sidebarBorder", v);
                  }}
                  recommendedSwatches={[
                    "#000000",
                    "#09090b",
                    "#1c1917",
                    "#27272a",
                    "#facc15",
                    "#ff5400",
                    "#e5e5e5",
                  ]}
                />
                <ColorField
                  label={t("settings:themes.tokenBackground")}
                  description={t("settings:themes.tokenBackgroundDesc")}
                  value={resolvedColors.background}
                  onChange={(v) => {
                    handleColorChange("background", v);
                    handleColorChange("card", v);
                    handleColorChange("popover", v);
                  }}
                  recommendedSwatches={[
                    "#ffffff",
                    "#fefcf6",
                    "#fffdfa",
                    "#faf6ee",
                    "#f8fafc",
                    "#121212",
                    "#09090b",
                    "#161311",
                  ]}
                />
                <ColorField
                  label={t("settings:themes.tokenForeground")}
                  description={t("settings:themes.tokenForegroundDesc")}
                  value={resolvedColors.foreground}
                  onChange={(v) => {
                    handleColorChange("foreground", v);
                    handleColorChange("cardForeground", v);
                    handleColorChange("popoverForeground", v);
                  }}
                  recommendedSwatches={[
                    "#000000",
                    "#171717",
                    "#09090b",
                    "#1c1917",
                    "#ffffff",
                    "#fafafa",
                    "#f4f4f5",
                  ]}
                />
                <ColorField
                  label={t("settings:themes.tokenSidebar")}
                  description={t("settings:themes.tokenSidebarDesc")}
                  value={resolvedColors.sidebar}
                  onChange={(v) => handleColorChange("sidebar", v)}
                  recommendedSwatches={[
                    "#fafafa",
                    "#faf3e0",
                    "#fdf8e6",
                    "#f3ecde",
                    "#f1f5f9",
                    "#18181b",
                    "#0b0b0d",
                    "#050507",
                  ]}
                />
                <ColorField
                  label={t("settings:themes.tokenDestructive")}
                  description={t("settings:themes.tokenDestructiveDesc")}
                  value={resolvedColors.destructive}
                  onChange={(v) => handleColorChange("destructive", v)}
                  recommendedSwatches={["#ef4444", "#dc2626", "#e11d48", "#f43f5e", "#f87171"]}
                />
              </CardContent>
            </Card>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
