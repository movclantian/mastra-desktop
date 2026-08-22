import {
  CheckIcon,
  CopyIcon,
  LaptopIcon,
  MoonIcon,
  PaletteIcon,
  PanelLeftIcon,
  RotateCcwIcon,
  SearchIcon,
  SparklesIcon,
  SunMediumIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTheme } from "@/components/theme-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { THEME_INSPIRATIONS } from "@/lib/theme/presets";
import type { ThemeColorTokens, ThemePreset } from "@/lib/theme/types";
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

function ColorField({
  label,
  description,
  value,
  onChange,
  recommendedSwatches,
}: ColorFieldProps) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card/60 p-3 shadow-xs transition-colors hover:bg-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-semibold text-foreground">{label}</span>
          <span className="text-[11px] text-muted-foreground truncate">{description}</span>
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
    updateActiveCustomization,
    resetActiveCustomization,
    isDark,
  } = useTheme();

  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<"all" | "brutalism" | "modern">("all");
  const [interactiveSwitch, setInteractiveSwitch] = React.useState(true);
  const [interactiveInput, setInteractiveInput] = React.useState("Mastra Neubrutalism AI Agent");

  const filteredPresets = React.useMemo(() => {
    return presets.filter((p) => {
      const matchSearch =
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.englishName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.registrySource.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.description.toLowerCase().includes(searchQuery.toLowerCase());

      const matchCategory =
        categoryFilter === "all" ||
        (categoryFilter === "brutalism" && (p.category === "brutalism" || p.category === "soft_brutalism")) ||
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
      colors: resolvedColors,
    };
    void navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast.success("主题配置已复制到剪贴板");
  };

  return (
    <div className="flex h-[min(560px,calc(100dvh-5rem))] w-full min-h-0 min-w-0 overflow-hidden bg-background">
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
                <div className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant={categoryFilter === "all" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-2"
                    onClick={() => setCategoryFilter("all")}
                  >
                    全部 ({presets.length})
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "brutalism" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-2"
                    onClick={() => setCategoryFilter("brutalism")}
                  >
                    粗野主义
                  </Button>
                  <Button
                    size="xs"
                    variant={categoryFilter === "modern" ? "secondary" : "ghost"}
                    className="h-6 text-[11px] px-2"
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
                            <span className="w-1/3 h-full" style={{ backgroundColor: colors.background }} />
                            <span className="w-1/3 h-full" style={{ backgroundColor: colors.primary }} />
                            <span className="w-1/3 h-full" style={{ backgroundColor: colors.accent }} />
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
              <div className="flex items-center gap-0.5 group-data-[collapsible=icon]/sidebar:mx-auto">
                <Button
                  size="icon-xs"
                  variant={mode === "light" ? "default" : "ghost"}
                  onClick={() => setMode("light")}
                  title="浅色模式"
                  className="size-6"
                >
                  <SunMediumIcon className="size-3.5" />
                </Button>
                <Button
                  size="icon-xs"
                  variant={mode === "dark" ? "default" : "ghost"}
                  onClick={() => setMode("dark")}
                  title="深色模式"
                  className="size-6"
                >
                  <MoonIcon className="size-3.5" />
                </Button>
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
        <ScrollArea className="min-h-0 flex-1 p-4">
          <div className="flex flex-col gap-6 max-w-3xl pb-6">
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
                    <span className="font-medium text-foreground">实体硬阴影深度 (Hard Shadow Offset)</span>
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
            {/* 模块 2: 调色板灵感预设 (1-Click Color Presets) */}
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
                      <span className="text-[10px] text-muted-foreground truncate">
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
                  recommendedSwatches={["#000000", "#09090b", "#1c1917", "#27272a", "#facc15", "#ff5400", "#e5e5e5"]}
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
                  recommendedSwatches={["#ffffff", "#fefcf6", "#fffdfa", "#faf6ee", "#f8fafc", "#121212", "#09090b", "#161311"]}
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
                  recommendedSwatches={["#000000", "#171717", "#09090b", "#1c1917", "#ffffff", "#fafafa", "#f4f4f5"]}
                />
                <ColorField
                  label="侧边栏背景 (Sidebar)"
                  description="左侧导航底色、工作区垫底层"
                  value={resolvedColors.sidebar}
                  onChange={(v) => handleColorChange("sidebar", v)}
                  recommendedSwatches={["#fafafa", "#faf3e0", "#fdf8e6", "#f3ecde", "#f1f5f9", "#18181b", "#0b0b0d", "#050507"]}
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
            {/* 模块 4: 实时交互预览沙盒 (Live Interactive Preview Sandbox) */}
            {/* ------------------------------------------------------------- */}
            <Card className="border shadow-xs">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <span>实时交互沙盒 (Live Preview Sandbox)</span>
                  <Badge variant="secondary" className="text-xs">
                    当前参数即时渲染
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  测试按钮点击触感、阴影投影与组件层叠效果。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-4 pb-4">
                {/* 按钮与徽章集合 */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="default">
                    主操作按钮
                  </Button>
                  <Button size="sm" variant="secondary">
                    次级按钮
                  </Button>
                  <Button size="sm" variant="outline">
                    轮廓按钮
                  </Button>
                  <Button size="sm" variant="destructive">
                    危险按钮
                  </Button>
                  <Button size="sm" variant="ghost">
                    幽灵按钮
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="default">Default Badge</Badge>
                  <Badge variant="secondary">Secondary</Badge>
                  <Badge variant="outline">Outline</Badge>
                  <Badge variant="destructive">Destructive</Badge>
                </div>

                {/* 模拟输入与开关 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-foreground">输入控件测试</span>
                    <Input
                      value={interactiveInput}
                      onChange={(e) => setInteractiveInput(e.target.value)}
                      className="h-8 text-xs bg-background"
                      placeholder="输入测试文本..."
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-lg border p-2 bg-muted/20">
                    <div className="flex flex-col">
                      <span className="text-xs font-medium text-foreground">状态开关 (Switch)</span>
                      <span className="text-[11px] text-muted-foreground">实时布尔状态切换</span>
                    </div>
                    <Switch
                      checked={interactiveSwitch}
                      onCheckedChange={setInteractiveSwitch}
                    />
                  </div>
                </div>

                {/* 模拟对话气泡卡片 */}
                <div className="rounded-lg border bg-card p-3 shadow-xs flex flex-col gap-2">
                  <div className="flex items-center justify-between border-b pb-2">
                    <div className="flex items-center gap-1.5">
                      <div className="size-2 rounded-full bg-primary" />
                      <span className="text-xs font-bold font-mono">Agent Response</span>
                    </div>
                    <Badge variant="outline" className="text-[10px] h-4">
                      Thinking Done
                    </Badge>
                  </div>
                  <p className="text-xs text-foreground leading-relaxed">
                    当前主题「<strong className="text-primary">{activePreset.name}</strong>」已装载！
                    边框粗细为 <code className="font-mono bg-muted px-1 rounded-xs">{resolvedGeometry.borderWidth}px</code>，
                    圆角半径为 <code className="font-mono bg-muted px-1 rounded-xs">{resolvedGeometry.radius}px</code>，
                    实体投影为 <code className="font-mono bg-muted px-1 rounded-xs">{resolvedGeometry.shadowDepth}px</code>。
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
