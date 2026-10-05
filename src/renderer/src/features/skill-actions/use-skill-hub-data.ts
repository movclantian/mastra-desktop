import * as React from "react";
import type {
  CuratedOwner,
  LeaderboardView,
  MarketCategory,
  McpSummary,
  SkillDetail,
  SkillMarketplace,
  SkillMetadata,
  SkillSection,
} from "@/entities/skill";
import {
  fetchCuratedSkillOwners,
  fetchInstalledSkills,
  fetchMcpServers,
  fetchRegistrySkills,
  fetchSkillDetail,
  fetchSkillMarketplaces,
  fetchSkillsShList,
} from "@/entities/skill";
import { i18n } from "@/shared/i18n";
import { toastError } from "@/shared/lib";

let memRegistrySkills: SkillMetadata[] = [];
let memCuratedOwners: CuratedOwner[] = [];
let memInstalledSkills: SkillMetadata[] = [];
let memMcpServers: McpSummary[] = [];
let memMarketplaces: SkillMarketplace[] = [];

interface UseSkillHubDataOptions {
  activeSkill: SkillMetadata | null;
  query: string;
  section: SkillSection;
  marketCategory: MarketCategory;
  leaderboardView: LeaderboardView;
  selectedMaker: string | null;
  page: number;
  pageSize: number;
}

export interface SkillHubDataState {
  skills: SkillMetadata[];
  displaySkills: SkillMetadata[];
  totalSkillsCount: number;
  registrySkills: SkillMetadata[];
  curatedOwners: CuratedOwner[];
  mcpServers: McpSummary[];
  marketplaces: SkillMarketplace[];
  detail: SkillDetail | null;
  setDetail: React.Dispatch<React.SetStateAction<SkillDetail | null>>;
  detailLoading: boolean;
  detailError: string | null;
  loading: boolean;
  listLoading: boolean;
  registryLoading: boolean;
  curatedLoading: boolean;
  loadInstalled: () => Promise<void>;
  loadCurated: () => Promise<void>;
  loadRegistry: (search: string) => Promise<void>;
  loadMcp: () => Promise<void>;
  loadMarketplaces: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export function useSkillHubData({
  activeSkill,
  query,
  section,
  marketCategory,
  leaderboardView,
  selectedMaker,
  page,
  pageSize,
}: UseSkillHubDataOptions): SkillHubDataState {
  const [skills, setSkills] = React.useState<SkillMetadata[]>(memInstalledSkills);
  const [displaySkills, setDisplaySkills] = React.useState<SkillMetadata[]>([]);
  const [totalSkillsCount, setTotalSkillsCount] = React.useState<number>(0);
  const [registrySkills, setRegistrySkills] = React.useState<SkillMetadata[]>(memRegistrySkills);
  const [curatedOwners, setCuratedOwners] = React.useState<CuratedOwner[]>(memCuratedOwners);
  const [mcpServers, setMcpServers] = React.useState<McpSummary[]>(memMcpServers);
  const [marketplaces, setMarketplaces] = React.useState<SkillMarketplace[]>(memMarketplaces);
  const [detail, setDetail] = React.useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(
    () => memInstalledSkills.length === 0 && memMarketplaces.length === 0,
  );
  const [listLoading, setListLoading] = React.useState(false);
  const [registryLoading, setRegistryLoading] = React.useState(
    () => memRegistrySkills.length === 0,
  );
  const [curatedLoading, setCuratedLoading] = React.useState(() => false);

  const loadInstalled = React.useCallback(async () => {
    const nextSkills = await fetchInstalledSkills();
    memInstalledSkills = nextSkills;
    setSkills(nextSkills);
  }, []);

  const loadCurated = React.useCallback(async () => {
    setCuratedLoading(true);
    try {
      const nextOwners = await fetchCuratedSkillOwners();
      if (nextOwners && nextOwners.length > 0) {
        memCuratedOwners = nextOwners;
        setCuratedOwners(nextOwners);
      }
    } catch {
      // 官方目录短暂失败时保留已装载结果。
    } finally {
      setCuratedLoading(false);
    }
  }, []);

  const loadRegistry = React.useCallback(async (search: string) => {
    if (memRegistrySkills.length === 0) setRegistryLoading(true);
    try {
      const { skills: nextSkills } = await fetchRegistrySkills(search);
      if (!search) memRegistrySkills = nextSkills;
      setRegistrySkills(nextSkills);
    } catch (error) {
      if (memRegistrySkills.length === 0) setRegistrySkills([]);
      toastError(error, i18n.t("skills:marketplaceUnavailable"));
    } finally {
      setRegistryLoading(false);
    }
  }, []);

  const loadMcp = React.useCallback(async () => {
    const nextMcp = await fetchMcpServers();
    memMcpServers = nextMcp;
    setMcpServers(nextMcp);
  }, []);

  const loadMarketplaces = React.useCallback(async () => {
    const nextMarketplaces = await fetchSkillMarketplaces();
    memMarketplaces = nextMarketplaces;
    setMarketplaces(nextMarketplaces);
  }, []);

  // 核心：根据分类、榜单、厂商、分页、搜索实时请求真实的远程 API 数据
  const loadActiveList = React.useCallback(
    async (forceRefresh = false) => {
      if (section !== "public") return;
      setListLoading(true);
      try {
        if (marketCategory === "marketplace") {
          const needle = query.trim().toLowerCase();
          const mktAll = registrySkills.filter((s) => s.origin === "marketplace");
          const filtered = needle
            ? mktAll.filter(
                (s) =>
                  s.name.toLowerCase().includes(needle) ||
                  (s.description || "").toLowerCase().includes(needle),
              )
            : mktAll;
          setTotalSkillsCount(filtered.length);
          const start = (page - 1) * pageSize;
          setDisplaySkills(filtered.slice(start, start + pageSize));
          return;
        }

        // 社区排行榜或官方原厂：走真实 skills-sh 接口查询
        const res = await fetchSkillsShList({
          view: leaderboardView,
          curated: marketCategory === "official",
          owner: marketCategory === "official" ? selectedMaker || undefined : undefined,
          page: page - 1,
          perPage: pageSize,
          query: query.trim() || undefined,
          refresh: forceRefresh,
        });

        setDisplaySkills(res.skills);
        setTotalSkillsCount(res.total);
        if (res.curatedOwners && res.curatedOwners.length > 0) {
          setCuratedOwners(res.curatedOwners);
          memCuratedOwners = res.curatedOwners;
        }
      } catch (error) {
        toastError(error, i18n.t("skills:fetchSkillListFailed"));
      } finally {
        setListLoading(false);
      }
    },
    [
      leaderboardView,
      marketCategory,
      page,
      pageSize,
      query,
      registrySkills,
      section,
      selectedMaker,
    ],
  );

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadInstalled(), loadMcp(), loadMarketplaces(), loadCurated()]);
    } catch (error) {
      toastError(error, i18n.t("skills:readSkillSuiteFailed"));
    } finally {
      setLoading(false);
    }
  }, [loadCurated, loadInstalled, loadMarketplaces, loadMcp]);

  const refreshAll = React.useCallback(async () => {
    await Promise.all([
      refresh(),
      marketCategory === "marketplace" ? loadRegistry("") : Promise.resolve(),
      loadActiveList(true),
    ]);
  }, [loadActiveList, loadRegistry, marketCategory, refresh]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (section === "public" && marketCategory === "marketplace") void loadRegistry("");
  }, [section, marketCategory, loadRegistry]);

  // 依赖项变化时发起真实 API 列表查询
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadActiveList();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [loadActiveList]);

  React.useEffect(() => {
    if (!activeSkill) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void fetchSkillDetail(activeSkill)
      .then((nextDetail) => {
        if (!cancelled) setDetail(nextDetail);
      })
      .catch((error) => {
        if (!cancelled) {
          setDetailError(
            error instanceof Error ? error.message : i18n.t("skills:readSkillDetailFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSkill]);

  return {
    skills,
    displaySkills,
    totalSkillsCount,
    registrySkills,
    curatedOwners,
    mcpServers,
    marketplaces,
    detail,
    setDetail,
    detailLoading,
    detailError,
    loading,
    listLoading,
    registryLoading,
    curatedLoading,
    loadInstalled,
    loadCurated,
    loadRegistry,
    loadMcp,
    loadMarketplaces,
    refresh,
    refreshAll,
  };
}
