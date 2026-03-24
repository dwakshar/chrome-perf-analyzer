import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = resolve(rootDir, "package.json");
const manifestPath = resolve(rootDir, "manifest.json");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.version !== packageJson.version) {
  manifest.version = packageJson.version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Synced manifest version to ${packageJson.version}.`);
}
