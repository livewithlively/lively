// 수집 단위 판정(#4213 T10 #4742) — 사양 엣지 표 P·N·O·B·L·S·V·C 행(순수). DB 쪽 행(L·A·C·S·V 의 저장 부작용)은
//  collect-unit.pg-test.mjs 가 실 Postgres 로 본다.
//
//  사양 요지: 수집 중 단위마다 담당은 하나 — 수집기가 켜져 있으면 수집기, 아니면 우선순위대로 **건강한 첫 후보**.
//  1순위가 끊기면 2순위, 회복되면 다시 1순위. 아무도 못 메우는 단위만 사람이 고칠 수 있는 끊김인 첫 후보에게 알린다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ANY_CONNECTOR, canAdvanceCursor, canEditUnit, canSeeUnit, classifyCollectRun, computeAudience, connectorKey, healthIndex,
  listingClaimAllowed, noticeTargets, normalizeListing, orderCandidates, planUnit, retryDelayMs, splitOverreach,
  type PlanCandidate, type PlanHealth, type PlanUnit,
} from "./unit-plan.js";

const NOW = 1_800_000_000_000;
const H = 3600_000;
const cand = (member_id: string, priority = 10, added_at = 1): PlanCandidate => ({ member_id, priority, added_at });
const unit = (o: Partial<PlanUnit> = {}): PlanUnit => ({
  id: 1, route: "member_ai", state: "active", connector: "Slack", collector: null, candidates: [cand("a", 10), cand("b", 20)], ...o,
});
const health = (member_id: string, state: PlanHealth["state"], o: Partial<PlanHealth> = {}): PlanHealth => ({
  member_id, connector: ANY_CONNECTOR, state, since: NOW - H, retry_at: null, notified_at: null, ...o,
});
const plan = (u: PlanUnit, rows: PlanHealth[] = [], axis = true) => planUnit(u, healthIndex(rows), { now: NOW, sourceAxisOn: axis });
const who = (p: ReturnType<typeof plan>): string | null =>
  p.assignee == null ? null : p.assignee.kind === "member" ? p.assignee.member_id : `collector:${p.assignee.collector_id}`;

// ── P 담당 고르기 ──
test("P1 후보·검토 중 단위는 담당이 없다(not_active)", () => {
  for (const state of ["candidate", "excluded"] as const) {
    const p = plan(unit({ state }));
    assert.equal(p.assignee, null); assert.equal(p.reason, "not_active");
  }
});
test("P2 수집기 경로 — 수집기가 켜져 있고 정상이면 수집기(구성원보다 먼저)", () => {
  const p = plan(unit({ route: "lively_collector", collector: { id: 7, enabled: true, broken: false } }));
  assert.equal(who(p), "collector:7"); assert.equal(p.reason, "ok");
});
test("P3 수집기가 꺼졌거나 없으면 담당 없음 — 구성원으로 넘기지 않는다", () => {
  const off = plan(unit({ route: "lively_collector", collector: { id: 7, enabled: false, broken: false } }));
  assert.equal(off.assignee, null); assert.equal(off.reason, "collector_off");
  const gone = plan(unit({ route: "lively_collector", collector: null }));
  assert.equal(gone.assignee, null); assert.equal(gone.reason, "collector_off");
});
test("P4 수집기가 켜져 있는데 끊겼으면 구성원 후보로 넘어간다", () => {
  const p = plan(unit({ route: "lively_collector", collector: { id: 7, enabled: true, broken: true } }));
  assert.equal(who(p), "a");
});
test("P4b 리브 직접 연결(liv_direct)도 수집기처럼 먼저 모은다", () => {
  assert.equal(who(plan(unit({ route: "liv_direct", collector: { id: 9, enabled: true, broken: false } }))), "collector:9");
});
test("P5 우선순위가 작은 쪽 → 같으면 먼저 들어온 쪽 → 같으면 구성원 id 사전순", () => {
  assert.equal(who(plan(unit({ candidates: [cand("a", 20), cand("b", 10)] }))), "b");
  assert.equal(who(plan(unit({ candidates: [cand("b", 10, 5), cand("a", 10, 9)] }))), "b");
  assert.equal(who(plan(unit({ candidates: [cand("b", 10, 5), cand("a", 10, 5)] }))), "a");
  assert.deepEqual(orderCandidates([cand("c", 5, 1), cand("a", 5, 1), cand("b", 1, 9)]).map((c) => c.member_id), ["b", "a", "c"]);
});
test("P6 1순위의 로그인이 끊기면 2순위가 이어받는다(건너뛴 사람이 남는다)", () => {
  const p = plan(unit(), [health("a", "login_broken")]);
  assert.equal(who(p), "b");
  assert.equal(p.assignee?.kind === "member" && p.assignee.rank, 2);
  assert.deepEqual(p.skipped, [{ member_id: "a", state: "login_broken", connector: ANY_CONNECTOR }]);
});
test("P6b 1순위의 그 단위 커넥터가 끊겨도 넘어간다(대소문자 무시)", () => {
  assert.equal(who(plan(unit(), [health("a", "connector_missing", { connector: "slack" })])), "b");
});
test("P6c 다른 커넥터만 끊긴 1순위는 그대로 담당", () => {
  assert.equal(who(plan(unit(), [health("a", "connector_missing", { connector: "Notion" })])), "a");
});
test("P7 다시 해 볼 시각이 지나면(같은 시각 포함) 1순위에게 한 번 더 맡긴다 — 1ms 전이면 아직 아니다 · 시각 없으면 계속 끊김", () => {
  assert.equal(who(plan(unit(), [health("a", "login_broken", { retry_at: NOW })])), "a");
  assert.equal(who(plan(unit(), [health("a", "login_broken", { retry_at: NOW + 1 })])), "b");
  assert.equal(who(plan(unit(), [health("a", "login_broken", { retry_at: null })])), "b");
});
test("P8 후보가 없으면 «볼 사람 없음»", () => {
  const p = plan(unit({ candidates: [] }));
  assert.equal(p.assignee, null); assert.equal(p.reason, "no_viewer");
});
test("P9 후보가 모두 끊기면 «모두 끊김»", () => {
  const p = plan(unit(), [health("a", "login_broken"), health("b", "quota")]);
  assert.equal(p.assignee, null); assert.equal(p.reason, "all_unhealthy");
  assert.deepEqual(p.skipped.map((s) => s.member_id), ["a", "b"]);
});
test("P10 자료 축이 꺼지면 구성원 경로로는 모으지 않는다 — 수집기 경로는 그대로, 끊긴 수집기의 넘김도 막힌다", () => {
  const m = plan(unit(), [], false);
  assert.equal(m.assignee, null); assert.equal(m.reason, "source_axis_off");
  assert.equal(who(plan(unit({ route: "lively_collector", collector: { id: 7, enabled: true, broken: false } }), [], false)), "collector:7");
  const fb = plan(unit({ route: "lively_collector", collector: { id: 7, enabled: true, broken: true } }), [], false);
  assert.equal(fb.assignee, null); assert.equal(fb.reason, "source_axis_off");
});
test("P11 회복(ok 행) · P12 건강 행이 없는 후보는 건강", () => {
  assert.equal(who(plan(unit(), [health("a", "ok")])), "a");
  assert.equal(who(plan(unit(), [])), "a");
});

// ── N «다시 로그인» 알림 대상 ──
const targets = (units: PlanUnit[], rows: PlanHealth[], axis = true) => {
  const idx = healthIndex(rows);
  return noticeTargets(units.map((u) => planUnit(u, idx, { now: NOW, sourceAxisOn: axis })), idx);
};
test("N1 다른 사람이 메우는 단위는 아무도 부르지 않는다", () => {
  assert.deepEqual(targets([unit()], [health("a", "login_broken")]), []);
});
test("N2 볼 사람이 한 명뿐이고 로그인이 끊기면 그 사람에게(login)", () => {
  assert.deepEqual(targets([unit({ candidates: [cand("a")] })], [health("a", "login_broken")]),
    [{ member_id: "a", kind: "login", connector: ANY_CONNECTOR, unit_ids: [1] }]);
});
test("N2b 둘 다 끊기면 우선순위가 가장 높은 사람만", () => {
  const t = targets([unit()], [health("a", "login_broken"), health("b", "login_broken")]);
  assert.deepEqual(t.map((x) => x.member_id), ["a"]);
});
test("N3 한도 초과만으로 멈춘 사람은 부르지 않는다 · 앞이 한도 초과면 사람이 고칠 수 있는 다음 사람", () => {
  assert.deepEqual(targets([unit({ candidates: [cand("a")] })], [health("a", "quota")]), []);
  assert.deepEqual(targets([unit()], [health("a", "quota"), health("b", "login_broken")]).map((x) => x.member_id), ["b"]);
});
test("N4 이번 끊김에 이미 알린 사람은 다시 고르지 않는다 — 옛 끊김에 알린 것이면 다시", () => {
  const u = unit({ candidates: [cand("a")] });
  assert.deepEqual(targets([u], [health("a", "login_broken", { since: NOW - H, notified_at: NOW - H + 1 })]), []);
  assert.equal(targets([u], [health("a", "login_broken", { since: NOW - H, notified_at: NOW - 2 * H })]).length, 1);
});
test("N5 같은 사람이 여러 단위로 걸리면 한 건(단위 묶음) · 로그인과 커넥터는 따로", () => {
  const solo = (id: number, connector = "Slack") => unit({ id, connector, candidates: [cand("a")] });
  const one = targets([solo(1), solo(2), solo(3)], [health("a", "login_broken")]);
  assert.deepEqual(one, [{ member_id: "a", kind: "login", connector: ANY_CONNECTOR, unit_ids: [1, 2, 3] }]);
  const two = targets([solo(1, "Slack"), solo(2, "Notion")], [health("a", "connector_missing", { connector: "notion" }), health("a", "connector_missing", { connector: "slack" })]);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((t) => t.kind), ["connector", "connector"]);
});
test("N6 수집 중이 아닌 단위 · 자료 축이 꺼진 단위는 알림 대상이 아니다", () => {
  assert.deepEqual(targets([unit({ state: "candidate", candidates: [cand("a")] })], [health("a", "login_broken")]), []);
  assert.deepEqual(targets([unit({ candidates: [cand("a")] })], [health("a", "login_broken")], false), []);
});

// ── O 실행 결과 분류 ──
const ok = { error: null, code: 0 };
test("O1 stderr 의 자격 실패 문구 → 로그인 끊김(*) + 근거", () => {
  const v = classifyCollectRun({ exit: { error: "claude exit 1", code: 1 }, summary: { stderrTail: "API Error: 401 OAuth token has expired. Please obtain a new token" }, requested: ["Slack"] });
  assert.deepEqual(v.changes, [{ connector: ANY_CONNECTOR, state: "login_broken", reason: "토큰 만료(expired)" }]);
  assert.ok(v.evidence && /expired/.test(v.evidence));
});
test("O1b 짧은 결과 문장의 «Please run /login» → 로그인 끊김", () => {
  const v = classifyCollectRun({ exit: { error: "claude exit 1" }, summary: { result: { subtype: "success", error: true, text: "Invalid API key · Please run /login" } }, requested: [] });
  assert.equal(v.changes[0]?.state, "login_broken");
});
test("O2 한도 초과 문구 → quota(*)", () => {
  const v = classifyCollectRun({ exit: { error: "claude exit 1" }, summary: { stderrTail: "Claude AI usage limit reached|1792130000" }, requested: ["Slack"] });
  assert.deepEqual(v.changes, [{ connector: ANY_CONNECTOR, state: "quota", reason: "한도 초과" }]);
});
test("O3 정상 끝 → 로그인 정상 · 허락된 앱 정상 · 빠진 앱은 커넥터 끊김", () => {
  const v = classifyCollectRun({ exit: ok, summary: { result: { subtype: "success", text: "done" }, allowed: ["Slack"], missing: ["Notion"] }, requested: ["Slack", "Notion"] });
  assert.deepEqual(v.changes, [
    { connector: ANY_CONNECTOR, state: "ok", reason: null },
    { connector: "Slack", state: "ok", reason: null },
    { connector: "Notion", state: "connector_missing", reason: "missing" },
  ]);
});
test("O4 no-connector → 요청한 앱은 모두 커넥터 끊김 · 로그인 상태는 그대로(모름)", () => {
  const v = classifyCollectRun({ exit: { error: "no-connector" }, summary: { allowed: [], missing: ["Slack"] }, requested: ["Slack"] });
  assert.deepEqual(v.changes, [{ connector: "Slack", state: "connector_missing", reason: "no-connector" }]);
});
test("O5 시간 초과 · 자격 문구 없는 claude exit · 러너 사망 · 잃음은 아무것도 바꾸지 않는다", () => {
  for (const error of ["timeout", "claude exit 1", "runner-gone", "lost", "canceled"]) {
    assert.deepEqual(classifyCollectRun({ exit: { error }, summary: { stderrTail: "some failure", result: null }, requested: ["Slack"] }).changes, [], error);
  }
});
test("O6 긴 결과 문장 안의 401 은 작업 내용이다 — 성공 판정 그대로", () => {
  const long = "보고서 ".repeat(200) + " 401 unauthorized oauth";
  const v = classifyCollectRun({ exit: ok, summary: { result: { subtype: "success", text: long }, allowed: ["Slack"] }, requested: ["Slack"] });
  assert.equal(v.changes[0].state, "ok");
});
test("O7 끝 신호가 없거나 요약이 없으면 모른다(변화 없음)", () => {
  assert.deepEqual(classifyCollectRun({ exit: null, summary: null, requested: ["Slack"] }).changes, []);
  assert.deepEqual(classifyCollectRun({ exit: ok, summary: null, requested: ["Slack"] }).changes, []);
});

// ── B 다시 해 볼 시각 ──
test("B1 끊김은 연속 횟수로 1h·4h·12h·24h(상한) · B2 한도 초과는 늘 1h", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 0].map((n) => retryDelayMs("login_broken", n) / H), [1, 4, 12, 24, 24, 1]);
  assert.equal(retryDelayMs("connector_missing", 2) / H, 4);
  assert.equal(retryDelayMs("quota", 7) / H, 1);
});

// ── A 볼 수 있는 사람 ──
test("A3 여러 단위로 들어온 자료는 합집합 · A4 정책이 묶었으면 그 안으로 · A4b 팀 대상은 팀원 · A5 비면 0", () => {
  const teams = new Map([["T1", new Set(["b"])]]);
  assert.deepEqual(computeAudience({ units: [{ viewers: ["a"], policy: null }, { viewers: ["b"], policy: null }], teamMembers: teams }), ["a", "b"]);
  assert.deepEqual(computeAudience({ units: [{ viewers: ["a", "b"], policy: { visibility: "members", members: [{ subject_kind: "member", member_id: "a" }, { subject_kind: "member", member_id: "c" }] } }], teamMembers: teams }), ["a"]);
  assert.deepEqual(computeAudience({ units: [{ viewers: ["a", "b"], policy: { visibility: "members", members: [{ subject_kind: "team", member_id: "T1" }] } }], teamMembers: teams }), ["b"]);
  assert.deepEqual(computeAudience({ units: [{ viewers: ["a", "b"], policy: { visibility: "open", members: [] } }], teamMembers: teams }), ["a", "b"]);
  assert.deepEqual(computeAudience({ units: [{ viewers: [], policy: null }], teamMembers: teams }), []);
});

// ── L 목록 정규화 · 메일함 ──
test("L8 같은 ref 는 한 건(뒤의 이름이 빈 이름을 채운다) · 빈 ref 버림 · 모르는 종류는 other", () => {
  const n = normalizeListing([{ ref: " C1 ", kind: "channel" }, { ref: "C1", name: "제품" }, { ref: "" }, { ref: "   " }, { ref: "C2", kind: "weird" }]);
  assert.deepEqual(n, [{ ref: "C1", name: "제품", kind: "channel" }, { ref: "C2", name: null, kind: "other" }]);
});
test("L10 메일함 단위는 본인 메일 주소일 때만(대소문자 무시) · 다른 종류는 제한 없음", () => {
  assert.equal(listingClaimAllowed({ ref: "A@x.io", name: null, kind: "mailbox" }, ["a@x.io"]), true);
  assert.equal(listingClaimAllowed({ ref: "b@x.io", name: null, kind: "mailbox" }, ["a@x.io"]), false);
  assert.equal(listingClaimAllowed({ ref: "b@x.io", name: null, kind: "mailbox" }, []), false);
  assert.equal(listingClaimAllowed({ ref: "C1", name: null, kind: "channel" }, []), true);
});

// ── S 쪼개기 ──
test("S1·S2 쪼개기는 좁히기만 — 부모 밖 구성원을 돌려준다", () => {
  assert.deepEqual(splitOverreach(["a", "b"], ["a"]), []);
  assert.deepEqual(splitOverreach(["a", "b"], []), []);
  assert.deepEqual(splitOverreach(["a"], ["a", "z", "z"]), ["z"]);
});

// ── V 조회·수정 권한 ──
test("V1 구성원 경로 단위는 볼 수 있는 구성원만(관리하는 사람도 못 본다) · V2 수집기 단위는 관리하는 사람도 · V3 수정", () => {
  const m = { route: "member_ai" as const, viewers: ["a"] };
  const c = { route: "lively_collector" as const, viewers: [] as string[] };
  assert.equal(canSeeUnit(m, "z", true), false);
  assert.equal(canSeeUnit(m, "a", false), true);
  assert.equal(canSeeUnit(c, "z", true), true);
  assert.equal(canSeeUnit(c, "z", false), false);
  assert.equal(canEditUnit(m, "z", true), false);
  assert.equal(canEditUnit(m, "a", false), true);
  assert.equal(canEditUnit(c, "a", false), false);
  assert.equal(canEditUnit(c, "z", true), true);
});

// ── C 읽은 위치 ──
test("C1·C2 지금 담당만 읽은 위치를 옮긴다(구성원·수집기 모두)", () => {
  const pm = plan(unit());
  assert.equal(canAdvanceCursor(pm, { member: "a" }), true);
  assert.equal(canAdvanceCursor(pm, { member: "b" }), false);
  assert.equal(canAdvanceCursor(pm, { member: null }), false);
  const pc = plan(unit({ route: "lively_collector", collector: { id: 7, enabled: true, broken: false } }));
  assert.equal(canAdvanceCursor(pc, { collector_id: 7 }), true);
  assert.equal(canAdvanceCursor(pc, { member: "a" }), false);
  assert.equal(canAdvanceCursor(plan(unit({ state: "candidate" })), { member: "a" }), false);
});

test("커넥터 키는 대소문자·앞뒤 공백 무시, * 는 그대로", () => {
  assert.equal(connectorKey(" Google Drive "), "google drive");
  assert.equal(connectorKey("*"), "*");
});
