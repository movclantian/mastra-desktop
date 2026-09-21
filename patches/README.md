# Mastra Core 1.67.0 workspace correction

The version-pinned pnpm patch covers both ESM and CommonJS distribution files and public declarations. `pnpm install --frozen-lockfile` applies it; never edit installed node_modules manually. Patch files must remain LF (`.gitattributes`) because their hashes are recorded in pnpm-lock.yaml.

- grep considers UTF-8 text independently of extension, detects NUL/bad encoding, and reports incomplete results for skipped files. Host-side reads default to 8 MiB per file; callers can explicitly raise `maxFileBytes` for known text. Existing ignore, hidden-file, permissions, regex and output-limit behavior remains.
- execute_command accepts `outputEncoding` (`utf-8`, `gbk`, `utf-16le`), forwarded to foreground/background raw process decoders. It is not automatic charset detection. Keep differently encoded programs in separate invocations.

Run `pnpm run test:regression` and `pnpm run verify:release` after any patch/dependency change. Rebase or remove the patch when upgrading core; verify all entry formats, permissions and test contracts. No upstream issue/PR has been submitted by this task.

Packaging boundary: Electron currently resolves production dependencies from the app root (the nested `.mastra/output/node_modules` tree is excluded). The Mastra deployer does not copy patchedDependencies into standalone output. A standalone `.mastra/output` deployment is **not verified** and must not be claimed to include these fixes. Before release, inspect the final app.asar core runtime and run the same installed-tool cases; a source test is not installation acceptance.
