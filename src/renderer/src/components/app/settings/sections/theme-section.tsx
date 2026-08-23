import {
  CheckIcon,
  CopyIcon,
  FlameIcon,
  LaptopIcon,
  PaletteIcon,
  PanelLeftIcon,
  RotateCcwIcon,
  SearchIcon,
  SparklesIcon,
  TypeIcon,
  Wand2Icon,
  ZapIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTheme } from "@/components/theme-provider";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { AnimatedGradientText } from "@/components/ui/animated-gradient-text";
import { AnimatedChevron } from "@/components/ui/animated-icon";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import {
  AnimatedThemeToggler,
  type AnimatedThemeTogglerVariant,
} from "@/components/ui/animated-theme-toggler";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DotPattern } from "@/components/ui/dot-pattern";
import { Dotm3x3_1 } from "@/components/ui/dotm-3x3-1";
import { Dotm3x3_6 } from "@/components/ui/dotm-3x3-6";
import { Dotm3x3_11 } from "@/components/ui/dotm-3x3-11";
import { DotmCircular4 } from "@/components/ui/dotm-circular-4";
import { DotmCircular5 } from "@/components/ui/dotm-circular-5";
import { DotmHex1 } from "@/components/ui/dotm-hex-1";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import { DotmSquare10 } from "@/components/ui/dotm-square-10";
import { DotmSquare18 } from "@/components/ui/dotm-square-18";
import { DotmTriangle2 } from "@/components/ui/dotm-triangle-2";
import { HyperText } from "@/components/ui/hyper-text";
import { Input } from "@/components/ui/input";
import { InteractiveHoverButton } from "@/components/ui/interactive-hover-button";
import { MagicCard } from "@/components/ui/magic-card";
import { Meteors } from "@/components/ui/meteors";
import { NeonGradientCard } from "@/components/ui/neon-gradient-card";
import { OrbitingCircles } from "@/components/ui/orbiting-circles";
import { PulsatingButton } from "@/components/ui/pulsating-button";
import { RainbowButton } from "@/components/ui/rainbow-button";
import { Ripple } from "@/components/ui/ripple";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Slider } from "@/components/ui/slider";
import { SlidingNumber } from "@/components/ui/sliding-number";
import { SparklesText } from "@/components/ui/sparkles-text";
import { THEME_INSPIRATIONS } from "@/lib/theme/presets";
import type { ThemeColorTokens } from "@/lib/theme/types";
import { cn } from "@/lib/utils";

// 预设快速色彩选项
const QUICK_COLOR_SWATCHES = [
  { label: "纯黑", color: "#000000" },
  { label: "碳灰", color: "#18181b" },
  { label: "烈焰橙", color: "#ff5400" },
  { label: "赛博黄", color: "#facc15" },
  { label: "复古琥珀", color: "#d97706" },
  { label: "电光蓝", color: "#4f46e5" },
  { label: "荧光绿", color: "#22c55e" },
  { label: "霓虹粉", color: "#f43f5e" },
  { label: "极客青", color: "#06b6d4" },
  { label: "纸面暖白", color: "#fefcf6" },
  { label: "纯白", color: "#ffffff" },
];

interface ColorFieldProps {
  label: string;
  description: string;
  value: string;
  onChange: (val: string) => void;
  recommendedSwatches?: string[];
}

function ColorField({ label, description, value, onChange, recommendedSwatches }: ColorFieldProps) {
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
            title="选择颜色"
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

  const [animateCounter, setAnimateCounter] = React.useState(1420);
  const [activeAnimateTab, setActiveAnimateTab] = React.useState("tab-1");
  const [animateCollapseOpen, setAnimateCollapseOpen] = React.useState(true);
  const [togglerVariant, setTogglerVariant] = React.useState<AnimatedThemeTogglerVariant>("circle");

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
    toast.success("主题配置已复制到剪贴板");
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
          "group/sidebar relative flex h-full min-h-0 flex-col border-r bg-sidebar transition-[width] duration-200 ease-linear overflow-hidden shrink-0",
          sidebarOpen ? "w-56 md:w-64" : "w-12",
        )}
      >
        <div className="flex h-full w-full min-h-0 shrink-0 flex-col">
          {/* 顶栏: 搜索与折叠切换 */}
          <div className="border-b border-sidebar-border p-2 shrink-0 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1.5 min-w-0 group-data-[collapsible=icon]/sidebar:hidden">
                <PaletteIcon className="size-4 text-primary shrink-0" />
                <span className="text-xs font-semibold truncate">选择主题风格</span>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-7 shrink-0"
                onClick={() => setSidebarOpen(!sidebarOpen)}
                title={sidebarOpen ? "收起主题列表" : "展开主题列表"}
              >
                <PanelLeftIcon className="size-4" />
              </Button>
            </div>

            {sidebarOpen ? (
              <div className="space-y-1.5">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索主题或库..."
                    className="h-7 bg-background pl-7 text-xs"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="xs"
                    variant={categoryFilter === "all" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("all")}
                  >
                    全部 ({presets.length})
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "brutalism" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("brutalism")}
                  >
                    粗野
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "clay_glass" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("clay_glass")}
                  >
                    拟物/玻璃
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "scifi_dark" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("scifi_dark")}
                  >
                    科幻/发光
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "pixel_retro" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("pixel_retro")}
                  >
                    像素/游戏
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "oriental_desktop" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("oriental_desktop")}
                  >
                    东方/桌面
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "modern" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-1.5"
                    onClick={() => setCategoryFilter("modern")}
                  >
                    极简
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
                色彩模式
              </span>
              <div className="flex items-center gap-1 group-data-[collapsible=icon]/sidebar:mx-auto">
                <AnimatedThemeToggler
                  variant={togglerVariant}
                  theme={isDark ? "dark" : "light"}
                  onThemeChange={setMode}
                  className="size-6 rounded-md p-1 border-transparent hover:border-sidebar-border"
                  title="使用 Magic UI 视口流光切换深浅色"
                />
                <Button
                  size="icon-xs"
                  variant={mode === "system" ? "default" : "ghost"}
                  onClick={() => setMode("system")}
                  title="跟随系统"
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
                title="展开主题列表"
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
              <Badge variant="secondary" className="text-xs font-mono">
                {activePreset.registrySource}
              </Badge>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="xs"
              variant="outline"
              onClick={resetActiveCustomization}
              title="重置当前主题自定义参数为默认值"
              className="gap-1 text-xs"
            >
              <RotateCcwIcon className="size-3.5" />
              恢复默认
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={handleCopyThemeJson}
              title="复制当前主题完整 Token JSON"
              className="gap-1 text-xs"
            >
              <CopyIcon className="size-3.5" />
              复制配置
            </Button>
          </div>
        </header>

        {/* 调参主滚动区 */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 max-w-3xl pb-6">
            {/* ------------------------------------------------------------- */}
            {/* 模块 1: 几何形态与空间尺度 (圆角 / 边框厚度 / 硬阴影) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <span>几何形态与空间尺度</span>
                  <span className="text-xs text-muted-foreground font-normal font-mono">
                    R:{resolvedGeometry.radius}px | B:{resolvedGeometry.borderWidth}px | S:
                    {resolvedGeometry.shadowDepth}px
                  </span>
                </CardTitle>
                <CardDescription className="text-xs">
                  精确调整全系统圆角曲率、粗野主义描边粗细与立体实体投影深度。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-4 pb-4">
                {/* 1. 圆角 Radius */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">基础圆角半径 (Radius)</span>
                    <span className="font-mono text-primary font-bold tabular-nums">
                      {resolvedGeometry.radius} px
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
                      { label: "0px 直角", val: 0 },
                      { label: "4px 紧凑", val: 4 },
                      { label: "6px 标准", val: 6 },
                      { label: "10px 柔和", val: 10 },
                      { label: "14px 粗野", val: 14 },
                      { label: "18px 胶囊", val: 18 },
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
                    <span className="font-medium text-foreground">边框描边粗细 (Border Width)</span>
                    <span className="font-mono text-primary font-bold tabular-nums">
                      {resolvedGeometry.borderWidth} px
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
                      { label: "1px 极简细线", val: 1 },
                      { label: "1.5px 柔和", val: 1.5 },
                      { label: "2px 粗野标准", val: 2 },
                      { label: "2.5px 加厚", val: 2.5 },
                      { label: "3px 重度粗野", val: 3 },
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
                      实体硬阴影深度 (Hard Shadow Offset)
                    </span>
                    <span className="font-mono text-primary font-bold tabular-nums">
                      {resolvedGeometry.shadowDepth} px
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
                      { label: "0px 无硬阴影", val: 0 },
                      { label: "2px 微立体", val: 2 },
                      { label: "3px 粗野标准", val: 3 },
                      { label: "4px 经典立柱", val: 4 },
                      { label: "6px 夸张浮雕", val: 6 },
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
                    <span>字体排版与文字规范</span>
                  </div>
                  <Badge variant="outline" className="text-xs font-mono">
                    {activePreset.typography.headingWeight} Weight |{" "}
                    {activePreset.typography.letterSpacing}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  官方字体栈与文字层级规范，即时渲染专属字符间距、标题字重与排版韵律。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-4 pb-4">
                {/* 字体栈选择 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">
                      无衬线字体栈 (Sans-Serif Font Stack)
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground truncate max-w-[200px]">
                      {resolvedTypography.fontSans.split(",")[0]}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1">
                    {[
                      {
                        label: "Space Grotesk (粗野新潮)",
                        sans: '"Space Grotesk", "Public Sans", "Inter", -apple-system, sans-serif',
                        mono: '"Space Mono", monospace',
                      },
                      {
                        label: "Bricolage (复古粗野)",
                        sans: '"Bricolage Grotesque", "Plus Jakarta Sans", -apple-system, sans-serif',
                        mono: '"Space Mono", monospace',
                      },
                      {
                        label: "Orbitron (科幻HUD)",
                        sans: '"Orbitron", "Rajdhani", "Space Grotesk", sans-serif',
                        mono: '"Space Mono", monospace',
                      },
                      {
                        label: "Cormorant (文学衬线)",
                        sans: '"Cormorant Garamond", "Cinzel", Georgia, serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: "Press Start (8位像素)",
                        sans: '"Press Start 2P", "Silkscreen", "Space Mono", monospace',
                        mono: '"Press Start 2P", "Space Mono", monospace',
                      },
                      {
                        label: "VT323 (复古终端)",
                        sans: '"VT323", "Silkscreen", "Space Mono", monospace',
                        mono: '"VT323", "Space Mono", monospace',
                      },
                      {
                        label: "Noto Serif (和纸宋体)",
                        sans: '"Noto Serif SC", "Songti SC", "Cormorant Garamond", serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: "Shippori (日系明朝)",
                        sans: '"Shippori Mincho", "Noto Serif SC", serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: "Nunito (黏土软体)",
                        sans: '"Nunito", "Plus Jakarta Sans", -apple-system, sans-serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: "SF Pro / Apple (苹果玻璃)",
                        sans: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Plus Jakarta Sans", "Inter", system-ui, sans-serif',
                        mono: '"SF Mono", "JetBrains Mono", monospace',
                      },
                      {
                        label: "Plus Jakarta (现代清爽)",
                        sans: '"Plus Jakarta Sans", "Inter", -apple-system, sans-serif',
                        mono: '"JetBrains Mono", monospace',
                      },
                      {
                        label: "Helvetica (经典拟物)",
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
                      标题字重 (Heading Weight)
                    </span>
                    <div className="flex items-center gap-1">
                      {[
                        { label: "600 半粗", val: "600" },
                        { label: "700 经典粗体", val: "700" },
                        { label: "800 极度黑体", val: "800" },
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
                      字符间距 (Letter Spacing)
                    </span>
                    <div className="flex items-center gap-1">
                      {[
                        { label: "-0.03em 紧绷", val: "-0.03em" },
                        { label: "-0.015em 紧凑", val: "-0.015em" },
                        { label: "0 标准", val: "0" },
                        { label: "+0.01em 宽松", val: "0.01em" },
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
                  <span>调色板灵感配方</span>
                </CardTitle>
                <CardDescription className="text-xs">
                  一键为当前主题注入专业设计师精选的粗野主义高对比撞色方案。
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
                      toast.success(`已应用「${insp.name}」配色方案`);
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
                  <span>色彩精确调控 ({isDark ? "暗色模式" : "浅色模式"})</span>
                  <Badge variant="outline" className="text-xs">
                    实时生效
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  直接修改当前状态下的各项颜色 Token，支持取色器、HEX 文本与快捷调色点。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-4 pb-4">
                <ColorField
                  label="主色 (Primary)"
                  description="主按钮、活动指示器、重点强调"
                  value={resolvedColors.primary}
                  onChange={(v) => handleColorChange("primary", v)}
                  recommendedSwatches={QUICK_COLOR_SWATCHES.map((s) => s.color)}
                />
                <ColorField
                  label="次色 (Secondary)"
                  description="次级按钮、标签底色、辅助模块"
                  value={resolvedColors.secondary}
                  onChange={(v) => handleColorChange("secondary", v)}
                  recommendedSwatches={QUICK_COLOR_SWATCHES.map((s) => s.color)}
                />
                <ColorField
                  label="强调色 (Accent)"
                  description="霓虹点缀色、高亮提示、微光"
                  value={resolvedColors.accent}
                  onChange={(v) => handleColorChange("accent", v)}
                  recommendedSwatches={QUICK_COLOR_SWATCHES.map((s) => s.color)}
                />
                <ColorField
                  label="边框轮廓 (Border)"
                  description="粗野主义关键纯黑/亮色外框"
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
                  label="画布背景 (Background)"
                  description="主工作台底色、文档区域"
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
                  label="文字前景 (Foreground)"
                  description="主要正文文字、标题文本"
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
                  label="侧边栏背景 (Sidebar)"
                  description="左侧导航底色、工作区垫底层"
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
                  label="危险告警 (Destructive)"
                  description="删除操作、错误状态、警示标签"
                  value={resolvedColors.destructive}
                  onChange={(v) => handleColorChange("destructive", v)}
                  recommendedSwatches={["#ef4444", "#dc2626", "#e11d48", "#f43f5e", "#f87171"]}
                />
              </CardContent>
            </Card>

            {/* ------------------------------------------------------------- */}
            {/* 模块 4: Magic UI 动效与全套视觉特效矩阵 (Magic UI Motion Matrix) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs overflow-hidden relative">
              <DotPattern className="opacity-40" />
              <CardHeader className="pb-3 pt-4 px-4 relative z-10">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <SparklesIcon className="size-4 text-primary" />
                    <span>Magic UI 动效与特效交互展台</span>
                  </div>
                  <Badge variant="secondary" className="text-xs font-mono">
                    16 官方动效组件实时联动
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  所有按钮、光效、粒子与流体卡片实时响应当前激活的主题风格与调色板 Tokens。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-4 pb-4 relative z-10">
                {/* 1. 动效文字与字符重组 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-background/80 backdrop-blur-xs p-3">
                  <span className="text-xs font-medium text-foreground">
                    文字特效 (Text Motion & Reveal)
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                    <div className="flex items-center justify-center p-2 rounded-md border bg-muted/20">
                      <AnimatedShinyText shimmerWidth={120} className="text-xs font-semibold">
                        ✨ 实时文字扫光高亮
                      </AnimatedShinyText>
                    </div>
                    <div className="flex items-center justify-center p-2 rounded-md border bg-muted/20">
                      <SparklesText text="星芒闪烁文字" className="text-xs font-bold" />
                    </div>
                    <div className="flex items-center justify-center p-2 rounded-md border bg-muted/20">
                      <HyperText
                        text="CYBER_DECRYPT_01"
                        className="text-xs text-primary font-mono"
                      />
                    </div>
                  </div>
                </div>

                {/* 2. 动效按钮与交互触感 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-background/80 backdrop-blur-xs p-3">
                  <span className="text-xs font-medium text-foreground">
                    高光按钮与微交互 (Action Buttons)
                  </span>
                  <div className="flex flex-wrap items-center gap-3">
                    <ShimmerButton
                      shimmerColor="rgba(255, 255, 255, 0.8)"
                      className="text-xs py-2 px-4 shadow-md"
                    >
                      <SparklesIcon className="size-3.5 mr-1.5" />
                      Shimmer 金属扫光
                    </ShimmerButton>

                    <RainbowButton className="text-xs h-8 px-4">
                      <ZapIcon className="size-3.5 mr-1.5" />
                      Rainbow 彩虹流光
                    </RainbowButton>

                    <InteractiveHoverButton className="text-xs py-1.5 px-4 h-8">
                      探索工作流
                    </InteractiveHoverButton>

                    <PulsatingButton duration="2s" className="text-xs py-1.5 px-3.5 h-8">
                      <FlameIcon className="size-3.5 mr-1" />
                      呼吸脉冲
                    </PulsatingButton>
                  </div>

                  {/* Animated Theme Toggler 视口转场形态选择 */}
                  <div className="mt-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-t pt-2.5">
                    <div className="flex items-center gap-2">
                      <AnimatedThemeToggler
                        variant={togglerVariant}
                        showLabel
                        theme={isDark ? "dark" : "light"}
                        onThemeChange={setMode}
                        className="h-8 shadow-xs"
                      />
                      <span className="text-xs text-muted-foreground font-mono">
                        Shape: {togglerVariant}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      {(
                        [
                          "circle",
                          "star",
                          "diamond",
                          "triangle",
                          "hexagon",
                          "square",
                          "rectangle",
                        ] as AnimatedThemeTogglerVariant[]
                      ).map((shape) => (
                        <Button
                          key={shape}
                          size="xs"
                          variant={togglerVariant === shape ? "default" : "outline"}
                          className="h-6 text-[10px] px-1.5 capitalize font-mono"
                          onClick={() => setTogglerVariant(shape)}
                        >
                          {shape}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 3. 探照灯光晕卡片与霓虹流光 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <MagicCard
                    gradientSize={180}
                    gradientFrom="var(--primary)"
                    gradientTo="var(--accent)"
                    className="p-4 flex flex-col justify-between min-h-[110px]"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">MagicCard 鼠标探照灯</span>
                      <Wand2Icon className="size-4 text-primary" />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      移动鼠标即可看到随光标动态游走的主题色彩放射光斑。
                    </p>
                  </MagicCard>

                  <div className="relative min-h-[110px]">
                    <NeonGradientCard borderRadius={8} borderSize={1.5} className="min-h-[110px]">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold">NeonGradient 霓虹发光</span>
                        <Badge variant="outline" className="text-[10px]">
                          360° 旋转
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        绚丽的双色霓虹流体外边框与环境弥散柔光。
                      </p>
                    </NeonGradientCard>
                  </div>
                </div>

                {/* 4. 环境粒子、轨道与涟漪 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-background/80 backdrop-blur-xs p-3">
                  <span className="text-xs font-medium text-foreground">
                    环境粒子与轨道 (Ambient Particles & Orbit)
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="relative overflow-hidden rounded-md border bg-muted/20 min-h-[110px]">
                      <Meteors number={10} />
                      <OrbitingCircles radius={26} duration={16} delay={2}>
                        <SparklesIcon className="size-3 text-primary" />
                      </OrbitingCircles>
                      <OrbitingCircles radius={44} duration={22} delay={8} reverse>
                        <ZapIcon className="size-3.5 text-primary" />
                      </OrbitingCircles>
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <span className="text-[10px] font-mono text-muted-foreground">
                          METEOR FIELD
                        </span>
                      </div>
                    </div>

                    <div className="relative overflow-hidden rounded-md border bg-muted/20 min-h-[110px] flex items-center justify-center">
                      <Ripple mainCircleSize={48} numCircles={4} mainCircleOpacity={0.32} />
                      <AnimatedGradientText
                        speed={2}
                        className="relative z-10 text-[11px] font-medium"
                      >
                        ✨ Gradient 流光描边
                      </AnimatedGradientText>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ------------------------------------------------------------- */}
            {/* 模块 5: Animate UI 物理弹簧与微交互控制矩阵 (Animate UI Matrix) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs overflow-hidden">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FlameIcon className="size-4 text-primary" />
                    <span>Animate UI 物理弹簧与全局微交互</span>
                  </div>
                  <Badge variant="outline" className="text-xs font-mono">
                    Spring Physics & Odometer
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  控件级平滑物理弹簧、数字翻页滚动跳变、选项卡惯性吸附滑块与动态形变图标。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-4 pb-4">
                {/* 1. SlidingNumber 动态数字滚动 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">
                      SlidingNumber 动态数字翻页钟 (Odometer)
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="xs"
                        variant="outline"
                        className="h-6 text-[11px] px-2"
                        onClick={() => setAnimateCounter((c) => c + 150)}
                      >
                        +150 Tokens
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        className="h-6 text-[11px] px-2"
                        onClick={() => setAnimateCounter((c) => Math.max(0, c - 80))}
                      >
                        -80
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        className="h-6 text-[11px] px-2"
                        onClick={() => setAnimateCounter(Math.floor(Math.random() * 9000) + 1000)}
                      >
                        随机数值
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-md border bg-background/80">
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">当前会话 Token 消耗</span>
                      <div className="flex items-baseline gap-1 text-xl font-bold font-mono text-primary">
                        <SlidingNumber number={animateCounter} thousandSeparator="," />
                        <span className="text-xs font-normal text-muted-foreground">tokens</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-xs text-muted-foreground">上下文占比</span>
                      <div className="flex items-baseline gap-0.5 text-xl font-bold font-mono text-foreground">
                        <SlidingNumber
                          number={Math.min(100, (animateCounter / 16384) * 100)}
                          decimalPlaces={1}
                        />
                        <span className="text-xs font-normal text-muted-foreground">%</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. AnimatedTabs 胶囊惯性吸附滑块 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <span className="text-xs font-medium text-foreground">
                    AnimatedTabs 选项卡平滑胶囊吸附 (Morphing Pill Indicator)
                  </span>
                  <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
                    <AnimatedTabs
                      variant="segmented"
                      activeTab={activeAnimateTab}
                      onChange={setActiveAnimateTab}
                      tabs={[
                        {
                          id: "tab-1",
                          label: "智能体流水线",
                          icon: <SparklesIcon className="size-3.5" />,
                        },
                        {
                          id: "tab-2",
                          label: "工具调用轨迹",
                          icon: <ZapIcon className="size-3.5" />,
                        },
                        {
                          id: "tab-3",
                          label: "知识库向量",
                          icon: <TypeIcon className="size-3.5" />,
                        },
                      ]}
                    />
                    <Badge variant="outline" className="font-mono text-xs">
                      Active: {activeAnimateTab}
                    </Badge>
                  </div>
                </div>

                {/* 3. AnimatedCollapsible 物理弹簧高度展开 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">
                      AnimatedCollapsible 物理阻尼弹性折叠
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="h-7 text-xs flex items-center gap-1.5"
                      onClick={() => setAnimateCollapseOpen(!animateCollapseOpen)}
                    >
                      <span>{animateCollapseOpen ? "收起执行详情" : "展开执行详情"}</span>
                      <AnimatedChevron open={animateCollapseOpen} size={14} />
                    </Button>
                  </div>
                  <AnimatedCollapsible open={animateCollapseOpen}>
                    <div className="p-3 mt-1 rounded-md border bg-background/80 text-xs font-mono space-y-1.5 text-muted-foreground">
                      <p className="text-foreground font-semibold">⚡ 工具调用轨迹 (Tool Trace):</p>
                      <p>• [Agent-01] 检索工作区知识库已完成 (耗时: 120ms)</p>
                      <p>• [Agent-02] 正在进行 TypeScript 语法树静态分析...</p>
                      <p>• [Agent-03] 物理弹簧阻尼高度动态自适应展开无闪烁。</p>
                    </div>
                  </AnimatedCollapsible>
                </div>
              </CardContent>
            </Card>

            {/* ------------------------------------------------------------- */}
            {/* 模块 6: Dot Matrix 极客点阵微动效矩阵 (Dot Matrix Loaders) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs overflow-hidden">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ZapIcon className="size-4 text-primary" />
                    <span>Dot Matrix 极客点阵微动效矩阵</span>
                  </div>
                  <Badge variant="outline" className="text-xs font-mono">
                    55+ CSS Dot Loaders
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  纯 CSS / React 驱动的高性能 LED
                  点阵动效，实时响应主题色与暗色模式，广泛应用于侧边栏线程工作状态、AI
                  深度思考中与工具执行轨迹。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-4 pb-4">
                {/* 1. 微型 3x3 九宫格系列 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <span className="text-xs font-medium text-foreground">
                    微型 3×3 矩阵系列 (适合侧栏线程状态、状态栏、Badge 徽标)
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="flex items-center gap-2.5 p-2 rounded-md border bg-background/80">
                      <Dotm3x3_1 size={18} dotSize={2.5} colorPreset="solid-theme" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium">Square Spiral</span>
                        <span className="text-[10px] text-muted-foreground">3×3 螺旋流转</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 p-2 rounded-md border bg-background/80">
                      <Dotm3x3_6 size={18} dotSize={2.5} colorPreset="solid-theme" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium">Core Echo</span>
                        <span className="text-[10px] text-muted-foreground">3×3 核心涟漪</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 p-2 rounded-md border bg-background/80">
                      <Dotm3x3_11 size={18} dotSize={2.5} colorPreset="solid-theme" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium">Glyph Pulse</span>
                        <span className="text-[10px] text-muted-foreground">3×3 符文脉冲</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. 5x5 标准方形与 CRT 扫描系列 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <span className="text-xs font-medium text-foreground">
                    标准 5×5 矩阵系列 (适合 AI 思考中、代码执行沙箱)
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="flex items-center gap-3 p-2.5 rounded-md border bg-background/80">
                      <DotmSquare3 size={24} dotSize={2.8} colorPreset="solid-theme" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium">Core Spiral</span>
                        <span className="text-[10px] text-muted-foreground">5×5 核心旋涡</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 rounded-md border bg-background/80">
                      <DotmSquare10 size={24} dotSize={2.8} colorPreset="solid-theme" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium">CRT Glide</span>
                        <span className="text-[10px] text-muted-foreground">CRT 电子束扫描</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 rounded-md border bg-background/80">
                      <DotmSquare18 size={24} dotSize={2.8} colorPreset="solid-theme" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium">Sound Bars</span>
                        <span className="text-[10px] text-muted-foreground">音频等化均衡器</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. 圆形全息与蜂巢多边形系列 */}
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <span className="text-xs font-medium text-foreground">
                    全息圆形 / 三角 / 蜂巢系列 (适合 Agent 专属头像框、联网检索雷达)
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="flex flex-col items-center justify-center p-3 rounded-md border bg-background/80 gap-2">
                      <DotmCircular4 size={28} dotSize={2.5} colorPreset="solid-theme" />
                      <span className="text-[11px] font-medium text-center">Radar Arc 雷达</span>
                    </div>
                    <div className="flex flex-col items-center justify-center p-3 rounded-md border bg-background/80 gap-2">
                      <DotmCircular5 size={28} dotSize={2.5} colorPreset="solid-theme" />
                      <span className="text-[11px] font-medium text-center">Nova Wheel 新星</span>
                    </div>
                    <div className="flex flex-col items-center justify-center p-3 rounded-md border bg-background/80 gap-2">
                      <DotmHex1 size={28} dotSize={2.5} colorPreset="solid-theme" />
                      <span className="text-[11px] font-medium text-center">Hex Orbit 蜂巢</span>
                    </div>
                    <div className="flex flex-col items-center justify-center p-3 rounded-md border bg-background/80 gap-2">
                      <DotmTriangle2 size={28} dotSize={2.5} colorPreset="solid-theme" />
                      <span className="text-[11px] font-medium text-center">Altitude 三角波</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
