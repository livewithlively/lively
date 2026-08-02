// db 접근 감사 v1(P5, #746) 단위 체크 — canonical 직렬화·해시체인·subject 수집(순수) + 체인 INSERT(목 클라이언트).
// 실행: npm run build && node dist/db/access-log.test.js
import assert from "node:assert/strict";
import {
  GENESIS, canonicalJson, computeRowHash, collectSubjectKeys, writeAccessRow, scrubErrorText,
  type HashedRowFields,
} from "./access-log.js";
import type { DbAccessRecord } from "../../db/access-log.js"; // 레코드형은 코어 계약
import { assertSafeSelect, type SourcePolicy } from "../../db/firewall.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): Promise<void> | void => {
  const r = fn();
  if (r instanceof Promise) return r.then(() => { pass++; console.log(`ok  ${name}`); });
  pass++;
  console.log(`ok  ${name}`);
};

// ── canonicalJson — jsonb 왕복(키 순서 비보존)에도 동일 직렬화 ──
t("canonicalJson: 객체 키 순서 무관 동일", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] }), canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
});
t("canonicalJson: null/undefined → null, 배열 순서는 보존", () => {
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson(null), "null");
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

// ── computeRowHash — 결정론 + 임의 필드 변조 검출 + jsonb 왕복 재현 ──
const baseFields: HashedRowFields = {
  at: "2026-07-09T07:00:00.123Z", userId: "u1", tokenHashPrefix: "abcd", harness: "claude",
  op: "query", source: "prod", sql: "SELECT id FROM t WHERE x = ?",
  tables: ["t"], maskedColumns: ["ssn"], unmaskedColumns: [], grantIds: null,
  subjectKeys: { "t.id": { values: ["1", "2"], distinct: 2, truncated: false } },
  rowCount: 2, durationMs: 12, ok: true, error: null,
};
t("computeRowHash: 결정론(같은 입력 → 같은 해시)", () => {
  assert.equal(computeRowHash(GENESIS, baseFields), computeRowHash(GENESIS, { ...baseFields }));
});
t("computeRowHash: 본문 1필드 변조 → 해시 변화(rowCount·sql·ok·prev)", () => {
  const h = computeRowHash(GENESIS, baseFields);
  assert.notEqual(computeRowHash(GENESIS, { ...baseFields, rowCount: 3 }), h);
  assert.notEqual(computeRowHash(GENESIS, { ...baseFields, sql: "SELECT id FROM t" }), h);
  assert.notEqual(computeRowHash(GENESIS, { ...baseFields, ok: false }), h);
  assert.notEqual(computeRowHash("otherprev", baseFields), h);
});
t("computeRowHash: subjectKeys 키 순서 재배열(jsonb 왕복 시뮬) → 해시 동일", () => {
  const reordered = {
    ...baseFields,
    subjectKeys: JSON.parse('{"t.id":{"truncated":false,"distinct":2,"values":["1","2"]}}') as unknown,
  };
  assert.equal(computeRowHash(GENESIS, reordered), computeRowHash(GENESIS, baseFields));
});
t("computeRowHash: timestamptz 왕복(Date→ISO) 재현", () => {
  const at2 = new Date("2026-07-09T07:00:00.123Z").toISOString();
  assert.equal(computeRowHash(GENESIS, { ...baseFields, at: at2 }), computeRowHash(GENESIS, baseFields));
});

// ── collectSubjectKeys — 지정 컬럼 값 distinct 수집(상한부) ──
t("collectSubjectKeys: srcKey 매칭 컬럼만, distinct·null 스킵", () => {
  const fields = [
    { name: "uid", srcKey: "users.user_id" },
    { name: "nm", srcKey: "users.name" },
    { name: "expr", srcKey: null },
  ];
  const rows: unknown[][] = [[1, "a", "x"], [2, "b", "y"], [1, "c", "z"], [null, "d", "w"]];
  const got = collectSubjectKeys(fields, rows, (k) => (k === "users.user_id" ? k : null));
  assert.deepEqual(got, { "users.user_id": { values: ["1", "2"], distinct: 2, truncated: false } });
});
t("collectSubjectKeys: 지정 없음 → null", () => {
  assert.equal(collectSubjectKeys([{ name: "a", srcKey: "t.a" }], [[1]], () => null), null);
});
t("collectSubjectKeys: 200 초과 distinct → truncated + 총계 보존", () => {
  const fields = [{ name: "id", srcKey: "t.id" }];
  const rows: unknown[][] = Array.from({ length: 250 }, (_, i) => [i]);
  const got = collectSubjectKeys(fields, rows, (k) => k)!;
  assert.equal(got["t.id"].values.length, 200);
  assert.equal(got["t.id"].distinct, 250);
  assert.equal(got["t.id"].truncated, true);
});
t("collectSubjectKeys: 같은 subject 를 가리키는 별칭 2컬럼 → 값 합산 distinct", () => {
  const fields = [
    { name: "a", srcKey: "t.id" },
    { name: "b", srcKey: "t.id" },
  ];
  const got = collectSubjectKeys(fields, [[1, 2], [3, 1]], (k) => k)!;
  assert.deepEqual(got["t.id"].values.sort(), ["1", "2", "3"]);
});

// ── writeAccessRow(목 클라이언트) — 체인 선형화·해시 연결·스크럽·롤백 ──
interface Call { text: string; values?: unknown[] }
function mockClient(lastHash: string | null, failOnInsert = false) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.startsWith("SELECT row_hash")) {
        return { rows: lastHash ? [{ row_hash: lastHash }] : [] };
      }
      if (text.startsWith("INSERT") && failOnInsert) throw new Error("boom");
      return { rows: [] };
    },
  };
}
const rec: DbAccessRecord = {
  userId: "u1", tokenHashPrefix: "abcd", harness: "claude", op: "query", source: "prod",
  sql: "SELECT id FROM t WHERE name = '홍길동'",
  tables: ["t"], maskedColumns: ["name"], rowCount: 1, durationMs: 7, ok: true, subjectKeys: null,
};

await t("writeAccessRow: BEGIN→advisory lock→last 조회→INSERT→COMMIT 순서 + GENESIS 체인", async () => {
  const c = mockClient(null);
  await writeAccessRow(c, rec, "2026-07-09T07:00:00.000Z");
  const kinds = c.calls.map((x) => x.text.split(/[ (]/)[0]);
  assert.deepEqual(kinds, ["BEGIN", "SELECT", "SELECT", "INSERT", "COMMIT"]);
  const ins = c.calls.find((x) => x.text.startsWith("INSERT"))!;
  const v = ins.values!;
  assert.equal(v[16], GENESIS); // prev_hash
  // 저장 해시 = 동일 본문 재계산과 일치(검증 경로와 왕복 정합)
  const expected = computeRowHash(GENESIS, {
    at: "2026-07-09T07:00:00.000Z", userId: "u1", tokenHashPrefix: "abcd", harness: "claude",
    op: "query", source: "prod", sql: v[6] as string, tables: ["t"], maskedColumns: ["name"],
    unmaskedColumns: [], grantIds: null, subjectKeys: null, rowCount: 1, durationMs: 7, ok: true, error: null,
  });
  assert.equal(v[17], expected); // row_hash
});

await t("writeAccessRow: SQL 리터럴 스크럽(PII 미잔존, #705)", async () => {
  const c = mockClient(null);
  await writeAccessRow(c, rec, "2026-07-09T07:00:00.000Z");
  const ins = c.calls.find((x) => x.text.startsWith("INSERT"))!;
  const storedSql = ins.values![6] as string;
  assert.ok(!storedSql.includes("홍길동"), "리터럴이 스크럽돼야 함");
  assert.ok(storedSql.includes("?"), "구조는 보존(플레이스홀더)");
});

await t("writeAccessRow: 직전 행 있으면 그 row_hash 로 체인", async () => {
  const c = mockClient("prevhash123");
  await writeAccessRow(c, rec, "2026-07-09T07:00:01.000Z");
  const ins = c.calls.find((x) => x.text.startsWith("INSERT"))!;
  assert.equal(ins.values![16], "prevhash123");
});

await t("writeAccessRow: INSERT 실패 → ROLLBACK 후 throw", async () => {
  const c = mockClient(null, true);
  await assert.rejects(() => writeAccessRow(c, rec), /boom/);
  assert.ok(c.calls.some((x) => x.text === "ROLLBACK"));
});

// ── 에러 문자열 스크럽(리뷰 blocking②) — DB 에러가 되쏘는 리터럴이 WORM 감사에 박제되지 않게 ──
t("scrubErrorText: pg 큰따옴표·mysql 작은따옴표 되쏨 값 가림", () => {
  const pg = scrubErrorText('invalid input syntax for type integer: "홍길동"');
  const my = scrubErrorText("Incorrect integer value: '홍길동' for column 'age'");
  assert.ok(!pg.includes("홍길동") && !my.includes("홍길동"));
  assert.ok(pg.includes('"?"'), "구조 표식은 남긴다");
});
await t("writeAccessRow: error 필드도 스크럽 후 저장", async () => {
  const c = mockClient(null);
  await writeAccessRow(c, { ...rec, ok: false, error: 'invalid input: "주민801010"' }, "2026-07-09T07:00:00.000Z");
  const ins = c.calls.find((x) => x.text.startsWith("INSERT"))!;
  const storedErr = ins.values![15] as string;
  assert.ok(!storedErr.includes("주민801010"), "error 내 리터럴이 스크럽돼야 함");
});

// ── 게이트1 차단 에러에 참조 테이블 부착(P5 — 차단 시도의 구조화 감사) ──
t("firewall: DENIED 테이블 차단 에러에 tables 부착", () => {
  try {
    assertSafeSelect("SELECT * FROM auth_token");
    assert.fail("throw 해야 함");
  } catch (e) {
    assert.deepEqual((e as { tables?: string[] }).tables, ["auth_token"]);
  }
});
t("firewall: 정책 deny 차단 에러에도 tables 부착", () => {
  const policy: SourcePolicy = {
    tableDefault: "deny", tableMode: new Map(), maskedCols: new Set(), maskedColNames: new Set(), hasMasks: false,
  };
  try {
    assertSafeSelect("SELECT a FROM customer_secret", policy);
    assert.fail("throw 해야 함");
  } catch (e) {
    assert.deepEqual((e as { tables?: string[] }).tables, ["customer_secret"]);
  }
});

console.log(`\naccess-log tests: ${pass} passed`);
