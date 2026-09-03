// #2636 — sessionRelayNodeId(sources, isSelf): 세션의 생사·종료를 "어느 컴퓨터에 물어야 하는가"를
// 정하는 좌표 판정을 지킨다. 사양(spec.md) R1~R6 을 그대로 옮긴 것 — 특히 R2(요청에 좌표가 없어도
// 포기하지 않는다)와 R4(셀프로 접힌 출처 다음도 계속 본다)가 이 변경의 핵심이다. 반환값뿐 아니라
// 판정기(isSelf)에 "정확히 무엇을·트림해서·몇 번" 묻는지도 함께 잰다 — 안 그러면 값 단언이 우연히
// 통과하는 빈(vacuous) 테스트가 된다(이웃 파일 relayNodeId A7 과 같은 이유).
import { strict as assert } from "node:assert";
import test from "node:test";
import { sessionRelayNodeId } from "./self-node.js";

// ── 도우미 ────────────────────────────────────────────────────────────────
const SELF_ID = "gw-self";

// 아무 좌표도 셀프가 아니라고 답하는 판정기.
const REMOTE = (): boolean => false;

// 출처가 부재(없음/빈 값/공백)인데 불리면 즉시 실패시키는 판정기 — R5 "부재는 판정기로 안 넘긴다"를 잡는다.
const NEVER = (): boolean => {
  throw new Error("출처가 부재(없음/빈 값/공백)인데 판정기를 불렀다 — 셀프 판정은 공짜가 아니다");
};

// 주어진 id 목록에 속하면(만) 셀프로 답하는 판정기.
const isSelfOf = (selfIds: readonly string[]) => (id: string): boolean => selfIds.includes(id);

// 호출을 기록하는 판정기 래퍼 — "정확히 무엇을, 몇 번" 물었는지 검증할 때 쓴다.
const recordCalls = (impl: (id: string) => boolean): { isSelf: (id: string) => boolean; asked: string[] } => {
  const asked: string[] = [];
  const isSelf = (id: string): boolean => {
    asked.push(id);
    return impl(id);
  };
  return { isSelf, asked };
};

// 트림하면 빈 값인데 불리면 즉시 실패시키는 래퍼 — "부재 슬롯은 건너뛰고, 그 뒤 진짜 값만 정상 판정되는지"를 잡는다.
const guardBlank = (impl: (id: string) => boolean) => (id: string): boolean => {
  if (id.trim() === "") throw new Error("트림하면 빈 값인데 판정기를 불렀다 — 부재로 처리했어야 한다");
  return impl(id);
};

// ── R1 — 앞선 출처가 답하면 그것이 답이다(1→2→3) ──────────────────────────────
test("세 출처가 다 있으면 요청(query) 값이 이긴다(R1)", () => {
  const { isSelf, asked } = recordCalls(REMOTE);
  const result = sessionRelayNodeId(
    { query: "node-query", desired: "node-desired", snapshot: "node-snapshot" },
    isSelf,
  );
  assert.equal(result, "node-query", "요청 좌표가 있는데 다른 출처의 값이 반환됐다");
  assert.deepEqual(asked, ["node-query"], "요청이 이미 답인데 대장·스냅샷까지 판정기에 물었다");
});

test("대장 값이 있으면 스냅샷은 보지 않는다(R1 우선순위, 요청은 부재)", () => {
  const { isSelf, asked } = recordCalls(REMOTE);
  const result = sessionRelayNodeId({ query: undefined, desired: "node-desired", snapshot: "node-snapshot" }, isSelf);
  assert.equal(result, "node-desired", "대장 값이 있는데 스냅샷 값이 반환됐다");
  assert.deepEqual(asked, ["node-desired"], "대장이 이미 답인데 스냅샷까지 판정기에 물었다");
});

// ── R2 — 요청이 좌표를 안 실어도 포기하지 않는다(이 변경의 핵심) ───────────────
// R2 가 깨지면: 좌표를 안 실어 보내는 화면에서 "종료"를 눌러도 그 PC 의 세션이 안 죽는다.
// 화면은 "종료했어요"라고 말한다 — 못 걷은 걸 걷었다고 기록하는 것이다.
test("요청에 좌표가 없어도 대장(desired-state) 값을 쓴다 — 곧장 중앙으로 단정하지 않는다(R2)", () => {
  const result = sessionRelayNodeId({ query: undefined, desired: "macmini", snapshot: undefined }, REMOTE);
  assert.equal(result, "macmini", "요청에 좌표가 없다고 곧장 중앙으로 단정하고 대장 값을 무시했다");
});

test("요청·대장 둘 다 없어도 노드 현황 스냅샷 값을 쓴다(R2)", () => {
  const result = sessionRelayNodeId({ query: undefined, desired: undefined, snapshot: "macmini" }, REMOTE);
  assert.equal(result, "macmini", "요청·대장에 좌표가 없다고 중앙으로 단정하고 스냅샷 값을 무시했다");
});

// ── R3 — "셀프 노드" 좌표는 좌표가 아니다 ────────────────────────────────────
// R3 이 깨지면: 같은 컴퓨터를 원격 노드처럼 취급해 불필요한 왕복·지연·거부가 생긴다.
test("요청 좌표가 셀프 노드면 접는다 — 다른 출처가 없으면 좌표 없음(R3)", () => {
  const { isSelf, asked } = recordCalls(isSelfOf([SELF_ID]));
  const result = sessionRelayNodeId({ query: SELF_ID, desired: undefined, snapshot: undefined }, isSelf);
  assert.equal(result, "", "게이트웨이 자신을 가리키는 요청 좌표를 원격 노드로 취급했다");
  assert.deepEqual(asked, [SELF_ID], "셀프 여부를 판정기에 묻지 않고 접었다(우연히 맞았을 뿐일 수 있다)");
});

test("대장 좌표가 셀프 노드면 접는다 — 다른 출처가 없으면 좌표 없음(R3)", () => {
  const result = sessionRelayNodeId({ query: undefined, desired: SELF_ID, snapshot: undefined }, isSelfOf([SELF_ID]));
  assert.equal(result, "", "대장에 적힌 셀프 좌표를 원격 노드로 취급했다");
});

test("스냅샷 좌표가 셀프 노드면 접는다 — 다른 출처가 없으면 좌표 없음(R3)", () => {
  const result = sessionRelayNodeId({ query: undefined, desired: undefined, snapshot: SELF_ID }, isSelfOf([SELF_ID]));
  assert.equal(result, "", "스냅샷의 셀프 좌표를 원격 노드로 취급했다");
});

test("요청 좌표가 이기면 대장이 셀프인지는 판정기에 묻지도 않는다(R1)", () => {
  const { isSelf, asked } = recordCalls(isSelfOf([SELF_ID]));
  const result = sessionRelayNodeId({ query: "node-query", desired: SELF_ID, snapshot: undefined }, isSelf);
  assert.equal(result, "node-query", "요청 좌표가 이겨야 하는데 다른 값이 반환됐다");
  assert.deepEqual(asked, ["node-query"], "이미 요청이 이겼는데 대장의 셀프 여부까지 판정기에 물었다");
});

// ── R4 — 접힌 출처에서 멈추지 않는다(뒤가 살아난다) ───────────────────────────
// R4 가 깨지면: 화면이 실어 보낸 값 하나 때문에 진짜 노드 좌표가 통째로 버려진다.
test("요청이 셀프 좌표를 실어도 대장의 원격 좌표가 답이다 — 사양의 예시 그대로(R4)", () => {
  const { isSelf, asked } = recordCalls(isSelfOf([SELF_ID]));
  const result = sessionRelayNodeId({ query: SELF_ID, desired: "macmini", snapshot: undefined }, isSelf);
  assert.equal(result, "macmini", "요청의 셀프 좌표 때문에 대장의 진짜 원격 좌표까지 버려졌다");
  assert.deepEqual(asked, [SELF_ID, "macmini"], "셀프로 접힌 뒤 대장 값을 판정기에 이어서 묻지 않았다");
});

test("요청·대장이 둘 다 셀프여도 스냅샷의 원격 좌표가 살아난다 — 가장 깊은 폴드(R4)", () => {
  const { isSelf, asked } = recordCalls(isSelfOf([SELF_ID]));
  const result = sessionRelayNodeId({ query: SELF_ID, desired: SELF_ID, snapshot: "macmini" }, isSelf);
  assert.equal(result, "macmini", "두 출처가 연달아 셀프로 접혔는데 스냅샷 값이 살아나지 않았다");
  assert.deepEqual(asked, [SELF_ID, SELF_ID, "macmini"], "연쇄로 접히는 동안 판정기 호출 순서가 사양과 다르다");
});

test("요청이 셀프로 접히고 대장이 부재여도 스냅샷이 살아난다 — 폴드+부재 혼합(R4+R5+R2)", () => {
  const { isSelf, asked } = recordCalls(isSelfOf([SELF_ID]));
  const result = sessionRelayNodeId({ query: SELF_ID, desired: undefined, snapshot: "macmini" }, isSelf);
  assert.equal(result, "macmini", "요청이 접히고 대장이 부재라고 스냅샷까지 포기했다");
  assert.deepEqual(asked, [SELF_ID, "macmini"], "부재인 대장을 판정기에 묻거나, 정작 스냅샷은 묻지 않았다");
});

// ── R5 — 빈 값·공백뿐인 값·null/undefined 는 전부 "부재"다, 앞뒤 공백은 다듬는다 ──
test("빈 문자열은 부재다 — 다음 출처로 넘어간다(R5)", () => {
  const result = sessionRelayNodeId({ query: "", desired: "macmini", snapshot: undefined }, REMOTE);
  assert.equal(result, "macmini", "빈 문자열을 유효한 좌표로 잘못 읽어 대장 값으로 못 넘어갔다");
});

test("공백뿐인 값은 부재다 — 다음 출처로 넘어간다(R5)", () => {
  const result = sessionRelayNodeId({ query: "\t\n  ", desired: "macmini", snapshot: undefined }, REMOTE);
  assert.equal(result, "macmini", "공백만 있는 문자열을 유효한 좌표로 잘못 읽어 대장 값으로 못 넘어갔다");
});

test("null 은 부재다 — 다음 출처로 넘어간다(R5)", () => {
  const result = sessionRelayNodeId({ query: null, desired: "macmini", snapshot: undefined }, REMOTE);
  assert.equal(result, "macmini", "null 을 유효한 좌표로 잘못 읽어 대장 값으로 못 넘어갔다");
});

test("undefined 는 부재다 — 다음 출처로 넘어간다(R5)", () => {
  const result = sessionRelayNodeId({ query: undefined, desired: "macmini", snapshot: undefined }, REMOTE);
  assert.equal(result, "macmini", "undefined 를 유효한 좌표로 잘못 읽어 대장 값으로 못 넘어갔다");
});

test("부재(빈 값·공백·null) 는 판정기로 넘기지 않는다 — 셋 다 부재면 호출 자체가 없다(R5)", () => {
  const result = sessionRelayNodeId({ query: "", desired: "   ", snapshot: null }, NEVER);
  assert.equal(result, "", "부재 값뿐인데도 판정기를 불러 무언가를 만들어냈다(또는 부재 판정이 틀렸다)");
});

test("빈 문자열 슬롯은 건너뛰고, 그 뒤 진짜 값만 판정기에 넘긴다(R5)", () => {
  const result = sessionRelayNodeId({ query: "", desired: "macmini", snapshot: undefined }, guardBlank(REMOTE));
  assert.equal(result, "macmini", "빈 문자열 슬롯을 판정기에 넘기다 걸려 대장 값에 도달하지 못했다");
});

test("공백뿐인 슬롯은 건너뛰고, 그 뒤 진짜 값만 판정기에 넘긴다(R5)", () => {
  const result = sessionRelayNodeId({ query: "  ", desired: "macmini", snapshot: undefined }, guardBlank(REMOTE));
  assert.equal(result, "macmini", "공백뿐인 슬롯을 판정기에 넘기다 걸려 대장 값에 도달하지 못했다");
});

test("좌표 문자열의 앞뒤 공백은 다듬어 반환한다(R5)", () => {
  const result = sessionRelayNodeId({ query: "  macmini  ", desired: undefined, snapshot: undefined }, REMOTE);
  assert.equal(result, "macmini", "반환값에 앞뒤 공백이 그대로 남아 있다");
});

test("판정기에는 트림된 값으로 정확히 한 번 묻는다(R5)", () => {
  const { isSelf, asked } = recordCalls(REMOTE);
  const result = sessionRelayNodeId({ query: "  macmini  ", desired: undefined, snapshot: undefined }, isSelf);
  assert.equal(result, "macmini", "트림된 반환값이 아니다");
  assert.deepEqual(asked, ["macmini"], "판정기에 앞뒤 공백이 붙은 원문을 그대로 넘겼다");
});

test("공백이 붙은 셀프 좌표도 트림 후 판정되어 접힌다(R5+R3)", () => {
  const result = sessionRelayNodeId(
    { query: `  ${SELF_ID}  `, desired: undefined, snapshot: undefined },
    (id) => id === SELF_ID, // 트림 안 된 원문과는 절대 안 맞는, 엄격한 완전일치 판정기
  );
  assert.equal(result, "", "트림하지 않고 판정기를 불러 셀프 좌표를 원격으로 오판했다");
});

// ── R6 — 어디서도 못 찾으면 "좌표 없음"("") ──────────────────────────────────
// R6 이 깨지면: 중앙 세션이 있지도 않은 노드로 보내진다.
test("세 출처가 모두 없으면(필드 자체 생략) 좌표 없음이다(R6)", () => {
  const result = sessionRelayNodeId({}, NEVER);
  assert.equal(result, "", "출처가 하나도 없는데도 어떤 좌표를 만들어냈다");
});

test("세 출처가 모두 null·undefined 여도 좌표 없음이다(R6)", () => {
  const result = sessionRelayNodeId({ query: null, desired: undefined, snapshot: null }, NEVER);
  assert.equal(result, "", "null/undefined 뿐인 출처에서 좌표를 만들어냈다");
});

// ── 출처 3개 × 있음(R)/없음(A)/셀프(S) 조합 — 앞선 출처가 접혔을 때 뒤가 살아나는지 전수 확인 ──
// A=부재(undefined) · S=셀프(SELF_ID, isSelf 가 참) · R=원격(자리마다 구분되는 고유 값, isSelf 가 거짓)
// expected/expectedAsked 는 R1~R6 을 손으로 적용해 사람이 미리 계산한 값이다(구현을 베낀 공식이 아니다).
type Presence = "A" | "S" | "R";
const NODE_Q = "node-query";
const NODE_D = "node-desired";
const NODE_SNAP = "node-snapshot";

const materialize = (p: Presence, remoteValue: string): string | undefined =>
  p === "A" ? undefined : p === "S" ? SELF_ID : remoteValue;

interface ComboRow {
  label: string;
  q: Presence;
  d: Presence;
  s: Presence;
  expected: string;
  expectedAsked: string[];
}

const comboRows: ComboRow[] = [
  { label: "AAA · 전부 없음 → 좌표 없음", q: "A", d: "A", s: "A", expected: "", expectedAsked: [] },
  { label: "AAR · 스냅샷만 원격 → 스냅샷이 답(R2)", q: "A", d: "A", s: "R", expected: NODE_SNAP, expectedAsked: [NODE_SNAP] },
  { label: "AAS · 스냅샷만 셀프 → 좌표 없음(R3)", q: "A", d: "A", s: "S", expected: "", expectedAsked: [SELF_ID] },
  { label: "ASA · 대장만 셀프 → 좌표 없음(R3)", q: "A", d: "S", s: "A", expected: "", expectedAsked: [SELF_ID] },
  { label: "ASR · 대장이 셀프로 접힌 뒤 스냅샷이 살아난다(R4)", q: "A", d: "S", s: "R", expected: NODE_SNAP, expectedAsked: [SELF_ID, NODE_SNAP] },
  { label: "ARA · 대장만 원격 → 대장이 답(R2)", q: "A", d: "R", s: "A", expected: NODE_D, expectedAsked: [NODE_D] },
  { label: "ARS · 대장이 이기면 스냅샷의 셀프 여부는 안 본다(R1)", q: "A", d: "R", s: "S", expected: NODE_D, expectedAsked: [NODE_D] },
  { label: "SAA · 요청만 셀프 → 좌표 없음(R3)", q: "S", d: "A", s: "A", expected: "", expectedAsked: [SELF_ID] },
  { label: "SAR · 요청이 셀프로 접히고 대장은 부재, 스냅샷이 살아난다(R4+R5+R2)", q: "S", d: "A", s: "R", expected: NODE_SNAP, expectedAsked: [SELF_ID, NODE_SNAP] },
  { label: "SSA · 요청·대장 둘 다 셀프 → 좌표 없음", q: "S", d: "S", s: "A", expected: "", expectedAsked: [SELF_ID, SELF_ID] },
  { label: "SSS · 셋 다 셀프 → 좌표 없음(R6, 전량 접힘)", q: "S", d: "S", s: "S", expected: "", expectedAsked: [SELF_ID, SELF_ID, SELF_ID] },
  { label: "SSR · 두 단계 접힌 뒤 스냅샷이 살아난다 — 가장 깊은 폴드(R4)", q: "S", d: "S", s: "R", expected: NODE_SNAP, expectedAsked: [SELF_ID, SELF_ID, NODE_SNAP] },
  { label: "SRA · 요청이 셀프로 접히고 대장이 답이다 — 사양 예시 그대로(R4)", q: "S", d: "R", s: "A", expected: NODE_D, expectedAsked: [SELF_ID, NODE_D] },
  { label: "SRS · 대장이 이기면 스냅샷의 셀프 여부는 안 본다(요청은 접힘)(R1)", q: "S", d: "R", s: "S", expected: NODE_D, expectedAsked: [SELF_ID, NODE_D] },
  { label: "RAA · 요청만 원격 → 요청이 답(R1)", q: "R", d: "A", s: "A", expected: NODE_Q, expectedAsked: [NODE_Q] },
  { label: "RSA · 요청이 이기면 대장의 셀프 여부는 안 본다(R1)", q: "R", d: "S", s: "A", expected: NODE_Q, expectedAsked: [NODE_Q] },
  { label: "RRR · 셋 다 원격이어도 요청이 이긴다 — 뒤는 보지도 않는다(R1)", q: "R", d: "R", s: "R", expected: NODE_Q, expectedAsked: [NODE_Q] },
];

for (const row of comboRows) {
  test(`좌표 접기 조합 — ${row.label}`, () => {
    const { isSelf, asked } = recordCalls(isSelfOf([SELF_ID]));
    const sources = {
      query: materialize(row.q, NODE_Q),
      desired: materialize(row.d, NODE_D),
      snapshot: materialize(row.s, NODE_SNAP),
    };
    const result = sessionRelayNodeId(sources, isSelf);
    assert.equal(result, row.expected, `[${row.label}] 반환된 좌표가 사양과 다르다`);
    assert.deepEqual(asked, row.expectedAsked, `[${row.label}] 판정기를 물은 대상·순서가 사양과 다르다`);
  });
}
