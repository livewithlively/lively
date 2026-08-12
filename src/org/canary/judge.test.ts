// 카나리 판정 테스트 (#1657). 사양 = 표 P(단언)·Q(연속 실패·전이)·R(프로브 구성).
//
//  회귀 대상 ①: **이번 구글 사고를 이 장치가 잡는가.** 구글은 스키마를 하나도 안 바꿨고(tools/list 는 익명으로도
//   200 + 8툴), 403 은 **HTTP 200 + isError:true** 로 왔다. 즉 '스키마가 같나'도 '200 이 왔나'도 판정 근거가
//   못 된다 — 응답 '내용'을 단언해야 한다. P1·P2 가 그 형태를 그대로 재현한다.
//  회귀 대상 ②: **카나리가 고객보다 잘 설정돼 있으면 눈이 먼다**(R3) — 게이트가 GCP 프로젝트 단위라 우리만
//   등록해 두면 전 고객이 깨져도 초록불이다. 어댑터마다 plain 등급 프로브를 강제한다.
//  회귀 대상 ③: **단언 없는 프로브는 프로브가 아니다**(R2) — 호출 성공만 보면 정확히 이번처럼 눈이 먼다.
import assert from "node:assert/strict";
import { judgeProbe, evaluateStreak, alertTransition, pluck, isUnconfigured } from "./judge.js";
import { assertProbeCoverage, CANARY_PROBES, DENIAL_MARKERS, type CanaryProbe } from "./probes.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── P. 한 번의 호출을 어떻게 판정하나 ──
t("P1 ★ 이번 구글 사고 형태 — HTTP 200 + isError:true + 거부 문구를 실패로 잡는다", () => {
  const google403 = {
    isError: true,
    text: JSON.stringify({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }),
  };
  const v = judgeProbe(google403, { json: true, contains: ["files"], notContains: DENIAL_MARKERS });
  assert.equal(v.ok, false);
  assert.ok(v.reason?.includes("permission"), `사유를 알 수 없으면 진단이 불가능하다: ${v.reason}`);
});

t("P2 ★ isError 가 아니어도 본문에 거부 문구가 있으면 실패 — 200 위장을 잡는다", () => {
  const v = judgeProbe({ isError: false, text: '{"error":"PERMISSION_DENIED","files":[]}' }, { json: true, contains: ["files"], notContains: DENIAL_MARKERS });
  assert.equal(v.ok, false, "형태만 맞으면 통과시키면 거부 응답이 초록불이 된다");
  assert.ok(v.reason?.includes("PERMISSION_DENIED"));
});

t("P1b isError:true 면 형태가 완벽해도 실패 — '안 던졌으니 성공'으로 되돌아가지 않는다", () => {
  // ⚠ 이 행이 isError 를 **독립적인 실패 근거**로 못박는다. P1 의 응답은 형태 단언도 어차피 깨져 있어서,
  //  isError 검사를 통째로 지워도 다른 단언이 대신 실패해 red 가 안 났다(실측).
  const v = judgeProbe({ isError: true, text: '{"files":[{"id":"1"}]}' },
    { json: true, contains: ["files"], paths: ["files.0.id"], notContains: DENIAL_MARKERS });
  assert.equal(v.ok, false, "isError 를 무시하면 #1653 이전 사고방식으로 되돌아간다");
});

t("P3 거부 판정이 형태 판정보다 먼저다 — 사유가 증상이 아니라 원인을 가리킨다", () => {
  // 형태 단언도 깨진 거부 응답. 사유가 "files 가 0개"면 사람이 '데이터가 없나 보다'로 완전히 잘못 짚는다.
  const v = judgeProbe({ isError: false, text: '{"files":[],"status":"PERMISSION_DENIED"}' },
    { json: true, arrayMin: [{ path: "files", min: 1 }], notContains: DENIAL_MARKERS });
  assert.equal(v.ok, false);
  assert.ok(v.reason?.includes("거부"), `증상(빈 배열)을 원인으로 보고했다: ${v.reason}`);
});

t("P4 정상 응답은 통과한다", () => {
  const v = judgeProbe({ isError: false, text: '{"files":[{"id":"1","name":"a"}]}' },
    { json: true, contains: ["files"], paths: ["files.0.id"], arrayMin: [{ path: "files", min: 1 }], notContains: DENIAL_MARKERS });
  assert.deepEqual(v, { ok: true, reason: null });
});

t("P5 JSON 이어야 하는데 아니면 실패", () => {
  assert.equal(judgeProbe({ isError: false, text: "<html>502 Bad Gateway</html>" }, { json: true }).ok, false);
});

t("P6 경로가 없으면 실패 — 상류가 응답 형태를 바꾼 경우", () => {
  const v = judgeProbe({ isError: false, text: '{"items":[{"id":"1"}]}' }, { paths: ["files.0.id"] });
  assert.equal(v.ok, false);
  assert.ok(v.reason?.includes("files.0.id"));
});

t("P7 배열 최소 개수 — 빈 배열은 '살아 있음'의 증거가 아니다", () => {
  assert.equal(judgeProbe({ isError: false, text: '{"files":[]}' }, { arrayMin: [{ path: "files", min: 1 }] }).ok, false);
  assert.equal(judgeProbe({ isError: false, text: '{"files":[1]}' }, { arrayMin: [{ path: "files", min: 1 }] }).ok, true);
  assert.equal(judgeProbe({ isError: false, text: '{"files":{}}' }, { arrayMin: [{ path: "files", min: 1 }] }).ok, false);
});

t("P8 단언이 문자열뿐이면 JSON 파싱을 요구하지 않는다(형식 유동적인 상류)", () => {
  assert.equal(judgeProbe({ isError: false, text: "plain text with marker" }, { contains: ["marker"] }).ok, true);
});

t("P9 거부 문구 판정은 대소문자를 가리지 않는다", () => {
  assert.equal(judgeProbe({ isError: false, text: "The Caller Does Not Have Permission" }, { notContains: ["does not have permission"] }).ok, false);
});

t("P10 pluck — 점 표기·배열 인덱스·부재", () => {
  const v = { a: { b: [{ c: 7 }] } };
  assert.equal(pluck(v, "a.b.0.c"), 7);
  assert.equal(pluck(v, "a.b.1.c"), undefined);
  assert.equal(pluck(v, "a.x"), undefined);
  assert.equal(pluck(v, "a.b.x"), undefined);
  assert.equal(pluck(null, "a"), undefined);
});

// ── Q. 언제 사람을 깨우나 ──
t("Q1 연속 실패가 임계에 닿아야 failing — 한 번 튄 걸로 깨우면 경보를 끄게 된다", () => {
  assert.deepEqual(evaluateStreak([false, false], 3), { state: "unknown", failStreak: 2 });
  assert.deepEqual(evaluateStreak([false, false, false], 3), { state: "failing", failStreak: 3 });
});

t("Q2 최신 1회가 성공이면 즉시 ok — 고장 판정은 신중하게, 해제는 빠르게(비대칭)", () => {
  assert.deepEqual(evaluateStreak([true, false, false, false], 3), { state: "ok", failStreak: 0 });
});

t("Q3 기록이 없으면 unknown — '아직 모른다'와 '정상'을 섞지 않는다", () => {
  assert.deepEqual(evaluateStreak([], 3), { state: "unknown", failStreak: 0 });
});

t("Q4 임계 경계(정확히 threshold / threshold-1)", () => {
  assert.equal(evaluateStreak([false, false, false], 3).state, "failing");
  assert.equal(evaluateStreak([false, false], 3).state, "unknown");
  assert.equal(evaluateStreak([false], 1).state, "failing"); // 임계 1 이면 첫 실패에 바로
});

t("Q5 경보는 상태가 바뀔 때만 — 같은 상태가 이어지면 조용하다", () => {
  assert.equal(alertTransition("ok", "failing"), "raise");
  assert.equal(alertTransition("failing", "failing"), null, "매 회전마다 깨우면 사람이 경보를 끈다");
  assert.equal(alertTransition("failing", "ok"), "clear");
  assert.equal(alertTransition("ok", "ok"), null);
});

t("Q6 unknown 은 전이로 치지 않는다 — 판정 중인 것을 알리면 소음이다", () => {
  assert.equal(alertTransition("unknown", "unknown"), null);
  assert.equal(alertTransition("failing", "unknown"), null, "임계 미만으로 내려간 것뿐인데 '복구'라고 알리면 거짓말이다");
  assert.equal(alertTransition("unknown", "failing"), "raise");
  assert.equal(alertTransition("unknown", "ok"), null, "첫 성공을 '복구'라고 알릴 근거가 없다");
});

// ── S. 구성 미비 vs 상류 회귀 (dev 실측으로 추가) ──
//  회귀 대상: **안 쓰는 커넥터가 영구 failing 으로 남아 가짜 경보가 진짜 경보를 묻던 것.**
//  dev 에서 실제로 그렇게 됐다 — gmail 미연결이 3회 만에 raise 를 울렸다.
t("S1 '자격 없음'·미연결은 상류 회귀가 아니다", () => {
  assert.equal(isUnconfigured("상류가 실패를 반환했다: 자격 없음 — 이 툴은 'google_gmail_oauth' 자격이 필요합니다."), true);
  assert.equal(isUnconfigured("'notion_oauth' OAuth 미연결 — me_oauth_connect 로 먼저 인증하세요."), true);
  assert.equal(isUnconfigured("org_tool 'google_drive_search' 이 없습니다(프리셋 미적용?)"), true);
  assert.equal(isUnconfigured("org_tool 'x' 이 꺼져 있습니다"), true);
});

t("S2 진짜 상류 거부는 구성 미비가 아니다 — 이걸 섞으면 이번 사고를 통째로 놓친다", () => {
  assert.equal(isUnconfigured("상류가 실패를 반환했다: The caller does not have permission"), false);
  assert.equal(isUnconfigured("응답에 경로 'files' 가 없다"), false);
  assert.equal(isUnconfigured(null), false);
  assert.equal(isUnconfigured(""), false);
});

t("S3 구성 미비 상태는 경보를 울리지 않는다", () => {
  assert.equal(alertTransition("unknown", "unconfigured"), null);
  assert.equal(alertTransition("ok", "unconfigured"), null);
  assert.equal(alertTransition("unconfigured", "unconfigured"), null);
});

t("S4 고장 → 구성 미비로 재분류되면 잘못 울린 경보를 푼다", () => {
  assert.equal(alertTransition("failing", "unconfigured"), "clear",
    "안 풀면 사람은 아직 고장 중인 줄 알고, 그 오해가 다음 진짜 경보의 신뢰를 깎는다");
});

// ── R. 프로브 구성이 실제로 볼 수 있는가 ──
t("R1 체크인된 프로브 정의가 자기검증을 통과한다", () => {
  assertProbeCoverage();
  assert.ok(CANARY_PROBES.length >= 3, "프로브가 너무 적다(배선 단언)");
});

t("R2 단언 없는 프로브는 거부 — 호출 성공만 보면 정확히 이번처럼 눈이 먼다", () => {
  const blind: CanaryProbe = {
    key: "x", label: "x", adapter: "http_proxy", tier: "plain",
    target: { tool: "t" }, args: {}, expect: {}, why: "x",
  };
  assert.throws(() => assertProbeCoverage([blind]));
});

t("R3 ★ 어댑터마다 고객과 같은 구성(plain) 프로브가 있어야 한다", () => {
  const onlyPrivileged: CanaryProbe = {
    key: "x", label: "x", adapter: "http_proxy", tier: "privileged",
    target: { tool: "t" }, args: {}, expect: { contains: ["ok"] }, why: "x",
  };
  assert.throws(() => assertProbeCoverage([onlyPrivileged]),
    "우리만 잘 설정돼 있으면 전 고객이 깨져도 초록불이다");
});

t("R4 key 중복·어댑터별 target 형태를 거부", () => {
  const p = (over: Partial<CanaryProbe>): CanaryProbe => ({
    key: "k", label: "l", adapter: "http_proxy", tier: "plain", target: { tool: "t" }, args: {}, expect: { contains: ["x"] }, why: "w", ...over,
  } as CanaryProbe);
  assert.throws(() => assertProbeCoverage([p({}), p({})]), "key 중복을 통과시켰다");
  assert.throws(() => assertProbeCoverage([p({ adapter: "mcp_proxy", target: { tool: "t" } })]), "mcp_proxy 인데 server 가 없다");
  assert.throws(() => assertProbeCoverage([p({ adapter: "http_proxy", target: { server: "s", tool: "t" } })]));
});

t("R5 A·B 두 어댑터를 모두 덮는다 — 어느 쪽이 깨졌는지 가르려면 대조군이 필요하다", () => {
  const adapters = new Set(CANARY_PROBES.map((p) => p.adapter));
  assert.ok(adapters.has("http_proxy") && adapters.has("mcp_proxy"), `한쪽만 본다: ${[...adapters]}`);
});

console.log(`\ncanary judge: ${pass} passed`);
