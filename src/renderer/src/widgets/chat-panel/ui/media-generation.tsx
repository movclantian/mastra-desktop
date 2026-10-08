import { ImageGeneration, type ImageGenerationHandle } from "img-fx";
import { DownloadIcon, ExpandIcon, ImageIcon, VideoIcon } from "lucide-react";
import { useReducedMotion } from "motion/react";
import * as React from "react";
import { contentObjectUrl } from "@/entities/workbench/api/workbench-api";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { apiFetch } from "@/shared/api";
import { useTranslation } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { type GeneratedMedia, generatedMediaSchema } from "../../../../../shared/agent-contract";

const placeholder = <div className="aspect-square w-full rounded-lg bg-muted" />;

/** The optional GPU effect must never take down a completed generation or its download. */
class EffectBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function GeneratedFile({
  file,
  animate,
}: {
  file: GeneratedMedia["files"][number];
  animate: boolean;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const openPreview = useWorkbenchStore((state) => state.requestFilePreview);
  const [loaded, setLoaded] = React.useState<{ url?: string; error?: string }>({});
  const [revealed, setRevealed] = React.useState(false);
  const effect = React.useRef<ImageGenerationHandle>(null);
  const reducedMotion = useReducedMotion();
  const isImage = file.contentType.startsWith("image/");
  const url = user ? contentObjectUrl(user.id, file) : undefined;
  React.useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setLoaded({});
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
  React.useEffect(() => {
    if (!loaded.url || !animate || reducedMotion || !isImage) return;
    const frame = requestAnimationFrame(() => effect.current?.triggerReveal({ hold: "manual" }));
    return () => cancelAnimationFrame(frame);
  }, [loaded.url, animate, reducedMotion, isImage]);
  return (
    <figure className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="relative flex aspect-square items-center justify-center bg-muted/30">
        {loaded.error ? (
          <p role="alert" className="p-3 text-sm text-destructive break-words">
            {loaded.error}
          </p>
        ) : loaded.url ? (
          isImage ? (
            <img
              src={loaded.url}
              alt={file.filename}
              className="size-full object-contain"
              onError={() => setLoaded({ error: t("chat:media.loadFailed") })}
            />
          ) : (
            <video
              src={loaded.url}
              controls
              preload="metadata"
              className="size-full object-contain"
              aria-label={file.filename}
              onError={() => setLoaded({ error: t("chat:media.loadFailed") })}
            />
          )
        ) : (
          <span role="status" className="text-sm text-muted-foreground">
            {t("chat:media.loading")}
          </span>
        )}
        {isImage && loaded.url && animate && !reducedMotion && !revealed ? (
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            <EffectBoundary>
              <React.Suspense fallback={null}>
                <ImageGeneration
                  ref={effect}
                  images={loaded.url}
                  preset="pixels-organic"
                  autoReveal={false}
                  onCycle={({ phase }) => {
                    if (phase === "visible") setRevealed(true);
                  }}
                >
                  {placeholder}
                </ImageGeneration>
              </React.Suspense>
            </EffectBoundary>
          </div>
        ) : null}
      </div>
      <figcaption className="flex min-w-0 flex-wrap items-center gap-1 p-2">
        <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
          {file.filename}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={!url}
          aria-label={t("chat:media.preview")}
          onClick={() => {
            if (url)
              openPreview(file.threadId, {
                id: file.objectId,
                filename: file.filename,
                mediaType: file.contentType,
                url,
              });
          }}
        >
          <ExpandIcon />
        </Button>
        {loaded.url ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("chat:media.download")}
            render={<a href={loaded.url} download={file.filename} />}
          >
            <DownloadIcon />
          </Button>
        ) : null}
      </figcaption>
    </figure>
  );
}

export default function MediaGeneration({
  kind,
  pending,
  waiting,
  output,
  error,
}: {
  kind: "image" | "video";
  pending: boolean;
  waiting?: boolean;
  output: unknown;
  error?: string;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const animate = React.useRef(pending);
  if (pending) animate.current = true;
  const result = generatedMediaSchema.safeParse(output);
  const Icon = kind === "image" ? ImageIcon : VideoIcon;
  return (
    <section
      className="my-2 min-w-0 space-y-2"
      aria-label={t(`chat:media.${kind}`)}
      aria-busy={pending}
    >
      <p className="flex items-center gap-2 text-sm">
        <Icon className="size-4 shrink-0" />
        {t(`chat:media.${kind}`)}
      </p>
      {result.success ? (
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-2">
          {result.data.files.map((file) => (
            <GeneratedFile key={file.objectId} file={file} animate={animate.current} />
          ))}
        </div>
      ) : waiting ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("chat:media.waitingApproval")}
        </p>
      ) : pending ? (
        <div className="relative max-w-sm overflow-hidden rounded-lg border">
          {!reducedMotion ? (
            <EffectBoundary>
              <React.Suspense fallback={placeholder}>
                <ImageGeneration
                  preset={kind === "image" ? "pixels-mechanic" : "sweep-gradient"}
                  autoReveal={false}
                >
                  {placeholder}
                </ImageGeneration>
              </React.Suspense>
            </EffectBoundary>
          ) : (
            placeholder
          )}
          <p role="status" className="relative bg-card/90 p-2 text-sm text-muted-foreground">
            {t("chat:media.generating")}
          </p>
        </div>
      ) : (
        <p role="alert" className="break-words text-sm text-destructive">
          {error ?? t("chat:media.failed")}
        </p>
      )}
      {result.success && result.data.warnings?.length ? (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {result.data.warnings.join("\n")}
        </p>
      ) : null}
    </section>
  );
}
