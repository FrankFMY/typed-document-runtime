import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
const result = spawnSync("node_modules/.bin/tsc", ["--project", "tsconfig.build.json"], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
