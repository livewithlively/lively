// 세션로그 append 인가 게이트(#905 C1 슬2b) 단위검증 — checkAppendGate 는 순수라 HTTP·DB 없이 못박는다.
//  실행: npm run build && node dist/session-log-gate.test.js
//  계약(프라이버시 안전): enabled 꺼짐·정책밖 하네스·비소유자·잘못된 오프셋·신원부재 = 거부. 정상만 통과.
import assert from "node:assert/strict";
import { checkAppendGate, checkViewGate, checkPurgeGate } from "./sessions/session-log-routes.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const base = { enabled: true, harnesses: ["claude"], requester: "alice", harness: "claude", owner: null, atOffset: 0 };

// ── 정상 → 통과(null) ──
{
  assert.equal(checkAppendGate(base), null, "정상 append 는 통과");
  assert.equal(checkAppendGate({ ...base, owner: "alice" }), null, "본인이 소유자면 통과");
  assert.equal(checkAppendGate({ ...base, harness: null }), null, "하네스 미명시(쿼리 생략)면 하네스 게이트 통과");
  ok("정상 케이스 → 통과");
}

// ── 🔴 조직 스위치 꺼짐 → 403(켜기 전엔 저장 안 함 — 구 훅 잔존 방어) ──
{
  const d = checkAppendGate({ ...base, enabled: false });
  assert.equal(d?.status, 403, "enabled 꺼지면 403");
  assert.match(d!.message, /세션 공유가 꺼/);
  ok("🔴 enabled 꺼짐 → 403(수집 안 함)");
}

// ── 🔴 정책 밖 하네스 → 403 ──
{
  assert.equal(checkAppendGate({ ...base, harness: "codex" })?.status, 403, "harnesses 에 없는 codex → 403");
  assert.equal(checkAppendGate({ ...base, harnesses: ["claude", "codex"], harness: "codex" }), null, "허용 목록에 있으면 통과");
  ok("🔴 정책 밖 하네스 → 403 · 허용 목록엔 통과");
}

// ── 🔴 비소유자 → 403(남의 세션 로그 오염 방지) ──
{
  const d = checkAppendGate({ ...base, owner: "bob" });
  assert.equal(d?.status, 403, "이미 bob 소유인데 alice 가 쓰면 403");
  assert.match(d!.message, /소유자가 아닙니다/);
  ok("🔴 비소유자 append → 403");
}

// ── 🔴 신원 부재 → 403 ──
{
  assert.equal(checkAppendGate({ ...base, requester: "" })?.status, 403, "requester 빈 문자열 → 403");
  ok("🔴 신원 부재 → 403");
}

// ── 오프셋 형식 오류 → 400 ──
{
  for (const bad of [-1, 1.5, NaN, Infinity]) {
    assert.equal(checkAppendGate({ ...base, atOffset: bad })?.status, 400, `atOffset=${bad} → 400`);
  }
  assert.equal(checkAppendGate({ ...base, atOffset: 0 }), null, "0 은 유효");
  assert.equal(checkAppendGate({ ...base, atOffset: 12345 }), null, "양의 정수 유효");
  ok("오프셋 — 음수·소수·NaN·Inf → 400 · 0/양정수 통과");
}

// ── 게이트 우선순위: 신원부재는 다른 무엇보다 먼저(잘못된 오프셋+꺼짐이어도 신원부터) ──
{
  const d = checkAppendGate({ enabled: false, harnesses: [], requester: "", harness: "x", owner: "y", atOffset: -1 });
  assert.equal(d?.status, 403, "신원부재가 최우선(403)");
  assert.match(d!.message, /신원/);
  ok("우선순위 — 신원 부재가 최우선 판정");
}

// ── 웹뷰 열람 게이트(checkViewGate) — 트랜스크립트 전문 열람 인가(프라이버시). ──
//  #1876 S2 — attach 의 허용 대상이 «프로젝트 멤버» 에서 «그 세션에 초대된 사람» 으로 바뀌었다.
//   명제는 그대로다(소유자 통과 · owner 정책은 비소유자 거부 · attach 는 허용 대상만) — 축만 초대로 옮긴다.
const v = { requester: "alice", owner: null as string | null, viewPolicy: "attach", invited: false };
{
  // 소유자는 정책 무관 항상 통과.
  assert.equal(checkViewGate({ ...v, owner: "alice", viewPolicy: "owner" }), null, "소유자는 owner 정책서도 통과");
  assert.equal(checkViewGate({ ...v, owner: "alice", viewPolicy: "attach" }), null, "소유자는 attach 정책서도 통과");
  ok("열람 — 소유자는 언제나 자기 로그 통과");
}
{
  // 🔴 owner 정책 + 비소유자 → 403(초대받았어도 막힌다 — owner 정책은 소유자 전용).
  assert.equal(checkViewGate({ ...v, owner: "bob", viewPolicy: "owner", invited: true })?.status, 403,
    "owner 정책은 초대받았어도 비소유자 거부");
  ok("🔴 열람 — owner 정책 + 비소유자(초대받았어도) → 403");
}
{
  // attach 정책: 비소유자라도 **초대받았으면** 통과, 아니면 403.
  assert.equal(checkViewGate({ ...v, owner: "bob", viewPolicy: "attach", invited: true }), null,
    "attach + 초대받음 → 통과");
  assert.equal(checkViewGate({ ...v, owner: "bob", viewPolicy: "attach", invited: false })?.status, 403,
    "🔴 attach 라도 초대 없으면 → 403");
  ok("열람 — attach: 초대받은 사람 통과 · 그 외 403");
}
{
  // 로그 소유자 미정(owner=null, 아직 아무도 안 씀): owner 정책이면 403, attach+초대면 빈 로그 열람 허용.
  assert.equal(checkViewGate({ ...v, owner: null, viewPolicy: "owner" })?.status, 403, "owner 미정+owner정책 → 403");
  assert.equal(checkViewGate({ ...v, owner: null, viewPolicy: "attach", invited: true }), null, "owner 미정+attach초대 → 통과");
  ok("열람 — 소유자 미정 시 owner정책 403 · attach초대 통과");
}
{
  // 🔴 신원 부재 → 403(최우선).
  assert.equal(checkViewGate({ ...v, requester: "", owner: "", viewPolicy: "attach", invited: true })?.status, 403,
    "requester 빈 문자열 → 403");
  ok("🔴 열람 — 신원 부재 → 403");
}

// ── 완전 삭제(#1850) — 묘비 게이트 + 삭제 인가 ──
{
  // 🔴 이게 이 기능의 핵심 회귀다. 완전 삭제는 session/session_log 행을 지워 **워터마크를 0으로 되돌린다**.
  //  캡처 훅은 "서버 워터마크부터" 올리므로, 묘비가 없으면 살아 있는 세션이 다음 턴에 전문을 처음부터 다시
  //  올려 **지운 기록이 스스로 부활한다**. 그래서 purged=true 는 정상 조건(enabled·소유자·offset 0)에서도 막아야 한다.
  assert.equal(checkAppendGate({ ...base, owner: "alice", purged: true })?.status, 410,
    "🔴 묘비가 선 좌표는 정상 append 여도 410(재수집 거부) — 없으면 지운 기록이 부활한다");
  assert.equal(checkAppendGate({ ...base, owner: "alice", purged: false }), null, "묘비 없으면 종전대로 통과");
  ok("🔴 append — 완전 삭제된 좌표는 410(부활 차단)");
}
{
  // 묘비는 **조직 스위치보다 앞선다** — 조직이 캡처를 켜 두었든 껐든, 개인이 지운 기록은 다시 받지 않는다.
  //  (enabled=false 면 어차피 403 이지만, 순서가 뒤바뀌면 '켜져 있을 때만' 부활을 막게 되어 반쪽이 된다.)
  assert.equal(checkAppendGate({ ...base, enabled: false, owner: "alice", purged: true })?.status, 410,
    "묘비가 enabled 검사보다 먼저 — 조직 설정과 무관하게 재수집 거부");
  ok("append — 묘비가 조직 스위치보다 우선");
}
{
  // 삭제 인가: 소유자만. 열람(attach 면 프로젝트 멤버까지)보다 **좁다** — 남의 대화를 지우는 건 삭제권이 아니라 검열이다.
  assert.equal(checkPurgeGate({ requester: "alice", owner: "alice" }), null, "소유자 본인 → 통과");
  assert.equal(checkPurgeGate({ requester: "alice", owner: "bob" })?.status, 403, "🔴 남의 기록 → 403");
  assert.equal(checkPurgeGate({ requester: "", owner: "alice" })?.status, 403, "신원 부재 → 403");
  ok("🔴 삭제 — 소유자만 통과(남의 기록 403)");
}
{
  // 기록이 없으면 404 — "지웠다"고 거짓 성공을 돌려주지 않는다(#1582: 확인창·결과는 실제로 일어난 일만).
  assert.equal(checkPurgeGate({ requester: "alice", owner: null })?.status, 404, "중앙 기록 없음 → 404");
  ok("삭제 — 기록 없으면 404(거짓 성공 금지)");
}

console.log(`\n${pass} passed`);
