// 리브 «처음 연결» 1턴의 사실 묶기(org/liv/connect-facts.ts) — 값으로 잠근다(#4213 T13 · 격리 리뷰 2026-10-17).
//
//  사양 — 엣지 표:
//   C1 단위 개수 — 앱별·상태별로 세고 앱 이름순 · 결과에 단위 이름·설명이 없다(남의 비공개 대화 이름이 1턴에 안 실린다)
//   C2 단위 개수 — 모르는 상태 값은 세지 않는다(NaN 칸을 만들지 않는다)
//   M1 내 커넥터 — 기록 없음 → 확인 null · 앱 없음
//   M2 내 커넥터 — 기록 있음 → 마지막 확인(ok·error)과 앱·상태(남의 기록은 안 섞인다)
//   T1 팀 앱 — 나는 세지 않는다
//   T2 팀 앱 — connected 만 센다(다시 로그인 필요·끊음은 «팀이 쓰는 앱» 이 아니다)
//   T3 팀 앱 — 구성원 경로(member_ai) · 모으는 중 단위만 센다(수집기 경로·후보·뺌은 안 센다)
//   T4 팀 앱 — 커넥터 이름은 대소문자 무시로 합친다 · 단위에 커넥터 이름이 없으면 앱 키로 찾는다
//   T5 팀 앱 — 연결한 사람 많은 순 → 단위 많은 순 → 이름순
import test from "node:test";
import assert from "node:assert/strict";
import { myConnectorFacts, teamAppsFor, unitCountsByApp, type FactsMemberIn, type FactsUnitIn } from "./connect-facts.js";

const U = (o: Partial<FactsUnitIn> & { name?: string; description?: string }): FactsUnitIn & { name?: string; description?: string } =>
  ({ app: "slack", state: "active", route: "member_ai", ...o });
const M = (id: string, apps: Array<[string, string]>, scan: FactsMemberIn["scan"] = { ok: true, error: null }): FactsMemberIn =>
  ({ member_id: id, scan, connectors: apps.map(([app, status]) => ({ app, status })) });
const NAMES: Record<string, string> = { slack: "Slack", notion: "Notion", gmail: "Gmail" };
const connectorOf = (app: string): string => NAMES[app] ?? app;

test("C1·C2 단위 개수 — 앱별·상태별 · 이름·설명은 나가지 않는다 · 모르는 상태는 안 센다", () => {
  const out = unitCountsByApp([
    U({ app: "slack", state: "active", name: "#경영진-비공개", description: "대표 논의" }), U({ app: "slack", state: "candidate", name: "#dev" }),
    U({ app: "notion", state: "excluded", name: "인사 평가" }), U({ app: "slack", state: "active" }),
    { app: "gmail", state: "weird" as unknown as "active", route: "member_ai" },
  ]);
  assert.deepEqual(out, [
    { app: "notion", candidate: 0, active: 0, excluded: 1 },
    { app: "slack", candidate: 1, active: 2, excluded: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(out), /경영진|대표|인사 평가|#dev/, "단위 이름·설명이 1턴 사실에 실린다");
});

test("M1·M2 내 커넥터 — 내 기록만 · 없으면 확인 null", () => {
  assert.deepEqual(myConnectorFacts("me", [M("other", [["Slack", "connected"]])]), { scan: null, apps: [] }, "M1");
  assert.deepEqual(myConnectorFacts("me", [M("other", [["Slack", "connected"]]), M("me", [["Notion", "needs-auth"]], { ok: false, error: "timeout" })]),
    { scan: { ok: false, error: "timeout" }, apps: [{ app: "Notion", status: "needs-auth" }] }, "M2");
});

test("T1~T5 팀 앱 — 남이 연결한 것 · 보이는 구성원 경로 단위만 · 이름 합치기 · 순서", () => {
  const everyone = [
    M("me", [["Linear", "connected"]]),                                         // T1 나는 안 센다
    M("a", [["Slack", "connected"], ["Gmail", "needs-auth"], ["Figma", "removed"]]), // T2 connected 만
    M("b", [["slack", "connected"], ["Notion", "connected"]]),                    // T4 대소문자 합치기
  ];
  const units = [
    U({ app: "notion", state: "active", route: "member_ai", connector: "Notion" }),
    U({ app: "notion", state: "active", route: "member_ai" }),                   // T4 커넥터 이름 없음 → 앱 키로
    U({ app: "slack", state: "candidate", route: "member_ai" }),                  // T3 후보는 안 센다
    U({ app: "gmail", state: "active", route: "lively_collector" }),             // T3 수집기 경로는 안 센다
    U({ app: "gmail", state: "excluded", route: "member_ai" }),                   // T3 뺌은 안 센다
  ];
  assert.deepEqual(teamAppsFor("me", everyone, units, connectorOf), [
    { app: "Slack", members: 2, units: 0 },
    { app: "Notion", members: 1, units: 2 },
  ]);
});
