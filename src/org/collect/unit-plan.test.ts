// 수집 단위 판정(#4213 T10 #4742) — 사양 엣지 표 P·N·O·B·L·S·V·C 행(순수). DB 쪽 행(L·A·C·S·V 의 저장 부작용)은
//  collect-unit.pg-test.mjs 가 실 Postgres 로 본다.
//
//  사양 요지: 수집 중 단위마다 담당은 하나 — 수집기가 켜져 있으면 수집기, 아니면 우선순위대로 **건강한 첫 후보**.
//  1순위가 끊기면 2순위, 회복되면 다시 1순위. 아무도 못 메우는 단위만 사람이 고칠 수 있는 끊김인 첫 후보에게 알린다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ANY_CONNECTOR, canAdvanceCursor, canEditUnit, canonicalCoord, classifyCollectRun, collectorAuthFailed, computeAudience, connectorKey,
  defaultVisibilityForKind, healthIndex, isWidening, listingClaimAllowed, noticeTargets, normalizeListing, orderCandidates, planUnit, retryDelayMs,
  splitOverreach, unitAccess, visibilityChangeError,
  type AudienceUnit, type PlanCandidate, type PlanHealth, type PlanUnit,
} from "./unit-plan.js";

const NOW = 1_800_000_000_000;
const H = 3600_000;
const cand = (member_id: string, priority = 10, added_at = 1, verified = true): PlanCandidate => ({ member_id, priority, added_at, verified });
const unit = (o: Partial<PlanUnit> = {}): PlanUnit => ({
  id: 1, route: "member_ai", state: "active", connector: "Slack", collector: null, candidates: [cand("a", 10), cand("b", 20)],
  visibility: "viewers", owner: null, ...o,
});
const health = (member_id: string, state: PlanHealth["state"], o: Partial<PlanHealth> = {}): PlanHealth => ({
  member_id, connector: ANY_CONNECTOR, state, since: NOW - H, retry_at: null, notified_at: null, ...o,
});
const plan = (u: PlanUnit, rows: PlanHealth[] = []) => planUnit(u, healthIndex(rows), { now: NOW });
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
test("P5d 확인된 사람이 먼저 — 신고만 한 사람은 우선순위가 앞이어도 뒤에 선다(확인된 사람이 없으면 그 사람이 맡는다)", () => {
  assert.equal(who(plan(unit({ candidates: [cand("z", 1, 1, false), cand("a", 50, 9, true)] }))), "a");
  assert.equal(who(plan(unit({ candidates: [cand("z", 1, 1, false)] }))), "z");
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
test("P10 «나만» 단위는 정한 사람의 계정으로만 모은다 — 1순위가 따로 있어도 · 주인이 끊기면 아무도 안 맡고 · 주인이 후보에 없으면 no_viewer", () => {
  assert.equal(who(plan(unit({ visibility: "me", owner: "b" }))), "b");
  const broken = plan(unit({ visibility: "me", owner: "b" }), [health("b", "login_broken")]);
  assert.equal(broken.assignee, null); assert.equal(broken.reason, "all_unhealthy");
  assert.deepEqual(broken.skipped.map((s) => s.member_id), ["b"]);
  const gone = plan(unit({ visibility: "me", owner: "z" }));
  assert.equal(gone.assignee, null); assert.equal(gone.reason, "no_viewer");
  //  끊긴 수집기에서 넘어올 때도 주인만.
  assert.equal(who(plan(unit({ visibility: "me", owner: "b", route: "lively_collector", collector: { id: 7, enabled: true, broken: true } }))), "b");
});
test("P10b «볼 수 있는 사람만»·«모두» 는 주인 칸이 남아 있어도 보통 순서대로", () => {
  assert.equal(who(plan(unit({ visibility: "viewers", owner: "b" }))), "a");
  assert.equal(who(plan(unit({ visibility: "all", owner: "b" }))), "a");
});
test("P11 회복(ok 행) · P12 건강 행이 없는 후보는 건강", () => {
  assert.equal(who(plan(unit(), [health("a", "ok")])), "a");
  assert.equal(who(plan(unit(), [])), "a");
});

// ── N «다시 로그인» 알림 대상 ──
const targets = (units: PlanUnit[], rows: PlanHealth[]) => {
  const idx = healthIndex(rows);
  return noticeTargets(units.map((u) => planUnit(u, idx, { now: NOW })), idx);
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
test("N6 수집 중이 아닌 단위는 알림 대상이 아니다 · N6b «나만» 단위가 주인 끊김으로 멈추면 주인에게만 알린다", () => {
  assert.deepEqual(targets([unit({ state: "candidate", candidates: [cand("a")] })], [health("a", "login_broken")]), []);
  assert.deepEqual(targets([unit({ visibility: "me", owner: "b" })], [health("a", "login_broken"), health("b", "login_broken")]),
    [{ member_id: "b", kind: "login", connector: ANY_CONNECTOR, unit_ids: [1] }]);
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
const au = (o: Partial<AudienceUnit> = {}): AudienceUnit => ({ visibility: "viewers", viewers: [], owner: null, policy: null, ...o });
const only = (...ids: string[]) => ({ visibility: "members" as const, members: ids.map((member_id) => ({ subject_kind: "member" as const, member_id })) });
const aud = (units: AudienceUnit[]) => computeAudience({ units, teamMembers: new Map([["T1", new Set(["b"])]]) });
const locked = (...members: string[]) => ({ open: false, members });
test("A3 여러 단위로 들어온 자료는 합집합 · A4 정책이 묶었으면 그 안으로 · A4b 팀 대상은 팀원 · A5 비면 0(잠긴 채)", () => {
  assert.deepEqual(aud([au({ viewers: ["a"] }), au({ viewers: ["b"] })]), locked("a", "b"));
  assert.deepEqual(aud([au({ viewers: ["a", "b"], policy: only("a", "c") })]), locked("a"));
  assert.deepEqual(aud([au({ viewers: ["a", "b"], policy: { visibility: "members", members: [{ subject_kind: "team", member_id: "T1" }] } })]), locked("b"));
  assert.deepEqual(aud([au({ viewers: ["a", "b"], policy: { visibility: "open", members: [] } })]), locked("a", "b"));
  assert.deepEqual(aud([au()]), locked());
});
test("A6 «모두» 단위 — 정책이 없거나 open 이면 잠그지 않는다 · 정책이 묶었으면 정책 대상 전원(팀은 팀원) · 정책이 못 읽혀 비면 0", () => {
  assert.deepEqual(aud([au({ visibility: "all", viewers: ["a"] })]), { open: true, members: [] });
  assert.deepEqual(aud([au({ visibility: "all", policy: { visibility: "open", members: [] } })]), { open: true, members: [] });
  assert.deepEqual(aud([au({ visibility: "all", viewers: ["a"], policy: only("c", "d") })]), locked("c", "d"));
  assert.deepEqual(aud([au({ visibility: "all", policy: { visibility: "members", members: [{ subject_kind: "team", member_id: "T1" }] } })]), locked("b"));
  assert.deepEqual(aud([au({ visibility: "all", viewers: ["a"], policy: only() })]), locked());
});
test("A7 «나만» 단위 — 정한 사람 한 명(볼 수 있는 구성원이 더 있어도) · 주인이 비면 0 · 정책 밖 주인이면 0 · 주인이 그 단위에서 빠졌으면 0", () => {
  assert.deepEqual(aud([au({ visibility: "me", owner: "a", viewers: ["a", "b"] })]), locked("a"));
  assert.deepEqual(aud([au({ visibility: "me", owner: null, viewers: ["a"] })]), locked());
  assert.deepEqual(aud([au({ visibility: "me", owner: "a", viewers: ["a"], policy: only("b") })]), locked());
  assert.deepEqual(aud([au({ visibility: "me", owner: "a", viewers: ["b"] })]), locked());
});
test("A9 섞이면 합집합 — 나만+볼 수 있는 사람만 · 모두(정책 없음)가 하나라도 있으면 열림 · 모두(정책)+볼 수 있는 사람만", () => {
  assert.deepEqual(aud([au({ visibility: "me", owner: "a", viewers: ["a"] }), au({ viewers: ["c", "b"] })]), locked("a", "b", "c"));
  assert.deepEqual(aud([au({ visibility: "me", owner: "a", viewers: ["a"] }), au({ visibility: "all" })]), { open: true, members: [] });
  assert.deepEqual(aud([au({ visibility: "all", policy: only("x") }), au({ viewers: ["b"] })]), locked("b", "x"));
});
test("A11 넓히기 — 나만 → 볼 수 있는 사람만 → 모두 쪽만(같거나 좁히기는 아니다)", () => {
  assert.equal(isWidening("me", "viewers"), true);
  assert.equal(isWidening("viewers", "all"), true);
  assert.equal(isWidening("me", "all"), true);
  for (const [a, b] of [["all", "viewers"], ["viewers", "me"], ["all", "me"], ["me", "me"], ["viewers", "viewers"], ["all", "all"]] as const) {
    assert.equal(isWidening(a, b), false, `${a}→${b}`);
  }
});
test("A10 리브의 첫 제안 — 공개 채널=모두 · DM·여러 사람 DM·메일함·라벨=나만 · 그 밖=볼 수 있는 사람만", () => {
  assert.equal(defaultVisibilityForKind("channel"), "all");
  for (const k of ["dm", "group_dm", "mailbox", "label"]) assert.equal(defaultVisibilityForKind(k), "me", k);
  for (const k of ["private_channel", "page", "database", "folder", "repo", "project", "team", "file", "other", "weird"]) {
    assert.equal(defaultVisibilityForKind(k), "viewers", k);
  }
});

// ── L 목록 정규화 · 메일함 ──
test("L8 같은 ref 는 한 건(뒤의 이름이 빈 이름을 채운다) · 빈 ref 버림 · 모르는 종류는 other", () => {
  const n = normalizeListing([{ ref: " C1 ", kind: "channel" }, { ref: "C1", name: "제품" }, { ref: "" }, { ref: "   " }, { ref: "C2", kind: "weird" }]);
  assert.deepEqual(n, [{ ref: "C1", name: "제품", kind: "channel" }, { ref: "C2", name: null, kind: "other" }]);
});
test("L10 메일함은 본인 주소만(대소문자 무시) — 메일함인지는 앱·저장된 단위로 정한다(신고자가 kind 를 빼거나 바꿔도 못 지나간다)", () => {
  const me = { memberEmails: ["a@x.io"] };
  assert.equal(listingClaimAllowed({ ref: "A@x.io", name: null, kind: "mailbox" }, { app: "gmail", ...me }), true);
  assert.equal(listingClaimAllowed({ ref: "b@x.io", name: null, kind: "mailbox" }, { app: "gmail", ...me }), false);
  assert.equal(listingClaimAllowed({ ref: "b@x.io", name: null, kind: "other" }, { app: "gmail", ...me }), false, "kind 를 빼도 gmail 은 메일함");
  assert.equal(listingClaimAllowed({ ref: "b@x.io", name: null, kind: "channel" }, { app: "outlook", ...me }), false, "kind 를 바꿔도 outlook 은 메일함");
  assert.equal(listingClaimAllowed({ ref: "b@x.io", name: null, kind: "other" }, { app: "cupg", existingKind: "mailbox", ...me }), false, "저장된 단위가 메일함");
  assert.equal(listingClaimAllowed({ ref: "b@x.io", name: null, kind: "mailbox" }, { app: "cupg", memberEmails: [] }), false);
  assert.equal(listingClaimAllowed({ ref: "C1", name: null, kind: "channel" }, { app: "slack", memberEmails: [] }), true);
});
test("L11 좌표 정규화 — 메일은 인스턴스 default·주소 소문자 · 노션 32자 id 는 하이픈 꼴 · 그 밖은 공백만", () => {
  assert.deepEqual(canonicalCoord("gmail", "", " A@X.io "), { instance: "default", ref: "a@x.io" });
  assert.deepEqual(canonicalCoord("outlook", "tenant", "B@X.io"), { instance: "tenant", ref: "b@x.io" });
  assert.deepEqual(canonicalCoord("notion", "ws", "0123456789ABCDEF0123456789abcdef"), { instance: "ws", ref: "01234567-89ab-cdef-0123-456789abcdef" });
  assert.deepEqual(canonicalCoord("notion", "ws", "01234567-89ab-cdef-0123-456789abcdef"), { instance: "ws", ref: "01234567-89ab-cdef-0123-456789abcdef" });
  assert.deepEqual(canonicalCoord("slack", " T1 ", " C0AB "), { instance: "T1", ref: "C0AB" });
});

// ── S 쪼개기 ──
test("S1·S2 쪼개기는 좁히기만 — 부모 밖 구성원을 돌려준다", () => {
  assert.deepEqual(splitOverreach(["a", "b"], ["a"]), []);
  assert.deepEqual(splitOverreach(["a", "b"], []), []);
  assert.deepEqual(splitOverreach(["a"], ["a", "z", "z"]), ["z"]);
});

// ── V 조회·수정 권한 ──
test("V1 구성원 경로 단위: 확인된 구성원 full · 신고만 한 본인 coarse · 그 밖(관리자 포함) none", () => {
  const m = { route: "member_ai" as const, members: [{ member_id: "a", verified: true }, { member_id: "c", verified: false }] };
  assert.equal(unitAccess(m, "a", false), "full");
  assert.equal(unitAccess(m, "c", false), "coarse");
  assert.equal(unitAccess(m, "z", true), "none");
});
test("V2 수집기 단위: 관리자 full · 확인된 구성원 full · 다른 구성원 coarse(후보 줄·건강은 안 보임)", () => {
  const c = { route: "lively_collector" as const, members: [{ member_id: "a", verified: true }] };
  assert.equal(unitAccess(c, "z", true), "full");
  assert.equal(unitAccess(c, "a", false), "full");
  assert.equal(unitAccess(c, "z", false), "coarse");
  assert.equal(unitAccess({ route: "liv_direct", members: [] }, "z", false), "coarse");
});
test("V3 고치기: 구성원 경로 = 확인된 구성원만(신고만 한 사람·관리자 안 됨) · 수집기 경로 = 관리자 또는 확인된 구성원", () => {
  const m = { route: "member_ai" as const, members: [{ member_id: "a", verified: true }, { member_id: "c", verified: false }] };
  const c = { route: "lively_collector" as const, members: [{ member_id: "a", verified: true }] };
  assert.equal(canEditUnit(m, "a", false), true);
  assert.equal(canEditUnit(m, "c", false), false);
  assert.equal(canEditUnit(m, "z", true), false);
  assert.equal(canEditUnit(c, "z", true), true);
  assert.equal(canEditUnit(c, "a", false), true);
  assert.equal(canEditUnit(c, "z", false), false);
});

test("V4 공개범위 바꾸기 — 고칠 수 있는 사람만 · «나만» 은 확인된 사람만 고른다 · 남의 «나만» 은 «볼 수 있는 사람만» 으로만", () => {
  const vis = (visibility: "me" | "viewers" | "all", owner: string | null, members: Array<{ member_id: string; verified: boolean; active?: boolean }>,
    route: "member_ai" | "lively_collector" = "member_ai") => ({ route, members, visibility, owner });
  const m = vis("viewers", null, [{ member_id: "a", verified: true }, { member_id: "c", verified: false }]);
  assert.equal(visibilityChangeError(m, "all", "a", false), null);
  assert.equal(visibilityChangeError(m, "me", "a", false), null);
  assert.match(String(visibilityChangeError(m, "all", "c", false)), /권한/);
  assert.match(String(visibilityChangeError(m, "all", "z", true)), /권한/);
  //  수집기 단위 — 관리자는 고칠 수 있어도 확인되지 않았으면 «나만» 을 못 고른다.
  assert.equal(visibilityChangeError(vis("viewers", null, [], "lively_collector"), "all", "z", true), null);
  assert.match(String(visibilityChangeError(vis("viewers", null, [], "lively_collector"), "me", "z", true)), /확인된 사람만/);
  //  «나만» 단위: 정한 사람은 무엇으로든 · 다른 확인된 구성원은 «볼 수 있는 사람만» 으로만(상민님 2026-10-16) —
  //   «모두» 로 넓히기·주인 바꾸기는 못 한다 · 확인되지 않은 사람(신고만 · 관리자)은 아무것도 못 한다.
  const mine = vis("me", "a", [{ member_id: "a", verified: true }, { member_id: "b", verified: true }, { member_id: "c", verified: false }]);
  assert.equal(visibilityChangeError(mine, "viewers", "a", false), null);
  assert.equal(visibilityChangeError(mine, "all", "a", false), null);
  assert.equal(visibilityChangeError(mine, "viewers", "b", false), null);
  assert.match(String(visibilityChangeError(mine, "all", "b", false)), /볼 수 있는 사람만» 으로만/);
  assert.match(String(visibilityChangeError(mine, "me", "b", false)), /볼 수 있는 사람만» 으로만/);
  assert.match(String(visibilityChangeError(mine, "viewers", "c", false)), /권한/);
  //  수집기 메일함처럼 주인 한 명만 확인된 «나만» — 확인 안 된 관리자는 고칠 수는 있어도(수집기 단위) 남의 «나만» 은 못 바꾼다.
  const box = vis("me", "a", [{ member_id: "a", verified: true }], "lively_collector");
  assert.match(String(visibilityChangeError(box, "viewers", "z", true)), /정한 사람만/);
  assert.match(String(visibilityChangeError(box, "all", "z", true)), /정한 사람만/);
});
test("V5 «나만» 넘겨받기 — 주인이 확인되지 않았거나(신고만) 내보낸 사람이면 확인된 구성원이 넘겨받는다 · 확인 안 된 관리자는 못 한다", () => {
  const claimed = { route: "member_ai" as const, visibility: "me" as const, owner: "c", members: [{ member_id: "c", verified: false }, { member_id: "b", verified: true }] };
  assert.equal(visibilityChangeError(claimed, "me", "b", false), null);
  assert.equal(visibilityChangeError(claimed, "viewers", "b", false), null);
  const left = { ...claimed, owner: "a", members: [{ member_id: "a", verified: true, active: false }, { member_id: "b", verified: true }] };
  assert.equal(visibilityChangeError(left, "me", "b", false), null);
  const coll = { route: "lively_collector" as const, visibility: "me" as const, owner: "c", members: [{ member_id: "c", verified: false }] };
  assert.match(String(visibilityChangeError(coll, "all", "z", true)), /정한 사람만/);
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

test("K1 수집기 자격 실패 — 실제 수집기 로그 문구(슬랙·노션·구글·GitHub)를 알아본다", () => {
  for (const t of [
    '{"level":50,"err":"slack conversations.history error: invalid_auth","msg":"generic 싱크 실패"}',
    "slack auth.test error: token_revoked",
    "slack users.conversations error: account_inactive",
    "slack conversations.list error: not_authed",
    'Notion 401 /databases/1a2b3c4d: {"object":"error","status":401,"code":"unauthorized","message":"API token is invalid."}',
    "Google 토큰 갱신 실패 400: invalid_grant",
    "GitHub 401: Bad credentials",
  ]) assert.equal(collectorAuthFailed(t), true, t);
});
test("K2 권한 부족·한도·없음·숫자만 401 은 자격 실패가 아니다", () => {
  for (const t of [
    "slack search.messages error: missing_scope (search:read 가 필요합니다)",
    "slack conversations.history error: ratelimited",
    "slack conversations.info error: channel_not_found",
    "Notion 404 /pages/401abc: object_not_found",
    "page 401 of 900 processed",
    "",
  ]) assert.equal(collectorAuthFailed(t), false, t);
});

test("커넥터 키는 대소문자·앞뒤 공백 무시, * 는 그대로", () => {
  assert.equal(connectorKey(" Google Drive "), "google drive");
  assert.equal(connectorKey("*"), "*");
});
