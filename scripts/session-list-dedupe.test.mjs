// 세션 목록 병합 **배선 계약**(#1716) — 노드 스냅샷을 로컬 목록과 합쳐 내보내는 라우트는 mergeSessionViews 를 거친다.
//
// 왜 정적 검사인가: 이중표기는 "게이트웨이와 노드 에이전트가 같은 박스에서 같은 tmux 서버를 본다"는 배치에서만
//  드러난다(실측 2026-08-15 dev — AI 세션 탭 카드가 전부 2장). 그 배치는 단위 테스트로 못 만들고, 헬퍼만
//  단위 테스트하면 **라우트가 헬퍼를 안 쓰는 상태로 되돌아가도 전부 초록불**이다 — 종전 코드가 정확히 그 모양
//  (`[...local, ...restorable, ...remote]`)이었다. 그래서 병합 지점 자체를 계약으로 고정한다.
//
// 실패하면: 새로 만든 세션 목록 응답이 있다면 mergeSessionViews 로 합치도록 고치고, 정말 단일 출처라면
//  아래 SINGLE_SOURCE_OK 에 근거와 함께 추가하라(그 응답에 노드 세션이 섞이지 않는다는 근거여야 한다).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = walk(srcDir);
assert.ok(files.length > 50, "src 스캔이 비었다 — 경로가 바뀌었으면 이 테스트도 같이 고치세요");

// ① 노드 세션을 목록에 합치는 파일은 병합 헬퍼를 쓴다.
//  (nodeSessionsFor/nodeProjectSessions 를 **정의·릴레이**만 하는 node/ 하위는 응답을 조립하지 않으므로 제외.)
const NODE_SESSION_CALL = /\bnode(SessionsFor|ProjectSessions)\s*\(/;
const consumers = files.filter((f) => {
  const rel = relative(root, f);
  if (rel.startsWith("src/node/")) return false;          // 레지스트리·릴레이 — 목록 응답을 만들지 않는다
  return NODE_SESSION_CALL.test(readFileSync(f, "utf8"));
});
assert.ok(consumers.length >= 2,
  `노드 세션을 합치는 라우트를 못 찾았다(${consumers.length}건) — 이름이 바뀌었다면 이 테스트도 같이 고치세요`);
for (const f of consumers) {
  const src = readFileSync(f, "utf8");
  const rel = relative(root, f);
  // 목록 응답을 만드는 파일만 대상(단건 조회에 nodeSessionsFor 를 쓰는 자리는 합칠 게 없다).
  if (!/res\.json\(\{\s*sessions:/.test(src)) continue;
  assert.match(src, /mergeSessionViews\(/,
    `${rel}: 세션 목록 응답이 mergeSessionViews 를 안 거친다 — 같은 세션이 중앙 tmux·노드 스냅샷 양쪽에 잡히면 카드가 2장이 된다(#1716)`);
}

// ② 세션 목록을 스프레드로 이어 붙이지 않는다 — 그게 중복을 만든 종전 모양이다.
//  단일 출처라 dedupe 가 필요 없는 응답은 여기 근거와 함께 등록한다(현재 없음).
const SINGLE_SOURCE_OK = new Set([]);
for (const f of files) {
  const rel = relative(root, f);
  if (SINGLE_SOURCE_OK.has(rel)) continue;
  const src = readFileSync(f, "utf8");
  const hit = src.match(/sessions:\s*\[\s*\.\.\./);
  assert.equal(hit, null,
    `${rel}: 세션 목록을 스프레드로 이어 붙였다("${hit && hit[0]}") — mergeSessionViews 로 합치세요(#1716 이중표기)`);
}

console.log(`session-list dedupe 계약 OK — 병합 라우트 ${consumers.length}건`);
