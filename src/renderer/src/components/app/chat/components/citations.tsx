import * as React from "react";
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
  InlineCitationSource,
} from "@/components/ai-elements/inline-citation";
import { cn } from "@/lib/utils";
import type { CitationEntries, CitationSource } from "../lib/citation-utils";

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

interface HastElement {
  properties?: Record<string, unknown>;
  children?: HastElement[];
}

function findFootnoteIds(node: unknown): string[] {
  const ids: string[] = [];
  for (const child of (node as HastElement | undefined)?.children ?? []) {
    const href = child.properties?.href;
    if (typeof href !== "string") continue;
    const match = /fn-(.+)$/.exec(href);
    if (match) ids.push(decodeURIComponent(match[1]).toLowerCase());
  }
  return ids;
}

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
  const entries = React.useContext(CitationEntriesContext);
  const sources = collectSources(findFootnoteIds(node), entries);

  if (!sources.length) {
    return (
      <sup className={cn("text-sm text-muted-foreground", className)} {...props}>
        {children}
      </sup>
    );
  }

  return (
    <InlineCitation>
      <InlineCitationCard>
        <InlineCitationCardTrigger sources={sources.map((source) => source.url)} />
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
                  <InlineCitationSource
                    description={source.description}
                    title={source.title}
                    url={source.url}
                  />
                </InlineCitationCarouselItem>
              ))}
            </InlineCitationCarouselContent>
          </InlineCitationCarousel>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  );
}

export function MarkdownSection({ node, children, ...props }: MarkdownProps<"section">) {
  if ((node as HastElement | undefined)?.properties?.dataFootnotes !== undefined) return null;
  return <section {...props}>{children}</section>;
}
