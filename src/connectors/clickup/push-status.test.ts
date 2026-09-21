import { test } from "node:test";
import assert from "node:assert/strict";
import { statusesForList, buildStatusMap, categoryOfStatusName, decidePushStatus } from "./push-status.js";

import type { ClickUpStatus, ClickUpList, ClickUpSpace } from "./types.js";

// ── 행위 1 — statusesForList: 이 카드에 유효한 상태셋을 고른다 ─────────────

test("override_statuses가 참이면 스페이스 상태셋이 있어도 리스트 고유 상태셋을 쓴다", () => {
  const list: ClickUpList = { id: "l1", override_statuses: true, statuses: [{ status: "리스트고유", type: "open" }] };
  const space: ClickUpSpace = { id: "s1", statuses: [{ status: "스페이스", type: "open" }] };
  assert.deepEqual(statusesForList(list, space), list.statuses);
});

test("override_statuses가 거짓이면 스페이스 상태셋을 상속한다", () => {
  const list: ClickUpList = { id: "l1", override_statuses: false, statuses: [{ status: "리스트고유", type: "open" }] };
  const space: ClickUpSpace = { id: "s1", statuses: [{ status: "스페이스", type: "open" }] };
  assert.deepEqual(statusesForList(list, space), space.statuses);
});

test("스페이스 상태셋이 빈 배열이면 상속할 게 없어 리스트 상태셋으로 폴백한다", () => {
  const list: ClickUpList = { id: "l1", override_statuses: false, statuses: [{ status: "리스트고유", type: "open" }] };
  const space: ClickUpSpace = { id: "s1", statuses: [] };
  assert.deepEqual(statusesForList(list, space), list.statuses);
});

test("스페이스 자체가 없으면 리스트 상태셋으로 폴백한다", () => {
  const list: ClickUpList = { id: "l1", override_statuses: false, statuses: [{ status: "리스트고유", type: "open" }] };
  assert.deepEqual(statusesForList(list, undefined), list.statuses);
});

test("리스트가 null이면 스페이스 상태셋을 쓴다", () => {
  const space: ClickUpSpace = { id: "s1", statuses: [{ status: "스페이스", type: "open" }] };
  assert.deepEqual(statusesForList(null, space), space.statuses);
});

test("리스트도 스페이스도 없으면 빈 배열을 반환한다", () => {
  assert.deepEqual(statusesForList(null, null), []);
});

// ── 행위 2 — buildStatusMap: 정규 카테고리 → 대표 라벨 ────────────────────

test("open 타입 라벨이 backlog와 unstarted 카테고리 모두의 대표값이 된다", () => {
  const map = buildStatusMap([{ status: "Open", type: "open" }]);
  assert.equal(map.backlog, "Open");
  assert.equal(map.unstarted, "Open");
});

test("custom 타입이 있으면 started는 custom 라벨을 대표값으로 쓴다", () => {
  const map = buildStatusMap([
    { status: "Open", type: "open" },
    { status: "Doing", type: "custom" },
  ]);
  assert.equal(map.started, "Doing");
});

test("custom 타입이 없으면 started는 open 라벨로 폴백한다", () => {
  const map = buildStatusMap([{ status: "Open", type: "open" }]);
  assert.equal(map.started, "Open");
});

test("done 타입이 있으면 done과 canceled 모두 done 라벨을 대표값으로 쓴다", () => {
  const map = buildStatusMap([
    { status: "Closed", type: "closed" },
    { status: "Complete", type: "done" },
  ]);
  assert.equal(map.done, "Complete");
  assert.equal(map.canceled, "Complete");
});

test("done 타입이 없으면 done과 canceled는 closed 라벨로 폴백한다", () => {
  const map = buildStatusMap([{ status: "Closed", type: "closed" }]);
  assert.equal(map.done, "Closed");
  assert.equal(map.canceled, "Closed");
});

test("해당 type이 상태셋에 전혀 없으면 그 카테고리는 undefined다", () => {
  const map = buildStatusMap([]);
  assert.equal(map.started, undefined);
});

// 우선순위 규칙(먼저 나오는 것 채택)이 없으면 배열 뒤쪽 항목으로 덮어써질 수 있어 리스트 편집 순서에 결과가 흔들린다.
test("같은 type이 여럿이면 상태셋에서 먼저 나오는 것을 대표값으로 쓴다", () => {
  const map = buildStatusMap([
    { status: "First", type: "open" },
    { status: "Second", type: "open" },
  ]);
  assert.equal(map.backlog, "First");
});

// ── 행위 3 — categoryOfStatusName: 라벨(또는 슬러그)로 카테고리 역추적 ────

test("done 타입 상태는 done 카테고리로 역추적된다", () => {
  const statuses = [{ status: "Complete", type: "done" }];
  assert.equal(categoryOfStatusName(statuses, "Complete"), "done");
});

test("closed 타입 상태도 done 카테고리로 역추적된다", () => {
  const statuses = [{ status: "Closed", type: "closed" }];
  assert.equal(categoryOfStatusName(statuses, "Closed"), "done");
});

test("custom 타입 상태는 started 카테고리로 역추적된다", () => {
  const statuses = [{ status: "In Progress", type: "custom" }];
  assert.equal(categoryOfStatusName(statuses, "In Progress"), "started");
});

test("open 타입 상태는 unstarted 카테고리로 역추적된다", () => {
  const statuses = [{ status: "Backlog", type: "open" }];
  assert.equal(categoryOfStatusName(statuses, "Backlog"), "unstarted");
});

test("type이 없거나 알려지지 않은 값이면 unstarted로 취급한다", () => {
  const known = [{ status: "Weird", type: "mystery" }];
  assert.equal(categoryOfStatusName(known, "Weird"), "unstarted");
  const missing = [{ status: "NoType" }];
  assert.equal(categoryOfStatusName(missing, "NoType"), "unstarted");
});

// 우리 저장본=슬러그, ClickUp 라벨=공백형이라 이 정규화가 없으면 행위4의 "카테고리 동일 판정"이 항상 실패해 불필요한 덮어쓰기가 발생한다.
test("슬러그(in-review)와 라벨(in review)의 표기 차이를 무시하고 매칭한다", () => {
  const statuses = [{ status: "in review", type: "custom" }];
  assert.equal(categoryOfStatusName(statuses, "in-review"), "started");
});

test("대소문자 차이를 무시하고 매칭한다", () => {
  const statuses = [{ status: "Open", type: "open" }];
  assert.equal(categoryOfStatusName(statuses, "open"), "unstarted");
});

test("상태셋에 없는 이름이면 null을 반환한다", () => {
  const statuses = [{ status: "Open", type: "open" }];
  assert.equal(categoryOfStatusName(statuses, "Nonexistent"), null);
});

test("이름이 null이면 null을 반환한다", () => {
  const statuses = [{ status: "Open", type: "open" }];
  assert.equal(categoryOfStatusName(statuses, null), null);
});

// ── 행위 4 — decidePushStatus: 실을 status 라벨을 정한다 ──────────────────

test("우리 카테고리가 없으면(null/undefined/빈값) status를 싣지 않는다", () => {
  const statuses = [{ status: "Complete", type: "done" }];
  for (const ourCategory of [null, undefined, ""]) {
    assert.equal(
      decidePushStatus({ ourCategory, theirStatusRaw: "backlog", statuses }),
      undefined,
    );
  }
});

// 카테고리가 같은데 대표 라벨로 덮으면 저쪽의 세부 진행단계(커스텀 단계)가 사라진다 — 그래서 undefined로 보존한다.
test("저쪽 카테고리가 우리와 같으면 status를 싣지 않는다(라벨 덮어쓰기로 세부 정보를 잃지 않도록)", () => {
  const statuses = [
    { status: "planned", type: "open" },
    { status: "in progress", type: "custom" },
  ];
  const result = decidePushStatus({ ourCategory: "started", theirStatusRaw: "in progress", statuses });
  assert.equal(result, undefined);
});

test("저쪽 카테고리가 우리와 다르면 우리 카테고리의 대표 라벨을 싣는다", () => {
  const statuses = [
    { status: "backlog", type: "open" },
    { status: "Complete", type: "done" },
  ];
  const result = decidePushStatus({ ourCategory: "done", theirStatusRaw: "backlog", statuses });
  assert.equal(result, "Complete");
});

test("저쪽 상태를 상태셋에서 찾을 수 없어 모를 때는 우리 카테고리의 대표 라벨을 싣는다", () => {
  const statuses = [
    { status: "backlog", type: "open" },
    { status: "Complete", type: "done" },
  ];
  const result = decidePushStatus({ ourCategory: "done", theirStatusRaw: "존재하지않는상태", statuses });
  assert.equal(result, "Complete");
});

test("우리 카테고리의 대표 라벨이 그 상태셋에 없으면 status를 싣지 않는다", () => {
  const statuses = [{ status: "backlog", type: "open" }]; // done·closed 타입이 상태셋에 전혀 없음
  const result = decidePushStatus({ ourCategory: "canceled", theirStatusRaw: "backlog", statuses });
  assert.equal(result, undefined);
});

// ── 회귀 락 — 실측: 우리는 done인데 ClickUp은 아직 backlog인 카드가 18건 있었다 ──

test("회귀 락: 우리 done + 저쪽 backlog면 'complete' 어휘를 쓰는 리스트에서는 complete를 싣는다", () => {
  const statuses = [
    { status: "backlog", type: "open" },
    { status: "planned", type: "open" },
    { status: "in progress", type: "custom" },
    { status: "complete", type: "done" },
  ];
  const result = decidePushStatus({ ourCategory: "done", theirStatusRaw: "backlog", statuses });
  assert.equal(result, "complete");
});

// 같은 조건이라도 리스트 어휘가 다르면(complete가 아니라 shipped) 보낼 라벨도 달라야 한다 — 대표 라벨을 하드코딩하면 이 리스트에서 깨진다.
test("회귀 락: 같은 조건이라도 'shipped' 어휘를 쓰는 리스트에서는 shipped를 싣는다(리스트마다 라벨이 다르다)", () => {
  const statuses = [
    { status: "backlog", type: "open" },
    { status: "in review", type: "custom" },
    { status: "shipped", type: "done" },
  ];
  const result = decidePushStatus({ ourCategory: "done", theirStatusRaw: "backlog", statuses });
  assert.equal(result, "shipped");
});

// 🔴 회귀 락 — buildStatusMap 은 backlog·canceled 도 라벨로 내놓지만 categoryOfStatusName 은 그 둘을
//  절대 반환하지 않는다(ClickUp type 에 대응물이 없다). 카테고리 비교만 하면 저쪽이 이미 같은 라벨인데도
//  매 틱 같은 PUT 이 반복된다(2026-09-21 리뷰 지적).
test("decidePushStatus — 보낼 라벨이 저쪽 현재 라벨과 같으면 보내지 않는다(backlog·canceled 비대칭 보정)", () => {
  const statuses = [
    { status: "backlog", type: "open" },
    { status: "in progress", type: "custom" },
    { status: "complete", type: "done" },
  ];
  assert.equal(decidePushStatus({ ourCategory: "backlog", theirStatusRaw: "backlog", statuses }), undefined);
  assert.equal(decidePushStatus({ ourCategory: "canceled", theirStatusRaw: "complete", statuses }), undefined);
  // 표기차(슬러그/대소문자)도 같은 것으로 본다.
  assert.equal(decidePushStatus({ ourCategory: "started", theirStatusRaw: "In-Progress", statuses }), undefined);
  // 반대로 실제로 다르면 그대로 보낸다(위 보정이 정상 푸시를 삼키지 않는지).
  assert.equal(decidePushStatus({ ourCategory: "backlog", theirStatusRaw: "complete", statuses }), "backlog");
});

// base 가 없는 행(네이티브·레거시 3키 base)에서 우리 값이 그대로 나가는지 — "base NULL 안전" 주장의 락.
test("decidePushStatus — 저쪽 상태가 없으면(base 부재) 우리 카테고리의 대표 라벨을 그대로 싣는다", () => {
  const statuses: ClickUpStatus[] = [
    { status: "backlog", type: "open" },
    { status: "in progress", type: "custom" },
    { status: "complete", type: "done" },
  ];
  assert.equal(decidePushStatus({ ourCategory: "done", theirStatusRaw: null, statuses }), "complete");
  assert.equal(decidePushStatus({ ourCategory: "started", theirStatusRaw: undefined, statuses }), "in progress");
});

// 🔴 회귀 락 — 우리 카테고리 공간(backlog·canceled)은 ClickUp type 에 대응물이 없어 categoryOfStatusName 이
//  절대 반환하지 않는다. 그래서 ourCategory 를 직접 비교하면 그 두 값에서 가드가 항상 빗나가 저쪽 상태를
//  덮어쓴다(canceled+Closed → Complete 평탄화). 판정은 「보낼 라벨의 카테고리」로 해야 한다.
test("decidePushStatus — canceled·backlog 에서도 저쪽이 같은 카테고리면 덮어쓰지 않는다", () => {
  const closedList: ClickUpStatus[] = [
    { status: "planned", type: "open" },
    { status: "Complete", type: "done" },
    { status: "Closed", type: "closed" },
  ];
  assert.equal(decidePushStatus({ ourCategory: "canceled", theirStatusRaw: "Closed", statuses: closedList }), undefined);
  assert.equal(decidePushStatus({ ourCategory: "backlog", theirStatusRaw: "planned", statuses: closedList }), undefined);
  // 실제로 다르면 그대로 보낸다(위 보정이 정상 푸시를 삼키지 않는지).
  assert.equal(decidePushStatus({ ourCategory: "canceled", theirStatusRaw: "planned", statuses: closedList }), "Complete");
  assert.equal(decidePushStatus({ ourCategory: "backlog", theirStatusRaw: "Closed", statuses: closedList }), "planned");
});

// 구 표현식(`(override || !space.length ? list : space) ?? list ?? space ?? []`)과 **갈리는 유일한 케이스**.
//  구현은 빈 배열을 nullish 로 보지 않아 `[]` 를 냈는데, 상속할 상태셋이 있으면 그쪽을 쓰는 게 맞다.
//  이 동작은 인바운드 effectiveStatusDefs 와 공유되므로 의도로 못 박아 둔다(2026-09-21 리뷰 지적).
test("statusesForList — override 인데 리스트 상태셋이 비어 있으면 스페이스로 넘어간다", () => {
  const list: ClickUpList = { id: "l1", override_statuses: true, statuses: [] };
  const space: ClickUpSpace = { id: "s1", statuses: [{ status: "spaceOnly", type: "open" }] };
  assert.deepEqual(statusesForList(list, space).map((s) => s.status), ["spaceOnly"]);
});
