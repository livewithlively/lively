// #1875 — 세션 목록의 워크스페이스 격리. 2026-08-27 장원준 신고: 개인 워크스페이스 사이드바에 **다른
//  워크스페이스(팀·박스)의 세션 제목이 그대로 보인다**. 원인: 세션 목록이 owner(org_member — 워크스페이스를
//  넘나드는 전역 신원)로만 걸러, 그 사람의 모든 세션이 어느 워크스페이스에서든 다 나왔다.
//
// 여기서 잠그는 명제는 "빠지면 조용히 남의 워크스페이스 세션 제목이 새는" 종류다. 그래서 규칙 하나를
//  순수 함수(sessionInWorkspace)로 뽑아 SQL 필터·JS 필터가 같은 명제를 쓰게 했고, 그 명제를 엣지마다 건다.
//  (SQL(listSessionsForOwner)·JS(routes.ts) 두 필터가 이 함수와 같은 규칙인지는 아래 구조 단언이 지킨다.)
//
// 엣지 표(입력=[세션의 맵 소속, 현재 워크스페이스] × 기대=보이나):
//   E1 [부재, primary]  → 보임   (새 헬퍼의 '맵 부재' 엣지 — 옛 세션은 전부 여기)
//   E2 [부재, 개인A]    → 숨김   ★신고의 핵심(박스 세션이 개인 ws 로 샜다)
//   E3 [개인A, 개인A]   → 보임   (자기 것)
//   E4 [개인A, 개인B]   → 숨김   ★개인↔개인 누수
//   E5 [개인A, primary] → 숨김   ★대칭(개인 세션이 박스로 누수)
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionInWorkspace, PRIMARY_TENANT_ID } from "./registry.js";

const PRIMARY = PRIMARY_TENANT_ID;                   // 박스/primary — gw_session_map 에 행이 없으면 여기로 귀속
const WS_A = "11111111-1111-1111-1111-111111111111"; // 개인 워크스페이스 A(예: 하루)
const WS_B = "22222222-2222-2222-2222-222222222222"; // 개인 워크스페이스 B

test("E1 안 묶인 옛 세션은 primary(박스)에서 보인다 — 맵 부재 = primary", () => {
  assert.equal(sessionInWorkspace(undefined, PRIMARY), true);
  assert.equal(sessionInWorkspace(null, PRIMARY), true);
});

test("★ E2 안 묶인(박스) 세션은 개인 워크스페이스로 새지 않는다 — 이 신고의 핵심", () => {
  // owner 로만 걸렀을 때 개인 ws 사이드바에 박스 세션 제목이 뜨던 바로 그 자리.
  assert.equal(sessionInWorkspace(undefined, WS_A), false);
});

test("E3 개인 워크스페이스 세션은 그 워크스페이스에서 보인다", () => {
  assert.equal(sessionInWorkspace(WS_A, WS_A), true);
});

test("★ E4 개인 워크스페이스 세션은 다른 개인 워크스페이스로 새지 않는다", () => {
  assert.equal(sessionInWorkspace(WS_A, WS_B), false);
});

test("★ E5 개인 워크스페이스 세션은 primary(박스)에도 새지 않는다", () => {
  // 대칭 — 개인에서 만든 세션이 팀/박스 목록에 뜨면 그것도 격리 위반이다.
  assert.equal(sessionInWorkspace(WS_A, PRIMARY), false);
});

// ── 구조·배선: 두 목록 경로가 실제로 워크스페이스로 거른다(누가 필터를 떼면 red) ──────────

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json")) && existsSync(path.join(d, "web"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const readSrc = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");

test("★ E6 이력 목록(/api/ui/v6/sessions)의 SQL 이 gw_session_map 으로 거른다 — 없으면 owner 전체가 샌다", () => {
  const src = readSrc("src/v6/session-log-store.ts");
  // listSessionsForOwner 가 gw_session_map 을 술어로 쓰고, 맵 부재를 primary 로 귀속(COALESCE … SINGLE_TENANT_ID)한다.
  assert.match(src, /gw_session_map[\s\S]{0,240}COALESCE|COALESCE[\s\S]{0,240}gw_session_map/,
    "listSessionsForOwner 에 gw_session_map 워크스페이스 필터가 없다 — owner 로만 걸러 개인 ws 에 박스 세션이 샌다");
  assert.match(src, /SINGLE_TENANT_ID/, "맵 부재 시 primary 귀속(SINGLE_TENANT_ID)이 없다");
});

test("★ E7 라이브 목록(/api/ui/terminal/sessions)이 sessionInWorkspace 로 거른다", () => {
  const src = readSrc("src/terminal/routes.ts");
  assert.match(src, /sessionInWorkspace\(/, "라이브 세션 목록 응답에 워크스페이스 필터(sessionInWorkspace)가 없다");
});

test("E8 세션 목록 엔드포인트가 현재 워크스페이스를 필터로 넘긴다", () => {
  const src = readSrc("src/sessions/session-log-routes.ts");
  // 현재 워크스페이스를 뽑아(currentTenant, 부재=primary) listSessionsForOwnerPage 의 3번째 인자로 넘긴다.
  assert.match(src, /const wsId = currentTenant\(\)\?\.id \?\? PRIMARY_TENANT_ID/,
    "/api/ui/v6/sessions 가 현재 워크스페이스(currentTenant)를 읽지 않는다");
  assert.match(src, /listSessionsForOwnerPage\([\s\S]{0,80}?,\s*wsId\)/,
    "/api/ui/v6/sessions 가 listSessionsForOwnerPage 에 wsId(현재 워크스페이스)를 넘기지 않는다");
});
