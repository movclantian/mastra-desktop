"use client";

import type { ComponentProps } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { i18n } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";

import { Input } from "@/shared/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";

export interface WebPreviewContextValue {
  draftUrl: string;
  url: string;
  setDraftUrl: (url: string) => void;
  setUrl: (url: string) => Promise<boolean>;
  submitDraft: () => Promise<boolean>;
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean) => void;
}

type WebPreviewUrlChange = (
  url: string,
) => string | false | undefined | Promise<string | false | undefined>;

async function requestWebPreviewNavigation(
  url: string,
  onUrlChange?: WebPreviewUrlChange,
): Promise<string | null> {
  try {
    const result = await onUrlChange?.(url);
    if (result === false) return null;
    return typeof result === "string" ? result : url;
  } catch {
    return null;
  }
}

export function shouldSubmitWebPreviewDraft(draftUrl: string, currentUrl: string): boolean {
  const draft = draftUrl.trim();
  return draft.length > 0 && draft !== currentUrl;
}

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null);

export const useWebPreview = () => {
  const context = useContext(WebPreviewContext);
  if (!context) {
    throw new Error("WebPreview components must be used within a WebPreview");
  }
  return context;
};

export type WebPreviewProps = ComponentProps<"div"> & {
  defaultUrl?: string;
  onUrlChange?: WebPreviewUrlChange;
  resolveUrl?: (input: string) => string | null;
};

export const WebPreview = ({
  className,
  children,
  defaultUrl = "",
  onUrlChange,
  resolveUrl,
  ...props
}: WebPreviewProps) => {
  const [url, setUrl] = useState(defaultUrl);
  const [draftUrl, setDraftUrl] = useState(defaultUrl);
  const [consoleOpen, setConsoleOpen] = useState(false);

  useEffect(() => {
    setUrl(defaultUrl);
    setDraftUrl(defaultUrl);
  }, [defaultUrl]);

  const handleUrlChange = useCallback(
    async (newUrl: string) => {
      const destination = resolveUrl ? resolveUrl(newUrl) : newUrl;
      if (!destination) return false;
      const committedUrl = await requestWebPreviewNavigation(destination, onUrlChange);
      if (committedUrl === null) return false;
      setUrl(committedUrl);
      setDraftUrl(committedUrl);
      return true;
    },
    [onUrlChange, resolveUrl],
  );

  const submitDraft = useCallback(async () => {
    if (!shouldSubmitWebPreviewDraft(draftUrl, url)) return false;
    return handleUrlChange(draftUrl.trim());
  }, [draftUrl, handleUrlChange, url]);

  const contextValue = useMemo<WebPreviewContextValue>(
    () => ({
      consoleOpen,
      draftUrl,
      setConsoleOpen,
      setDraftUrl,
      setUrl: handleUrlChange,
      submitDraft,
      url,
    }),
    [consoleOpen, draftUrl, handleUrlChange, submitDraft, url],
  );

  return (
    <WebPreviewContext.Provider value={contextValue}>
      <div
        className={cn("flex size-full flex-col rounded-lg border bg-card", className)}
        {...props}
      >
        {children}
      </div>
    </WebPreviewContext.Provider>
  );
};

export type WebPreviewNavigationProps = ComponentProps<"div">;

export const WebPreviewNavigation = ({
  className,
  children,
  ...props
}: WebPreviewNavigationProps) => (
  <div className={cn("flex items-center gap-1 border-b p-2", className)} {...props}>
    {children}
  </div>
);

export type WebPreviewNavigationButtonProps = ComponentProps<typeof Button> & {
  tooltip?: string;
};

export const WebPreviewNavigationButton = ({
  onClick,
  disabled,
  tooltip,
  children,
  ...props
}: WebPreviewNavigationButtonProps) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="h-8 w-8 p-0 hover:text-foreground"
            disabled={disabled}
            onClick={onClick}
            size="sm"
            variant="ghost"
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

export type WebPreviewUrlProps = ComponentProps<typeof Input>;

export const WebPreviewUrl = memo(function WebPreviewUrl({
  value,
  onChange,
  onKeyDown,
  ...props
}: WebPreviewUrlProps) {
  const { draftUrl, setDraftUrl, url, setUrl } = useWebPreview();
  const [prevUrl, setPrevUrl] = useState(url);
  const [inputValue, setInputValue] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);

  // External browser URL events are frequent on pages such as Bing. Preserve
  // an in-progress address-bar draft instead of replacing it on every event.
  useEffect(() => {
    if (url === prevUrl) return;
    const hasDraft = inputValue !== prevUrl;
    const isEditing = document.activeElement === inputRef.current;
    setPrevUrl(url);
    if (!isEditing || !hasDraft || draftUrl === url) {
      setInputValue(url);
      setDraftUrl(url);
    }
  }, [draftUrl, inputValue, prevUrl, setDraftUrl, url]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value);
    setDraftUrl(event.target.value);
    onChange?.(event);
  };

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const target = event.target as HTMLInputElement;
        const requestedUrl = target.value.trim();
        if (!requestedUrl) return;
        void setUrl(requestedUrl).then((accepted) => {
          if (!accepted) setInputValue(url);
        });
      }
      onKeyDown?.(event);
    },
    [setUrl, onKeyDown, url],
  );

  return (
    <Input
      className="h-8 flex-1 text-sm"
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      placeholder={props.placeholder ?? i18n.t("workspace:enterUrl")}
      ref={inputRef}
      value={value ?? inputValue}
      {...props}
    />
  );
});
