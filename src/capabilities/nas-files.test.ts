// NAS 도구(nas_find·nas_list) 사양 검증(DB 없음) — 매니지드 게이트웨이에서는 자체 호스팅 안내(501)로 거절하고,
//  구성원 FTP 자격(금고)을 읽지 않는다. 이전 색인이 있을 때 다시 만들기가 실패하는 응답(last_error 에 원문 없음)은
//  실 DB 가 필요해 net/nas/nas-access.pg-test.mjs 가 본다.
// 실행: npm run build && node dist/capabilities/nas-files.test.js
import assert from "node:assert/strict";
import { itemsPool } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { NAS_MANAGED_OFF } from "../net/nas/nas-access.js";
import { nasFileCapabilities } from "./nas-files.js";
import type { LivelyUser } from "../context.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

// 금고 페이크 — 부른 SQL 을 센다(매니지드에서 0건이어야 한다). 셀프호스트 대조군이 1건 이상을 보여 배선을 확인한다.
const dbCalls: string[] = [];
(itemsPool as unknown as { query: (sql: string) => Promise<{ rows: unknown[] }> }).query = async (sql: string) => {
  dbCalls.push(sql);
  return { rows: [] };
};

const USER = { userId: "m-nas-files-test", email: "m@example.invalid", scopes: ["memory"], projects: ["*"], tokenSource: "db" } as LivelyUser;
const cap = (name: string) => {
  const c = nasFileCapabilities.find((x) => x.name === name);
  if (!c) throw new Error(`${name} 가 없다`);
  return c;
};
const CALLS: Array<[string, Record<string, unknown>]> = [["nas_find", { q: "약정서" }], ["nas_list", { path: "/" }]];

await t("매니지드: nas_find·nas_list 는 자체 호스팅 안내(501)로 거절하고 금고를 읽지 않는다", async () => {
  dbCalls.length = 0;
  process.env.LIVELY_TENANT_HEADER_SECRET = "nas-files-test";
  try {
    for (const [name, input] of CALLS) {
      await assert.rejects(() => cap(name).handler(input, USER),
        (e: unknown) => e instanceof HttpError && e.status === 501 && e.message === NAS_MANAGED_OFF, name);
    }
  } finally {
    delete process.env.LIVELY_TENANT_HEADER_SECRET;
  }
  assert.equal(dbCalls.length, 0, `금고 조회: ${dbCalls.join(" | ")}`);
});

await t("셀프호스트 대조군: 같은 호출이 금고를 읽고 서버 미설정(503)으로 답한다", async () => {
  for (const [name, input] of CALLS) {
    dbCalls.length = 0;
    await assert.rejects(() => cap(name).handler(input, USER), (e: unknown) => e instanceof HttpError && e.status === 503, name);
    assert.ok(dbCalls.length >= 1, `${name}: 금고를 읽었다(페이크 배선 확인)`);
  }
});

console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
