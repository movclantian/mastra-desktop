import * as React from "react";
import { toast } from "sonner";
import {
  DEFAULT_LIBRARY_SETTINGS,
  fetchLibraryContents,
  fetchLibrarySettings,
  type LibraryAsset,
  type LibraryFolder,
  type LibrarySettings,
} from "@/entities/library";
import { toastError } from "@/shared/lib";

interface UseLibraryDataOptions {
  resourceId: string;
  settingsOpen: boolean;
}

export interface LibraryDataState {
  assets: LibraryAsset[];
  setAssets: React.Dispatch<React.SetStateAction<LibraryAsset[]>>;
  folders: LibraryFolder[];
  setFolders: React.Dispatch<React.SetStateAction<LibraryFolder[]>>;
  settings: LibrarySettings;
  setSettings: React.Dispatch<React.SetStateAction<LibrarySettings>>;
  loading: boolean;
  refresh: (silent?: boolean) => Promise<void>;
}

export function useLibraryData({
  resourceId,
  settingsOpen,
}: UseLibraryDataOptions): LibraryDataState {
  const [assets, setAssets] = React.useState<LibraryAsset[]>([]);
  const [folders, setFolders] = React.useState<LibraryFolder[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [settings, setSettings] = React.useState<LibrarySettings>(DEFAULT_LIBRARY_SETTINGS);

  const refresh = React.useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const next = await fetchLibraryContents(resourceId);
        setAssets(next.assets);
        setFolders(next.folders);
      } catch (error) {
        toastError(error, "读取资料库失败");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [resourceId],
  );

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!assets.some((asset) => asset.status === "indexing")) return;
    const timer = window.setTimeout(() => void refresh(true), 1_500);
    return () => window.clearTimeout(timer);
  }, [assets, refresh]);

  React.useEffect(() => {
    if (!settingsOpen) return;
    void fetchLibrarySettings()
      .then((nextSettings) => setSettings(nextSettings))
      .catch(() => toast.error("读取资料库设置失败"));
  }, [settingsOpen]);

  return {
    assets,
    setAssets,
    folders,
    setFolders,
    settings,
    setSettings,
    loading,
    refresh,
  };
}
