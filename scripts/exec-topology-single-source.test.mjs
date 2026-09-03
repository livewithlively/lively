#!/usr/bin/env node
// ★구조 불변식 — **«이 세션이 어디서 도나»를 묻는 env 는 한 곳에서만 읽는다** (#2599 T2).
//
//  이 시험이 없어서 실제로 났던 일(조사 `exec-topology-branch-map-2601`, 2026-09-03 실측):
//   🔴 같은 질문을 23개 파일 30자리가 각자 env 로 되물었고, **읽는 시점까지 갈렸다** —
//      `LIVELY_NODE_TOKEN` 은 4곳이 모듈 로드에 얼고 2곳이 호출 시점에 읽어, 한 프로세스 안에서
//      같은 질문에 두 답이 나오는 창이 구조적으로 있었다. 컴파일러가 못 잡는 자리라 조용히 자란다.
//   🔴 그 사후 추론이 실제 결함으로 나온 것이 #2592(셀프 노드)다 — 「지금 위치」를 되추론하는 코드가
//      세 자리에서 각각 다르게 틀렸고, 그 결과 중앙 세션의 접속이 노드 릴레이로 새어 나갔다.
//
//  규칙: 아래 env 를 읽는 프로덕션 코드는 `src/exec-topology.ts` **하나**다. 나머지는 `execTopology()` 로 묻는다.
//   시험 파일(*.test.ts)은 env 를 흔드는 것이 일이라 제외한다.
//
//  ⚠ `LIVELY_TENANCY_MODE` 만 예외 목록이 있다 — 그 값은 **두 축에 걸쳐 있다**(tmux 소켓 선택 · DB 테넌트
//   바인딩·파일 루트). 토폴로지는 tmux 쪽만 소유하고 나머지는 테넌시 축이 그대로 갖는다(섞으면 부팅 순서가
//   얽힌다 — `src/exec-topology.ts` 머리말의 «여기 없는 것»). 목록을 늘리려면 **왜 토폴로지가 아니라
//   테넌시 축인지**가 커밋 메시지에 있어야 한다.
//
//  실행: node scripts/exec-topology-single-source.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");
const OWNER = "src/exec-topology.ts";

// 토폴로지 env — 「이 세션이 어디서 도나」를 묻는 값들.
const TOPOLOGY_ENV = [
  "LIVELY_TMUX_EXEC", "LIVELY_SESSION_EXEC", "LIVELY_SESSION_ENSURE", "LIVELY_SESSION_SPAWN",
  "LIVELY_MEMBER_EXEC", "LIVELY_MEMBER_ISOLATION", "LIVELY_BOX_SPAWN", "LIVELY_BOX_CGSPAWN",
  "LIVELY_NODE_TOKEN", "LIVELY_ATTACH_WORKER_K",
];

// 테넌시/DB·경로 축이 계속 소유하는 자리(토폴로지가 아니다). 이 목록 밖에서 읽으면 실패한다.
const TENANCY_AXIS = new Set([
  "src/boot/tenancy-env.ts",              // 부팅 최초 재배선 — 이 값을 **쓴다**(읽는 자리가 아니다)
  "src/boot/housekeeping.ts",             // 자식 프로세스 env 에서 지운다(부모 process.env 아님)
  "src/db/tenant-binding-boot.ts",        // DB RLS 바인딩 모드
  "src/org/tenancy/state.ts",             // registryModeActive() — 테넌시 축 술어의 정본
  "src/org/tenant-middleware.ts",         // 요청별 워크스페이스 해석
  "src/terminal/catalog.ts",              // 테넌트별 파일 루트(tenantRootBase) — 저장 경로 축
  "src/terminal/terminal-pty-upgrade.ts", // WS 업그레이드에서 세션 정본으로 테넌트 되찾기
]);

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
    files.push(p);
  }
})(SRC);

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
const rel = (p) => relative(ROOT, p).split(sep).join("/");

/**
 * 그 파일에서 `process.env.X` / `env.X` 로 **읽는** 줄.
 *  ⚠ 주석은 뺀다(머리말이 env 이름을 설명하는 것은 정상이다). 훅 소스를 **문자열로 실어 보내는**
 *   자리(default-content.ts 의 org_hook source_code)도 뺀다 — 그 안은 다른 프로세스의 코드다.
 */
function readsOf(file, names) {
  const hits = [];
  const lines = readFileSync(file, "utf8").split("\n");
  const re = new RegExp(String.raw`(?:process\.)?\benv\.(${names.join("|")})\b`);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (inBlockComment) { if (raw.includes("*/")) inBlockComment = false; continue; }
    if (/^\s*\/\*/.test(raw) && !raw.includes("*/")) { inBlockComment = true; continue; }
    if (/^\s*(\/\/|\*)/.test(raw)) continue;              // 줄 주석 · 블록 주석 본문
    const code = raw.replace(/\/\/.*$/, "");              // 줄 끝 주석 제거
    if (/^\s*"[a-z_]+":\s*"/.test(code)) continue;        // JSON 문자열로 실린 훅 소스
    const m = re.exec(code);
    if (m) hits.push({ line: i + 1, env: m[1], text: raw.trim().slice(0, 110) });
  }
  return hits;
}

t("[S1] 토폴로지 env 를 읽는 프로덕션 파일은 src/exec-topology.ts 하나다", () => {
  const offenders = [];
  for (const f of files) {
    if (rel(f) === OWNER) continue;
    for (const h of readsOf(f, TOPOLOGY_ENV)) offenders.push(`${rel(f)}:${h.line}  ${h.env}  — ${h.text}`);
  }
  assert.deepEqual(offenders, [],
    `토폴로지 env 를 직접 읽는 자리가 ${offenders.length}곳 남아 있다. 되추론이 다시 자라는 자리다 — `
    + `\`execTopology()\` 로 물어라(${OWNER} 참조):\n  ` + offenders.join("\n  "));
});

t("[S2] LIVELY_TENANCY_MODE 는 토폴로지 + 승인된 테넌시 축에서만 읽는다", () => {
  const offenders = [];
  for (const f of files) {
    const r = rel(f);
    if (r === OWNER || TENANCY_AXIS.has(r)) continue;
    for (const h of readsOf(f, ["LIVELY_TENANCY_MODE"])) offenders.push(`${r}:${h.line}  — ${h.text}`);
  }
  assert.deepEqual(offenders, [],
    "LIVELY_TENANCY_MODE 를 새 자리에서 읽는다. tmux 파생이면 execTopology().tmux 를, DB·경로 축이면 "
    + "org/tenancy/state.registryModeActive() 를 써라(그래도 새 자리가 필요하면 이 시험의 TENANCY_AXIS 에 "
    + "사유와 함께 추가):\n  " + offenders.join("\n  "));
});

t("[S3] 토폴로지 모듈은 순수 잎이다 — node: 외 런타임 import 0 (노드 에이전트 번들에 실린다)", () => {
  const imports = readFileSync(join(ROOT, OWNER), "utf8").split("\n")
    .filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l))
    .map((l) => (l.match(/from\s+"([^"]+)"/) ?? [])[1])
    .filter((m) => m && !m.startsWith("node:"));
  assert.deepEqual(imports, [],
    "이 파일이 무언가를 import 하면 노드 에이전트 번들이 그 무게를 그대로 싣는다(#2165 — 간선 하나가 11개를 끌었다).");
});

t("[S4] 게이트웨이·노드 두 진입점이 부팅에서 토폴로지를 확정한다", () => {
  // 확정을 빼먹으면 «부팅 때 한 번»이 조용히 «물을 때마다»로 되돌아간다 — 증상이 없어서 아무도 모른다.
  const gw = readFileSync(join(ROOT, "src/index.ts"), "utf8");
  const node = readFileSync(join(ROOT, "src/node/agent.ts"), "utf8");
  assert.match(gw, /freezeExecTopology\(\)/, "게이트웨이 진입점(src/index.ts)이 토폴로지를 확정하지 않는다");
  assert.match(node, /freezeExecTopology\(\)/, "노드 진입점(src/node/agent.ts)이 토폴로지를 확정하지 않는다");
  // 순서 불변식: tenancy-env 가 부팅 중에 LIVELY_TENANCY_MODE 를 **쓰므로** 확정은 그 import 뒤여야 한다.
  const importIdx = gw.indexOf('import "./boot/tenancy-env.js"');
  const freezeIdx = gw.indexOf("freezeExecTopology()");
  assert.ok(importIdx >= 0 && freezeIdx > importIdx,
    "확정이 boot/tenancy-env import 보다 앞이면 틀린 워크스페이스 모드가 굳는다");
});

console.log(`\n${pass} passed — 실행 토폴로지 단일 출처(#2599 T2)`);
