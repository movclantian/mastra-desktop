# Repository engineering guidance

- Treat the current source and tests as the source of truth. Inspect the relevant call path and preserve unrelated user changes.
- Keep fixes scoped and fail closed around authorization, thread/resource identity, filesystem writes, and release publication. Never reset user data or databases without explicit authorization.
- For code changes, run the narrow regression first. For cross-module, browser, or release changes, run the relevant full tests, all typecheck projects, lint, and release/package guards; report exact commands and distinguish automated fixtures from desktop/manual evidence.
- For renderer/UI changes, follow the root `DESIGN.md` and inspect rendered screenshots with an available browser/computer-use tool. If no suitable tool is available, state that limitation rather than claiming visual verification.
- Keep public docs aligned with shipped behavior. Keep dated internal measurements identifiable as historical, and exclude credentials, machine-specific paths, runtime traces, and temporary screenshots from release changes.
- A release tag must match `package.json`; merge only after required PR CI checks pass, and publish only from the merged commit.
