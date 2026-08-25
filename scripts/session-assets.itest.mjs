// 앱 세션 물질화 실-DB 스모크(#1780 PR3) — 빈 pg 에 스키마 체인을 올리고 builtin 'hello' 앱을 설치한 뒤,
//  materializeAppAssets(tempDir, 'hello') 가 그 앱의 greet 스킬을 세션 폴더 .claude/skills/greet/SKILL.md 로
//  **원명(orig_name)** 으로 물질화하는지, writeAppHome 이 .lively/{token,gateway-url} 을 남기는지 본다.
//  ⚠ 수동 실행(docker). 실행:  node scripts/session-assets.itest.mjs
//   *.itest.mjs 라 run-tests(자동)에서 제외된다(apps-install.itest.mjs 와 동일 규약).
//  왜 실-DB 인가: materializeAppAssets 는 listComponents+getOrgHarnessAsset(실제 컬럼·조인)을 태운다 —
//   순수 유닛(session-assets.test.ts)은 디스패치·경로안전·조립만, 이 스모크는 설치→물질화 전 사슬이 디스크에 착지하는지.
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const PORT = 59463, CNAME = "co-session-assets-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initAllSchemas } = await import("../dist/boot/schemas.js");
  const { seedBuiltinApps } = await import("../dist/apps/seed.js");
  const { materializeAppAssets, writeAppHome, directFsWriter } = await import("../dist/apps/session-assets.js");

  await initAllSchemas();
  ok("전체 스키마 체인 완주(initAllSchemas)");

  const r1 = await seedBuiltinApps();
  assert.ok(r1.seeded.includes("hello"), `hello 가 설치돼야 한다 (실제: ${JSON.stringify(r1)})`);
  ok(`seedBuiltinApps — hello seeded (${JSON.stringify(r1)})`);

  // ── 세션 폴더로 쓸 임시 디렉터리 ──
  const sessionDir = mkdtempSync(join(tmpdir(), "app-session-"));

  // ── 앱 하네스 자산 물질화 → greet 스킬이 .claude/skills/greet/SKILL.md 로 착지 ──
  await materializeAppAssets(sessionDir, "hello", directFsWriter);
  const skillPath = join(sessionDir, ".claude", "skills", "greet", "SKILL.md");
  assert.ok(existsSync(skillPath), `greet 스킬이 ${skillPath} 에 있어야 한다`);
  ok("materializeAppAssets — greet 스킬이 .claude/skills/greet/SKILL.md 에 착지");

  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /^---\n/, "frontmatter 로 시작");
  assert.match(skill, /name: "greet"/, "name 은 앱 슬러그(greet) — 중앙 저장 id 가 아님");
  assert.doesNotMatch(skill, /app-[0-9a-f]{10}-greet/, "중앙 저장 id 는 파일에 새지 않는다");
  assert.match(skill, /description:/, "description frontmatter 포함");
  assert.ok(skill.includes("knowledge_search"), "greet SKILL.md 본문이 실려야 한다(원문 포함)");
  ok("materializeAppAssets — SKILL.md 내용(name=greet·본문 보존) 검증");

  // ── 앱 홈 물질화 → .lively/token(0600) + gateway-url ──
  await writeAppHome(sessionDir, "tkn_fake_app_token", "https://gw.example.com", directFsWriter);
  const tokenPath = join(sessionDir, ".lively", "token");
  assert.equal(readFileSync(tokenPath, "utf8"), "tkn_fake_app_token", "앱 토큰 파일 내용");
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600, "토큰 파일은 0600");
  assert.equal(readFileSync(join(sessionDir, ".lively", "gateway-url"), "utf8"), "https://gw.example.com\n", "gateway-url 파일");
  ok("writeAppHome — .lively/token(0600) + gateway-url 착지");

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
