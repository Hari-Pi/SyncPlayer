import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("apps/web/dist");
const target = resolve("dist");

if (!existsSync(source)) {
  throw new Error("Expected apps/web/dist to exist after the web build.");
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

