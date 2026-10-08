import { DownloadIcon, ExpandIcon, ImageIcon, RefreshCcwIcon, VideoIcon } from "lucide-react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import * as React from "react";
import { libraryAssetContentUrl } from "@/entities/library";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { apiFetch } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";
import { Skeleton } from "@/shared/ui/skeleton";
import { type GeneratedMedia, generatedMediaSchema } from "../../../../../shared/agent-contract";

const MotionCard = motion.create(Card);
const MotionCardFooter = motion.create(CardFooter);
const expansion = { type: "spring", duration: 0.6, bounce: 0.08 } as const;
// A small, static texture tiles without a canvas or per-frame noise generation.
const grainTexture = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#grain)"/></svg>')}")`;

interface MediaGenerationProps {
  kind: "image" | "video";
  pending: boolean;
  waiting?: boolean;
  output: unknown;
  error?: string;
  canceled?: boolean;
  onRetry?: () => void;
  retryDisabled?: boolean;
}

function GeneratedFile({
  file,
  kind,
  pending,
  waiting,
  error,
  canceled,
  onRetry,
  retryDisabled,
  animate,
}: Omit<MediaGenerationProps, "output"> & {
  file?: GeneratedMedia["files"][number];
  animate: boolean;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const openPreview = useWorkbenchStore((state) => state.requestFilePreview);
  const previewThreadId = useWorkbenchStore((state) => state.lastKnownThreadId);
  const [loaded, setLoaded] = React.useState<{ url?: string; error?: string; ready?: boolean }>({});
  const card = React.useRef<HTMLDivElement>(null);
  const inView = useInView(card, { margin: "80px" });
  const reducedMotion = useReducedMotion();
  const smooth = animate && !reducedMotion;
  const ready = Boolean(loaded.ready && !loaded.error);
  const busy = !waiting && !canceled && (pending || Boolean(file && !ready && !loaded.error));
  const failed = !ready && !busy && !waiting && !canceled;
  const Icon = kind === "image" ? ImageIcon : VideoIcon;
  const url = user && file ? libraryAssetContentUrl(file.assetId, user.id) : undefined;

  React.useEffect(() => {
    setLoaded({});
    if (!url) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void apiFetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("chat:media.loadFailed"));
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ url: objectUrl });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, t]);

  const mediaProps = {
    initial: false as const,
    layout: smooth ? ("preserve-aspect" as const) : false,
    animate: { opacity: ready ? 1 : 0, filter: ready ? "blur(0px)" : "blur(6px)" },
    transition: {
      duration: smooth ? 0.45 : 0,
      delay: smooth && ready ? 0.12 : 0,
      layout: expansion,
    },
    className: cn("block h-auto w-full", !ready && "pointer-events-none absolute inset-0"),
    "aria-hidden": !ready,
    onError: () =>
      setLoaded((current) => ({ ...current, ready: false, error: t("chat:media.loadFailed") })),
  };

  return (
    <MotionCard
      ref={card}
      layout={smooth}
      initial={false}
      transition={{ layout: expansion }}
      style={{ width: ready ? "100%" : "20rem", borderRadius: 12, originX: 0, originY: 0 }}
      className="relative min-w-0 max-w-full gap-0 overflow-hidden p-0 transition-none"
      role={file ? "figure" : "group"}
      aria-label={file?.filename ?? t(`chat:media.${kind}`)}
      aria-busy={busy}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {!ready ? (
          <motion.div
            key="waiting"
            className="group/media-wait"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: smooth ? 0.16 : 0 }}
          >
            {busy ? (
              <CardContent className="p-0" aria-hidden="true">
                <Skeleton
                  className="relative isolate h-40 w-full animate-none overflow-hidden rounded-none bg-muted/65"
                  style={{
                    backgroundImage:
                      "radial-gradient(ellipse at 12% 8%, color-mix(in oklch, var(--primary) 12%, transparent), transparent 65%), radial-gradient(ellipse at 88% 90%, color-mix(in oklch, var(--primary) 8%, transparent), transparent 60%), repeating-linear-gradient(0deg, transparent, transparent 3px, color-mix(in oklch, var(--foreground) 2.5%, transparent) 3px, color-mix(in oklch, var(--foreground) 2.5%, transparent) 4px)",
                  }}
                >
                  <div
                    className="pointer-events-none absolute inset-0 opacity-[0.08] mix-blend-multiply dark:opacity-[0.1] dark:mix-blend-screen"
                    style={{ backgroundImage: grainTexture, backgroundSize: "128px 128px" }}
                  />
                  <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-background/25 via-transparent to-primary/5 opacity-60 transition-opacity duration-500 group-hover/media-wait:opacity-100 motion-reduce:transition-none" />
                  {inView && !reducedMotion ? (
                    <div className="pointer-events-none absolute inset-0 opacity-65 transition-opacity duration-500 group-hover/media-wait:opacity-100 motion-reduce:transition-none">
                      <motion.div
                        className="absolute -inset-full"
                        style={{
                          backgroundImage:
                            "linear-gradient(135deg, transparent 38%, color-mix(in oklch, var(--primary) 10%, transparent) 46%, color-mix(in oklch, var(--background) 85%, transparent) 50%, color-mix(in oklch, var(--foreground) 8%, transparent) 50.15%, transparent 62%)",
                        }}
                        initial={{ x: "-35%", y: "-35%" }}
                        animate={{ x: ["-35%", "35%"], y: ["-35%", "35%"] }}
                        transition={{
                          duration: 4.8,
                          ease: "linear",
                          repeat: Infinity,
                          repeatDelay: 0.4,
                        }}
                      />
                    </div>
                  ) : null}
                </Skeleton>
              </CardContent>
            ) : null}
            <CardHeader className={cn("gap-1 px-3 py-3", busy && "border-t bg-muted/20")}>
              <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{t(`chat:media.${kind}`)}</span>
              </CardTitle>
              <CardDescription
                role={failed ? "alert" : "status"}
                className={cn(
                  "whitespace-pre-wrap text-xs [overflow-wrap:anywhere]",
                  failed && "text-destructive",
                )}
              >
                {loaded.error ??
                  (waiting
                    ? t("chat:media.waitingApproval")
                    : busy
                      ? t(file ? "chat:media.loading" : "chat:media.generating")
                      : canceled
                        ? t("chat:media.canceled")
                        : (error ?? t("chat:media.failed")))}
              </CardDescription>
            </CardHeader>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Decode in place without changing the card size; media enters layout only when ready. */}
      {file && loaded.url && !loaded.error ? (
        kind === "image" ? (
          <motion.img
            {...mediaProps}
            src={loaded.url}
            alt={file.filename}
            decoding="async"
            onLoad={() => setLoaded((current) => ({ ...current, ready: true }))}
          />
        ) : (
          <motion.video
            {...mediaProps}
            src={loaded.url}
            controls={ready}
            preload="metadata"
            aria-label={file.filename}
            onLoadedMetadata={() => setLoaded((current) => ({ ...current, ready: true }))}
          />
        )
      ) : null}

      {(file && (ready || failed)) || onRetry ? (
        <MotionCardFooter
          layout={smooth ? "position" : false}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: smooth ? 0.25 : 0, delay: smooth && ready ? 0.18 : 0 }}
          className="min-w-0 flex-wrap gap-1 p-2"
        >
          {file ? (
            <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
              {file.filename}
            </span>
          ) : null}
          {file && url && previewThreadId ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("chat:media.preview")}
              onClick={() =>
                openPreview(previewThreadId, {
                  id: file.assetId,
                  filename: file.filename,
                  mediaType: file.mediaType,
                  url,
                })
              }
            >
              <ExpandIcon />
            </Button>
          ) : null}
          {file && loaded.url ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("chat:media.download")}
              nativeButton={false}
              render={<a href={loaded.url} download={file.filename} />}
            >
              <DownloadIcon />
            </Button>
          ) : null}
          {onRetry ? (
            <Button size="sm" variant="ghost" onClick={onRetry} disabled={retryDisabled}>
              <RefreshCcwIcon /> {t("chat:messages.regenerate")}
            </Button>
          ) : null}
        </MotionCardFooter>
      ) : null}
    </MotionCard>
  );
}

export default function MediaGeneration({ output, ...props }: MediaGenerationProps) {
  const { t } = useTranslation();
  const animate = React.useRef(props.pending);
  if (props.pending) animate.current = true;
  const result = generatedMediaSchema.safeParse(output);
  const files = result.success ? result.data.files : [undefined];
  return (
    <section
      className="my-2 w-full min-w-0 max-w-2xl space-y-2"
      aria-label={t(`chat:media.${props.kind}`)}
    >
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] items-start gap-2">
        {/* Stable output slots keep the waiting card mounted through decoding and expansion. */}
        {files.map((file, index) => (
          <GeneratedFile key={index} {...props} file={file} animate={animate.current} />
        ))}
      </div>
      {result.success && result.data.warnings?.length ? (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {result.data.warnings.join("\n")}
        </p>
      ) : null}
    </section>
  );
}
