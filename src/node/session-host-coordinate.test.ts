// #3745 — sameTmuxCoordinate(boxRow, isSelf, isSessionHost): **박스(중앙) 세션에 붙은 세션 호스트 좌표는
// 좌표가 아니다.** 세션 호스트 `sesshost-46e3` 가 상주하자 매니지드 중앙 세션이 통째로 안 지워졌다
// (2026-09-08 실측: `?node=` 를 비우든 `sesshost-46e3` 로 주든 둘 다 404 「그 노드에 이 세션이 없습니다」).
// 호스트는 그 테넌트의 세션을 전부 스냅샷에 실으므로 목록 행에 좌표가 붙고(화면은 그 좌표를 DELETE 에
// 그대로 싣는다), 서버는 좌표가 없어도 스냅샷에서 되찾는다(#2636) — 그래서 어느 쪽으로 와도 노드 분기로
// 갔고, 박스 세션의 desired 행은 node_id 가 NULL 이라 «행이 있으면 그 행의 노드여야 한다» 가드에 걸렸다.
//
// 사양 엣지 표(spec H1~H9)를 그대로 옮긴다 — 특히 **새로 도입한 `boxRow` 의 부재 엣지**(H5 행 없음 ·
// H8 빈 문자열)가 이 표의 이유다. 값만 재는 단언은 우연히 통과할 수 있어(vacuous), 「판정기를 무엇으로·
// 몇 번 물었나」도 함께 잰다(이웃 session-relay-coordinate.test.ts 와 같은 규율).
import { strict as assert } from "node:assert";
import test from "node:test";
import { isBoxSessionRow, sameTmuxCoordinate, sessionRelayNodeId } from "./self-node.js";

const SELF_ID = "gw-self";
const HOST_ID = "sesshost-46e3";      // 선언된 세션 호스트 — 같은 tmux 를 본다(다른 기계가 아니다)
const PC_ID = "haruui-macbookair";    // 멤버 PC 노드 — 진짜 다른 기계

const isSelfOf = (ids: readonly string[]) => (id: string): boolean => ids.includes(id);

// 부재 슬롯인데 불리면 즉시 실패시키는 판정기 — "부재는 판정기로 안 넘긴다"(R5)를 잡는다.
const NEVER = (): boolean => {
  throw new Error("출처가 부재(없음·빈 값·공백)인데 판정기를 불렀다");
};

// 호출을 기록하는 래퍼 — 관측 장치가 죽어 있으면 테스트가 통과하면서 아무것도 안 본다.
const recordCalls = (impl: (id: string) => boolean): { fn: (id: string) => boolean; asked: string[] } => {
  const asked: string[] = [];
  return { fn: (id: string): boolean => { asked.push(id); return impl(id); }, asked };
};

/** 라우트가 만드는 것과 같은 판정기 — 박스 행이면 세션 호스트도 «같은 tmux» 로 본다. */
const fold = (boxRow: boolean): ((id: string) => boolean) =>
  sameTmuxCoordinate({ boxRow, isSelf: isSelfOf([SELF_ID]), isSessionHost: isSelfOf([HOST_ID]) });

/** 라우트가 부르는 **그 함수** — H5(행 없음)·H8(빈 문자열) 경계를 여기서 잰다(식을 베껴 적지 않는다). */
const boxRowOf = isBoxSessionRow;

// ── 술어 — 「이 좌표가 같은 tmux 를 뜻하나」 (H1~H5) ──────────────────────────
interface Row { label: string; boxRow: boolean; id: string; expected: boolean }

const rows: Row[] = [
  { label: "H1 박스 행 + 세션 호스트 → 같은 tmux(접는다)", boxRow: true, id: HOST_ID, expected: true },
  { label: "H2 박스 행 + 셀프 노드 → 같은 tmux(접는다)", boxRow: true, id: SELF_ID, expected: true },
  { label: "H3 박스 행 + 멤버 PC 노드 → 다른 기계(안 접는다)", boxRow: true, id: PC_ID, expected: false },
  { label: "H4 노드 행 + 세션 호스트 → 그 호스트의 세션이다(안 접는다)", boxRow: false, id: HOST_ID, expected: false },
  { label: "H4' 노드 행 + 셀프 노드 → 셀프는 행과 무관하게 접는다(#2592)", boxRow: false, id: SELF_ID, expected: true },
  { label: "H5 행 없음(박스 아님) + 세션 호스트 → 안 접는다(#2636 누수 방지)", boxRow: false, id: HOST_ID, expected: false },
];

for (const r of rows) {
  test(`세션 호스트 좌표 접기 — ${r.label}`, () => {
    assert.equal(fold(r.boxRow)(r.id), r.expected, `[${r.label}] 판정이 사양과 다르다`);
  });
}

// ── 박스 세션의 정의 — 새 변수 `boxRow` 의 부재·경계 엣지 (H5 · H8) ───────────
test("H8 ★ 박스 세션 = 행이 **있고** 노드가 없다 — 행 없음(H5)과 빈 문자열 노드(H8)를 가른다", () => {
  assert.equal(boxRowOf({ node_id: null }), true, "node_id 가 NULL 인 행은 박스 세션이다");
  assert.equal(boxRowOf({ node_id: "" }), true, "★빈 문자열 node_id 를 «노드 있음»으로 읽었다 — 그 행도 박스 세션이다");
  assert.equal(boxRowOf({}), true, "node_id 칸이 없는 행은 박스 세션이다");
  assert.equal(boxRowOf({ node_id: PC_ID }), false, "노드가 적힌 행을 박스 세션으로 읽었다");
  assert.equal(boxRowOf(undefined), false, "★행이 아예 없는데 박스 세션으로 읽었다 — #2636 의 누수가 그대로 돌아온다");
});

// ── 판정기를 무엇으로·몇 번 묻나 (H9) ────────────────────────────────────────
test("H9 ★ 박스 행이 아니면 세션 호스트 판정기를 **아예** 부르지 않는다 — 판정 축이 새지 않는다", () => {
  const host = recordCalls(isSelfOf([HOST_ID]));
  const f = sameTmuxCoordinate({ boxRow: false, isSelf: isSelfOf([SELF_ID]), isSessionHost: host.fn });
  assert.equal(f(HOST_ID), false, "노드 행인데 세션 호스트 좌표를 접었다");
  assert.deepEqual(host.asked, [], "박스 행이 아닌데 세션 호스트 판정기를 물었다");
});

test("셀프로 이미 접혔으면 세션 호스트는 묻지 않는다 — 같은 값을 두 번 보지 않는다", () => {
  const self = recordCalls(isSelfOf([SELF_ID]));
  const host = recordCalls(isSelfOf([HOST_ID]));
  const f = sameTmuxCoordinate({ boxRow: true, isSelf: self.fn, isSessionHost: host.fn });
  assert.equal(f(SELF_ID), true, "셀프 좌표를 접지 않았다");
  assert.deepEqual(self.asked, [SELF_ID], "셀프 판정기를 안 물었다(판정이 우연히 맞았을 수 있다)");
  assert.deepEqual(host.asked, [], "셀프로 이미 접혔는데 세션 호스트 판정기까지 물었다");
});

// ── 좌표 되찾기(#2636)와의 합성 — 세 출처 어디서 와도 같아야 한다 ─────────────
// 실측에서 «`?node=` 를 비워도, `sesshost-46e3` 로 줘도 둘 다 404» 였던 것이 곧
// «화면이 준 좌표(query)와 서버가 되찾은 좌표(snapshot) 모두 접어야 한다» 는 뜻이다.
test("H1-query · 화면이 실어 보낸 세션 호스트 좌표를 접는다 — 중앙 경로로 간다", () => {
  const result = sessionRelayNodeId({ query: HOST_ID, desired: null, snapshot: HOST_ID }, fold(true));
  assert.equal(result, "", "화면이 준 세션 호스트 좌표가 박스 세션의 릴레이 지시로 섰다(그 자리가 404 였다)");
});

test("H1-snapshot · 좌표를 안 실어도 스냅샷에서 되찾은 세션 호스트 좌표를 접는다", () => {
  const result = sessionRelayNodeId({ query: undefined, desired: null, snapshot: HOST_ID }, fold(true));
  assert.equal(result, "", "스냅샷이 준 세션 호스트 좌표가 박스 세션의 릴레이 지시로 섰다");
});

test("H3 · 박스 행에 엉뚱한 노드 좌표가 오면 접지 않는다 — 가드가 계속 404 를 내야 한다", () => {
  const result = sessionRelayNodeId({ query: PC_ID, desired: null, snapshot: HOST_ID }, fold(true));
  assert.equal(result, PC_ID, "박스 세션에 붙은 남의 노드 좌표까지 접어 스푸핑 가드를 무력화했다");
});

test("H5 · 행이 없는 옛 노드 세션은 스냅샷 좌표를 그대로 쓴다 — #2636 의 누수가 돌아오지 않는다", () => {
  const result = sessionRelayNodeId({ query: undefined, desired: undefined, snapshot: HOST_ID }, fold(boxRowOf(undefined)));
  assert.equal(result, HOST_ID, "행이 없는 세션의 좌표까지 접어, 노드에 묻지도 않고 지우는 경로를 되살렸다");
});

test("H6 · 세션 호스트로 접힌 뒤에도 뒤 출처의 진짜 노드 좌표가 살아난다(R4 불변)", () => {
  const result = sessionRelayNodeId({ query: HOST_ID, desired: null, snapshot: PC_ID }, fold(true));
  assert.equal(result, PC_ID, "앞 출처가 접혔다고 뒤 출처의 원격 좌표까지 버렸다");
});

test("H7 · 부재뿐이면 판정기를 부르지 않고 좌표 없음이다(R5 불변)", () => {
  const f = sameTmuxCoordinate({ boxRow: true, isSelf: NEVER, isSessionHost: NEVER });
  assert.equal(sessionRelayNodeId({ query: "", desired: null, snapshot: "  " }, f), "", "부재 좌표에서 무언가를 만들어냈다");
});
