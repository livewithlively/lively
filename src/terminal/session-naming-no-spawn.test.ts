// ★구조 불변식 — **이름짓기는 하위 프로세스를 만들지 않는다** (#1979).
//
//  이 테스트가 없어서 실제로 났던 일(프로덕션 실측 2026-08-25):
//   🔴 세션 이름을 짓는 코드가 하네스를 **헤드리스로 스폰**했고(`spawn(bin, argv, { env: { ...process.env } })`),
//      그 자식이 부모 세션의 LIVELY_SESSION_ID·LIVELY_TOKEN·훅 배선을 통째로 상속했다. 시드 훅
//      project-auto-bind(UserPromptSubmit)는 그 이름짓기 프롬프트를 **사람의 첫 실질 지시와 구별할 수 없어**
//      프로젝트를 만들어 부모 세션에 붙였다 — 쓰레기 프로젝트 #1946·#1957(제목이 이름짓기 프롬프트 첫 줄
//      그대로), 후자는 실사용자 세션. 무관한 세션에 #1946 의 AGENTS.md 가 주입되는 것까지 관측됐다.
//
//  ⚠ 왜 '스폰 0'을 보나 — **"이름짓기 1회에 프로젝트가 0개 생긴다"는 유닛으로 못 잡는다.** 그건 서버·훅 러너·
//   게이트웨이 DB가 다 있어야 관측되는 성질이라 프로덕션에서야 드러났다. 대신 그 사고의 **필요조건**은
//   결정론적이다: 자식 프로세스가 없으면 env 상속이 없고, env 상속이 없으면 훅이 부모를 오염시킬 수 없다.
//   그래서 여기서는 '결과'가 아니라 **원인 경로의 부재**를 못박는다. 누가 편의상 헤드리스 호출을 되살리면
//   이 테스트가 그 자리에서 깨진다.
//
//  실행: npm run build && node dist/terminal/session-naming-no-spawn.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/terminal → ../.. → repoRoot (seed-content.test.ts 와 같은 규약 — dist 에서 소스를 읽는다).
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let pass = 0;
const ok = (name: string): void => { pass++; console.log(`ok  ${name}`); };
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

// 이름을 짓는 경로. **고정 목록 + 이름 규칙 탐색**을 합친다 — 목록만 두면 나중에 누가 새 이름짓기 모듈을
//  만들 때 그 파일이 조용히 이 가드 밖에 선다(실제로 구 session-name-ai.ts 가 그런 파일이었다).
const NAMING_FIXED = [
  "src/terminal/session-name.ts",                          // 규칙 이름 + 에이전트 이름 다듬기
  "src/terminal/session-relabel.ts",                       // 서버측 실행부(걸쇠 + tmux 반영)
  "src/capabilities/session-rename.ts",                    // MCP·REST 표면
  "src/sessions/session-label-source.ts",                  // 걸쇠 표
  "src/sessions/session-autoname.ts",                      // 전사 기반 자동 이름
  "kit/hooks/examples/session-name-ask.org-hook.mjs",      // 첫 지시 턴 안내 훅
];
// 이 규칙에 걸리는 파일은 **자동으로** 가드 대상이 된다(테스트 파일 제외).
const NAMING_RE = /(^|\/)session-(name|rename|relabel|autoname|label-source)[A-Za-z0-9._-]*\.(ts|mjs)$/;

function discoverNaming(): string[] {
  const found = new Set(NAMING_FIXED);
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = path.relative(REPO_ROOT, p).split(path.sep).join("/");
      if (/\.test\.(ts|mjs)$/.test(rel)) continue;
      if (NAMING_RE.test(rel)) found.add(rel);
    }
  };
  for (const top of ["src", "kit"]) {
    const d = path.join(REPO_ROOT, top);
    if (fs.existsSync(d)) walk(d);
  }
  return [...found].filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)));
}
const NAMING_PATH = discoverNaming();

// ── ① 스폰 0 — 이름짓기 경로 어디에도 자식 프로세스가 없다. ──
{
  const SPAWN = /\bchild_process\b|\bspawnSync?\s*\(|\bexecFileS?y?n?c?\s*\(|\bexecSync\s*\(/;
  for (const rel of NAMING_PATH) {
    const src = read(rel);
    assert.ok(!SPAWN.test(src),
      `${rel} 가 하위 프로세스를 만든다 — 세션 안에서 스폰하면 부모 env(LIVELY_SESSION_ID)·훅을 상속해 ` +
      `project-auto-bind 가 쓰레기 프로젝트를 만든다(#1946·#1957). 이름은 이미 도는 세션이 지어야 한다.`);
  }
  // 배선 확인 — 고정 목록이 전부 실재해야 한다(경로 오타면 위 루프가 조용히 아무것도 안 본다).
  for (const rel of NAMING_FIXED) assert.ok(NAMING_PATH.includes(rel), `가드 대상 ${rel} 가 사라졌다 — 경로를 고치거나 목록에서 빼라`);
  ok(`이름짓기 경로 ${NAMING_PATH.length}개 파일(고정 ${NAMING_FIXED.length} + 규칙 탐색) — 하위 프로세스 스폰 0건`);
}

// ── ② 훅은 네트워크를 안 쓴다 — UserPromptSubmit 은 사람의 프롬프트 앞을 막고 서 있다. ──
{
  const hook = read("kit/hooks/examples/session-name-ask.org-hook.mjs");
  assert.ok(!/\bfetch\s*\(/.test(hook),
    "이름짓기 안내 훅이 fetch 를 쓴다 — UserPromptSubmit 은 사람의 프롬프트 앞이라 그게 곧 첫 응답 지연이다. " +
    "'이미 이름이 있나'는 서버 걸쇠(label_source)가 판정한다(훅은 tmp 플래그로 1회만 안내하고 빠진다).");
  // 배선 확인 — 이 파일을 실제로 읽었나(빈 문자열이면 위 단언이 vacuous 하게 통과한다).
  assert.ok(hook.includes("session_rename"), "훅 본문을 못 읽었다(또는 session_rename 안내가 사라졌다) — 위 단언이 무의미해진다");
  ok("이름짓기 안내 훅 — fetch 0건(조회 없이 세션당 1회 주입)");
}

// ── ③ 구 헤드리스 모듈이 되살아나지 않았다 — 파일도, 참조도. ──
{
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, "src", "terminal", "session-name-ai.ts")),
    "src/terminal/session-name-ai.ts 가 되살아났다 — 이 모듈이 곧 #1946·#1957 의 원인 경로다");

  const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      // import·require 로 **끌어 쓰는 것**만 잡는다 — 주석의 역사 서술("구 session-name-ai.ts")은 남아도 된다.
      if (/(from|require\(|import\()\s*["'][^"']*session-name-ai/.test(src)) hits.push(path.relative(REPO_ROOT, p));
    }
  };
  for (const top of ["src", "kit", "web", "scripts"]) {
    const d = path.join(REPO_ROOT, top);
    if (fs.existsSync(d)) walk(d);
  }
  assert.deepEqual(hits, [], `구 헤드리스 이름짓기 모듈을 다시 import 하는 파일이 있다: ${hits.join(", ")}`);
  ok("구 session-name-ai 모듈 — 파일 부재 + import 0건");
}

// ── ④ 배선 확인 — 워크를 실제로 돌았나(경로가 틀리면 ③이 통째로 vacuous 하다). ──
{
  let seen = 0;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(ts|mjs)$/.test(e.name)) seen++;
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  assert.ok(seen > 200, `src 에서 ${seen}개 파일만 봤다 — REPO_ROOT 가 틀렸을 수 있다(③이 아무것도 안 본다)`);
  ok(`배선 확인 — src 아래 ${seen}개 소스를 실제로 훑었다`);
}

console.log(`\n${pass} passed`);
