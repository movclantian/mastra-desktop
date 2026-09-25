import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const imported = await import("../src/mastra/tools/plan-draft.ts");
const { writePlanDraftTool } = imported.default;

test("Plan writer writes under plans and refuses a dangling symlink", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mastrawork-plan-draft-"));
  const workspace = join(temporaryRoot, "workspace");
  const planRoot = join(workspace, "plans");
  const missingTarget = join(temporaryRoot, "outside.md");
  const danglingLink = join(planRoot, "dangling.md");
  await mkdir(planRoot, { recursive: true });

  try {
    await writePlanDraftTool.execute(
      { path: "valid-plan.md", content: "# Approved plan\n" },
      { requestContext: { get: () => workspace } },
    );
    await writePlanDraftTool.execute(
      { path: "valid-plan.md", content: "# Revised plan\n" },
      { requestContext: { get: () => workspace } },
    );
    assert.equal(
      await readFile(join(planRoot, "valid-plan.md"), "utf8"),
      "# Revised plan\n",
      "atomic replacement must still allow revising an existing draft",
    );

    const source = await readFile(
      new URL("../src/mastra/tools/plan-draft.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /temporaryTarget = resolve\(resolvedPlanRoot,/);
    assert.ok(
      source.indexOf("const currentParent = await realpath(parentDirectory)") <
        source.indexOf("await rename(temporaryTarget, target)"),
      "destination parent must be revalidated immediately before the atomic rename",
    );

    try {
      await symlink(missingTarget, danglingLink, "file");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("Windows does not permit creating a symlink in this environment");
        return;
      }
      throw error;
    }

    await assert.rejects(
      writePlanDraftTool.execute(
        { path: "dangling.md", content: "# Escape attempt\n" },
        { requestContext: { get: () => workspace } },
      ),
      /计划文件不能是符号链接/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
