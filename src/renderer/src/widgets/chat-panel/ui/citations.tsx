import { ExternalLinkIcon, LinkIcon } from "lucide-react";
import * as React from "react";
import { libraryAssetFromUrl } from "@/entities/library";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationQuote,
  InlineCitationSource,
} from "@/shared/ui/ai-elements/inline-citation";
import { ScrollArea } from "@/shared/ui/scroll-area";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";
import { type CitationEntries, type CitationSource, findFootnoteIds } from "../lib/citation-utils";
import { MessageLink } from "./message-selection";

export type { CitationEntries, CitationSource } from "../lib/citation-utils";

const CitationEntriesContext = React.createContext<CitationEntries>(new Map());

export function CitationProvider({
  entries,
  children,
}: {
  entries: CitationEntries;
  children: React.ReactNode;
}) {
  return (
    <CitationEntriesContext.Provider value={entries}>{children}</CitationEntriesContext.Provider>
  );
}

type MarkdownProps<Tag extends keyof React.JSX.IntrinsicElements> =
  React.JSX.IntrinsicElements[Tag] & { node?: unknown };

function collectSources(ids: string[], entries: CitationEntries): CitationSource[] {
  const sources: CitationSource[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const source of entries.get(id) ?? []) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push(source);
    }
  }
  return sources;
}

export function FootnoteCitation({ node, children, className, ...props }: MarkdownProps<"sup">) {
  const { t } = useTranslation();
  const entries = React.useContext(CitationEntriesContext);
  const sources = collectSources(findFootnoteIds(node), entries);
  const anchors =
    (
      node as
        | {
            children?: Array<{
              properties?: { id?: string };
              children?: Array<{ value?: string }>;
            }>;
          }
        | undefined
    )?.children ?? [];
  const label = anchors
    .map((anchor) => anchor.children?.map((child) => child.value ?? "").join(""))
    .filter(Boolean)
    .join(", ");

  if (!sources.length) {
    return (
      <sup className={cn("text-sm text-muted-foreground", className)} {...props}>
        {children}
      </sup>
    );
  }

  return (
    <InlineCitation {...props} className={className}>
      {anchors.map((anchor) =>
        anchor.properties?.id ? (
          <span key={anchor.properties.id} id={anchor.properties.id} />
        ) : null,
      )}
      <InlineCitationCard>
        <InlineCitationCardTrigger
          sources={sources.map((source) => source.url)}
          label={label || undefined}
          aria-label={t("chat:messages.citationSources")}
        />
        <InlineCitationCardBody>
          <InlineCitationCarousel>
            <InlineCitationCarouselHeader>
              <InlineCitationCarouselPrev />
              <InlineCitationCarouselNext />
              <InlineCitationCarouselIndex />
            </InlineCitationCarouselHeader>
            <InlineCitationCarouselContent>
              {sources.map((source) => (
                <InlineCitationCarouselItem key={source.url}>
                  <ScrollArea className="max-h-72 min-w-0">
                    <MessageLink
                      href={source.url}
                      title={source.title}
                      className="break-words text-left text-sm font-medium text-primary underline underline-offset-2"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.title}
                      {!libraryAssetFromUrl(source.url) ? (
                        <span className="sr-only">{t("chat:trace.opensNewTab")}</span>
                      ) : null}
                    </MessageLink>
                    <MessageLink
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block h-auto break-all text-xs text-muted-foreground underline underline-offset-2"
                    >
                      {source.url}
                      {!libraryAssetFromUrl(source.url) ? (
                        <span className="sr-only">{t("chat:trace.opensNewTab")}</span>
                      ) : null}
                    </MessageLink>
                    <InlineCitationSource description={source.description}>
                      {source.quote ? (
                        <InlineCitationQuote>{source.quote}</InlineCitationQuote>
                      ) : null}
                    </InlineCitationSource>
                  </ScrollArea>
                </InlineCitationCarouselItem>
              ))}
            </InlineCitationCarouselContent>
          </InlineCitationCarousel>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  );
}

export function MessageSources({ sources }: { sources: CitationSource[] }) {
  const { t } = useTranslation();
  if (!sources.length) return null;
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <LinkIcon />
            </TraceIcon>
            <TraceTitle>{t("chat:trace.sourcesCount", { count: sources.length })}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <ScrollArea className="max-h-64">
            <Trace>
              {sources.map((source) => {
                const external = !libraryAssetFromUrl(source.url);
                return (
                  <MessageLink
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block h-auto min-w-0 text-left"
                  >
                    <TraceLine>
                      <TraceIcon>
                        <LinkIcon />
                      </TraceIcon>
                      <TraceTitle className="whitespace-normal break-words">
                        {source.title}
                      </TraceTitle>
                      {external ? (
                        <>
                          <TraceIcon>
                            <ExternalLinkIcon />
                          </TraceIcon>
                          <span className="sr-only">{t("chat:trace.opensNewTab")}</span>
                        </>
                      ) : null}
                    </TraceLine>
                  </MessageLink>
                );
              })}
            </Trace>
          </ScrollArea>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
