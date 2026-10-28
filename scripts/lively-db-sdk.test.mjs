// lively-db SDK(#4483 · public/sdk/lively-db.mjs) — 「입력 × 기대」 엣지 표 S1~S10. DB 없이 게이트웨이 응답을 흉내 낸다.
//  실제 게이트웨이·DB 와 붙여 보는 끝단은 src/apps/lively-db-sdk.pg-test.mjs.
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pgTable, bigint, numeric, timestamp, text, integer } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import {
  createLivelyDb, livelyIdentity, livelyMember, livelyJobs, withIdentity, livelyErrorOf, encodeParam, decodeRows, decodeObjects, parsePgArray, generateDrizzleSchema, LivelyDbError,
} from "../public/sdk/lively-db.mjs";

/** 게이트웨이 흉내 — 부른 것(경로·헤더·본문)을 남기고 정해 둔 응답을 돌려준다. */
function gateway(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, headers: init.headers, body });
    const r = typeof reply === "function" ? reply(body, calls.length) : reply;
    return new Response(JSON.stringify(r.body ?? r), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}
const wire = (fields, rows, extra = {}) => ({ kind: "select", fields: fields.map(([name, type]) => ({ name, type })), rows, row_count: rows.length, truncated: false, changed: null, ms: 1, ...extra });

test("S1 decodeRows — 형 OID 마다 node-postgres 와 같게(날짜·시각·간격·numeric·int8 은 글자 그대로)", () => {
  const r = wire([["i2", 21], ["i4", 23], ["i8", 20], ["num", 1700], ["f8", 701], ["f8n", 701], ["f8i", 701], ["b", 16], ["bf", 16], ["j", 3802], ["by", 17],
    ["d", 1082], ["tz", 1184], ["ts", 1114], ["iv", 1186], ["ta", 1009], ["i4a", 1007], ["i8a", 1016], ["numa", 1231], ["ja", 3807], ["u", 2950], ["nul", 25], ["unk", 999999]],
  [["7", "42", "9007199254740993", "12.50", "1.5", "NaN", "-Infinity", "t", "f", '{"a": [1]}', "\\x0aff", "2026-10-14", "2026-10-14 00:00:00+00",
    "2026-10-14 09:00:00", "1 day 02:00:00", '{a,"b,c",NULL,"NULL","d\\"e"}', "{1,2}", "{9007199254740993}", "{1.10,2.20}", '{"{\\"k\\": 1}"}', "6f477586-8eed-4e75-a321-3a1f0c9d2e41", null, "x"]]);
  const [row] = decodeRows(r);
  assert.deepEqual(row.slice(0, 9), [7, 42, "9007199254740993", "12.50", 1.5, NaN, -Infinity, true, false]);
  assert.deepEqual(row[9], { a: [1] });
  assert.deepEqual([...row[10]], [0x0a, 0xff]);
  assert.deepEqual(row.slice(11, 15), ["2026-10-14", "2026-10-14 00:00:00+00", "2026-10-14 09:00:00", "1 day 02:00:00"]);
  assert.deepEqual(row[15], ["a", "b,c", null, "NULL", 'd"e']);
  assert.deepEqual(row[16], [1, 2]);
  assert.deepEqual(row[17], ["9007199254740993"]);
  assert.equal(row[18], "{1.10,2.20}");                                   // numeric[] — Drizzle 가 글자로 받아 직접 푼다
  assert.deepEqual(row[19], [{ k: 1 }]);
  assert.deepEqual(row.slice(20), ["6f477586-8eed-4e75-a321-3a1f0c9d2e41", null, "x"]);
});

test("S2 decodeObjects — 칸 이름 → 값 · 겹친 이름은 뒤 칸 · rowCount(바뀐 행 수 · 없으면 행 수) · command", () => {
  const o = decodeObjects(wire([["id", 23], ["id", 23], ["n", 25]], [["1", "2", "a"]]), "select");
  assert.deepEqual([...o], [{ id: 2, n: "a" }]);
  assert.equal(o.rowCount, 1);
  assert.equal(o.command, "SELECT");
  const w = decodeObjects({ kind: "update", fields: [], rows: [], row_count: 0, changed: 5 }, "update");
  assert.deepEqual([[...w], w.rowCount, w.command], [[], 5, "UPDATE"]);
});

test("S3 encodeParam — JSON 으로 뜻이 바뀌는 값만 Postgres 글자로", () => {
  assert.equal(encodeParam(new Date("2026-10-14T00:00:00Z")), "2026-10-14T00:00:00.000Z");
  assert.equal(encodeParam(12345678901234567890n), "12345678901234567890");
  assert.deepEqual([encodeParam(NaN), encodeParam(Infinity), encodeParam(-Infinity), encodeParam(1.5)], ["NaN", "Infinity", "-Infinity", 1.5]);
  assert.equal(encodeParam(Buffer.from([1, 255])), "\\x01ff");
  assert.equal(encodeParam(new Uint8Array([2])), "\\x02");
  assert.equal(encodeParam(undefined), null);
  assert.deepEqual(encodeParam([1n, [new Date(0)], null]), ["1", ["1970-01-01T00:00:00.000Z"], null]);
  const obj = { a: 1 };
  assert.equal(encodeParam(obj), obj);
});

test("S4 parsePgArray — 빈 배열 · 따옴표 안 이스케이프 · 차원 표기 · 겹 배열 · 모양이 틀리면 throw", () => {
  assert.deepEqual(parsePgArray("{}"), []);
  assert.deepEqual(parsePgArray('{"a\\\\b","c\\"d"}'), ["a\\b", 'c"d']);
  assert.deepEqual(parsePgArray("[0:1]={1,2}", Number), [1, 2]);
  assert.deepEqual(parsePgArray("{{1,2},{3,NULL}}", Number), [[1, 2], [3, null]]);
  assert.throws(() => parsePgArray("{1,2"), /배열 모양/);
  assert.throws(() => parsePgArray("1,2"), /배열 모양/);
});

const contacts = pgTable("contacts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  score: integer("score"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

test("S5 createLivelyDb — 주소·토큰 없으면 throw · 요청 모양(경로·Bearer·wire·strict·app_id·params 인코딩) · Drizzle 매핑(bigint 수 · numeric 글자 · timestamptz Date)", async () => {
  assert.throws(() => createLivelyDb({ url: "", token: "t" }), /LIVELY_API_URL/);
  assert.throws(() => createLivelyDb({ url: "http://gw", token: "" }), /LIVELY_APP_TOKEN/);
  const g = gateway(wire([["id", 20], ["name", 25], ["amount", 1700], ["score", 23], ["created_at", 1184]], [["1", "가", "10.50", "3", "2026-10-14 00:00:00+00"]]));
  const { db } = createLivelyDb({ url: "http://gw/", token: "lvk_x", appId: "crm", fetch: g.fetch });
  const rows = await db.select().from(contacts).where(eq(contacts.createdAt, new Date("2026-10-14T00:00:00Z")));
  assert.deepEqual(rows, [{ id: 1, name: "가", amount: "10.50", score: 3, createdAt: new Date("2026-10-14T00:00:00Z") }]);
  assert.equal(g.calls.length, 1);
  const c = g.calls[0];
  assert.equal(c.path, "/api/ui/store/sql");
  assert.equal(c.headers.authorization, "Bearer lvk_x");
  assert.equal(c.headers["x-lively-identity"], undefined, "신원이 없으면 헤더도 없다");
  assert.deepEqual([c.body.format, c.body.strict, c.body.app_id], ["wire", true, "crm"]);
  assert.match(c.body.sql, /from "contacts" where "contacts"\."created_at" = \$1/);
  assert.deepEqual(c.body.params, ["2026-10-14T00:00:00.000Z"]);
});

test("S8 사람 신원 — 미들웨어 · withIdentity · identity 옵션이 그 호출에 X-Lively-Identity 를 싣는다(요청끼리 섞이지 않는다)", async () => {
  const g = gateway(wire([["n", 23]], [["1"]]));
  const { db } = createLivelyDb({ url: "http://gw", token: "t", fetch: g.fetch });
  const mw = livelyIdentity();
  await Promise.all(["A", "B"].map((who) => new Promise((resolve, reject) => {
    mw({ headers: { "x-lively-identity": `v1.k.${who}.s` } }, {}, () => { db.execute(sql`select 1 as n`).then(resolve, reject); });
  })));
  await withIdentity("v1.k.C.s", () => db.execute(sql`select 1 as n`));
  const opt = createLivelyDb({ url: "http://gw", token: "t", fetch: g.fetch, identity: () => "v1.k.D.s" });
  await opt.db.execute(sql`select 1 as n`);
  assert.deepEqual(g.calls.map((c) => c.headers["x-lively-identity"]).sort(), ["v1.k.A.s", "v1.k.B.s", "v1.k.C.s", "v1.k.D.s"]);
});

test("S6 오류 — 게이트웨이 4xx 는 LivelyDbError(status·body) · Drizzle 이 감싸도 livelyErrorOf 로 꺼낸다 · 닿지 못하면 status 0", async () => {
  const g = gateway({ status: 409, body: { error: "제약 조건에 걸렸습니다", pg_code: "23505" } });
  const { db } = createLivelyDb({ url: "http://gw", token: "t", fetch: g.fetch });
  await assert.rejects(db.insert(contacts).values({ name: "x" }), (e) => {
    const le = livelyErrorOf(e);
    return le instanceof LivelyDbError && le.status === 409 && le.body.pg_code === "23505" && /제약/.test(le.message);
  });
  const down = createLivelyDb({ url: "http://gw", token: "t", fetch: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(down.db.select().from(contacts), (e) => livelyErrorOf(e)?.status === 0 && /닿지 못했습니다/.test(livelyErrorOf(e)?.message));
  assert.equal(livelyErrorOf(new Error("다른 오류")), null);
  assert.equal(livelyErrorOf(undefined), null);
});

test("S7 묶음 — 요청 한 번(문장 순서 그대로) · 결과는 쿼리마다 제 모양 · 실패면 전부 거절(index) · 처리 안 된 거절 없음", async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const g = gateway((body) => ({
      results: [
        { kind: "insert", ...wire([["id", 20], ["name", 25], ["amount", 1700], ["score", 23], ["created_at", 1184]], [["5", "나", "1.00", null, "2026-10-14 00:00:00+00"]]), changed: 1 },
        { kind: "update", fields: [], rows: [], row_count: 0, truncated: false, changed: 2, ms: 1 },
        { kind: "select", ...wire([["n", 20]], [["7"]]) },
      ].slice(0, body.statements.length), ms: 3,
    }));
    const { db, batch } = createLivelyDb({ url: "http://gw", token: "t", fetch: g.fetch });
    const [ins, upd, cnt] = await batch([
      db.insert(contacts).values({ name: "나", amount: "1.00" }).returning(),
      db.update(contacts).set({ score: 1 }).where(eq(contacts.name, "나")),
      db.select({ n: sql`count(*)` }).from(contacts),
    ]);
    assert.equal(g.calls.length, 1);
    assert.equal(g.calls[0].path, "/api/ui/store/sql/batch");
    assert.deepEqual(g.calls[0].body.statements.map((s) => s.sql.split(" ")[0]), ["insert", "update", "select"]);
    assert.deepEqual(g.calls[0].body.statements[0].params, ["나", "1.00"]);
    assert.deepEqual(ins, [{ id: 5, name: "나", amount: "1.00", score: null, createdAt: new Date("2026-10-14T00:00:00Z") }]);
    assert.equal(upd.rowCount, 2);
    assert.deepEqual(cnt, [{ n: "7" }]);

    const bad = gateway({ status: 409, body: { error: "묶음 2번째 문장에서 멈춰 전부 취소했습니다", index: 1 } });
    const b2 = createLivelyDb({ url: "http://gw", token: "t", fetch: bad.fetch });
    await assert.rejects(b2.batch([b2.db.select().from(contacts), b2.db.insert(contacts).values({ name: "z" })]), (e) => e instanceof LivelyDbError && e.index === 1 && e.status === 409);
    const t0 = Date.now();
    await assert.rejects(b2.batch([b2.db.select().from(contacts), "not a query"]), /2번째가 Drizzle 쿼리가 아닙니다/);
    assert.ok(Date.now() - t0 < 1000, "쿼리가 아닌 것은 기다리지 않고 바로 거절");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, [], "처리 안 된 거절이 없다");
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("S9 빈 묶음 — 요청 없이 []", async () => {
  const g = gateway({});
  const { batch } = createLivelyDb({ url: "http://gw", token: "t", fetch: g.fetch });
  assert.deepEqual(await batch([]), []);
  assert.equal(g.calls.length, 0);
});

test("S10 generateDrizzleSchema — 매니페스트의 타입·제약·외래키가 Drizzle 표로(그대로 import 된다) · 관계", async () => {
  const manifest = { data: { tables: [
    { name: "contacts", columns: [
      { name: "name", type: "text", not_null: true }, { name: "email", type: "varchar(200)", unique: true },
      { name: "stage", type: "enum", values: ["lead", "won"], default: "lead" }, { name: "tags", type: "text[]" },
      { name: "meta", type: "jsonb" }, { name: "ref", type: "uuid", default_expr: "gen_random_uuid()" }, { name: "photo", type: "bytea" },
      { name: "met_on", type: "date", default_expr: "current_date" }, { name: "at", type: "timestamp", default_expr: "now()" },
    ] },
    { name: "orders", columns: [
      { name: "contact_id", type: "int", not_null: true, references: { table: "contacts", on_delete: "cascade" } },
      { name: "amount", type: "numeric(12,2)", default: 0 }, { name: "qty", type: "int4" }, { name: "ratio", type: "real" }, { name: "dur", type: "interval" },
    ] },
  ] } };
  const src = generateDrizzleSchema(manifest);
  //  레포 node_modules/.cache 아래에 만든다 — 만든 파일의 `import … from "drizzle-orm/…"` 가 이 레포의 drizzle-orm 으로 그대로 풀린다.
  const cache = new URL("../node_modules/.cache/", import.meta.url);
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(path.join(cache.pathname, "lively-db-gen-"));
  try {
    const file = path.join(dir, "schema.mjs");
    writeFileSync(file, src);
    const s = await import(pathToFileURL(file).href);
    const cfg = (t) => Object.fromEntries(Object.values(t).filter((c) => c && typeof c.getSQLType === "function").map((c) => [c.name, c.getSQLType()]));
    assert.deepEqual(cfg(s.contacts), {
      id: "bigint", name: "text", email: "varchar(200)", stage: "text", tags: "text[]", meta: "jsonb", ref: "uuid", photo: "bytea", met_on: "date",
      at: "timestamp with time zone", created_at: "timestamp with time zone",
    });
    assert.deepEqual(cfg(s.orders), { id: "bigint", contact_id: "bigint", amount: "numeric(12, 2)", qty: "integer", ratio: "real", dur: "interval", created_at: "timestamp with time zone" });
    assert.equal(s.contacts.name.notNull, true);
    assert.equal(s.contacts.email.isUnique, true);
    assert.deepEqual(s.contacts.stage.enumValues, ["lead", "won"]);
    assert.ok(s.ordersRelations && s.contactsRelations, "관계");
    assert.match(src, /contact: one\(contacts, \{ fields: \[orders\.contactId\], references: \[contacts\.id\] \}\)/);
    assert.match(src, /\.references\(\(\) => contacts\.id, \{ onDelete: "cascade" \}\)/);
    assert.match(src, /\.default\(sql`CURRENT_DATE`\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S11 livelyMember — 검사 층이 퍼센트 인코딩해 붙인 사람 머리글을 풀어 준다(한글 id · 이름) · 판 · 없으면 null · 깨진 인코딩은 그대로", () => {
  const h = (o) => ({ headers: o });
  assert.deepEqual(livelyMember(h({ "x-lively-member": encodeURIComponent("윤상민"), "x-lively-member-name": encodeURIComponent("윤 상민"), "x-lively-variant": "draft" })),
    { id: "윤상민", name: "윤 상민", variant: "draft", job: null });
  assert.deepEqual(livelyMember(h({ "x-lively-member": "sangmin-yoon" })), { id: "sangmin-yoon", name: "", variant: "pub", job: null }, "ASCII id · 이름 없음 · 판 기본 pub");
  assert.deepEqual(livelyMember(h({ "x-lively-member": ["a%20b", "x"], "x-lively-variant": "weird" })), { id: "a b", name: "", variant: "pub", job: null }, "배열은 첫 값 · 모르는 판은 pub");
  assert.equal(livelyMember(h({ "x-lively-member": "%E0%A4%A" })).id, "%E0%A4%A", "깨진 인코딩은 던지지 않고 그대로");
  assert.equal(livelyMember(h({})), null);
  assert.equal(livelyMember(h({ "x-lively-member": "" })), null);
  assert.equal(livelyMember(undefined), null);
});

test("S12 livelyMember — Fetch API 의 Headers(Next 앱 라우터 · Hono)도 같은 결과", () => {
  const headers = new Headers({ "x-lively-member": encodeURIComponent("윤상민"), "x-lively-member-name": encodeURIComponent("윤 상민"), "x-lively-variant": "draft" });
  assert.deepEqual(livelyMember({ headers }), { id: "윤상민", name: "윤 상민", variant: "draft", job: null });
  assert.equal(livelyMember({ headers: new Headers() }), null);
  assert.deepEqual(livelyMember(new Request("https://a.example/", { headers: { "x-lively-member": "m-1" } })), { id: "m-1", name: "", variant: "pub", job: null }, "Request 그대로");
});

test("S13 livelyMember — 백그라운드 작업이면 job(작업 번호 · #4486) · 숫자가 아니거나 0 이하면 null", () => {
  const h = (o) => ({ headers: o });
  assert.equal(livelyMember(h({ "x-lively-member": "m", "x-lively-job": "42" })).job, 42);
  assert.equal(livelyMember({ headers: new Headers({ "x-lively-member": "m", "x-lively-job": "7" }) }).job, 7, "Fetch Headers");
  for (const bad of ["0", "-3", "1.5", "abc", "", "99999999999999999999"]) assert.equal(livelyMember(h({ "x-lively-member": "m", "x-lively-job": bad })).job, null, `x-lively-job ${bad}`);
});

test("S14 livelyJobs — 앱 서버 토큰 + 들어온 신원으로 /api/ui/app-jobs 를 부른다 · 시작 · 보기(wait) · 목록 · 취소 · 기다리기 · 거절은 LivelyDbError", async () => {
  const calls = [];
  const replies = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const r = replies.shift() ?? { status: 200, body: { id: 1, status: "queued" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  assert.throws(() => livelyJobs({ token: "t", fetch }), /LIVELY_API_URL/);
  assert.throws(() => livelyJobs({ url: "https://w.example", fetch }), /LIVELY_APP_TOKEN/);
  const jobs = livelyJobs({ url: "https://w.example/", token: "tok", fetch, identity: () => "v1.k.p.s" });
  await jobs.start("/api/jobs/x", { file: "a.mp3" }, { label: "전사", wait: 5 });
  assert.deepEqual(calls[0], { url: "https://w.example/api/ui/app-jobs", method: "POST",
    headers: { authorization: "Bearer tok", "x-lively-identity": "v1.k.p.s", "content-type": "application/json" },
    body: { route: "/api/jobs/x", body: { file: "a.mp3" }, label: "전사", wait: 5 } });
  await jobs.start("/api/jobs/y");
  assert.deepEqual(calls[1].body, { route: "/api/jobs/y", body: {} }, "본문 생략 = {}");
  await jobs.get(3, { wait: 25 });
  assert.equal(calls[2].url, "https://w.example/api/ui/app-jobs/3?wait=25");
  assert.equal(calls[2].method, "GET");
  assert.equal(calls[2].body, undefined);
  replies.push({ status: 200, body: { jobs: [{ id: 1 }], count: 1 } });
  assert.deepEqual(await jobs.list({ status: "done" }), [{ id: 1 }]);
  assert.equal(calls[3].url, "https://w.example/api/ui/app-jobs?status=done");
  await jobs.cancel(9);
  assert.equal(calls[4].url, "https://w.example/api/ui/app-jobs/9/cancel");
  replies.push({ status: 200, body: { id: 9, status: "running" } }, { status: 200, body: { id: 9, status: "done" } });
  assert.equal((await jobs.wait(9)).status, "done", "끝날 때까지 다시 묻는다");
  assert.equal(calls.filter((c) => c.url.endsWith("/api/ui/app-jobs/9?wait=25")).length, 2);
  replies.push({ status: 429, body: { error: "하루 상한" } });
  await assert.rejects(jobs.start("/x"), (e) => e instanceof LivelyDbError && e.status === 429 && /하루 상한/.test(e.message));
  //  미들웨어가 실은 신원(livelyIdentity)을 쓴다 — identity 옵션이 없을 때.
  const j2 = livelyJobs({ url: "https://w.example", token: "tok", fetch });
  await new Promise((ok) => livelyIdentity()({ headers: { "x-lively-identity": "lvjr1.5.zzzz" } }, {}, () => { j2.get(5).then(ok); }));
  assert.equal(calls.at(-1).headers["x-lively-identity"], "lvjr1.5.zzzz", "작업 안에서 시작한 작업 · 조회는 돌기 신원을 싣는다");
});
