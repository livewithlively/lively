#!/usr/bin/env node
// R55 게이트 러너 편입 래퍼 — 러너(*.test.mjs 자동 발견)를 통해 로컬·CI 모두에서 경계 게이트가 돈다.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "check-imports.mjs")], { stdio: "inherit" });
process.exit(r.status ?? 1);
