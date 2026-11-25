// 새 구성원 기본 권한은 한 값이다 (2026-11-23)
//
//  scope 를 고르지 않고 구성원을 만들면 items · context · memory · db · code 를 받는다. 종전엔 자리마다 값이 달랐다 —
//   웹 등록 폼은 items · context 두 개만 체크해 두었고, 서버(REST · MCP) · 회사 계정 자동 가입 · DB 칸 기본값은 items · context · memory 였다.
//   같은 «새 구성원» 이 만든 길에 따라 다른 권한을 받았다.
//  서버 값(auth/scopes.ts DEFAULT_MEMBER_SCOPES)이 기준이고, 코드가 서로 import 할 수 없는 두 자리(웹 번들 · SQL)는 같은 값을 따로 적는다.
//   그 셋이 갈라지지 않게 소스로 잠근다. 실제 저장 동작은 DB 가 있어야 재진다(org/store/default-member-scopes.pg-test.mjs).
//
//  엣지 표:
//   D1 기본 권한 = items · context · memory · db · code (비지 않음 · 위험 권한 admin · runtime 없음 · 전부 실재하는 scope)
//   D2 웹 등록 폼의 미리 체크된 권한(web/admin-members.ts MEMBER_DEFAULT_SCOPES) = 서버 값
//   D3 웹에서 새 구성원 폼을 여는 두 자리가 그 상수를 쓴다(손으로 적은 배열 없음)
//   D4 DB 칸 기본값(칸을 만드는 문장 · 옛 DB 를 맞추는 문장) = 서버 값
//   D5 공용 시트 허용 권한은 함께 넓어지지 않았다(items · context · memory 그대로)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MEMBER_SCOPES, DANGEROUS_SCOPES, isScope } from "./scopes.js";
import { SEAT_BASIC_SCOPES, seatElevated } from "../ai-runs/plan.js";

const SRC_ROOT = new URL("../", import.meta.url).pathname.replace("/dist/", "/src/");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");
const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), "utf8");
/** 주석 줄을 뺀 소스 — 설명문에 옛 값이 인용돼도 검사가 흔들리지 않게. */
const code = (rel: string): string => read(rel).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");
const sorted = (a: readonly string[]): string[] => [...a].sort();

const EXPECTED = ["code", "context", "db", "items", "memory"];

test("D1 기본 권한은 items · context · memory · db · code 다", () => {
  assert.deepEqual(sorted(DEFAULT_MEMBER_SCOPES), EXPECTED);
  assert.equal(new Set(DEFAULT_MEMBER_SCOPES).size, DEFAULT_MEMBER_SCOPES.length, "겹치는 값이 없다");
  for (const s of DEFAULT_MEMBER_SCOPES) {
    assert.ok(isScope(s), `${s} 는 실재하는 scope 여야 한다`);
    assert.ok(!DANGEROUS_SCOPES.has(s), `${s} — 위험 권한은 기본값에 들지 않는다`);
  }
});

test("D2 웹 등록 폼의 미리 체크된 권한이 서버 값과 같다", () => {
  const m = /export const MEMBER_DEFAULT_SCOPES = \[([^\]]*)\]/.exec(code("web/admin-members.ts"));
  assert.ok(m, "web/admin-members.ts 에 MEMBER_DEFAULT_SCOPES 가 있어야 한다");
  const web = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(sorted(web), EXPECTED);
});

test("D3 새 구성원 폼을 여는 두 자리가 상수를 쓴다", () => {
  for (const rel of ["web/admin-members.ts", "web/admin-shell.ts"]) {
    const blanks = [...code(rel).matchAll(/const blank = \{[^}]*\}/g)].map((x) => x[0]);
    assert.ok(blanks.length >= 1, `${rel} 에 새 구성원 폼의 빈 값이 있어야 한다(관측 장치가 살아 있나)`);
    for (const b of blanks) {
      assert.match(b, /scopes: \[\.\.\.MEMBER_DEFAULT_SCOPES\]/, `${rel} 의 빈 값이 상수를 쓰지 않는다: ${b}`);
    }
  }
});

test("D4 DB 칸 기본값이 서버 값과 같다", () => {
  const sql = code("src/org/schema/core.ts");
  const defaults = [...sql.matchAll(/(?:ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL|ALTER COLUMN scopes SET) DEFAULT '(\[[^']*\])'::jsonb/g)].map((x) => x[1]);
  assert.equal(defaults.length, 2, "칸을 만드는 문장과 옛 DB 를 맞추는 문장, 둘 다 있어야 한다");
  for (const d of defaults) assert.deepEqual(sorted(JSON.parse(d) as string[]), EXPECTED, d);
});

test("D5 공용 시트 허용 권한은 넓어지지 않았다", () => {
  assert.deepEqual(sorted([...SEAT_BASIC_SCOPES]), ["context", "items", "memory"]);
  assert.equal(seatElevated(["items", "context", "memory"]), false);
  assert.equal(seatElevated([...DEFAULT_MEMBER_SCOPES]), true, "기본값 그대로 만든 구성원은 db · code 를 내려야 공용 시트가 된다");
});
