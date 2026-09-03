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
  "src/boot/housekeeping.ts",             // 자식 env **사본**에서 지운다(`delete env.X`). 부모 process.env 는 안 건드리지만
                                          //  아래 스캐너가 바로 그 `env.X` 철자를 «읽기» 로 세므로 목록이 필요하다.
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
  // ⚠ 철자를 바꿔 우회하는 길을 함께 막는다(블라인드 검증 2026-09-03 지적): 점 접근뿐 아니라
  //  대괄호 접근(`process.env["X"]`)과 구조분해(`const { X } = process.env`)도 «읽는 자리»다.
  //  동적 키(`process.env[k]`)는 정적으로 못 잡는다 — 그건 이 시험의 알려진 한계다(머리말 참조).
  const alt = names.join("|");
  const re = new RegExp(String.raw`(?:process\.)?\benv\.(${alt})\b`
    + String.raw`|(?:process\.)?\benv\[\s*["'\`](${alt})["'\`]\s*\]`
    + String.raw`|\{[^{}]*\b(${alt})\b[^{}]*\}\s*=\s*process\.env`);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (inBlockComment) { if (raw.includes("*/")) inBlockComment = false; continue; }
    if (/^\s*\/\*/.test(raw) && !raw.includes("*/")) { inBlockComment = true; continue; }
    if (/^\s*(\/\/|\*)/.test(raw)) continue;              // 줄 주석 · 블록 주석 본문
    const code = raw.replace(/\/\/.*$/, "");              // 줄 끝 주석 제거
    if (/^\s*"[a-z_]+":\s*"/.test(code)) continue;        // JSON 문자열로 실린 훅 소스
    const m = re.exec(code);
    if (m) hits.push({ line: i + 1, env: m[1] ?? m[2] ?? m[3], text: raw.trim().slice(0, 110) });
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
  // ⚠ 인덱스 비교는 철자에 취약하다 — 따옴표를 바꾸거나 주석에 함수 이름을 적기만 해도 엉뚱한 진단을 준다.
  //  그래서 ⓐ 두 자리를 **정규식**으로 찾고 ⓑ 못 찾으면 «순서가 틀렸다» 가 아니라 «못 찾았다» 로 말한다
  //  ⓒ freeze 는 주석이 아닌 **실행문**(줄 시작)만 센다.
  const importM = /^\s*import\s+["'][.\/]*boot\/tenancy-env\.js["']/m.exec(gw);
  const freezeM = /^\s*freezeExecTopology\(\)/m.exec(gw);
  assert.ok(importM, "src/index.ts 에서 boot/tenancy-env import 를 못 찾았다 — 철자가 바뀌었으면 이 시험도 함께 고쳐라");
  assert.ok(freezeM, "src/index.ts 본문에 freezeExecTopology() 실행문이 없다(주석 말고 실행문이어야 한다)");
  assert.ok(freezeM.index > importM.index,
    "확정이 boot/tenancy-env import 보다 앞이면 틀린 워크스페이스 모드가 굳는다");
});

t("[S6] 토폴로지 env 를 **쓰는** 자리도 boot/tenancy-env.ts 하나다", () => {
  // 읽기만 한 곳으로 모아도, 부팅 중에 그 값을 **쓰는** 코드가 새로 생기면 «같은 질문에 두 답» 이 되살아난다:
  //  모듈 로드 중에 토폴로지를 묻는 자리(terminal-isolation 의 BOX_SPAWN/BOX_CGSPAWN)는 진입점의
  //  freezeExecTopology() 보다 **먼저** 평가되므로, 그 사이에 새 쓰기가 끼면 확정 전후의 답이 갈린다.
  //  지금은 boot/tenancy-env.ts 하나뿐이고 그건 index.ts 의 문자 그대로 첫 import 라 안전하다 —
  //  이 시험은 그 «하나뿐» 을 지킨다. (자식 프로세스에 넘길 env 사본을 만드는 것은 여기 안 걸린다:
  //   `const env = {...process.env}` 뒤의 `env.X = …` 는 이 프로세스의 값을 안 바꾼다.)
  const KEY = "LIVELY_[A-Z_]+|LVLY_[A-Z_]+";
  const WRITE_RE = new RegExp(
    `process\\.env\\.(?:${KEY})\\s*=(?!=)`                       // process.env.X = …
    + `|delete\\s+process\\.env\\.(?:${KEY})`                     // delete process.env.X
    + `|process\\.env\\[\\s*["'\`](?:${KEY})["'\`]\\s*\\]\\s*=(?!=)`   // process.env["X"] = …
    + `|Object\\.assign\\(\\s*process\\.env`);                   // Object.assign(process.env, …)
  const offenders = [];
  for (const f of files) {
    const r = rel(f);
    if (r === "src/boot/tenancy-env.ts") continue;
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].replace(/\/\/.*$/, "");
      if (/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;
      if (WRITE_RE.test(code)) offenders.push(`${r}:${i + 1}  — ${lines[i].trim().slice(0, 110)}`);
    }
  }
  assert.deepEqual(offenders, [],
    "이 프로세스의 LIVELY_*/LVLY_* env 를 부팅 중에 쓰는 자리가 늘었다. 토폴로지 확정 전후로 답이 갈릴 수 "
    + "있으니, 정말 필요하면 boot/tenancy-env.ts 로 모으고 그 이유를 커밋 메시지에 남겨라:\n  "
    + offenders.join("\n  "));
});

t("[S5] 셀프 노드 판정의 «선결 조건»이 #2592 집행 지점에 물려 있다", () => {
  // 토폴로지가 소유하는 것은 «그 모순이 애초에 성립하는 배포인가» 하나다(증거 규칙·사유 문구는 #2592 소유).
  //  그 한 줄이 빠지면 매니지드 게이트웨이가 노드 등록마다 의미 없는 tmux 조회를 하고, 「위치를 되추론하지
  //  않는다」는 이 프로젝트의 계약이 그 자리에서만 조용히 깨진다 — 증상이 없어 아무도 모른다.
  const reg = readFileSync(join(ROOT, "src/node/registry.ts"), "utf8");
  assert.match(reg, /selfNodePossible\(\)/,
    "node/registry.looksLikeGatewayBox 가 토폴로지의 선결 조건을 묻지 않는다");
});

t("[S7] 확정 해제(unfreezeExecTopology)는 프로덕션 코드가 안 부른다 — 시험 전용이다", () => {
  // 「한 프로세스 한 답」이 존재 이유인 모듈이 그걸 무효화하는 손잡이를 공개로 달고 있다. 주석은 «시험 전용»
  //  이라 말하지만 강제하는 것이 없었다(블라인드 검증 2026-09-03 지적). 여기서 강제한다.
  const offenders = [];
  for (const f of files) {
    if (rel(f) === OWNER) continue;   // 정의부는 당연히 그 이름을 갖는다
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(\/\/|\*)/.test(lines[i])) continue;
      if (/\bunfreezeExecTopology\b/.test(lines[i].replace(/\/\/.*$/, ""))) {
        offenders.push(`${rel(f)}:${i + 1}  — ${lines[i].trim().slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "프로덕션 코드가 토폴로지 확정을 푼다. 그 순간부터 같은 질문에 두 답이 나올 수 있다:\n  " + offenders.join("\n  "));
});

console.log(`\n${pass} passed — 실행 토폴로지 단일 출처(#2599 T2)`);
