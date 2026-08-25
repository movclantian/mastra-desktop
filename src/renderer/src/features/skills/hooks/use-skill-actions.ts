import * as React from "react";
import { toast } from "sonner";
import type { SkillMetadata } from "@/features/workbench";
import { toastError } from "@/lib/errors";
import {
  authenticateMcpServer,
  deleteMcpServer,
  deleteSkill,
  importSkill as importSkillRequest,
  installSkill as installSkillRequest,
  uploadSkillArchive,
} from "../api";
import type { McpSummary, SkillDetail, SkillSection } from "../types";

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
  removeSkill: () => Promise<void>;
  removeMcp: (server: McpSummary) => Promise<void>;
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
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const uploadSkill = React.useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith(".zip")) {
        toast.error("技能包必须是 ZIP 文件");
        return;
      }
      setUploading(true);
      try {
        const skill = await uploadSkillArchive(file);
        await loadInstalled();
        setSection("personal");
        setActiveSkill(skill);
        setAddSkillOpen(false);
        toast.success(`技能「${skill.name}」已添加`);
      } catch (error) {
        toastError(error, "添加技能失败");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [loadInstalled, setActiveSkill, setAddSkillOpen, setSection],
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
        toast.success(`技能「${skill.name}」已导入`);
      } catch (error) {
        toastError(error, "导入技能失败");
      } finally {
        setUploading(false);
      }
    },
    [loadInstalled, setActiveSkill, setAddSkillOpen, setSection],
  );

  const installBuiltin = React.useCallback(
    async (skill: SkillMetadata) => {
      setInstalling(skill.name);
      try {
        const installedSkill = await installSkillRequest(skill);
        await loadInstalled();
        toast.success(`技能「${installedSkill.name}」已安装`);
      } catch (error) {
        toastError(error, "安装技能失败");
      } finally {
        setInstalling(null);
      }
    },
    [loadInstalled],
  );

  const removeSkill = React.useCallback(async () => {
    if (!activeSkill || !window.confirm(`确定删除技能「${activeSkill.name}」吗？`)) return;
    try {
      await deleteSkill(activeSkill.name);
    } catch {
      toast.error("删除技能失败");
      return;
    }
    setActiveSkill(null);
    setDetail(null);
    await loadInstalled();
    toast.success("技能已删除");
  }, [activeSkill, loadInstalled, setActiveSkill, setDetail]);

  const removeMcp = React.useCallback(
    async (server: McpSummary) => {
      if (!window.confirm(`确定移除 MCP「${server.name}」吗？`)) return;
      try {
        await deleteMcpServer(server.id);
      } catch {
        toast.error("移除 MCP 失败");
        return;
      }
      await loadMcp();
      toast.success("MCP 已移除");
    },
    [loadMcp],
  );

  const authenticateMcp = React.useCallback(async (server: McpSummary) => {
    try {
      const result = await authenticateMcpServer(server.id);
      if (result.authorizationUrl) {
        await window.api.workspace.openExternal(result.authorizationUrl);
        toast.success("已打开 MCP 授权页面，完成后服务会自动连接");
      } else if (result.authenticated) {
        toast.success("MCP 已完成授权");
      }
    } catch (error) {
      toastError(error, "MCP OAuth 授权失败");
    }
  }, []);

  return {
    inputRef,
    installing,
    uploading,
    uploadSkill,
    importSkill,
    installBuiltin,
    removeSkill,
    removeMcp,
    authenticateMcp,
  };
}
