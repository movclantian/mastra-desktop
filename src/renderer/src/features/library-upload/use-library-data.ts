import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import {
  DEFAULT_LIBRARY_SETTINGS,
  fetchLibraryContents,
  fetchLibrarySettings,
  type LibraryAsset,
  type LibraryFolder,
  type LibrarySettings,
} from "@/entities/library";
import { qk } from "@/entities/workbench";
import { useTranslation } from "@/shared/i18n";
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const contentsQuery = useQuery<{ assets: LibraryAsset[]; folders: LibraryFolder[] }>({
    queryKey: qk.libraryContents(resourceId),
    queryFn: () => fetchLibraryContents(resourceId),
    refetchInterval: (query) =>
      query.state.data?.assets.some((asset) => asset.status === "indexing") ? 1_500 : false,
  });
  const settingsQuery = useQuery({
    queryKey: qk.librarySettings(),
    queryFn: fetchLibrarySettings,
    enabled: settingsOpen,
    staleTime: 30_000,
  });
  const assets = contentsQuery.data?.assets ?? [];
  const folders = contentsQuery.data?.folders ?? [];
  const settings = settingsQuery.data ?? DEFAULT_LIBRARY_SETTINGS;
  const setAssets = React.useCallback<React.Dispatch<React.SetStateAction<LibraryAsset[]>>>(
    (updater) => {
      queryClient.setQueryData<{ assets: LibraryAsset[]; folders: LibraryFolder[] }>(
        qk.libraryContents(resourceId),
        (current) => {
          const data = current ?? { assets: [], folders: [] };
          return {
            ...data,
            assets: typeof updater === "function" ? updater(data.assets) : updater,
          };
        },
      );
    },
    [queryClient, resourceId],
  );
  const setFolders = React.useCallback<React.Dispatch<React.SetStateAction<LibraryFolder[]>>>(
    (updater) => {
      queryClient.setQueryData<{ assets: LibraryAsset[]; folders: LibraryFolder[] }>(
        qk.libraryContents(resourceId),
        (current) => {
          const data = current ?? { assets: [], folders: [] };
          return {
            ...data,
            folders: typeof updater === "function" ? updater(data.folders) : updater,
          };
        },
      );
    },
    [queryClient, resourceId],
  );
  const setSettings = React.useCallback<React.Dispatch<React.SetStateAction<LibrarySettings>>>(
    (updater) => {
      queryClient.setQueryData<LibrarySettings>(qk.librarySettings(), (current) =>
        typeof updater === "function" ? updater(current ?? DEFAULT_LIBRARY_SETTINGS) : updater,
      );
    },
    [queryClient],
  );

  const refresh = React.useCallback(
    async (_silent = false) => {
      try {
        const next = await queryClient.fetchQuery({
          queryKey: qk.libraryContents(resourceId),
          queryFn: () => fetchLibraryContents(resourceId),
          staleTime: 0,
        });
        queryClient.setQueryData(qk.libraryContents(resourceId), next);
      } catch (error) {
        toastError(error, t("library:readLibraryFailed"));
      }
    },
    [queryClient, resourceId, t],
  );

  return {
    assets,
    setAssets,
    folders,
    setFolders,
    settings,
    setSettings,
    loading: contentsQuery.isPending,
    refresh,
  };
}
