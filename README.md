# mastra-desktop

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

### Release

Pushing a semantic-version tag builds Windows, macOS, and Linux installers and
publishes them to the matching GitHub Release. The tag without its leading `v`
must match the version in `package.json`.

```bash
# First release (package.json version: 0.0.1)
git tag v0.0.1
git push origin v0.0.1
```

The workflow can also be started manually from GitHub Actions to verify the
build. Manual runs upload the installers as workflow artifacts but do not create
a GitHub Release.
