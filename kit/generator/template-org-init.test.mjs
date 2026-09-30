// 새 조직 골격(template-org)을 --init 한 직후 --check 가 «선택 누락» 을 말하지 않는다 (#4501).
//  template-org 는 memory/MEMORY.md 를 실었는데 생성기(build-context.mjs)는 memory/knowledge-index.md 만 읽었다 —
//  init 직후부터 «선택 누락 → 권장: memory/knowledge-index.md» 가 떴고, 조직이 MEMORY.md 를 채워도 합성·발행에 안 실렸다.
//  골격이 생성기가 읽는 표준 레이어 이름을 그대로 싣는지를, 실제 --init → --check 로 잰다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

const GEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "build-context.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-org-init-"));
const org = path.join(dir, "org");
const run = (...args) => spawnSync(process.execPath, [GEN, ...args], { encoding: "utf8", env: { ...process.env, ...sandboxEnv({ home: dir, tmp: dir }) } });

try {
  const init = run("--init", org);
  assert.equal(init.status, 0, `--init 실패\n${init.stdout}${init.stderr}`);
  // 배선 단언 — 골격이 실제로 복사됐는가(빈 디렉터리에 --check 를 돌리면 다른 이유로 실패한다).
  assert.ok(fs.existsSync(path.join(org, "org", "org-defaults.md")), "--init 이 골격을 복사하지 않았다");

  assert.ok(fs.existsSync(path.join(org, "memory", "knowledge-index.md")), "골격에 memory/knowledge-index.md 가 없다(생성기가 읽는 이름)");
  assert.ok(!fs.existsSync(path.join(org, "memory", "MEMORY.md")), "골격이 생성기가 읽지 않는 memory/MEMORY.md 를 싣는다");

  const check = run("--check", org);
  const out = `${check.stdout}${check.stderr}`;
  assert.equal(check.status, 0, `--check 실패\n${out}`);
  assert.doesNotMatch(out, /선택 (레이어 )?누락/, `갓 init 한 골격에서 선택 레이어 누락 경고가 난다\n${out}`);
  console.log("ok  --init 한 골격이 생성기의 표준 레이어를 전부 싣는다(--check 경고 0)");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
