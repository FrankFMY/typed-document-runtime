import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

mkdirSync(".artifacts", { recursive: true });
const result = spawnSync("bun", ["pm", "pack", "--destination", ".artifacts", "--ignore-scripts"], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
