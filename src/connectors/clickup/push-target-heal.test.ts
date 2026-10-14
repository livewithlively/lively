// 자식 카드 create 가 ITEM_137(부모가 그 리스트에 없음)로 실패할 때 부모의 실제 리스트를 다시 찾아 한 번만 재시도하는 자가 치유.
//  잠그는 사고: 오판정으로 엉뚱한 오류에 재시도, 무한 재시도, 고친 좌표를 기록하지 않아 매 push 마다 같은 400 반복.
import test from "node:test";
import assert from "node:assert/strict";
import { isParentNotInList, createUnderParent, isRowScopedLookupFailure } from "./push-target.js";

const ORIG = "901814368850";
const HEALED = "901817591515";
const PARENT = "parent-ext-1";

const item137 = (): Error =>
  new Error(`ClickUp 400 /list/${ORIG}/task: {"err":"Parent not child of list","ECODE":"ITEM_137"}`);

type Lookup = { kind: "list"; listId: string } | { kind: "gone" };

// 호출 순서·인자를 한 로그에 남겨 onHealed 와 재시도의 선후를 비교한다.
function harness(opts: {
  create: (listId: string, healed: boolean, nth: number) => string;
  lookup?: (parentExt: string) => Lookup;
}) {
  const log: Array<[string, ...unknown[]]> = [];
  let n = 0;
  return {
    log,
    calls: (name: string) => log.filter((e) => e[0] === name),
    deps: {
      create: async (listId: string, healed: boolean) => {
        log.push(["create", listId, healed]);
        n += 1;
        return opts.create(listId, healed, n);
      },
      lookupParentList: async (parentExt: string) => {
        log.push(["lookup", parentExt]);
        if (!opts.lookup) throw new Error("lookup 은 불리면 안 된다");
        return opts.lookup(parentExt);
      },
      onHealed: async (parentExt: string, listId: string) => {
        log.push(["onHealed", parentExt, listId]);
      },
    },
  };
}

// ── A. isParentNotInList ────────────────────────────────────────────

test("400 + ITEM_137 오류는 부모-리스트 불일치로 판정한다", () => {
  assert.equal(isParentNotInList(item137()), true, "ITEM_137 을 못 알아보면 자가 치유가 영영 안 돌고 자식 카드 생성이 계속 실패한다");
});

test("400 이지만 다른 ECODE 면 불일치가 아니다", () => {
  const e = new Error('ClickUp 400 /list/9018/task: {"err":"Task name invalid","ECODE":"INPUT_005"}');
  assert.equal(isParentNotInList(e), false, "다른 400 까지 치유 대상으로 보면 부모 조회·리스트 이동이 엉뚱한 오류에 일어난다");
});

test("404·500·429 는 메시지에 ITEM_137 이 섞여 있어도 불일치가 아니다", () => {
  for (const code of ["404", "500", "429"]) {
    const e = new Error(`ClickUp ${code} /list/9018/task: upstream said ITEM_137`);
    assert.equal(isParentNotInList(e), false,
      `ClickUp ${code} 를 ITEM_137 로 오판하면 장애·레이트리밋 중에 부모 좌표를 잘못 덮어쓴다`);
  }
});

test("Error 가 아닌 값은 불일치가 아니다", () => {
  assert.equal(isParentNotInList('ClickUp 400 /list/9018/task: {"ECODE":"ITEM_137"}'), false,
    "문자열 throw 를 Error 처럼 다루면 형식이 보장되지 않은 값으로 치유 경로가 열린다");
  assert.equal(isParentNotInList(null), false, "null 에서 터지거나 true 가 나오면 원래 오류가 묻힌다");
  assert.equal(isParentNotInList({ message: 'ClickUp 400 x: {"ECODE":"ITEM_137"}' }), false,
    "message 만 흉내낸 객체를 받아들이면 Error 판정 계약이 무너진다");
});

// ── B. createUnderParent ───────────────────────────────────────────

test("첫 시도가 성공하면 원래 리스트 결과를 돌려주고 조회·기록은 하지 않는다", async () => {
  const h = harness({ create: () => "task-1" });
  const out = await createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps });
  assert.deepEqual(out, { kind: "created", result: "task-1", listId: ORIG }, "정상 생성 결과·리스트가 틀리면 링크 좌표가 어긋난다");
  assert.deepEqual(h.log, [["create", ORIG, false]],
    "성공 경로에서 조회·기록이 일어나면 매 생성마다 불필요한 API 호출과 좌표 덮어쓰기가 생긴다");
});

test("ITEM_137 후 부모가 사라졌으면 parent_gone 을 돌려주고 재시도·기록하지 않는다", async () => {
  const h = harness({ create: () => { throw item137(); }, lookup: () => ({ kind: "gone" }) });
  const out = await createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps });
  assert.deepEqual(out, { kind: "parent_gone" }, "부모 소멸을 오류로 던지면 호출부가 고아 카드를 정리할 기회를 잃는다");
  assert.deepEqual(h.log, [["create", ORIG, false], ["lookup", PARENT]],
    "부모가 없는데 재시도·기록하면 존재하지 않는 좌표가 저장되거나 같은 400 이 반복된다");
});

test("ITEM_137 후 부모의 다른 리스트를 찾으면 그 좌표를 먼저 기록하고 그 리스트에 한 번 재시도한다", async () => {
  const h = harness({
    create: (_l, _h, nth) => { if (nth === 1) throw item137(); return "task-2"; },
    lookup: () => ({ kind: "list", listId: HEALED }),
  });
  const out = await createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps });
  assert.deepEqual(out, { kind: "created", result: "task-2", listId: HEALED },
    "치유 후 결과의 listId 가 원래 값이면 호출부가 틀린 리스트 좌표를 계속 쓴다");
  assert.deepEqual(h.log, [
    ["create", ORIG, false],
    ["lookup", PARENT],
    ["onHealed", PARENT, HEALED],
    ["create", HEALED, true],
  ], "기록이 재시도보다 늦거나 빠지면 재시도 성공·실패와 무관하게 고친 좌표가 유실되어 다음 push 가 같은 400 을 낸다");
});

test("조회한 리스트가 원래 리스트와 같으면 처음 오류를 그대로 던진다", async () => {
  const first = item137();
  const h = harness({ create: () => { throw first; }, lookup: () => ({ kind: "list", listId: ORIG }) });
  await assert.rejects(createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps }),
    (e) => e === first, "같은 리스트로 재시도하면 반드시 같은 400 이 나고, 다른 오류로 바꿔 던지면 원인이 가려진다");
  assert.equal(h.calls("create").length, 1, "같은 리스트 재시도는 무의미한 API 호출이다");
  assert.equal(h.calls("onHealed").length, 0, "바뀐 것이 없는데 기록하면 치유된 것처럼 보인다");
});

test("조회한 리스트가 빈 문자열·공백뿐이면 처음 오류를 그대로 던진다", async () => {
  for (const blank of ["", "   "]) {
    const first = item137();
    const h = harness({ create: () => { throw first; }, lookup: () => ({ kind: "list", listId: blank }) });
    await assert.rejects(createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps }),
      (e) => e === first, `빈 좌표(${JSON.stringify(blank)})로 재시도하면 /list//task 로 나가 원인을 알 수 없는 400 이 된다`);
    assert.equal(h.calls("create").length, 1, "빈 좌표 재시도가 일어나면 안 된다");
    assert.equal(h.calls("onHealed").length, 0, "빈 좌표를 기록하면 부모 리스트 좌표가 지워진다");
  }
});

test("부모 리스트 조회가 실패하면 그 오류가 밖으로 나간다", async () => {
  const lookupErr = new Error("ClickUp 500 /task/parent-ext-1");
  const h = harness({ create: () => { throw item137(); }, lookup: () => { throw lookupErr; } });
  await assert.rejects(createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps }),
    (e) => e === lookupErr, "조회 실패를 삼키거나 바꾸면 실제 장애 원인이 로그에서 사라진다");
  assert.equal(h.calls("create").length, 1, "조회 실패 후 재시도하면 근거 없는 좌표로 생성을 시도한다");
  assert.equal(h.calls("onHealed").length, 0, "조회 실패 후 기록하면 확인 안 된 좌표가 저장된다");
});

// 부모 재조회가 «이 행만» 막혔을 때(401·403 등 4xx) — 조회 오류를 그대로 던지면 401·403 이 시스템성으로 분류돼
//  (push-failure.ts) 이 행 하나가 매 틱 실행 실패가 되고 브레이커가 반출 전체를 세운다. 처음 거절(ITEM_137, 400)을
//  던져야 행 거절로 파킹 경로를 탄다. 일시 장애(429·5xx·네트워크)는 조회 오류 그대로가 맞다.
test("조회 실패 판정 — 행 고유 4xx(429 제외)만 «이 행만 막힘» 이다", () => {
  for (const m of ['ClickUp 401 /task/p: {"err":"Not authorized","ECODE":"OAUTH_023"}', "ClickUp 403 /task/p: forbidden",
    'ClickUp 400 /task/p: {"ECODE":"INPUT_001"}']) {
    assert.equal(isRowScopedLookupFailure(new Error(m)), true, `${m.slice(0, 12)} 를 일시 장애로 보면 행 하나가 매 틱 실패한다`);
  }
  for (const m of ["ClickUp 429 재시도 초과(5회): /task/p", "ClickUp 503 /task/p: down", "ClickUp 502 /task/p401x: bad gateway",
    "ClickUp 네트워크/타임아웃 실패(재시도 소진) /task/p: aborted"]) {
    assert.equal(isRowScopedLookupFailure(new Error(m)), false, `${m.slice(0, 12)} 를 행 고유로 보면 장애가 행 거절 속에 숨는다`);
  }
  assert.equal(isRowScopedLookupFailure("ClickUp 401 /task/p: x"), false, "Error 가 아닌 값을 판정했다");
});

test("부모 조회가 401(OAUTH_027 아님)·403 이면 처음 ITEM_137 을 그대로 던진다", async () => {
  for (const msg of ['ClickUp 401 /task/parent-ext-1: {"err":"Not authorized to view","ECODE":"OAUTH_023"}', "ClickUp 403 /task/parent-ext-1: forbidden"]) {
    const first = item137();
    const h = harness({ create: () => { throw first; }, lookup: () => { throw new Error(msg); } });
    await assert.rejects(createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps }), (e) => e === first,
      `${msg.slice(0, 11)} 조회 오류를 그대로 던지면 시스템성으로 분류돼 이 행 하나가 매 틱 크론 실패가 된다`);
    assert.equal(h.calls("create").length, 1, "조회가 막혔는데 다른 리스트로 재시도했다");
    assert.equal(h.calls("onHealed").length, 0, "확인 안 된 좌표를 기록했다");
  }
});

test("부모 조회가 429·5xx·네트워크면 조회 오류를 그대로 던진다(일시 장애)", async () => {
  for (const msg of ["ClickUp 429 재시도 초과(5회): /task/parent-ext-1", "ClickUp 503 /task/parent-ext-1: down",
    "ClickUp 네트워크/타임아웃 실패(재시도 소진) /task/parent-ext-1: aborted"]) {
    const lookupErr = new Error(msg);
    const h = harness({ create: () => { throw item137(); }, lookup: () => { throw lookupErr; } });
    await assert.rejects(createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps }), (e) => e === lookupErr,
      `${msg.slice(0, 11)} 를 처음 거절로 바꾸면 장애가 행 거절로 파킹돼 사람이 못 본다`);
  }
});

test("재시도가 실패하면 그 오류가 밖으로 나가고 기록은 이미 되어 있다", async () => {
  const retryErr = new Error("ClickUp 500 /list/901817591515/task: boom");
  const h = harness({
    create: (_l, _h, nth) => { throw nth === 1 ? item137() : retryErr; },
    lookup: () => ({ kind: "list", listId: HEALED }),
  });
  await assert.rejects(createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps }),
    (e) => e === retryErr, "재시도 오류 대신 첫 오류를 던지면 실제 실패 원인(재시도 측)이 가려진다");
  assert.deepEqual(h.calls("onHealed"), [["onHealed", PARENT, HEALED]],
    "재시도가 실패해도 찾아낸 부모 좌표는 기록돼야 다음 push 가 올바른 리스트로 간다");
});

test("재시도가 다시 ITEM_137 이어도 create 는 두 번에서 멈춘다", async () => {
  const h = harness({
    create: () => { throw item137(); },
    lookup: () => ({ kind: "list", listId: HEALED }),
  });
  await assert.rejects(createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps }));
  assert.equal(h.calls("create").length, 2, "재시도 실패에 또 치유를 돌면 ClickUp 호출이 끝없이 반복될 수 있다");
  assert.equal(h.calls("lookup").length, 1, "두 번째 실패에 다시 조회하면 세 번째 시도로 이어지는 루프가 열린다");
});

test("ITEM_137 이 아닌 첫 실패는 조회 없이 그대로 던진다", async () => {
  const other = new Error('ClickUp 400 /list/9018/task: {"ECODE":"INPUT_005"}');
  const h = harness({ create: () => { throw other; } });
  await assert.rejects(createUnderParent({ listId: ORIG, parentExt: PARENT, ...h.deps }),
    (e) => e === other, "다른 오류를 치유 경로로 돌리면 원래 오류가 가려지고 엉뚱한 리스트로 옮겨진다");
  assert.deepEqual(h.log, [["create", ORIG, false]], "치유 대상이 아닌 오류에 조회·재시도가 일어나면 안 된다");
});

test("최상위 카드(parentExt 없음)는 ITEM_137 이어도 조회 없이 그대로 던진다", async () => {
  const first = item137();
  const h = harness({ create: () => { throw first; } });
  await assert.rejects(createUnderParent({ listId: ORIG, parentExt: undefined, ...h.deps }),
    (e) => e === first, "부모가 없는 카드를 치유하려 들면 undefined 로 부모 조회를 날린다");
  assert.deepEqual(h.log, [["create", ORIG, false]], "최상위 카드에서 조회·재시도가 일어나면 안 된다");
});
