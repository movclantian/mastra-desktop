import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSessionInfo } from "@/features/terminal/types";
import type { MainView } from "./navigation";
import { reportWorkbenchState } from "./reporting";
import type {
  ActivePanelTab,
  BrowserRequest,
  LocalPanelTab,
  PanelTabKind,
  TerminalRequest,
} from "./types";

interface UseWorkbenchPanelsOptions {
  resourceId: string;
  activeThreadId: string | null;
  activeView: MainView;
  setActiveView: (view: MainView) => void;
}

export interface WorkbenchPanelsState {
  workspacePanelOpen: boolean;
  setWorkspacePanelOpen: (open: boolean) => void;
  panelTabs: LocalPanelTab[];
  activePanelTab: ActivePanelTab;
  activatePanelTab: (tab: ActivePanelTab) => void;
  addPanelTab: (kind: "files" | "terminal" | "changes") => string;
  closePanelTab: (id: string) => void;
  openWorkspacePanel: (kind?: PanelTabKind) => void;
  terminalPanelOpen: boolean;
  setTerminalPanelOpen: (open: boolean) => void;
  promptMinWidth: number;
  reportPromptMinWidth: (width: number) => void;
  reportTerminalSession: (id: string, info: TerminalSessionInfo | null) => void;
  terminalRequest: TerminalRequest | null;
  requestTerminalCommand: (request: Omit<TerminalRequest, "id">) => void;
  browserRequest: BrowserRequest | null;
  openBrowserUrl: (url: string) => void;
}

function isSamePanelTab(left: ActivePanelTab, right: ActivePanelTab): boolean {
  if (left.kind === "welcome" || right.kind === "welcome") {
    return left.kind === right.kind;
  }
  if (left.kind === "browser" || right.kind === "browser") {
    return left.kind === "browser" && right.kind === "browser" && left.index === right.index;
  }
  return left.kind === right.kind && left.id === right.id;
}

function panelLabel(kind: "files" | "terminal" | "changes"): string {
  return kind === "files" ? "文件" : kind === "terminal" ? "终端" : "代码更改";
}

export function useWorkbenchPanels({
  resourceId,
  activeThreadId,
  activeView,
  setActiveView,
}: UseWorkbenchPanelsOptions): WorkbenchPanelsState {
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [panelTabs, setPanelTabs] = useState<LocalPanelTab[]>([]);
  const [activePanelTab, setActivePanelTab] = useState<ActivePanelTab>({
    kind: "welcome",
    id: "welcome",
  });
  const panelTabCountsRef = useRef({ files: 0, terminal: 0, changes: 0 });
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(false);
  const [terminalRequest, setTerminalRequest] = useState<TerminalRequest | null>(null);
  const terminalRequestIdRef = useRef(0);
  const [browserRequest, setBrowserRequest] = useState<BrowserRequest | null>(null);
  const browserRequestIdRef = useRef(0);
  const terminalSessionsRef = useRef(new Map<string, TerminalSessionInfo>());
  const [terminalSessionsVersion, setTerminalSessionsVersion] = useState(0);
  const [promptMinWidth, setPromptMinWidth] = useState(0);

  useEffect(() => {
    reportWorkbenchState(activeThreadId, resourceId, {
      workbench: {
        workspacePanelOpen,
        workspacePanelTab: activePanelTab.kind,
        terminalPanelOpen,
        libraryOpen: activeView === "library",
      },
    });
  }, [
    activePanelTab.kind,
    activeThreadId,
    activeView,
    resourceId,
    terminalPanelOpen,
    workspacePanelOpen,
  ]);

  useEffect(() => {
    void terminalSessionsVersion;
    const sessions = [...terminalSessionsRef.current.values()];
    if (sessions.length === 0) {
      reportWorkbenchState(activeThreadId, resourceId, {
        terminal: { open: false, sessionCount: 0 },
      });
      return;
    }
    const settled = sessions
      .filter((session) => session.settledAt !== undefined)
      .sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0))[0];
    const focused = sessions.find((session) => session.status === "ready") ?? sessions[0];
    reportWorkbenchState(activeThreadId, resourceId, {
      terminal: {
        open: true,
        sessionCount: sessions.length,
        activeTitle: focused.title,
        activeStatus: focused.status,
        ...(settled?.lastCommand ? { lastCommand: settled.lastCommand } : {}),
        ...(settled?.lastExitCode === undefined ? {} : { lastExitCode: settled.lastExitCode }),
      },
    });
  }, [activeThreadId, resourceId, terminalSessionsVersion]);

  const activatePanelTab = useCallback((tab: ActivePanelTab) => {
    setActivePanelTab((active) => (isSamePanelTab(active, tab) ? active : tab));
    setWorkspacePanelOpen(true);
  }, []);

  const addPanelTab = useCallback((kind: "files" | "terminal" | "changes") => {
    const id = nanoid();
    const counts = panelTabCountsRef.current;
    counts[kind] += 1;
    const title = panelLabel(kind);
    setPanelTabs((current) => [
      ...current,
      { id, kind, title: counts[kind] > 1 ? `${title} ${counts[kind]}` : title },
    ]);
    setActivePanelTab({ kind, id });
    setWorkspacePanelOpen(true);
    return id;
  }, []);

  const closePanelTab = useCallback((id: string) => {
    setPanelTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const next = current.filter((tab) => tab.id !== id);
      setActivePanelTab((active) => {
        if (active.kind === "browser" || active.id !== id) return active;
        const neighbor = next[Math.max(0, index - 1)];
        return neighbor
          ? { kind: neighbor.kind, id: neighbor.id }
          : { kind: "welcome", id: "welcome" };
      });
      return next;
    });
  }, []);

  const openWorkspacePanel = useCallback((kind?: PanelTabKind) => {
    setWorkspacePanelOpen(true);
    if (!kind || kind === "welcome") {
      setActivePanelTab((active) =>
        active.kind === "welcome" ? active : { kind: "welcome", id: "welcome" },
      );
      return;
    }
    if (kind === "browser") {
      setActivePanelTab((active) =>
        active.kind === "browser" ? active : { kind: "browser", index: 0 },
      );
      return;
    }
    setPanelTabs((current) => {
      const existing = current.find((tab) => tab.kind === kind);
      if (existing) {
        const next = { kind, id: existing.id } as ActivePanelTab;
        setActivePanelTab((active) => (isSamePanelTab(active, next) ? active : next));
        return current;
      }
      const id = nanoid();
      const counts = panelTabCountsRef.current;
      counts[kind] += 1;
      const title = panelLabel(kind);
      setActivePanelTab({ kind, id });
      return [
        ...current,
        { id, kind, title: counts[kind] > 1 ? `${title} ${counts[kind]}` : title },
      ];
    });
  }, []);

  const reportPromptMinWidth = useCallback((width: number) => {
    const rounded = Math.ceil(width);
    setPromptMinWidth((current) => (current === rounded ? current : rounded));
  }, []);

  const reportTerminalSession = useCallback((id: string, info: TerminalSessionInfo | null) => {
    if (info) terminalSessionsRef.current.set(id, info);
    else if (!terminalSessionsRef.current.delete(id)) return;
    setTerminalSessionsVersion((version) => version + 1);
  }, []);

  const requestTerminalCommand = useCallback((request: Omit<TerminalRequest, "id">) => {
    setTerminalPanelOpen(true);
    setTerminalRequest({ ...request, id: ++terminalRequestIdRef.current });
  }, []);

  const openBrowserUrl = useCallback(
    (url: string) => {
      const normalized = url.trim();
      if (!normalized) return;
      try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      } catch {
        return;
      }
      setActiveView("chat");
      setActivePanelTab((active) =>
        active.kind === "browser" ? active : { kind: "browser", index: 0 },
      );
      setWorkspacePanelOpen(true);
      setBrowserRequest({
        id: ++browserRequestIdRef.current,
        newTab: true,
        threadId: activeThreadId,
        url: normalized,
      });
    },
    [activeThreadId, setActiveView],
  );

  return {
    workspacePanelOpen,
    setWorkspacePanelOpen,
    panelTabs,
    activePanelTab,
    activatePanelTab,
    addPanelTab,
    closePanelTab,
    openWorkspacePanel,
    terminalPanelOpen,
    setTerminalPanelOpen,
    promptMinWidth,
    reportPromptMinWidth,
    reportTerminalSession,
    terminalRequest,
    requestTerminalCommand,
    browserRequest,
    openBrowserUrl,
  };
}
