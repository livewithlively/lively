// 클릭업 리스트 id 목록 해석(parseListIds) — 사양 R1·R2 · 엣지 L1~L7(#4970).
//  토글·웹은 고른 리스트를 공백으로 잇고 사람·환경변수는 쉼표로 적는다 — 둘 다 같은 집합이어야 한다.
//  실행: npm run build && node dist/connectors/clickup/list-ids.test.js
import assert from "node:assert/strict";
import { parseListIds } from "./api.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };
const ids = (raw: string | null | undefined) => [...parseListIds(raw)].sort();

assert.deepEqual(ids("901,902"), ["901", "902"]); ok("L1 쉼표");
assert.deepEqual(ids("901 902"), ["901", "902"]); ok("L2 공백(토글·웹이 저장하는 모양)");
assert.deepEqual(ids("901, 902\n903"), ["901", "902", "903"]); ok("L3 섞인 구분자");
assert.deepEqual(ids(""), []); assert.deepEqual(ids(undefined), []); assert.deepEqual(ids(null), []); ok("L4 빈 값");
assert.deepEqual(ids(" , ,\n"), []); ok("L5 구분자만");
assert.deepEqual(ids("901"), ["901"]); ok("L6 하나");
assert.deepEqual(ids("901,901 901"), ["901"]); ok("L7 중복 없음");

console.log(`\n${pass} passed`);
