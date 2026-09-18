import * as React from "react";
import { toast } from "sonner";
import type { McpSummary, SkillDetail, SkillMetadata, SkillSection } from "@/entities/skill";
import {
  authenticateMcpServer,
  deleteMcpServer,
  deleteSkill,
  importSkill as importSkillRequest,
  installSkill as installSkillRequest,
  setMcpServerEnabled,
  updateSkill as updateSkillRequest,
  uploadSkillArchive,
} from "@/entities/skill";
import { useTranslation } from "@/shared/i18n";
import { toastError } from "@/shared/lib";

interface UseSkillActionsOptions {
  activeSkill: SkillMetadata | null;
  setActiveSkill: (skill: SkillMetadata | null) => void;
  setDetail: React.Dispatch<React.SetStateAction<SkillDetail | null>>;
  setSection: React.Dispatch<React.SetStateAction<SkillSection>>;
  setAddSkillOpen: (open: boolean) => void;
  loadInstalled: () => Promise<void>;
  loadMcp: () => Promise<void>;
}

export interface SkillActionsState {
  inputRef: React.RefObject<HTMLInputElement | null>;
  installing: string | null;
  uploading: boolean;
  uploadSkill: (file: File | undefined) => Promise<void>;
  importSkill: (source: string) => Promise<void>;
  installBuiltin: (skill: SkillMetadata) => Promise<void>;
  removeSkill: (targetSkill?: SkillMetadata) => Promise<void>;
  updateSkill: (
    name: string,
    patch: { description?: string; instructions?: string; enabled?: boolean },
  ) => Promise<void>;
  toggleSkill: (skill: SkillMetadata, enabled: boolean) => Promise<void>;
  removeMcp: (server: McpSummary) => Promise<void>;
  toggleMcp: (server: McpSummary, enabled: boolean) => Promise<void>;
  authenticateMcp: (server: McpSummary) => Promise<void>;
}

export function useSkillActions({
  activeSkill,
  setActiveSkill,
  setDetail,
  setSection,
  setAddSkillOpen,
  loadInstalled,
  loadMcp,
}: UseSkillActionsOptions): SkillActionsState {
  const { t } = useTranslation();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const uploadSkill = React.useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith(".zip")) {
        toast.error(t("skills:zipRequired"));
        return;
      }
      setUploading(true);
      try {
        const skill = await uploadSkillArchive(file);
        await loadInstalled();
        setSection("personal");
        setActiveSkill(skill);
        setAddSkillOpen(false);
        toast.success(t("skills:addSuccess", { name: skill.name }));
      } catch (error) {
        toastError(error, t("skills:addFailed"));
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [loadInstalled, setActiveSkill, setAddSkillOpen, setSection, t],
  );

  const importSkill = React.useCallback(
    async (source: string) => {
      setUploading(true);
      try {
        const skill = await importSkillRequest(source);
        await loadInstalled();
        setSection("personal");
        setActiveSkill(skill);
        setAddSkillOpen(false);
        toast.success(t("skills:importSuccess", { name: skill.name }));
      } catch (error) {
        toastError(error, t("skills:importFailed"));
      } finally {
        setUploading(false);
      }
    },
    [loadInstalled, setActiveSkill, setAddSkillOpen, setSection, t],
  );

  const installBuiltin = React.useCallback(
    async (skill: SkillMetadata) => {
      setInstalling(skill.name);
      try {
        const installedSkill = await installSkillRequest(skill);
        await loadInstalled();
        toast.success(t("skills:installSuccess", { name: installedSkill.name }));
      } catch (error) {
        toastError(error, t("skills:installFailed"));
      } finally {
        setInstalling(null);
      }
    },
    [loadInstalled, t],
  );

  const removeSkill = React.useCallback(
    async (targetSkill?: SkillMetadata) => {
      const skillToDelete = targetSkill || activeSkill;
      if (
        !skillToDelete ||
        !window.confirm(t("skills:deleteConfirm", { name: skillToDelete.name }))
      )
        return;
      try {
        await deleteSkill(skillToDelete.name);
      } catch {
        toast.error(t("skills:deleteFailed"));
        return;
      }
      if (activeSkill?.name === skillToDelete.name) {
        setActiveSkill(null);
        setDetail(null);
      }
      await loadInstalled();
      toast.success(t("skills:deleteSuccess"));
    },
    [activeSkill, loadInstalled, setActiveSkill, setDetail, t],
  );

  const updateSkill = React.useCallback(
    async (
      name: string,
      patch: { description?: string; instructions?: string; enabled?: boolean },
    ) => {
      try {
        const updated = await updateSkillRequest(name, patch);
        await loadInstalled();
        setDetail((prev) => (prev && prev.name === name ? { ...prev, ...updated } : prev));
        toast.success(t("skills:saveSuccess"));
      } catch (error) {
        toastError(error, t("skills:saveFailed"));
        throw error;
      }
    },
    [loadInstalled, setDetail, t],
  );

  const toggleSkill = React.useCallback(
    async (skill: SkillMetadata, enabled: boolean) => {
      try {
        await updateSkillRequest(skill.name, { enabled });
        await loadInstalled();
        toast.success(
          enabled
            ? t("skills:statusEnabled", { name: skill.name })
            : t("skills:statusDisabled", { name: skill.name }),
        );
      } catch (error) {
        toastError(error, t("skills:statusUpdateFailed"));
      }
    },
    [loadInstalled, t],
  );

  const removeMcp = React.useCallback(
    async (server: McpSummary) => {
      if (!window.confirm(t("mcp:deleteConfirm", { name: server.name }))) return;
      try {
        await deleteMcpServer(server.id);
      } catch {
        toast.error(t("mcp:deleteFailed"));
        return;
      }
      await loadMcp();
      toast.success(t("mcp:deleteSuccess"));
    },
    [loadMcp, t],
  );

  const authenticateMcp = React.useCallback(
    async (server: McpSummary) => {
      try {
        const result = await authenticateMcpServer(server.id);
        if (result.authorizationUrl) {
          await window.api.workspace.openExternal(result.authorizationUrl);
          toast.success(t("mcp:oauthOpened"));
        } else if (result.authenticated) {
          toast.success(t("mcp:oauthSuccess"));
        }
      } catch (error) {
        toastError(error, t("mcp:oauthFailed"));
      }
    },
    [t],
  );

  const toggleMcp = React.useCallback(
    async (server: McpSummary, enabled: boolean) => {
      try {
        await setMcpServerEnabled(server.id, enabled);
        await loadMcp();
        toast.success(
          enabled
            ? t("mcp:statusEnabled", { name: server.name })
            : t("mcp:statusDisabled", { name: server.name }),
        );
      } catch (error) {
        toastError(error, t("mcp:statusUpdateFailed"));
      }
    },
    [loadMcp, t],
  );

  return {
    inputRef,
    installing,
    uploading,
    uploadSkill,
    importSkill,
    installBuiltin,
    removeSkill,
    updateSkill,
    toggleSkill,
    removeMcp,
    toggleMcp,
    authenticateMcp,
  };
}
