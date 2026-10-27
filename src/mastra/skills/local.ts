import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SkillSearchProcessor, type SkillSearchProcessorOptions } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import { mergeWorkspaceSkills, resolveAgentSkills, type SkillInput } from "@mastra/core/skills";
import { Workspace } from "@mastra/core/workspace";
import { z } from "zod";
import type { PluginSkill } from "../../shared/plugin-contract";
import { workError } from "../errors";
import { listPluginSkills } from "../plugins/registry";
import { getAppConfig, setAppConfig } from "../storage/database";

function localSkillId(path: string): string {
  return `local_${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
}

export function expandSkillPath(path: string, base: string): string {
  return path === "~"
    ? homedir()
    : /^~[\\/]/.test(path)
      ? resolve(homedir(), path.slice(2))
      : resolve(base, path);
}

/** Only path configuration is application-owned; Mastra owns discovery, validation and deduplication. */
export async function localSkillPaths(): Promise<string[]> {
  const base = join(homedir(), ".agents");
  const paths = [join(base, "skills")];
  const configuration = await readFile(join(base, "skills.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (configuration) {
    const { entries } = z
      .object({ entries: z.array(z.object({ path: z.string().min(1) }).strict()).max(256) })
      .strict()
      .parse(JSON.parse(configuration));
    paths.push(...entries.map(({ path }) => expandSkillPath(path, base)));
  }
  return [...new Set(paths)];
}

/** Metadata for the composer; runtime loading uses the same official filesystem resolver. */
export async function listManagedSkills(owner?: string): Promise<PluginSkill[]> {
  if (!owner) return [];
  const [installed, local] = await Promise.all([
    listPluginSkills(owner),
    localSkillPaths().then((paths) => resolveAgentSkills(paths).list()),
  ]);
  return [
    ...installed,
    ...(await Promise.all(
      local.map(async (skill) => ({
        id: localSkillId(skill.path),
        pluginId: "local",
        name: skill.name,
        displayName: skill.name,
        description: skill.description,
        path: skill.path,
        enabled:
          (await getAppConfig(`skill-enabled:${localSkillId(skill.path)}`, owner)) !== "false",
        userInvocable: skill["user-invocable"] !== false,
      })),
    )),
  ];
}

export async function setLocalSkillEnabled(id: string, enabled: boolean, owner: string) {
  const skill = (await listManagedSkills(owner)).find(
    (item) => item.pluginId === "local" && item.id === id,
  );
  if (!skill) throw workError("SKILL_NOT_FOUND");
  // One scoped key per skill keeps concurrent toggles from overwriting other selections.
  await setAppConfig(`skill-enabled:${id}`, String(enabled), owner);
  return { ...skill, enabled };
}

/** Return individual directories so scanning a parent cannot re-enable a disabled skill. */
export async function enabledLocalSkillPaths(paths: string[], owner?: string): Promise<string[]> {
  if (!owner) return [];
  const skills = await resolveAgentSkills(paths).list();
  const enabled = await Promise.all(
    skills.map(
      async (skill) =>
        (await getAppConfig(`skill-enabled:${localSkillId(skill.path)}`, owner)) !== "false",
    ),
  );
  return skills.filter((_, index) => enabled[index]).map((skill) => skill.path);
}

/** SkillSearchProcessor takes a Workspace, unlike SkillsProcessor's direct skills option. */
export async function skillSearchForRequest(
  workspace: Workspace,
  inputs: SkillInput[],
  options: Omit<SkillSearchProcessorOptions, "workspace">,
  requestContext?: RequestContext,
) {
  const primary = resolveAgentSkills(inputs);
  const scoped = (await workspace.skills?.getScoped?.({ requestContext })) ?? workspace.skills;
  const skills = scoped ? (await mergeWorkspaceSkills(primary, scoped)).merged : primary;
  const view = new (class extends Workspace {
    override get skills() {
      return skills;
    }
  })({ filesystem: workspace.filesystem });
  return new SkillSearchProcessor({ ...options, workspace: view });
}
