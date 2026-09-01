// 열람 인가 판정(checkViewGate) — 엣지 표 행마다 한 검사. **인가 경로라 순수 단위로 못 박는다.**
//
//  ── 왜 늘렸나 (#1631, 실측 2026-08-31) ──
//  `owner` 는 «첫 append 한 멤버» 라 대화가 한 줄도 없으면 null 이다. 그런데 게이트가 그 값만 보면
//   `owner && owner === requester` 가 통째로 건너뛰어져, **자기가 방금 연 세션**을 여는 사람에게
//   «이 세션 로그를 볼 권한이 없습니다»(403)가 나갔다 — 온보딩 직후 착지하는 화면이 정확히 그랬다.
//   「기록이 없다」와 「볼 권한이 없다」는 다른 사실이고, 화면은 사실대로 말해야 한다.
//
//  ⚠ 넓히되 **좁게** 넓힌다: 레지스트리 축은 기록 축이 **비었을 때만** 본다. 기록이 있는데 주인이 다르면
//   그 답이 정본이다 — 아니면 남의 기록을 자기 세션 id 로 여는 길이 생긴다(이 파일의 ⑤가 그 자리다).
import test from "node:test";
import assert from "node:assert/strict";
import { checkViewGate } from "./session-log-routes.js";

const ME = "lively3";
const OTHER = "someone-else";
const base = { requester: ME, owner: null as string | null, viewPolicy: "owner", invited: false };

test("① 기록의 소유자면 언제나 본다(종전 그대로)", () => {
  assert.equal(checkViewGate({ ...base, owner: ME }), null);
});

test("② 기록의 주인이 남이면 막는다(종전 그대로)", () => {
  const d = checkViewGate({ ...base, owner: OTHER });
  assert.equal(d?.status, 403);
});

test("③ ★기록이 아직 없는 **자기** 세션 — 통과한다(#1631)", () => {
  assert.equal(checkViewGate({ ...base, owner: null, registryOwner: ME }), null);
});

test("④ 기록도 없고 레지스트리 주인도 남이면 막는다", () => {
  assert.equal(checkViewGate({ ...base, owner: null, registryOwner: OTHER })?.status, 403);
});

test("⑤ ★기록 축이 정본이다 — 기록 주인이 남이면 레지스트리로 못 덮는다(권한 상승 차단)", () => {
  const d = checkViewGate({ ...base, owner: OTHER, registryOwner: ME });
  assert.equal(d?.status, 403, "레지스트리가 기록 축을 덮으면 남의 기록을 자기 세션 id 로 열 수 있다");
});

test("⑥ 레지스트리도 모르면(null·빈 문자열) 막는다 — 모름은 허용이 아니다", () => {
  assert.equal(checkViewGate({ ...base, owner: null, registryOwner: null })?.status, 403);
  assert.equal(checkViewGate({ ...base, owner: null, registryOwner: "" })?.status, 403);
  assert.equal(checkViewGate({ ...base, owner: null })?.status, 403);   // 필드 자체가 없을 때(옛 호출자)
});

test("⑦ 신원이 없으면 무엇도 통과하지 않는다 — registryOwner 가 있어도", () => {
  assert.equal(checkViewGate({ ...base, requester: "", owner: null, registryOwner: "" })?.status, 403);
  //  빈 requester 와 빈 registryOwner 가 «같다»고 통과해선 안 된다(빈 문자열 동치 함정).
  assert.equal(checkViewGate({ ...base, requester: "", owner: null, registryOwner: null })?.status, 403);
});

test("⑧ attach 정책의 초대자는 종전대로 본다 — 새 축이 그 길을 막지 않는다", () => {
  assert.equal(checkViewGate({ ...base, owner: OTHER, viewPolicy: "attach", invited: true }), null);
});

test("⑨ attach 가 아니면 초대만으로는 못 본다(종전 그대로)", () => {
  assert.equal(checkViewGate({ ...base, owner: OTHER, viewPolicy: "owner", invited: true })?.status, 403);
});
