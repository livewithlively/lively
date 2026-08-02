// 세션로그 append 인가 게이트(#905 C1 슬2b) 단위검증 — checkAppendGate 는 순수라 HTTP·DB 없이 못박는다.
//  실행: npm run build && node dist/session-log-gate.test.js
//  계약(프라이버시 안전): enabled 꺼짐·정책밖 하네스·비소유자·잘못된 오프셋·신원부재 = 거부. 정상만 통과.
import assert from "node:assert/strict";
import { checkAppendGate, checkViewGate } from "./sessions/session-log-routes.js";

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
const v = { requester: "alice", owner: null as string | null, viewPolicy: "attach", isProjectMember: false };
{
  // 소유자는 정책 무관 항상 통과.
  assert.equal(checkViewGate({ ...v, owner: "alice", viewPolicy: "owner" }), null, "소유자는 owner 정책서도 통과");
  assert.equal(checkViewGate({ ...v, owner: "alice", viewPolicy: "attach" }), null, "소유자는 attach 정책서도 통과");
  ok("열람 — 소유자는 언제나 자기 로그 통과");
}
{
  // 🔴 owner 정책 + 비소유자 → 403(프로젝트 멤버여도 막힌다 — owner 정책은 소유자 전용).
  assert.equal(checkViewGate({ ...v, owner: "bob", viewPolicy: "owner", isProjectMember: true })?.status, 403,
    "owner 정책은 멤버여도 비소유자 거부");
  ok("🔴 열람 — owner 정책 + 비소유자(멤버여도) → 403");
}
{
  // attach 정책: 비소유자라도 프로젝트 멤버면 통과, 아니면 403.
  assert.equal(checkViewGate({ ...v, owner: "bob", viewPolicy: "attach", isProjectMember: true }), null,
    "attach + 프로젝트 멤버 → 통과");
  assert.equal(checkViewGate({ ...v, owner: "bob", viewPolicy: "attach", isProjectMember: false })?.status, 403,
    "🔴 attach 라도 비멤버 → 403");
  ok("열람 — attach: 멤버 통과 · 비멤버 403");
}
{
  // 로그 소유자 미정(owner=null, 아직 아무도 안 씀): owner 정책이면 403, attach+멤버면 빈 로그 열람 허용.
  assert.equal(checkViewGate({ ...v, owner: null, viewPolicy: "owner" })?.status, 403, "owner 미정+owner정책 → 403");
  assert.equal(checkViewGate({ ...v, owner: null, viewPolicy: "attach", isProjectMember: true }), null, "owner 미정+attach멤버 → 통과");
  ok("열람 — 소유자 미정 시 owner정책 403 · attach멤버 통과");
}
{
  // 🔴 신원 부재 → 403(최우선).
  assert.equal(checkViewGate({ ...v, requester: "", owner: "", viewPolicy: "attach", isProjectMember: true })?.status, 403,
    "requester 빈 문자열 → 403");
  ok("🔴 열람 — 신원 부재 → 403");
}

console.log(`\n${pass} passed`);
