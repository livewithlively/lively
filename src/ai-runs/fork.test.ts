// 앱 AI 실행의 분기 갈래 — 순수 판정 엣지 표(#4489 앱 v2-10). 실행: npm run build && node dist/ai-runs/fork.test.js
//  이게 틀리면: 모양이 틀린 대상을 조용히 새 대화로 접어 앱이 «세션 맥락으로 답했다» 고 믿거나, 남의 세션 좌표(하네스 · 폴더)를 거절 문장으로
//  흘리거나, 비공개 세션 대화를 앱으로 내보내거나, 메모 없는 답을 맞음으로 읽어 세션에 아무것도 안 남는다.
import assert from "node:assert/strict";
import { FORK_CONSENT_MARK, FORK_SESSION_RE, NOTICE_TEXT_MAX, SESSION_NOTE_MAX, forkConsentOf, forkNoticeText, forkOutputSchema, forkPrompt, forkRefusal, forkTargetOf, judgeForkOutput, type ForkFacts } from "./fork.js";
import { AI_FORK_TOOL } from "../apps/manifest.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// ── T1~T5 대상 읽기 ──
{
  for (const v of [undefined, null, ""]) assert.equal(forkTargetOf(v), null, `${String(v)} 는 새 대화`);
  ok("T1 대상 없음 → 새 대화(null)");
  assert.deepEqual(forkTargetOf({ fork: " box-a1 " }), { session: "box-a1" });
  ok("T2 {fork: 세션} → 그 세션(앞뒤 공백 걷음)");
  for (const bad of [{ fork: 5 }, { fork: "../x" }, { fork: "a b" }, { fork: "" }, { fork: "-x" }, { fork: "x".repeat(129) }]) {
    const r = forkTargetOf(bad);
    assert.ok(r && "error" in r, `${JSON.stringify(bad)} 는 거절이어야 한다`);
  }
  ok("T3 fork 칸의 모양이 틀림 → 거절(조용히 새 대화로 접지 않는다)");
  for (const bad of ["box-a1", ["box-a1"], 7]) assert.ok((forkTargetOf(bad) as { error?: string })?.error, `${JSON.stringify(bad)} 는 객체가 아니라 거절`);
  ok("T4 target 이 객체가 아님 → 거절");
  assert.equal(forkTargetOf({ new: true }), null);
  assert.equal(forkTargetOf({ fork: null }), null);
  ok("T5 다른 모양({new}) · fork:null → 새 대화");
  assert.ok(FORK_SESSION_RE.test("x".repeat(128)) && !FORK_SESSION_RE.test("x".repeat(129)), "경계 — 128자까지");
  ok("T6 경계 — 세션 id 128자까지");
}

// ── R1~R15 분기 거절 판정 — 순서가 곧 안내의 우선순위 ──
{
  const session = (o: Partial<ForkFacts["session"]> = {}): ForkFacts["session"] => ({
    exists: true, owner: "alice", kind: "human", harness: "claude", dir: "/work/p", nodeId: null, appAttached: true, participant: true,
    conversation: "11111111-2222-3333-4444-555555555555", incognito: false, ...o,
  });
  const facts = (o: Partial<ForkFacts> = {}, s: Partial<ForkFacts["session"]> = {}): ForkFacts => ({
    requester: { member: "alice", kind: "member" }, consent: "ok", ownerConsent: "ok", managed: true, session: session(s), ...o,
  });
  assert.equal(forkRefusal(facts()), null);
  ok("R14 다 맞음(주인) → 받는다");
  assert.equal(forkRefusal(facts({ requester: { member: "bob", kind: "member" } }, { participant: true })), null);
  ok("R15 초대받은 사람 → 받는다");

  //  R1 — 사람이 아니면 다른 사실이 다 틀려도 그 이유가 먼저다
  const r1 = forkRefusal(facts({ requester: { member: "alice", kind: "app_server" }, consent: "undeclared", managed: false }, { exists: false }));
  assert.equal(r1?.status, 403); assert.equal(r1?.code, "fork_unavailable"); assert.match(r1!.message, /사람이 보낸 요청/);
  ok("R1 앱 서버 요청 → 403(다른 사실보다 먼저)");
  const r2 = forkRefusal(facts({ consent: "undeclared" }, { exists: false }));
  assert.equal(r2?.status, 403); assert.match(r2!.message, /ai_fork/);
  ok("R2 미선언 → 403(세션 사실보다 먼저)");
  for (const c of ["no_grant", "regrant"] as const) {
    const r = forkRefusal(facts({ consent: c }));
    assert.equal(r?.status, 403); assert.equal(r?.code, "consent_required");
  }
  ok("R3 동의 없음 · 옛 동의 → 403 consent_required");
  assert.equal(forkRefusal(facts({}, { exists: false, owner: null }))?.status, 404);
  ok("R4 세션 없음 → 404");
  //  R5 — 들어갈 수 없는 세션이면 하네스 · 폴더 · 노드가 무엇이든 «주인 · 초대» 만 말한다(좌표를 흘리지 않는다)
  const r5 = forkRefusal(facts({ requester: { member: "eve", kind: "member" } }, { participant: false, harness: "codex", nodeId: "pc-1", dir: null, kind: "task" }));
  assert.equal(r5?.status, 403); assert.match(r5!.message, /주인이나 그 세션에 초대받은 사람/);
  assert.ok(!/Codex|컴퓨터|폴더|위탁/.test(r5!.message), `남의 세션 좌표를 흘렸다: ${r5!.message}`);
  ok("R5 주인도 초대도 아님 → 403 · 세션 좌표를 말하지 않는다");
  assert.equal(forkRefusal(facts({}, { kind: "task" }))?.status, 409);
  ok("R6 사람 세션 아님 → 409");
  assert.equal(forkRefusal(facts({}, { appAttached: false }))?.status, 403);
  ok("R7 앱이 안 붙음 → 403");
  const r8 = forkRefusal(facts({}, { incognito: true }));
  assert.equal(r8?.status, 409); assert.match(r8!.message, /비공개/);
  ok("R8 비공개(incognito) 세션 → 409(대화를 앱으로 내보내지 않는다)");
  const r9 = forkRefusal(facts({}, { harness: "codex" }));
  assert.equal(r9?.status, 409); assert.match(r9!.message, /#4920/);
  assert.match(forkRefusal(facts({}, { harness: "gemini" }))!.message, /Claude Code 세션만/);
  ok("R9 Codex → 409(후속 #4920 안내) · 그 밖의 하네스 → 409");
  assert.equal(forkRefusal(facts({}, { nodeId: "pc-1" }))?.status, 409);
  ok("R10 사람 컴퓨터 노드 세션 → 409");
  assert.equal(forkRefusal(facts({ managed: false }))?.status, 501);
  ok("R11 작업 컨테이너 없는 배포 → 501");
  assert.equal(forkRefusal(facts({}, { conversation: null }))?.status, 409);
  ok("R12 대화 없음 → 409");
  assert.equal(forkRefusal(facts({}, { dir: null }))?.status, 409);
  ok("R13 작업 폴더 모름 → 409");
  //  하네스가 비면 claude 로 친다(옛 행)
  assert.equal(forkRefusal(facts({}, { harness: null })), null);
  ok("R16 하네스 기록 없음 → claude 로 친다");
  //  R17 — 초대받은 사람이 보냈는데 세션 주인이 이 앱의 분기에 동의하지 않았다 → 403 consent_required(주인 몰래 대화를 읽지 않는다)
  for (const c of ["no_grant", "regrant", "undeclared"] as const) {
    const r = forkRefusal(facts({ requester: { member: "bob", kind: "member" }, ownerConsent: c }));
    assert.equal(r?.status, 403); assert.equal(r?.code, "consent_required"); assert.match(r!.message, /세션 주인/);
  }
  ok("R17 세션 주인의 동의가 없음 → 403 consent_required(주인)");
  //  R18 — 들어갈 수 없는 세션이면 주인의 동의 사정보다 «주인·초대» 가 먼저(남의 세션 사정을 흘리지 않는다)
  const r18 = forkRefusal(facts({ requester: { member: "eve", kind: "member" }, ownerConsent: "no_grant" }, { participant: false }));
  assert.match(r18!.message, /주인이나 그 세션에 초대받은/);
  ok("R18 못 들어가는 세션 → 주인 동의보다 «주인·초대» 가 먼저");
}

// ── C1~C4 동의 상태 — 표지 이름 그대로만 ──
{
  assert.equal(FORK_CONSENT_MARK, AI_FORK_TOOL, "판정의 표지와 매니페스트가 함의하는 표지가 같은 글자");
  assert.equal(forkConsentOf(["app_ai_run", "app_ai_fork"], { tools: ["app_ai_run", "app_ai_fork"] }), "ok");
  ok("C1 선언 · 동의 모두 표지 그대로 → ok");
  for (const d of [["app_*"], ["*"], ["app_ai_*"], []]) assert.equal(forkConsentOf(d, { tools: ["*"] }), "undeclared", `선언 ${JSON.stringify(d)}`);
  ok("C2 글롭 선언(app_* · * · app_ai_*) → undeclared(동의 창에 줄이 안 선다)");
  assert.equal(forkConsentOf(["app_ai_fork"], null), "no_grant");
  ok("C3 동의 없음 → no_grant");
  for (const g of [["app_ai_run"], ["app_*"], ["*"]]) assert.equal(forkConsentOf(["app_ai_fork"], { tools: g }), "regrant", `동의 ${JSON.stringify(g)}`);
  ok("C4 옛 동의 · 글롭 동의 → regrant(다시 동의)");
}

// ── J1~J5 출력 판정 — result + session_note ──
{
  const j1 = judgeForkOutput(JSON.stringify({ result: "세 줄 요약", session_note: "  앱이 요약을 물어 세 줄로 답함  " }), null);
  assert.deepEqual(j1, { ok: true, result: "세 줄 요약", note: "앱이 요약을 물어 세 줄로 답함" });
  ok("J1 맞는 모양 → result · 메모(앞뒤 공백 걷음)");
  assert.equal(judgeForkOutput(JSON.stringify({ result: "x" }), null).ok, false);
  assert.equal(judgeForkOutput(JSON.stringify({ result: "x", session_note: "" }), null).ok, false);
  ok("J2 메모 없음 · 빈 메모 → 어긋남(세션에 남길 것이 없다)");
  const app = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
  assert.equal(judgeForkOutput(JSON.stringify({ result: { n: 3 }, session_note: "n=3" }), app).ok, true);
  assert.equal(judgeForkOutput(JSON.stringify({ result: { n: "3" }, session_note: "n=3" }), app).ok, false);
  ok("J3 앱 스키마는 result 칸에 건다");
  assert.equal(judgeForkOutput(JSON.stringify({ result: "x", session_note: "y", extra: 1 }), null).ok, false);
  ok("J4 딴 칸 → 어긋남");
  assert.equal(judgeForkOutput(JSON.stringify({ result: "x", session_note: "가".repeat(SESSION_NOTE_MAX) }), null).ok, true);
  assert.equal(judgeForkOutput(JSON.stringify({ result: "x", session_note: "가".repeat(SESSION_NOTE_MAX + 1) }), null).ok, false);
  ok("J5 경계 — 메모 600자까지");
  const s = forkOutputSchema(null) as { required: string[]; additionalProperties: boolean };
  assert.deepEqual(s.required, ["result", "session_note"]); assert.equal(s.additionalProperties, false);
  ok("J6 출력 스키마 모양");
}

// ── N1~N4 알림 한 줄 ──
{
  const base = { appTitle: "장표 수정", runId: 42, owner: "alice", prompt: "3쪽\n요약해 줘" };
  const n1 = forkNoticeText({ ...base, requester: "alice", note: "3쪽 요약을 앱에 보냄" });
  assert.equal(n1, "앱 「장표 수정」 요청(실행 #42) — 3쪽 요약해 줘 → 3쪽 요약을 앱에 보냄");
  ok("N1 주인이 보낸 성공 → 앱 · 번호 · 요지 → 메모");
  assert.match(forkNoticeText({ ...base, requester: "bob", note: "x" }), /실행 #42 · bob님이 보냄/);
  ok("N2 초대받은 사람이 보냄 → 누가 보냈는지");
  const n3 = forkNoticeText({ ...base, requester: "alice", error: "형식에 맞는 답을 받지 못했습니다\n원문: {" });
  assert.match(n3, /^앱 「장표 수정」 요청이 실패했습니다\(실행 #42\) — 3쪽 요약해 줘: 형식에 맞는 답을 받지 못했습니다 원문: \{$/);
  ok("N3 실패 → 실패 · 사유(줄바꿈은 공백)");
  assert.equal(forkNoticeText({ ...base, requester: "alice", note: "가".repeat(5000) }).length, NOTICE_TEXT_MAX);
  ok("N4 경계 — 한 줄 1000자");
}

// ── P1~P3 분기 지시 ──
{
  const p = forkPrompt({ appTitle: "장표 수정", appId: "deck-edit", requester: "bob", owner: "alice", prompt: "표를 읽고 답해", system: "짧게", schema: null });
  assert.match(p, /^\[라이블리 — 앱 분기 실행\]/);
  assert.match(p, /bob님\(이 세션에 초대받은 사람\)/);
  assert.match(p, /사람의 지시보다 앞서지 않습니다/);
  assert.ok(p.indexOf("[앱 지시]\n짧게") < p.indexOf("[앱 요청]\n표를 읽고 답해"), "앱 지시가 요청보다 앞");
  assert.match(p, /session_note/);
  ok("P1 지시 — 누가 · 앱 글의 자리 · 출력 모양");
  assert.match(forkPrompt({ appTitle: "t", appId: "a", requester: "alice", owner: "alice", prompt: "x", system: null, schema: null }), /이 세션 주인의 요청/);
  ok("P2 주인이 보냄 → «이 세션 주인»");
}

console.log(`ai-runs fork.test: ${pass} passed`);
