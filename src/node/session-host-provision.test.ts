// #2600 T2 d5 — 세션 호스트 자격 보장의 **순수 판정** 둘(노드 id 유도 · 등록 행 처분).
//  엣지 표(스크래치패드 spec-d5-lively.md)의 C1~C15 를 행마다 하나씩 겨눈다.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  SESSION_HOST_MEMBER_ID, decideSessionHostNode, pickSessionHostNode, sessionHostNodeId,
} from "./session-host-provision.js";

const ours = { owner_member: SESSION_HOST_MEMBER_ID, session_host: true };
const human = { owner_member: "sangmin-yoon", session_host: true };
const undeclared = { owner_member: SESSION_HOST_MEMBER_ID, session_host: false };

test("C1·C2 — 등록이 없으면 조회든 발급이든 create", () => {
  assert.equal(decideSessionHostNode({ existing: null, issue: false }), "create");
  assert.equal(decideSessionHostNode({ existing: null, issue: true }), "create");
});

test("★ C3·C5·C8 — issue=false(조회)는 **아무것도 바꾸지 않는다**", () => {
  //  이 세 행이 지키는 것: 브로커의 주기 조회가 도는 세션 호스트의 토큰을 회전시켜 죽이지 않는다.
  assert.equal(decideSessionHostNode({ existing: ours, issue: false }), "keep");
  assert.equal(decideSessionHostNode({ existing: human, issue: false }), "keep", "주인이 틀려도 조회는 안 고친다");
  assert.equal(decideSessionHostNode({ existing: undeclared, issue: false }), "keep");
});

test("C4 — 이미 우리 것이고 발급 요청이면 회전만", () => {
  assert.equal(decideSessionHostNode({ existing: ours, issue: true }), "rotate");
});

test("★★ C6 — 사람 소유(d4 수기 등록)는 발급 때 **주인부터 옮긴다**", () => {
  //  사람 계정이 비활성되면 노드 인증이 owner-inactive 로 거절된다 — 그 테넌트 세션이 통째로 안 붙는다.
  assert.equal(decideSessionHostNode({ existing: human, issue: true }), "fix-and-rotate");
});

test("★ C7 — 주인은 맞는데 세션 호스트 선언이 꺼져 있으면 그것도 고친다(#2592 면제 축)", () => {
  assert.equal(decideSessionHostNode({ existing: undeclared, issue: true }), "fix-and-rotate");
});

test("C9 — 노드 id 는 슬러그에서 결정론적으로", () => {
  assert.equal(sessionHostNodeId("lively-46e3"), "sesshost-lively-46e3");
});

test("★ C10~C13 — 모양이 아니면 지어내지 않고 null(자르면 남의 테넌트와 충돌한다)", () => {
  assert.equal(sessionHostNodeId(""), null, "빈 슬러그 — 새 유도 규칙의 «부재» 엣지");
  assert.equal(sessionHostNodeId("Bad-Case"), null, "대문자는 슬러그가 아니다");
  assert.equal(sessionHostNodeId("-leading"), null, "첫 글자는 영숫자");
  assert.equal(sessionHostNodeId("has space"), null, "공백");
});

test("★ C14·C15 — 노드 id 상한(41자)이 경계다: 32자 슬러그는 되고 33자는 null", () => {
  assert.equal(sessionHostNodeId("a".repeat(32))?.length, 41, "sesshost- 9자 + 32 = 41(상한 안)");
  assert.equal(sessionHostNodeId("a".repeat(33)), null, "42자면 store.normalizeNodeId 가 400 을 던진다 — 그 전에 «못 한다»를 말한다");
});

// ── 등록 «찾기» — 이름이 아니라 선언으로 (D1~D6) ────────────────────────────
const n = (id: string, session_host: boolean, created_at: string): { id: string; session_host: boolean; created_at: string } =>
  ({ id, session_host, created_at });

test("★ D1·D5 — 선언된 노드가 없으면 null(선언 안 된 노드는 후보가 아니다)", () => {
  assert.equal(pickSessionHostNode([], "lively-46e3"), null);
  assert.equal(
    pickSessionHostNode([n("haruui-macbookair", false, "2026-01-01"), n("hammurabi", false, "2026-01-02")], "lively-46e3"),
    null, "멤버 PC 노드는 세션 호스트 후보가 아니다",
  );
});

test("★★ D2 — 이름이 달라도 **선언된 그 행**을 물려받는다(d4 수기 노드 `sesshost-46e3`)", () => {
  //  이 행이 지키는 것: 자동 경로가 카나리아에 **두 번째** 세션 호스트를 세우지 않는다.
  //  둘이 동시에 온라인이면 두 스냅샷이 같은 세션을 주장하고, 그때 목록·attach 라우팅이 갈린다.
  const got = pickSessionHostNode([n("haruui-macbookair", false, "2026-01-01"), n("sesshost-46e3", true, "2026-09-08")], "lively-46e3");
  assert.equal(got?.id, "sesshost-46e3");
});

test("★ D3 — 선언이 둘이면 정규 id 를 고른다", () => {
  const got = pickSessionHostNode([n("sesshost-46e3", true, "2026-09-08"), n("sesshost-lively-46e3", true, "2026-09-09")], "lively-46e3");
  assert.equal(got?.id, "sesshost-lively-46e3");
});

test("★ D4 — 선언이 둘인데 정규 id 가 없으면 **가장 먼저 만들어진 것**(결정론)", () => {
  //  틱마다 다른 답을 고르면 두 토큰이 서로를 회전시켜 죽인다 — 여기서 흔들리면 안 된다.
  const nodes = [n("sesshost-b", true, "2026-09-09"), n("sesshost-a", true, "2026-09-08")];
  assert.equal(pickSessionHostNode(nodes, "lively-46e3")?.id, "sesshost-a");
  assert.equal(pickSessionHostNode([...nodes].reverse(), "lively-46e3")?.id, "sesshost-a", "입력 순서가 답을 바꾸지 않는다");
});

test("★ D6 — created_at 이 같으면 id 로 가른다(그래도 답이 하나여야 한다)", () => {
  const nodes = [n("sesshost-b", true, "2026-09-08"), n("sesshost-a", true, "2026-09-08")];
  assert.equal(pickSessionHostNode(nodes, "zzz")?.id, "sesshost-a");
  assert.equal(pickSessionHostNode([...nodes].reverse(), "zzz")?.id, "sesshost-a");
});
