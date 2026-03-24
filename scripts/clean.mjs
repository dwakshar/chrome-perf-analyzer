import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

for (const relativePath of ["dist", "artifacts"]) {
  rmSync(resolve(rootDir, relativePath), { recursive: true, force: true });
}

console.log("Cleaned dist and artifacts.");
