// 세션 종류 축 (#2162) — 이 표가 틀렸을 때 실제로 났던 일:
//  🔴 종류 신호가 **두 벌로 갈라져** 있었다. 서버는 `managed`·`loginFor`·`appId` 를 알고, 훅은
//     `LIVELY_TASK_WS`·`LIVELY_MODE` 를 봤는데 둘이 안 이어졌다 — 특히 `managed: true` 는 pane 에
//     한 글자도 안 나갔다. 그래서 **새 기계 세션 경로는 말없이 '사람 세션'** 이 됐고, #1979 에서
//     두 번 샜다(이름짓기 헤드리스 · 위탁 워커 — 10분 크론만으로 하루 100건대 쓰레기).
//  실행: npm run build && node dist/sessions/session-kind.test.js
import assert from "node:assert/strict";
import { normalizeSessionKind, isWorkSession, isMachineSession, sessionKindFromRequest, SESSION_KIND_ENV, type SessionKind } from "./session-kind.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

// ── 표 A — 종류별 정책. 행 하나가 곧 "그 종류가 프로젝트를 갖나 / 배치로 보이나". ──
const TABLE: Array<[SessionKind, work: boolean, machine: boolean, why: string]> = [
  ["human",   true,  false, "사람의 작업 세션 — 유일하게 프로젝트를 갖고 이름을 짓는다"],
  ["task",    false, true,  "★위탁 워커 — 첫 프롬프트가 서버 조립물이라 사람 지시와 구별이 안 됐다(#1979 항목4)"],
  ["managed", false, true,  "★상시 세션 — 크론이 프롬프트를 주입한다. 종전엔 어느 가드에도 안 걸렸다"],
  ["app",     false, false, "앱 세션 — 사람이 열지만 소속이 인스턴스 축에 따로 있다(#1780)"],
  ["login",   false, false, "로그인 절차용 — 사람이 열지만 작업 세션이 아니다(#1516)"],
];
for (const [kind, work, machine, why] of TABLE) {
  assert.equal(isWorkSession(kind), work, `isWorkSession(${kind}) — ${why}`);
  assert.equal(isMachineSession(kind), machine, `isMachineSession(${kind}) — ${why}`);
}
ok(`정책 표 ${TABLE.length}행 — 작업세션은 human 뿐 · 기계는 task·managed`);

// 배선 확인 — 표가 한쪽으로만 나오면 아무것도 안 가르는 것이다.
{
  const w = TABLE.filter(([k]) => isWorkSession(k)).length;
  const m = TABLE.filter(([k]) => isMachineSession(k)).length;
  assert.ok(w > 0 && w < TABLE.length, `work 축이 한쪽으로만(${w}/${TABLE.length})`);
  assert.ok(m > 0 && m < TABLE.length, `machine 축이 한쪽으로만(${m}/${TABLE.length})`);
  ok("배선 확인 — 두 술어가 각각 실제로 갈라진다");
}

// ★ 두 술어는 **다른 질문**이다 — app·login 은 작업세션도 기계도 아니다.
//  합치면 "사람이 연 앱 세션"을 배치로 표시하게 된다(화면이 거짓말한다).
{
  const both = TABLE.filter(([, w, m]) => w === m).map(([k]) => k);
  assert.deepEqual(both, ["app", "login"], "app·login 은 두 축이 모두 false — 술어를 하나로 합치지 마라");
  ok("★isWorkSession ≠ isMachineSession — app·login 이 그 차이를 만든다");
}

// ── 표 B — 요청 → 종류. **경계 매핑은 여기 한 곳뿐**이다(라우트에 인라인으로 두면 아무도 못 본다). ──
assert.equal(sessionKindFromRequest({}), "human");
assert.equal(sessionKindFromRequest({ appId: "hello" }), "app");
assert.equal(sessionKindFromRequest({ loginFor: "claude" }), "login");
// 우선순위 — 로그인 세션은 앱보다 먼저다(로그인은 그 하네스를 아예 못 띄우는 상태에서 도는 절차다).
assert.equal(sessionKindFromRequest({ loginFor: "claude", appId: "hello" }), "login");
// ★경계 — 빈 문자열·공백은 표식이 아니다. 여길 틀리면 **모든 세션이 app/login 으로 오분류**된다.
for (const v of ["", "   ", undefined, null]) {
  assert.equal(sessionKindFromRequest({ appId: v }), "human", `appId=${JSON.stringify(v)}`);
  assert.equal(sessionKindFromRequest({ loginFor: v }), "human", `loginFor=${JSON.stringify(v)}`);
}
ok("요청→종류 매핑 — app·login 판정 · login 우선 · 빈값/공백 경계");

// ── 표 C — 정규화. 구 행(kind 없음)이 어디로 떨어지나. ──
//  ⚠ **안전한 쪽(기계)이 아니라 human 이다.** 이 축 이전에 만들어진 세션과 구 노드 번들이 여기로 오는데,
//   그것들은 대부분 진짜 사람 세션이다. 기계로 오인하면 **사람의 세션이 프로젝트를 못 갖고 이름도 못 받는다**
//   — 조용한 기능 상실이라 훨씬 나쁘다. 기계 경로는 전부 명시하므로(컴파일 강제) 이 폴백에 안 기댄다.
for (const v of [undefined, null, "", "   ", "아무거나", "HUMAN_X"]) {
  assert.equal(normalizeSessionKind(v), "human", `${JSON.stringify(v)} → human`);
}
assert.equal(normalizeSessionKind(" TASK "), "task", "트림·소문자 정규화");
assert.equal(normalizeSessionKind("Managed"), "managed");
assert.notEqual(normalizeSessionKind(null), "task", "구 행이 기계로 오인되면 사람 세션이 기능을 잃는다");
ok("정규화 — 미상·구 행은 human(안전한 쪽이 아니라 기능을 잃지 않는 쪽)");

// pane env 이름은 훅과의 **계약**이다 — 바꾸면 훅이 못 읽는다(훅은 이 상수를 import 할 수 없다).
assert.equal(SESSION_KIND_ENV, "LIVELY_SESSION_KIND",
  "훅(kit/hooks/examples/*.mjs)이 이 이름을 리터럴로 읽는다 — 바꾸려면 훅도 함께");
ok("pane env 이름 계약 — LIVELY_SESSION_KIND");

console.log(`\n${pass} passed`);
