import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { Workspace, LocalFilesystem, LocalSandbox, createWorkspaceTools } = await import(
  process.env.CORE_TEST_MODULE || "@mastra/core/workspace"
);

test("Real workspace grep searches text regardless of extension and reports binary exclusions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mastra-grep-regression-"));
  const names = [
    "README",
    ..."c cpp css env go h ini java js jsx less php py rb rs scss sh sql svg toml xml csv html json md ts txt yml ps1 bat cmd psd1 psm1 cfg log mk make dockerfile"
      .split(" ")
      .map((ext) => `sample.${ext}`),
  ];
  let workspace;
  try {
    await Promise.all(names.map((name) => writeFile(join(dir, name), "NEEDLE_TOKEN 中文\n")));
    await writeFile(join(dir, "binary.bin"), Buffer.from([0, 78, 69, 69, 68, 76, 69]));
    await writeFile(join(dir, "bad-encoding.txt"), Buffer.from([0xff, 0xfe, 0x81]));
    workspace = new Workspace({ filesystem: new LocalFilesystem({ basePath: dir }) });
    await workspace.init();
    const tools = await createWorkspaceTools(workspace);
    const grep = tools.mastra_workspace_grep;
    const input = {
      pattern: "NEEDLE_TOKEN",
      path: ".",
      contextLines: 0,
      caseSensitive: true,
      includeHidden: false,
    };
    const result = await grep.execute(input, { workspace });
    assert.match(result, /39 matches across 39 files/);
    assert.match(result, /2 files skipped: binary, non-UTF-8/);
    assert.match(
      await grep.execute({ ...input, path: "README", maxFileBytes: 1 }, { workspace }),
      /1 files skipped/,
    );
    assert.match(
      await grep.execute({ ...input, path: "README", maxFileBytes: 100 }, { workspace }),
      /1 match across 1 file/,
    );
    assert.match(
      await grep.execute({ ...input, path: "sample.ps1" }, { workspace }),
      /1 match across 1 file/,
    );
    assert.match(
      await grep.execute({ ...input, path: "**/*.ps1" }, { workspace }),
      /1 match across 1 file/,
    );
    assert.match(
      await grep.execute({ ...input, path: "README" }, { workspace }),
      /1 match across 1 file/,
    );
  } finally {
    await workspace?.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Real process decoding preserves split GBK/UTF8 bytes, stderr, background output and exit status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mastra-encoding-regression-"));
  const sandbox = new LocalSandbox({ workingDirectory: dir });
  try {
    await sandbox.start();
    const file = join(dir, "bytes.cjs");
    await writeFile(
      file,
      "const b=Buffer.from([0xd6,0xd0,0xce,0xc4]); let i=0; const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1)); process.stderr.write(b.subarray(i,i+1)); if(++i===b.length){clearInterval(t);process.exitCode=7;}},10);",
    );
    const command = `"${process.execPath}" "${file}"`;
    const handle = await sandbox.processes.spawn(command, { outputEncoding: "gbk" });
    const result = await handle.wait();
    assert.equal(result.stdout, "中文");
    assert.equal(result.stderr, "中文");
    assert.equal(result.exitCode, 7);
    assert.equal(handle.stdout, "中文");
    const foreground = await sandbox.executeCommand(command, [], { outputEncoding: "gbk" });
    assert.equal(foreground.stdout, "中文");
    assert.equal(foreground.stderr, "中文");
    assert.equal(foreground.exitCode, 7);
    await writeFile(
      file,
      "const b=Buffer.from('中文'); let i=0; const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1)); if(++i===b.length)clearInterval(t);},10);",
    );
    const utf = await sandbox.executeCommand(command, [], { outputEncoding: "utf-8" });
    assert.equal(utf.stdout, "中文");
    assert.equal(utf.exitCode, 0);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Execute tool schema forwards encoding for foreground and background, preserving native Windows output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mastra-command-tool-"));
  const sandbox = new LocalSandbox({ workingDirectory: dir });
  const workspace = new Workspace({ sandbox, filesystem: new LocalFilesystem({ basePath: dir }) });
  try {
    await workspace.init();
    const file = join(dir, "output.cjs");
    await writeFile(file, "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]));");
    const tools = await createWorkspaceTools(workspace);
    const execute = tools.mastra_workspace_execute_command;
    const args = execute.inputSchema.parse({
      command: `"${process.execPath}" "${file}"`,
      outputEncoding: "gbk",
    });
    assert.equal(args.outputEncoding, "gbk");
    assert.match(await execute.execute(args, { workspace }), /中文/);
    const before = new Set((await sandbox.processes.list()).map((item) => item.pid));
    await execute.execute({ ...args, background: true }, { workspace });
    const spawned = (await sandbox.processes.list()).find((item) => !before.has(item.pid));
    assert.ok(spawned);
    const handle = await sandbox.processes.get(spawned.pid);
    assert.equal((await handle.wait()).stdout, "中文");
    if (process.platform === "win32") {
      const codepage = await execute.execute(
        { command: "chcp", outputEncoding: "gbk" },
        { workspace },
      );
      if (/936/.test(codepage)) {
        assert.match(
          await execute.execute({ command: "echo 中文", outputEncoding: "gbk" }, { workspace }),
          /中文/,
        );
        assert.match(
          await execute.execute(
            {
              command: 'powershell -NoProfile -Command "Write-Output 中文"',
              outputEncoding: "gbk",
            },
            { workspace },
          ),
          /中文/,
        );
      }
    }
  } finally {
    await workspace.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
