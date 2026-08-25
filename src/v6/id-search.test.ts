import { strict as assert } from "node:assert";
import test from "node:test";
import { idEquals } from "./search-util.js";

// 2026-08-25 상민님: "프로젝트는 번호로도 검색가능하게". 번호 지목은 grep 이 아니라 **정확일치**여야 한다 —
//  `id::text ILIKE '%1%'` 로 하면 1·10·100·1835 가 다 걸려 목록이 쓰레기가 된다.
//  사양·엣지 표: 스크래치패드 spec-idsearch.md (10행).
//  ⚠ params 규약이 이 함수의 진짜 위험이다 — null 을 돌려주면서 push 하면 뒤따르는 술어의 $n 이 통째로 밀린다.

test("[1] 숫자면 술어를 돌려주고 값을 push 한다", () => {
  const p: unknown[] = [];
  assert.equal(idEquals("p.id", "1835", p), "p.id = $1");
  assert.deepEqual(p, [1835]);
});

test("[2] 사람 표기 #1835 도 같은 뜻", () => {
  const p: unknown[] = [];
  assert.equal(idEquals("p.id", "#1835", p), "p.id = $1");
  assert.deepEqual(p, [1835]);
});

test("[3] 앞뒤 공백은 무시", () => {
  const p: unknown[] = [];
  assert.equal(idEquals("p.id", "  1835  ", p), "p.id = $1");
});

test("[4] 숫자가 아니면 null", () => {
  const p: unknown[] = [];
  assert.equal(idEquals("p.id", "탭 줄", p), null);
});

test("★ [5] 일부만 숫자면 id 지목이 아니다", () => {
  const p: unknown[] = [];
  assert.equal(idEquals("p.id", "1835 탭", p), null);
  assert.equal(idEquals("p.id", "v1835", p), null);
});

test("[6] 0·음수는 id 가 아니다", () => {
  const p: unknown[] = [];
  assert.equal(idEquals("p.id", "0", p), null);
  assert.equal(idEquals("p.id", "-3", p), null);
});

test("★ [7] int4 경계 — 2147483647 은 되고 2147483648 은 안 된다", () => {
  const a: unknown[] = [];
  assert.equal(idEquals("p.id", "2147483647", a), "p.id = $1");
  const b: unknown[] = [];
  assert.equal(idEquals("p.id", "2147483648", b), null);
});

test("[8] 빈 입력은 null", () => {
  for (const q of ["", "   ", null as unknown as string, undefined as unknown as string]) {
    assert.equal(idEquals("p.id", q, []), null, `q=${String(q)}`);
  }
});

test("[9] 앞자리 0 도 숫자 표기다", () => {
  const p: unknown[] = [];
  assert.equal(idEquals("p.id", "01835", p), "p.id = $1");
  assert.deepEqual(p, [1835]);
});

test("★★ [10] null 을 돌려줄 땐 params 를 절대 건드리지 않는다 — 자리표시자가 밀리면 엉뚱한 조건이 실행된다", () => {
  const p: unknown[] = ["%기존%"];
  for (const q of ["탭 줄", "", "0", "2147483648", "v1", "1835 탭"]) {
    assert.equal(idEquals("p.id", q, p), null, `q=${q}`);
    assert.deepEqual(p, ["%기존%"], `q=${q} 에서 params 가 오염됐다`);
  }
});

test("자리표시자 번호는 params 길이를 따른다(앞에 이미 있으면 $2)", () => {
  const p: unknown[] = ["%탭%"];
  assert.equal(idEquals("p.id", "7", p), "p.id = $2");
});
