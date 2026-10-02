// 아웃바운드 create 의 «어느 리스트에 만드나» 판정 — 순수 leaf(네트워크·DB 무의존) + 배선 잠금.
//  사양: 자식 카드는 조상 체인에서 가장 가까운 리스트 좌표에 태어난다. 체인이 비면 컨테이너로 폴백한다.
//  잠그는 사고: 컨테이너에 만들면서 다른 리스트의 parent 를 지정 → ClickUp 400 ITEM_137.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createListFor } from "./push-target.js";

const r = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const PUSH = r("../clickup-push.ts");

const CONTAINER = "901814368850"; // TO-DO List

test("직계 부모의 리스트를 알면 컨테이너가 아니라 그 리스트에 만든다", () => {
  assert.equal(createListFor(["901817591515"], CONTAINER), "901817591515");
});

// 3단 체인 — push 로 방금 만든 중간 노드는 list_ext 가 비어 있다(base 는 인바운드만 채운다).
//  한 칸만 보면 여기서 컨테이너로 떨어져 ITEM_137 이 재발한다.
test("직계 부모의 좌표가 없으면 조상으로 올라가 첫 리스트를 쓴다", () => {
  assert.equal(createListFor([null, "901809464086"], CONTAINER), "901809464086");
  assert.equal(createListFor([null, null, "901817591515"], CONTAINER), "901817591515");
});

test("체인이 전부 비면(네이티브 top-level 계보) 컨테이너로 폴백한다", () => {
  assert.equal(createListFor([null, null], CONTAINER), CONTAINER);
  assert.equal(createListFor([], CONTAINER), CONTAINER); // 최상위 — 부모 자체가 없다
});

// 빈 문자열·공백을 그대로 쓰면 `/list//task` 로 나가 무엇이 틀렸는지 알 수 없는 400 이 된다.
test("빈 문자열·공백뿐인 좌표는 없는 것으로 보고 다음 조상으로 넘어간다", () => {
  assert.equal(createListFor(["", "  ", "901809464086"], CONTAINER), "901809464086");
  assert.equal(createListFor([""], CONTAINER), CONTAINER);
});

// ── 배선 — 순수 판정이 맞아도 호출부가 컨테이너를 그대로 쓰면 아무 의미가 없다 ──────
test("배선 — create 는 판정 결과(createList)로 나가고 컨테이너 직행 경로가 남아 있지 않다", () => {
  assert.match(PUSH, /createSafe\(createList,/, "create 가 판정 결과를 안 쓴다");
  assert.ok(!/createSafe\(containerId/.test(PUSH), "컨테이너 직행 create 가 남아 있다 — ITEM_137 재발 경로");
});

test("배선 — 조상 체인을 실제로 조회하고, status 기준 리스트도 같은 값을 쓴다", () => {
  assert.match(PUSH, /WITH RECURSIVE anc AS/, "조상 체인 조회가 없다 — 3단 이상에서 컨테이너로 떨어진다");
  assert.ok(PUSH.includes("NULLIF(btrim(external_base->>'list_ext'), '') AS list_ext, 0 AS d"),
    "조상 쿼리 anchor 가 리스트 좌표를 안 뽑는다(공백=없음 정규화 포함)");
  assert.match(PUSH, /listForStatus = .*createList/, "status 기준 리스트가 실제 생성 리스트와 갈린다");
});
