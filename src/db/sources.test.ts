// 순수 선택 로직 단위 체크 — 테스트 러너 없이 node:assert 로 자급(빌드+typecheck 가 게이트).
// 실행: npm run build && node dist/db/sources.test.js
// env 자동등록(DATABASE_URL/DB_SOURCES_JSON) 폐기(2026-06-23) — db_query 소스는 org_db_source(웹 SoT)가 유일.
//   따라서 env 파싱 단위테스트는 제거하고, 순수 선택 로직(pickDefaultFrom/pickSourceFrom)과
//   resolveConnectionString 의 authMode/url 게이트만 단위로 본다(IP-pin·비번해소는 DB·DNS 의존 → 통합 영역).
import assert from "node:assert/strict";
import { pickDefaultFrom, pickSourceFrom, resolveConnectionString, DEFAULT_SOURCE, type DbSource } from "./sources.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};
const throws = (name: string, fn: () => void, re: RegExp): void => {
  assert.throws(fn, re, name);
  pass++;
  console.log(`ok  ${name}`);
};

// 테스트용 DbSource 빌더(웹 등록 소스 형상 — origin='db').
const src = (name: string, over: Partial<DbSource> = {}): DbSource => ({
  name, url: `postgres://u@h/${name}`, driver: "postgres", rls: null,
  maxRows: 1000, timeoutMs: 5000, authMode: "password", secretSource: null, origin: "db", tableDefault: "allow", ...over,
});
const mapOf = (...ss: DbSource[]): Map<string, DbSource> => new Map(ss.map((s) => [s.name, s]));

// ── pickDefaultFrom ──
t("pickDefaultFrom: default 있으면 default", () => {
  assert.equal(pickDefaultFrom(mapOf(src(DEFAULT_SOURCE), src("ops"))), DEFAULT_SOURCE);
});
t("pickDefaultFrom: 단일 비-default → 그것", () => {
  assert.equal(pickDefaultFrom(mapOf(src("ops"))), "ops");
});
t("pickDefaultFrom: 다중+default없음 → null", () => {
  assert.equal(pickDefaultFrom(mapOf(src("ops"), src("ana"))), null);
});

// ── pickSourceFrom (D1 정책) ──
t("pickSourceFrom: 명시 소스 존재 → 그대로", () => {
  assert.equal(pickSourceFrom(mapOf(src("ops"), src("ana")), "ana"), "ana");
});
throws(
  "pickSourceFrom: 명시했는데 없음 → 에러",
  () => pickSourceFrom(mapOf(src(DEFAULT_SOURCE)), "nope"),
  /알 수 없는 db source/,
);
t("pickSourceFrom: 미지정+단일 → 그것", () => {
  assert.equal(pickSourceFrom(mapOf(src(DEFAULT_SOURCE))), DEFAULT_SOURCE);
});
throws(
  "pickSourceFrom: 미지정+다중+기본없음 → 에러",
  () => pickSourceFrom(mapOf(src("ops"), src("ana"))),
  /source 명시 필요/,
);
throws("pickSourceFrom: 소스 0개 → 에러(웹 등록 안내)", () => pickSourceFrom(new Map()), /등록된 DB 소스 없음/);

// ── resolveConnectionString: authMode/url 게이트(DB·DNS 의존 전에 throw) ──
const at = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};
await at("resolveConnectionString: iam 미지원 → throw", async () => {
  await assert.rejects(() => resolveConnectionString(src("x", { authMode: "iam" })), /미지원/);
});
await at("resolveConnectionString: url 없음 → throw", async () => {
  await assert.rejects(() => resolveConnectionString(src("x", { url: "" })), /url/);
});

console.log(`\n${pass} checks passed`);
