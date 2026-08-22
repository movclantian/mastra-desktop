"use client";

import type { ChatStatus, FileUIPart, SourceDocumentUIPart } from "ai";
import { CornerDownLeftIcon, ImageIcon, Monitor, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type {
  ChangeEvent,
  ChangeEventHandler,
  ClipboardEventHandler,
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
  PropsWithChildren,
  ReactNode,
  RefObject,
} from "react";
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ============================================================================
// Helpers
// ============================================================================

const captureScreenshot = async (): Promise<File | null> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    return null;
  }

  let stream: MediaStream | null = null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: true,
    });

    video.srcObject = stream;

    // Video element uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    await new Promise<void>((resolve, reject) => {
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      video.onloadedmetadata = () => resolve();
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      video.onerror = () => reject(new Error("Failed to load screen stream"));
    });

    await video.play();

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, width, height);
    // canvas.toBlob uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
      return null;
    }

    const timestamp = new Date()
      .toISOString()
      .replaceAll(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");

    return new File([blob], `screenshot-${timestamp}.png`, {
      lastModified: Date.now(),
      type: "image/png",
    });
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    video.pause();
    video.srcObject = null;
  }
};

// ============================================================================
// Provider Context & Types
// ============================================================================

type PromptAttachment = FileUIPart & {
  id: string;
  byteSize?: number;
  fingerprint?: string;
  file?: File;
};

function attachmentKey(file: PromptAttachment | FileUIPart): string {
  if ("fingerprint" in file && typeof file.fingerprint === "string" && file.fingerprint) {
    return `file:${file.fingerprint}`;
  }
  return `url:${file.url}`;
}

export interface AttachmentsContext {
  files: PromptAttachment[];
  add: (files: File[] | FileList) => void;
  restore: (files: FileUIPart[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

export interface TextInputContext {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
}

export interface PromptInputControllerProps {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  /** Draft persistence has finished loading for the active persistence key. */
  ready: boolean;
  /** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
  __registerFileInput: (ref: RefObject<HTMLInputElement | null>, open: () => void) => void;
}

const PromptInputController = createContext<PromptInputControllerProps | null>(null);
const ProviderAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputController = () => {
  const ctx = useContext(PromptInputController);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use usePromptInputController().",
    );
  }
  return ctx;
};

// Optional variants (do NOT throw). Useful for dual-mode components.
const useOptionalPromptInputController = () => useContext(PromptInputController);

export const useProviderAttachments = () => {
  const ctx = useContext(ProviderAttachmentsContext);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use useProviderAttachments().",
    );
  }
  return ctx;
};

const useOptionalProviderAttachments = () => useContext(ProviderAttachmentsContext);

export type PromptInputProviderProps = PropsWithChildren<{
  initialInput?: string;
  persistenceKey?: string;
}>;

interface PersistedPromptAttachment {
  filename?: string;
  mediaType?: string;
  byteSize?: number;
  fingerprint?: string;
  file?: File;
  url?: string;
}

interface PersistedPromptDraft {
  text: string;
  attachments: PersistedPromptAttachment[];
}

const PROMPT_DRAFT_DB = "mastra-work-prompt-drafts";
const PROMPT_DRAFT_STORE = "drafts";

function withPromptDraftStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROMPT_DRAFT_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROMPT_DRAFT_STORE)) {
        request.result.createObjectStore(PROMPT_DRAFT_STORE);
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(PROMPT_DRAFT_STORE, mode);
      const operation = run(transaction.objectStore(PROMPT_DRAFT_STORE));
      operation.onerror = () => reject(operation.error);
      operation.onsuccess = () => resolve(operation.result);
      transaction.oncomplete = () => database.close();
    };
  });
}

/**
 * Optional global provider that lifts PromptInput state outside of PromptInput.
 * If you don't use it, PromptInput stays fully self-managed.
 */
export const PromptInputProvider = ({
  initialInput: initialTextInput = "",
  persistenceKey,
  children,
}: PromptInputProviderProps) => {
  // ----- textInput state
  const [textInput, setTextInput] = useState(initialTextInput);

  // ----- attachments state (global when wrapped)
  const [attachmentFiles, setAttachmentFiles] = useState<PromptAttachment[]>([]);
  const [ready, setReady] = useState(!persistenceKey || typeof indexedDB === "undefined");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // oxlint-disable-next-line eslint(no-empty-function)
  const openRef = useRef<() => void>(() => {});
  const loadedPersistenceKeyRef = useRef<string | undefined>(undefined);
  const previousPersistenceKeyRef = useRef<string | undefined>(undefined);
  const draftRevisionRef = useRef(0);

  const clearPersistedDraft = useCallback(() => {
    draftRevisionRef.current += 1;
    loadedPersistenceKeyRef.current = persistenceKey;
    if (!persistenceKey || typeof indexedDB === "undefined") return;
    void withPromptDraftStore("readwrite", (store) => store.delete(persistenceKey)).catch(
      () => undefined,
    );
  }, [persistenceKey]);

  const clearInput = useCallback(() => {
    clearPersistedDraft();
    setTextInput("");
  }, [clearPersistedDraft]);

  useEffect(() => {
    let cancelled = false;
    const loadRevision = ++draftRevisionRef.current;
    const previousKey = previousPersistenceKeyRef.current;
    previousPersistenceKeyRef.current = persistenceKey;
    if (previousKey?.endsWith(":new") && previousKey !== persistenceKey) {
      void withPromptDraftStore("readwrite", (store) => store.delete(previousKey)).catch(
        () => undefined,
      );
    }
    loadedPersistenceKeyRef.current = undefined;
    setReady(false);
    setTextInput(initialTextInput);
    setAttachmentFiles((current) => {
      for (const file of current) if (file.url.startsWith("blob:")) URL.revokeObjectURL(file.url);
      return [];
    });
    if (!persistenceKey || typeof indexedDB === "undefined") {
      loadedPersistenceKeyRef.current = persistenceKey;
      setReady(true);
      return;
    }
    void withPromptDraftStore<PersistedPromptDraft | undefined>("readonly", (store) =>
      store.get(persistenceKey),
    )
      .then((draft) => {
        if (cancelled || loadRevision !== draftRevisionRef.current || !draft) return;
        setTextInput(draft.text || "");
        setAttachmentFiles(
          draft.attachments.flatMap((file) => {
            const url = file.file ? URL.createObjectURL(file.file) : file.url;
            return url
              ? [
                  {
                    ...file,
                    id: nanoid(),
                    type: "file" as const,
                    url,
                    // FileUIPart 要求 mediaType 必填;旧草稿缺省时按二进制流兜底
                    mediaType: file.mediaType ?? "application/octet-stream",
                  },
                ]
              : [];
          }),
        );
      })
      .finally(() => {
        if (!cancelled && loadRevision === draftRevisionRef.current) {
          loadedPersistenceKeyRef.current = persistenceKey;
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialTextInput, persistenceKey]);

  useEffect(() => {
    if (
      !persistenceKey ||
      typeof indexedDB === "undefined" ||
      loadedPersistenceKeyRef.current !== persistenceKey
    ) {
      return;
    }
    const writeRevision = draftRevisionRef.current;
    const timer = window.setTimeout(() => {
      if (writeRevision !== draftRevisionRef.current) return;
      const draft: PersistedPromptDraft = {
        text: textInput,
        attachments: attachmentFiles.map((file) => ({
          filename: file.filename,
          mediaType: file.mediaType,
          byteSize: file.byteSize,
          fingerprint: file.fingerprint,
          file: file.file,
          ...(!file.url.startsWith("blob:") ? { url: file.url } : {}),
        })),
      };
      const empty = !draft.text && draft.attachments.length === 0;
      void withPromptDraftStore<undefined>("readwrite", (store) =>
        // delete/put 的 IDBRequest 泛型不同且 this 类型不变,联合推断不出单一 T;
        // 结果仅用于判断成败,统一按 undefined 断言
        empty
          ? store.delete(persistenceKey)
          : (store.put(draft, persistenceKey) as unknown as IDBRequest<undefined>),
      ).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [attachmentFiles, persistenceKey, textInput]);

  const add = useCallback((files: File[] | FileList) => {
    const incoming = [...files];
    if (incoming.length === 0) {
      return;
    }

    setAttachmentFiles((prev) => {
      const keys = new Set(prev.map(attachmentKey));
      const next: PromptAttachment[] = [];
      for (const file of incoming) {
        const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
        const key = `file:${fingerprint}`;
        if (keys.has(key)) continue;
        keys.add(key);
        next.push({
          filename: file.name,
          byteSize: file.size,
          fingerprint,
          file,
          id: nanoid(),
          mediaType: file.type,
          type: "file" as const,
          url: URL.createObjectURL(file),
        });
      }
      return [...prev, ...next];
    });
  }, []);

  const restore = useCallback((files: FileUIPart[]) => {
    if (files.length === 0) return;
    setAttachmentFiles((prev) => {
      const keys = new Set(prev.map(attachmentKey));
      const next = files.flatMap((file) => {
        const key = attachmentKey(file);
        if (keys.has(key)) return [];
        keys.add(key);
        return [{ ...file, id: nanoid() }];
      });
      return [...prev, ...next];
    });
  }, []);

  const remove = useCallback((id: string) => {
    setAttachmentFiles((prev) => {
      const found = prev.find((f) => f.id === id);
      if (found?.url.startsWith("blob:")) {
        URL.revokeObjectURL(found.url);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    clearPersistedDraft();
    setAttachmentFiles((prev) => {
      for (const f of prev) {
        if (f.url.startsWith("blob:")) {
          URL.revokeObjectURL(f.url);
        }
      }
      return [];
    });
  }, [clearPersistedDraft]);

  // Keep a ref to attachments for cleanup on unmount (avoids stale closure)
  const attachmentsRef = useRef(attachmentFiles);

  useEffect(() => {
    attachmentsRef.current = attachmentFiles;
  }, [attachmentFiles]);

  // Cleanup blob URLs on unmount to prevent memory leaks
  useEffect(
    () => () => {
      for (const f of attachmentsRef.current) {
        if (f.url.startsWith("blob:")) {
          URL.revokeObjectURL(f.url);
        }
      }
    },
    [],
  );

  const openFileDialog = useCallback(() => {
    openRef.current?.();
  }, []);

  const attachments = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear,
      fileInputRef,
      files: attachmentFiles,
      openFileDialog,
      remove,
      restore,
    }),
    [attachmentFiles, add, remove, restore, clear, openFileDialog],
  );

  const __registerFileInput = useCallback(
    (ref: RefObject<HTMLInputElement | null>, open: () => void) => {
      fileInputRef.current = ref.current;
      openRef.current = open;
    },
    [],
  );

  const controller = useMemo<PromptInputControllerProps>(
    () => ({
      __registerFileInput,
      attachments,
      ready,
      textInput: {
        clear: clearInput,
        setInput: setTextInput,
        value: textInput,
      },
    }),
    [textInput, clearInput, attachments, __registerFileInput, ready],
  );

  return (
    <PromptInputController.Provider value={controller}>
      <ProviderAttachmentsContext.Provider value={attachments}>
        {children}
      </ProviderAttachmentsContext.Provider>
    </PromptInputController.Provider>
  );
};

// ============================================================================
// Component Context & Hooks
// ============================================================================

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = () => {
  // Prefer local context (inside PromptInput) as it has validation, fall back to provider
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = local ?? provider;
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider",
    );
  }
  return context;
};

// ============================================================================
// Referenced Sources (Local to PromptInput)
// ============================================================================

export interface ReferencedSourcesContext {
  sources: (SourceDocumentUIPart & { id: string })[];
  add: (sources: SourceDocumentUIPart[] | SourceDocumentUIPart) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const LocalReferencedSourcesContext = createContext<ReferencedSourcesContext | null>(null);

export const usePromptInputReferencedSources = () => {
  const ctx = useContext(LocalReferencedSourcesContext);
  if (!ctx) {
    throw new Error(
      "usePromptInputReferencedSources must be used within a LocalReferencedSourcesContext.Provider",
    );
  }
  return ctx;
};

export type PromptInputActionAddAttachmentsProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label = "Add photos or files",
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      attachments.openFileDialog();
    },
    [attachments],
  );

  return (
    <DropdownMenuItem {...props} onClick={handleClick}>
      <ImageIcon className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

export type PromptInputActionAddScreenshotProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string;
};

export const PromptInputActionAddScreenshot = ({
  label = "Take screenshot",
  onClick,
  ...props
}: PromptInputActionAddScreenshotProps) => {
  const attachments = usePromptInputAttachments();

  const handleClick = useCallback<NonNullable<PromptInputActionAddScreenshotProps["onClick"]>>(
    async (event) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }

      try {
        const screenshot = await captureScreenshot();
        if (screenshot) {
          attachments.add([screenshot]);
        }
      } catch (error) {
        if (
          error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "AbortError")
        ) {
          return;
        }
        throw error;
      }
    },
    [onClick, attachments],
  );

  return (
    <DropdownMenuItem {...props} onClick={handleClick}>
      <Monitor className="mr-2 size-4" />
      {label}
    </DropdownMenuItem>
  );
};

export interface PromptInputMessage {
  text: string;
  files: Array<FileUIPart & { byteSize?: number; file?: File }>;
}

export interface PromptInputFileDescriptor {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit" | "onError"> & {
  // e.g., "image/*" or leave undefined for any
  accept?: string;
  multiple?: boolean;
  // When true, accepts drops anywhere on document. Default false (opt-in).
  globalDrop?: boolean;
  // Render a hidden input with given name and keep it in sync for native form posts. Default false.
  syncHiddenInput?: boolean;
  // Minimal constraints
  maxFiles?: number;
  // bytes
  maxFileSize?: number;
  maxTotalFileSize?: number;
  maxTotalFileTokens?: number;
  estimateFileTokens?: (file: PromptInputFileDescriptor) => number;
  onError?: (err: {
    code: "max_files" | "max_file_size" | "max_total_file_size" | "accept" | "duplicate";
    message: string;
  }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  accept,
  multiple,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  maxTotalFileSize,
  maxTotalFileTokens,
  estimateFileTokens,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  // Try to use a provider controller if present
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  // Refs
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // ----- Local attachments (only used when no provider)
  const [items, setItems] = useState<PromptAttachment[]>([]);
  const files = usingProvider ? controller.attachments.files : items;

  // ----- Local referenced sources (always local to PromptInput)
  const [referencedSources, setReferencedSources] = useState<
    (SourceDocumentUIPart & { id: string })[]
  >([]);

  // Keep a ref to files for cleanup on unmount (avoids stale closure)
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === "") {
        return true;
      }

      const patterns = accept
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      return patterns.some((pattern) => {
        if (pattern.endsWith("/*")) {
          // e.g: image/* -> image/
          const prefix = pattern.slice(0, -1);
          return f.type.startsWith(prefix);
        }
        if (pattern.startsWith(".")) {
          return f.name.toLowerCase().endsWith(pattern.toLowerCase());
        }
        return f.type === pattern;
      });
    },
    [accept],
  );

  const addLocal = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList];
      const accepted = incoming.filter((f) => matchesAccept(f));
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: "当前模型或应用不支持这些文件类型",
        });
        return;
      }
      const withinSize = (f: File) => (maxFileSize ? f.size <= maxFileSize : true);
      const sized = accepted.filter(withinSize);
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: "所选文件均超过单文件大小限制",
        });
        return;
      }

      setItems((prev) => {
        const fingerprints = new Set(
          prev.map((file) => file.fingerprint).filter((value): value is string => Boolean(value)),
        );
        let totalBytes = prev.reduce((sum, file) => sum + (file.byteSize ?? 0), 0);
        let totalTokens = prev.reduce(
          (sum, file) =>
            sum +
            (estimateFileTokens?.({
              name: file.filename ?? "未命名附件",
              size: file.byteSize ?? 0,
              type: file.mediaType ?? "",
              lastModified: file.file?.lastModified ?? 0,
            }) ?? 0),
          0,
        );
        const unique = sized.filter((file) => {
          const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
          if (fingerprints.has(fingerprint)) return false;
          fingerprints.add(fingerprint);
          return true;
        });
        if (unique.length < sized.length) {
          onError?.({ code: "duplicate", message: "已忽略重复附件" });
        }
        const withinTotal = unique.filter((file) => {
          if (maxTotalFileSize !== undefined && totalBytes + file.size > maxTotalFileSize)
            return false;
          const fileTokens =
            estimateFileTokens?.({
              name: file.name,
              size: file.size,
              type: file.type,
              lastModified: file.lastModified,
            }) ?? 0;
          if (maxTotalFileTokens !== undefined && totalTokens + fileTokens > maxTotalFileTokens)
            return false;
          totalBytes += file.size;
          totalTokens += fileTokens;
          return true;
        });
        if (withinTotal.length < unique.length) {
          onError?.({ code: "max_total_file_size", message: "附件总大小超过上传限制或上下文预算" });
        }
        const capacity =
          typeof maxFiles === "number" ? Math.max(0, maxFiles - prev.length) : undefined;
        const capped = typeof capacity === "number" ? withinTotal.slice(0, capacity) : withinTotal;
        if (typeof capacity === "number" && withinTotal.length > capacity) {
          onError?.({
            code: "max_files",
            message: "附件数量超过限制，部分文件未添加",
          });
        }
        const next: PromptAttachment[] = [];
        for (const file of capped) {
          next.push({
            filename: file.name,
            byteSize: file.size,
            fingerprint: `${file.name}:${file.size}:${file.lastModified}`,
            file,
            id: nanoid(),
            mediaType: file.type,
            type: "file",
            url: URL.createObjectURL(file),
          });
        }
        return [...prev, ...next];
      });
    },
    [
      estimateFileTokens,
      matchesAccept,
      maxFiles,
      maxFileSize,
      maxTotalFileSize,
      maxTotalFileTokens,
      onError,
    ],
  );

  const removeLocal = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) {
          URL.revokeObjectURL(found.url);
        }
        return prev.filter((file) => file.id !== id);
      }),
    [],
  );

  const restoreLocal = useCallback((incoming: FileUIPart[]) => {
    if (incoming.length === 0) return;
    setItems((prev) => [...prev, ...incoming.map((file) => ({ ...file, id: nanoid() }))]);
  }, []);

  // Wrapper that validates files before calling provider's add
  const addWithProviderValidation = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList];
      const accepted = incoming.filter((f) => matchesAccept(f));
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: "当前模型或应用不支持这些文件类型",
        });
        return;
      }
      const withinSize = (f: File) => (maxFileSize ? f.size <= maxFileSize : true);
      const sized = accepted.filter(withinSize);
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: "所选文件均超过单文件大小限制",
        });
        return;
      }

      const existingFingerprints = new Set(
        files.map((file) =>
          "fingerprint" in file && typeof file.fingerprint === "string"
            ? file.fingerprint
            : `${file.filename ?? ""}:${"byteSize" in file ? String(file.byteSize) : ""}`,
        ),
      );
      const unique = sized.filter(
        (file) => !existingFingerprints.has(`${file.name}:${file.size}:${file.lastModified}`),
      );
      if (unique.length < sized.length) {
        onError?.({ code: "duplicate", message: "已忽略重复附件" });
      }
      let totalBytes = files.reduce(
        (sum, file) =>
          sum + ("byteSize" in file && typeof file.byteSize === "number" ? file.byteSize : 0),
        0,
      );
      let totalTokens = files.reduce(
        (sum, file) =>
          sum +
          (estimateFileTokens?.({
            name: file.filename ?? "未命名附件",
            size: "byteSize" in file && typeof file.byteSize === "number" ? file.byteSize : 0,
            type: file.mediaType ?? "",
            lastModified: "file" in file && file.file instanceof File ? file.file.lastModified : 0,
          }) ?? 0),
        0,
      );
      const withinTotal = unique.filter((file) => {
        if (maxTotalFileSize !== undefined && totalBytes + file.size > maxTotalFileSize)
          return false;
        const fileTokens =
          estimateFileTokens?.({
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified,
          }) ?? 0;
        if (maxTotalFileTokens !== undefined && totalTokens + fileTokens > maxTotalFileTokens)
          return false;
        totalBytes += file.size;
        totalTokens += fileTokens;
        return true;
      });
      if (withinTotal.length < unique.length) {
        onError?.({
          code: "max_total_file_size",
          message: "附件总大小超过当前模型的可用上下文预算",
        });
      }

      const currentCount = files.length;
      const capacity =
        typeof maxFiles === "number" ? Math.max(0, maxFiles - currentCount) : undefined;
      const capped = typeof capacity === "number" ? withinTotal.slice(0, capacity) : withinTotal;
      if (typeof capacity === "number" && withinTotal.length > capacity) {
        onError?.({
          code: "max_files",
          message: "附件数量超过限制，部分文件未添加",
        });
      }

      if (capped.length > 0) {
        controller?.attachments.add(capped);
      }
    },
    [
      controller,
      estimateFileTokens,
      files,
      matchesAccept,
      maxFileSize,
      maxFiles,
      maxTotalFileSize,
      maxTotalFileTokens,
      onError,
    ],
  );

  const clearAttachments = useCallback(
    () =>
      usingProvider
        ? controller?.attachments.clear()
        : setItems((prev) => {
            for (const file of prev) {
              if (file.url) {
                URL.revokeObjectURL(file.url);
              }
            }
            return [];
          }),
    [usingProvider, controller],
  );

  const clearReferencedSources = useCallback(() => setReferencedSources([]), []);

  const add = usingProvider ? addWithProviderValidation : addLocal;
  const restore = usingProvider ? controller.attachments.restore : restoreLocal;
  const remove = usingProvider ? controller.attachments.remove : removeLocal;
  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;

  const clear = useCallback(() => {
    clearAttachments();
    clearReferencedSources();
  }, [clearAttachments, clearReferencedSources]);

  // Let provider know about our hidden file input so external menus can call openFileDialog()
  useEffect(() => {
    if (!usingProvider) {
      return;
    }
    controller.__registerFileInput(inputRef, () => inputRef.current?.click());
  }, [usingProvider, controller]);

  // Note: File input cannot be programmatically set for security reasons
  // The syncHiddenInput prop is no longer functional
  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = "";
    }
  }, [files, syncHiddenInput]);

  // Attach drop handlers on nearest form and document (opt-in)
  useEffect(() => {
    const form = formRef.current;
    if (!form) {
      return;
    }
    if (globalDrop) {
      // when global drop is on, let the document-level handler own drops
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("drop", onDrop);
    return () => {
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(() => {
    if (!globalDrop) {
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) {
          if (f.url) {
            URL.revokeObjectURL(f.url);
          }
        }
      }
    },
    [usingProvider],
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      if (event.currentTarget.files) {
        add(event.currentTarget.files);
      }
      // Reset input value to allow selecting files that were previously removed
      event.currentTarget.value = "";
    },
    [add],
  );

  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear: clearAttachments,
      fileInputRef: inputRef,
      files: files.map((item) => ({ ...item, id: item.id })),
      openFileDialog,
      remove,
      restore,
    }),
    [files, add, remove, restore, clearAttachments, openFileDialog],
  );

  const refsCtx = useMemo<ReferencedSourcesContext>(
    () => ({
      add: (incoming: SourceDocumentUIPart[] | SourceDocumentUIPart) => {
        const array = Array.isArray(incoming) ? incoming : [incoming];
        setReferencedSources((prev) => [...prev, ...array.map((s) => ({ ...s, id: nanoid() }))]);
      },
      clear: clearReferencedSources,
      remove: (id: string) => {
        setReferencedSources((prev) => prev.filter((s) => s.id !== id));
      },
      sources: referencedSources,
    }),
    [referencedSources, clearReferencedSources],
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault();

      const form = event.currentTarget;
      const text = usingProvider
        ? controller.textInput.value
        : (() => {
            const formData = new FormData(form);
            return (formData.get("message") as string) || "";
          })();

      // Reset form immediately after capturing text to avoid race condition
      // where user input during async blob conversion would be lost
      if (!usingProvider) {
        form.reset();
      }

      try {
        const convertedFiles = files.map(({ id: _id, fingerprint: _fingerprint, ...item }) => item);

        const result = onSubmit({ files: convertedFiles, text }, event);

        // Handle both sync and async onSubmit
        if (result instanceof Promise) {
          try {
            await result;
            clear();
            if (usingProvider) {
              controller.textInput.clear();
            }
          } catch {
            // Don't clear on error - user may want to retry
          }
        } else {
          // Sync function completed without throwing, clear inputs
          clear();
          if (usingProvider) {
            controller.textInput.clear();
          }
        }
      } catch {
        // Don't clear on error - user may want to retry
      }
    },
    [usingProvider, controller, files, onSubmit, clear],
  );

  // Render with or without local provider
  const inner = (
    <>
      <input
        accept={accept}
        aria-label="Upload files"
        className="hidden"
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        title="Upload files"
        type="file"
      />
      <form className={cn("w-full", className)} onSubmit={handleSubmit} ref={formRef} {...props}>
        <InputGroup className="overflow-visible border border-border bg-card shadow-sm rounded-xl transition-all focus-within:border-ring">
          {children}
        </InputGroup>
      </form>
    </>
  );

  const withReferencedSources = (
    <LocalReferencedSourcesContext.Provider value={refsCtx}>
      {inner}
    </LocalReferencedSourcesContext.Provider>
  );

  // Always provide LocalAttachmentsContext so children get validated add function
  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      {withReferencedSources}
    </LocalAttachmentsContext.Provider>
  );
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      // Call the external onKeyDown handler first
      onKeyDown?.(e);

      // If the external handler prevented default, don't run internal logic
      if (e.defaultPrevented) {
        return;
      }

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) {
          return;
        }
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();

        // Check if the submit button is disabled before submitting
        const { form } = e.currentTarget;
        const submitButton = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        if (submitButton?.disabled) {
          return;
        }

        form?.requestSubmit();
      }

      // Remove last attachment when Backspace is pressed and textarea is empty
      if (e.key === "Backspace" && e.currentTarget.value === "" && attachments.files.length > 0) {
        e.preventDefault();
        const lastAttachment = attachments.files.at(-1);
        if (lastAttachment) {
          attachments.remove(lastAttachment.id);
        }
      }
    },
    [onKeyDown, isComposing, attachments],
  );

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      const items = event.clipboardData?.items;

      if (!items) {
        return;
      }

      const files: File[] = [];

      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length > 0) {
        event.preventDefault();
        attachments.add(files);
      }
    },
    [attachments],
  );

  const handleCompositionEnd = useCallback(() => setIsComposing(false), []);
  const handleCompositionStart = useCallback(() => setIsComposing(true), []);

  const controlledProps = controller
    ? {
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value);
          onChange?.(e);
        },
        value: controller.textInput.value,
      }
    : {
        onChange,
      };

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
      {...controlledProps}
    />
  );
};

export type PromptInputHeaderProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputHeader = ({ className, ...props }: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("order-first flex-wrap gap-1", className)}
    {...props}
  />
);

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  // gap-0:左右两组之间的距离由右组的 ml-auto(弹性空白)独占提供。留着 gap 会在
  // 那段空白之外再吃掉固定宽度,让「空白见底」提前发生,也让实测的最小宽度虚高。
  // 必须显式归零 —— 不写的话会回落到 InputGroupAddon 基类的 gap-2。
  <InputGroupAddon align="block-end" className={cn("justify-between gap-0", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex min-w-0 items-center gap-1", className)} {...props} />
);

export type PromptInputButtonTooltip =
  | string
  | {
      content: ReactNode;
      shortcut?: string;
      side?: ComponentProps<typeof TooltipContent>["side"];
    };

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton> & {
  tooltip?: PromptInputButtonTooltip;
};

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  tooltip,
  ...props
}: PromptInputButtonProps) => {
  const newSize = size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm");

  const button = (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  const tooltipContent = typeof tooltip === "string" ? tooltip : tooltip.content;
  const shortcut = typeof tooltip === "string" ? undefined : tooltip.shortcut;
  const side = typeof tooltip === "string" ? "top" : (tooltip.side ?? "top");

  return (
    <Tooltip>
      <TooltipTrigger>{button}</TooltipTrigger>
      <TooltipContent side={side}>
        {tooltipContent}
        {shortcut && <span className="ml-2 text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
};

export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;
export const PromptInputActionMenu = (props: PromptInputActionMenuProps) => (
  <DropdownMenu {...props} />
);

export type PromptInputActionMenuTriggerProps = PromptInputButtonProps;

export const PromptInputActionMenuTrigger = ({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) => (
  <DropdownMenuTrigger render={<PromptInputButton className={className} {...props} />}>
    {children ?? <PlusIcon className="size-4" />}
  </DropdownMenuTrigger>
);

export type PromptInputActionMenuContentProps = ComponentProps<typeof DropdownMenuContent>;
export const PromptInputActionMenuContent = ({
  className,
  ...props
}: PromptInputActionMenuContentProps) => (
  <DropdownMenuContent align="start" className={cn(className)} {...props} />
);

export type PromptInputActionMenuItemProps = ComponentProps<typeof DropdownMenuItem>;
export const PromptInputActionMenuItem = ({
  className,
  ...props
}: PromptInputActionMenuItemProps) => <DropdownMenuItem className={cn(className)} {...props} />;

// Note: Actions that perform side-effects (like opening a file dialog)
// are provided in opt-in modules (e.g., prompt-input-attachments).

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === "submitted" || status === "streaming";

  let Icon = <CornerDownLeftIcon className="size-4" />;

  if (status === "submitted") {
    Icon = <Spinner />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-4" />;
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />;
  }

  const handleClick = useCallback<NonNullable<PromptInputSubmitProps["onClick"]>>(
    (e) => {
      if (isGenerating && onStop) {
        e.preventDefault();
        onStop();
        return;
      }
      onClick?.(e);
    },
    [isGenerating, onStop, onClick],
  );

  return (
    <InputGroupButton
      aria-label={isGenerating ? "Stop" : "Submit"}
      className={cn(className)}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? "button" : "submit"}
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  );
};

export type PromptInputSelectProps = ComponentProps<typeof Select>;

export const PromptInputSelect = (props: PromptInputSelectProps) => <Select {...props} />;

export type PromptInputSelectTriggerProps = ComponentProps<typeof SelectTrigger>;

export const PromptInputSelectTrigger = ({
  className,
  ...props
}: PromptInputSelectTriggerProps) => (
  <SelectTrigger
    className={cn(
      "border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors",
      "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
      className,
    )}
    {...props}
  />
);

export type PromptInputSelectContentProps = ComponentProps<typeof SelectContent>;

export const PromptInputSelectContent = ({
  className,
  ...props
}: PromptInputSelectContentProps) => <SelectContent className={cn(className)} {...props} />;

export type PromptInputSelectItemProps = ComponentProps<typeof SelectItem>;

export const PromptInputSelectItem = ({ className, ...props }: PromptInputSelectItemProps) => (
  <SelectItem className={cn(className)} {...props} />
);

export type PromptInputSelectValueProps = ComponentProps<typeof SelectValue>;

export const PromptInputSelectValue = ({ className, ...props }: PromptInputSelectValueProps) => (
  <SelectValue className={cn(className)} {...props} />
);

export type PromptInputHoverCardProps = ComponentProps<typeof HoverCard>;

export const PromptInputHoverCard = (props: PromptInputHoverCardProps) => <HoverCard {...props} />;

export type PromptInputHoverCardTriggerProps = ComponentProps<typeof HoverCardTrigger> & {
  /** How long to wait before the preview opens (ms). Base UI Trigger API. */
  delay?: number;
  /** How long to wait before the preview closes (ms). Base UI Trigger API. */
  closeDelay?: number;
};

export const PromptInputHoverCardTrigger = ({
  delay = 0,
  closeDelay = 0,
  ...props
}: PromptInputHoverCardTriggerProps) => (
  <HoverCardTrigger closeDelay={closeDelay} delay={delay} {...props} />
);

export type PromptInputHoverCardContentProps = ComponentProps<typeof HoverCardContent>;

export const PromptInputHoverCardContent = ({
  align = "start",
  ...props
}: PromptInputHoverCardContentProps) => <HoverCardContent align={align} {...props} />;

export type PromptInputTabsListProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabsList = ({ className, ...props }: PromptInputTabsListProps) => (
  <div className={cn(className)} {...props} />
);

export type PromptInputTabProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTab = ({ className, ...props }: PromptInputTabProps) => (
  <div className={cn(className)} {...props} />
);

export type PromptInputTabLabelProps = HTMLAttributes<HTMLHeadingElement>;

export const PromptInputTabLabel = ({ className, ...props }: PromptInputTabLabelProps) => (
  // Content provided via children in props
  // oxlint-disable-next-line eslint-plugin-jsx-a11y(heading-has-content)
  <h3 className={cn("mb-2 px-3 font-medium text-muted-foreground text-xs", className)} {...props} />
);

export type PromptInputTabBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabBody = ({ className, ...props }: PromptInputTabBodyProps) => (
  <div className={cn("space-y-1", className)} {...props} />
);

export type PromptInputTabItemProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabItem = ({ className, ...props }: PromptInputTabItemProps) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent", className)}
    {...props}
  />
);

export type PromptInputCommandProps = ComponentProps<typeof Command>;

export const PromptInputCommand = ({ className, ...props }: PromptInputCommandProps) => (
  <Command className={cn(className)} {...props} />
);

export type PromptInputCommandInputProps = ComponentProps<typeof CommandInput>;

export const PromptInputCommandInput = ({ className, ...props }: PromptInputCommandInputProps) => (
  <CommandInput className={cn(className)} {...props} />
);

export type PromptInputCommandListProps = ComponentProps<typeof CommandList>;

export const PromptInputCommandList = ({ className, ...props }: PromptInputCommandListProps) => (
  <CommandList className={cn(className)} {...props} />
);

export type PromptInputCommandEmptyProps = ComponentProps<typeof CommandEmpty>;

export const PromptInputCommandEmpty = ({ className, ...props }: PromptInputCommandEmptyProps) => (
  <CommandEmpty className={cn(className)} {...props} />
);

export type PromptInputCommandGroupProps = ComponentProps<typeof CommandGroup>;

export const PromptInputCommandGroup = ({ className, ...props }: PromptInputCommandGroupProps) => (
  <CommandGroup className={cn(className)} {...props} />
);

export type PromptInputCommandItemProps = ComponentProps<typeof CommandItem>;

export const PromptInputCommandItem = ({ className, ...props }: PromptInputCommandItemProps) => (
  <CommandItem className={cn(className)} {...props} />
);

export type PromptInputCommandSeparatorProps = ComponentProps<typeof CommandSeparator>;

export const PromptInputCommandSeparator = ({
  className,
  ...props
}: PromptInputCommandSeparatorProps) => <CommandSeparator className={cn(className)} {...props} />;
