// 위탁 스케줄러 자격 좌표상수(#1101-b/#1299 회귀 가드) — 헤드리스 claude -p 인증 토큰의 kind 이름.
//
// 왜 이 테스트가 있나: member_secret 은 저장과 조회의 kind 정규화가 비대칭이다.
//   · 저장(setMemberSecret) → normalizeKind → KIND_RE(/^[a-z0-9_]{1,40}$/) 위반이면 throw.
//   · 조회(getMemberSecret) → 정규화 없이 raw kind 로 SELECT → 없으면 조용히 null.
// 그래서 리스 상수가 정규식을 위반하면 "등록은 영영 거부되고(사용자에게만 오류), 리스는 영영 null(무증상)" 이 된다.
// 실제로 SECRET_KIND 가 하이픈("claude-setup-token")이던 동안 등록 UI(#1299)는 저장 단계에서 막혔고,
// 스케줄러는 env 없이 claude -p 를 띄워 32분 무출력 hang → canceled 로 끝났다(#1101-b, 고객사 A 실측).
// alerts.ts 의 ALERT_KIND 에는 같은 가드가 alerts.test.ts 에 있었지만 여기엔 없어서 통과된 결함이다.
import { strict as assert } from "node:assert";
import { normalizeKind } from "../org/credentials/member-secret-store.js";
import { SECRET_KIND } from "./task-scheduler.js";

// 핵심 불변식: 저장이 받아들이는 이름과 조회가 찾는 이름이 같아야 한다(normalizeKind 가 무손실).
assert.equal(normalizeKind(SECRET_KIND), SECRET_KIND,
  `SECRET_KIND(${SECRET_KIND})가 저장 시 정규화로 바뀌거나 거부된다 — 등록은 막히고 리스는 조용히 null 이 된다`);
assert.match(SECRET_KIND, /^[a-z0-9_]{1,40}$/, "member_secret kind 형식(소문자·숫자·_)을 지켜야 저장이 거부되지 않는다");

// 회귀 방향 명시 — 하이픈은 저장 단계에서 거부된다(과거 결함의 형태).
assert.throws(() => normalizeKind("claude-setup-token"), /kind 형식 오류/,
  "하이픈 kind 는 저장 불가 — 리스 상수로 쓰면 무증상 인증 실패가 된다");

console.log("task-scheduler-kind.test: ok");
