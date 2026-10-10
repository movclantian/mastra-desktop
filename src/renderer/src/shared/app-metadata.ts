import packageJson from "../../../../package.json";

type PackageManifest = {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const manifest = packageJson as PackageManifest;

export const APP_NAME = "MastraWork";
export const APP_VERSION = manifest.version;

export function packageVersion(name: string): string {
  return manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? "Included";
}
