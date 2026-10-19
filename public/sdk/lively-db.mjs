// lively-db — 라이블리 앱 데이터 SDK(#4483). 앱 서버(Express · Lambda · Next 라우트 …)에서 Drizzle 로 라이블리 앱 표를 쓴다.
//  게이트웨이 앱 SQL(store_sql) 위의 Drizzle HTTP 드라이버(pg-proxy) + 묶음 트랜잭션 + 사람 신원 넘기기 + 매니페스트 → Drizzle 스키마.
//  이 파일 하나를 앱 프로젝트에 넣고 drizzle-orm 만 설치한다(npm i drizzle-orm@0.45.3). 받는 곳: <게이트웨이>/ui/sdk/lively-db.mjs
//
//  쓰는 법:
//    import express from "express";
//    import { createLivelyDb, livelyIdentity } from "./lively-db.mjs";
//    import * as schema from "./db/schema.mjs";          // node lively-db.mjs gen lively-app.json > db/schema.mjs
//    const { db, batch } = createLivelyDb({ schema });     // 환경변수 LIVELY_API_URL · LIVELY_APP_TOKEN
//    const app = express();
//    app.use(livelyIdentity());                            // 들어온 요청의 사람 신원(X-Lively-Identity)을 그 요청의 DB 호출에 싣는다
//    app.get("/api/contacts", async (_req, res) => res.json(await db.select().from(schema.contacts)));
//    app.get("/api/me", (req, res) => res.json(livelyMember(req)));   // 이 요청의 사람 {id, name, variant}(한글 id · 이름도 풀어서)
//
//  규칙(게이트웨이가 지킨다 — 어기면 오류 문구가 대신 쓸 길을 말한다):
//   · 표·칸·제약은 매니페스트(lively-app.json data.tables)로만 만든다. SQL 로 CREATE/ALTER 하지 않는다.
//   · 여러 쓰기를 «전부 되거나 전부 취소» 로 하려면 batch([...]) — 대화형 트랜잭션(db.transaction)은 없다.
//   · 한 번에 5,000행 · 5MB 까지 — 넘으면 오류(413)다(.limit()·.offset() 으로 나눠 읽는다). 문장 5초.
//   · 오류: Drizzle 은 드라이버 오류를 DrizzleQueryError("Failed query: …") 로 감싼다. 게이트웨이가 준 안내(무엇 대신 무엇을 쓸지)는
//     그 안의 cause 에 있다 — livelyErrorOf(err) 로 꺼낸다: `catch (e) { const le = livelyErrorOf(e); res.status(le?.status ?? 500).json({ error: le?.message ?? String(e) }) }`
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";

export const LIVELY_DB_SDK_VERSION = "1";
const IDENTITY_HEADER = "x-lively-identity";

/** 게이트웨이가 거절한 호출 — status · body(게이트웨이 JSON) · index(묶음에서 몇 번째 문장인지, 0부터). */
export class LivelyDbError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "LivelyDbError";
    this.status = status ?? 0;
    this.body = body ?? null;
    this.index = typeof body?.index === "number" ? body.index : undefined;
  }
}

// ── 사람 신원 — 요청마다 ─────────────────────────────────────────────────────────────────
//  앞단(라이블리)이 앱 서버로 보낸 요청에는 서명된 사람 신원(X-Lively-Identity)이 붙어 온다. 게이트웨이는 «앱 서버 토큰 + 그 신원»
//  일 때만 그 사람 ∩ 그 사람의 앱 동의로 SQL 을 돌린다(토큰만으로는 아무것도 못 한다). 그래서 요청마다 신원을 이어 붙인다.
const identityStore = new AsyncLocalStorage();

/** Express·Connect 미들웨어 — 그 요청 안의 DB 호출이 들어온 신원을 싣게 한다. */
export function livelyIdentity() {
  return (req, _res, next) => {
    const h = req?.headers?.[IDENTITY_HEADER];
    identityStore.run({ identity: Array.isArray(h) ? h[0] : h }, next);
  };
}

/**
 * 이 요청의 사람 — 앱 서버 함수 앞의 검사 층(#4485)이 신원을 검사한 뒤 붙인 머리글을 풀어 준다: {id, name, variant}. 없으면 null.
 *  x-lively-member(구성원 id) · x-lively-member-name(이름)은 퍼센트 인코딩이다(한글 id «윤상민» 도 머리글에 실리게) — 그대로 쓰지 말고 이것으로 읽는다.
 *  ⚠ 라이블리 앱 서버 함수 안에서만 믿을 수 있다(검사 층이 들어온 같은 이름 머리글을 지우고 다시 쓴다). 그 밖에서 돌리면 누구나 이 머리글을 붙일 수 있다.
 */
export function livelyMember(req) {
  const h = req?.headers ?? {};
  //  Node(Express) 는 머리글 객체 · Fetch API(Next 앱 라우터 · Hono · Lambda 핸들러의 Request)는 Headers(get) — 둘 다 읽는다.
  const one = typeof h.get === "function"
    ? (k) => { const v = h.get(k); return typeof v === "string" ? v.split(",")[0].trim() : null; }
    : (k) => { const v = Array.isArray(h[k]) ? h[k][0] : h[k]; return typeof v === "string" ? v : null; };
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const id = one("x-lively-member");
  if (!id) return null;
  return { id: dec(id), name: dec(one("x-lively-member-name") ?? ""), variant: one("x-lively-variant") === "draft" ? "draft" : "pub" };
}

/** 미들웨어를 못 쓰는 곳(Next 라우트 · Lambda 핸들러 · 백그라운드)에서 — fn 안의 DB 호출이 그 신원을 싣는다.
 *  ⚠ Drizzle 쿼리는 await 할 때 비로소 실행된다 — 그래서 fn 의 결과를 **이 안에서** 기다린다(밖에서 await 하면 신원 문맥이 이미
 *   끝나 신원 없이 나간다). 늘 Promise 를 돌려준다. */
export function withIdentity(identity, fn) {
  return identityStore.run({ identity: identity ?? undefined }, async () => await fn());
}

/** 잡은 오류에서 게이트웨이 오류(LivelyDbError)를 꺼낸다 — Drizzle 이 감싼 것(err.cause)도. 아니면 null. */
export function livelyErrorOf(err) {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) if (e instanceof LivelyDbError) return e;
  return null;
}

// ── 값 — 보낼 때 ─────────────────────────────────────────────────────────────────────────
/** JSON 으로 못 가거나 뜻이 바뀌는 값을 Postgres 글자로(node-postgres 가 보내는 것과 같은 뜻). */
export function encodeParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? v : (Number.isNaN(v) ? "NaN" : (v > 0 ? "Infinity" : "-Infinity"));
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return "\\x" + Buffer.from(v).toString("hex");
  if (Array.isArray(v)) return v.map(encodeParam);
  return v;
}

// ── 값 — 받을 때(node-postgres 기본 해석 + Drizzle 가 글자로 받는 형) ──────────────────────────
//  게이트웨이는 값을 DB 글자 그대로 보내고(형 OID 와 함께) 여기서 node-postgres 와 똑같이 해석한다 — 날짜·numeric·int8·NaN 이
//  JSON 을 지나며 바뀌지 않는다. Drizzle 의 node-postgres 드라이버처럼 date·timestamp·timestamptz·interval(과 그 배열)·numeric[] 은
//  글자 그대로 두고 Drizzle 칸이 바꾼다.
const ident = (v) => v;
const int = (v) => parseInt(v, 10);
const float = (v) => parseFloat(v);
const bool = (v) => v === "TRUE" || v === "t" || v === "true" || v === "y" || v === "yes" || v === "on" || v === "1";
const json = (v) => JSON.parse(v);
function bytea(v) {
  if (v.startsWith("\\x")) return Buffer.from(v.slice(2), "hex");
  // 옛 escape 형식(bytea_output=escape) — \ooo 와 \\
  const out = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== "\\") { out.push(v.charCodeAt(i)); continue; }
    if (v[i + 1] === "\\") { out.push(0x5c); i++; continue; }
    out.push(parseInt(v.slice(i + 1, i + 4), 8)); i += 3;
  }
  return Buffer.from(out);
}

/** Postgres 배열 글자(`{a,"b,c",NULL,{1,2}}`) → JS 배열. 원소는 el 로 해석, 따옴표 없는 NULL 은 null. */
export function parsePgArray(text, el = ident) {
  let i = 0;
  if (text[0] === "[") i = text.indexOf("=") + 1;                   // [1:2]={…} 차원 표기
  const fail = () => { throw new Error(`Postgres 배열 모양이 아닙니다: ${text.slice(0, 80)}`); };
  function list() {
    if (text[i] !== "{") fail();
    i++;
    const out = [];
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      if (text[i] === "{") out.push(list());
      else if (text[i] === "\"") {
        i++;
        let s = "";
        while (i < text.length && text[i] !== "\"") { if (text[i] === "\\") i++; s += text[i++]; }
        if (text[i] !== "\"") fail();
        i++;
        out.push(el(s));
      } else {
        let s = "";
        while (i < text.length && text[i] !== "," && text[i] !== "}") s += text[i++];
        out.push(s === "NULL" ? null : el(s));
      }
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      fail();
    }
  }
  return list();
}
const arr = (el) => (v) => parsePgArray(v, el);

/** 형 OID → 해석 함수(없으면 글자 그대로 — numeric · uuid · text · 열거형 · inet …). */
export const TYPE_PARSERS = {
  16: bool, 17: bytea, 20: ident, 21: int, 23: int, 26: int, 700: float, 701: float, 114: json, 3802: json,
  1082: ident, 1114: ident, 1184: ident, 1186: ident,
  1000: arr(bool), 1001: arr(bytea), 1005: arr(int), 1007: arr(int), 1028: arr(int), 1016: arr(ident), 1021: arr(float), 1022: arr(float),
  1231: ident, 1115: ident, 1182: ident, 1185: ident, 1187: ident,
  651: arr(ident), 791: arr(ident), 1008: arr(ident), 1009: arr(ident), 1014: arr(ident), 1015: arr(ident), 1040: arr(ident), 1041: arr(ident),
  1183: arr(ident), 1270: arr(ident), 2951: arr(ident), 3907: arr(ident),
  199: arr(json), 3807: arr(json),
};

/** wire 결과 → 배열 행(Drizzle 'all' — 칸 위치로 읽는다). */
export function decodeRows(r) {
  const ps = (r.fields ?? []).map((f) => TYPE_PARSERS[f.type] ?? ident);
  return (r.rows ?? []).map((row) => row.map((v, i) => (v === null ? null : ps[i](v))));
}

/** wire 결과 → 객체 행(Drizzle 'execute' · db.execute(sql)). 같은 이름이 겹치면 뒤 칸이 이긴다(node-postgres 와 같다).
 *  쓰기면 rowCount(바뀐 행 수)·command 를 배열에 붙인다 — node-postgres 의 결과처럼 res.rowCount 로 읽는다. */
export function decodeObjects(r, kind) {
  const names = (r.fields ?? []).map((f) => f.name);
  const rows = decodeRows(r).map((vals) => { const o = {}; names.forEach((n, i) => { o[n] = vals[i]; }); return o; });
  Object.assign(rows, { rowCount: r.changed ?? r.row_count ?? rows.length });
  if (kind) Object.assign(rows, { command: String(kind).toUpperCase() });
  return rows;
}

// ── 클라이언트 ──────────────────────────────────────────────────────────────────────────
const batchStore = new AsyncLocalStorage();

/**
 * opts: url(기본 LIVELY_API_URL) · token(기본 LIVELY_APP_TOKEN) · appId(앱이 붙은 세션 토큰일 때만) · schema · logger · casing
 *  · fetch(시험 주입) · identity(() => 신원 — 미들웨어 대신). 반환 { db, batch }.
 */
export function createLivelyDb(opts = {}) {
  const env = typeof process !== "undefined" ? process.env : {};
  const url = String(opts.url ?? env.LIVELY_API_URL ?? "").replace(/\/+$/, "");
  const token = opts.token ?? env.LIVELY_APP_TOKEN;
  const appId = opts.appId ?? env.LIVELY_APP_ID;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!url) throw new Error("라이블리 주소가 없습니다 — LIVELY_API_URL 환경변수(또는 createLivelyDb({ url }))를 주세요");
  if (!token) throw new Error("앱 토큰이 없습니다 — LIVELY_APP_TOKEN 환경변수(또는 createLivelyDb({ token }))를 주세요");

  async function call(path, body) {
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const identity = opts.identity ? opts.identity() : identityStore.getStore()?.identity;
    if (identity) headers[IDENTITY_HEADER] = identity;
    let res;
    try {
      res = await fetchImpl(url + path, { method: "POST", headers, body: JSON.stringify({ ...body, ...(appId ? { app_id: appId } : {}), format: "wire", strict: true }) });
    } catch (e) {
      throw new LivelyDbError(`라이블리에 닿지 못했습니다(${url}) — ${e?.message ?? e}`, { status: 0 });
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 500) }; }
    if (!res.ok) throw new LivelyDbError(String(data?.error ?? data?.message ?? `HTTP ${res.status}`), { status: res.status, body: data });
    return data;
  }

  // Drizzle pg-proxy 콜백 — method 'all' = 배열 행(칸 위치로 매핑), 'execute' = 객체 행. 묶음 중이면 보내지 않고 모은다.
  async function proxy(sql, params, method) {
    const b = batchStore.getStore();
    if (b) return new Promise((resolve, reject) => b.collect({ sql, params, method, resolve, reject }));
    const r = await call("/api/ui/store/sql", { sql, params: params.map(encodeParam) });
    return { rows: method === "all" ? decodeRows(r) : decodeObjects(r, r.kind) };
  }

  const db = drizzle(proxy, { schema: opts.schema, logger: opts.logger, casing: opts.casing });

  /**
   * 묶음 — Drizzle 쿼리 여러 개를 한 트랜잭션으로(전부 되거나 전부 취소). 결과는 각 쿼리를 따로 await 한 것과 같은 모양.
   *  예: const [order, _] = await batch([db.insert(orders).values(o).returning(), db.update(stock).set(...).where(...)]);
   *  대화형이 아니다 — 앞 쿼리의 결과를 뒤 쿼리에 넣을 수 없다(필요하면 한 문장 안에서 서브쿼리로).
   *  실패하면 LivelyDbError(.index = 몇 번째 쿼리인지).
   */
  async function batch(queries) {
    if (!Array.isArray(queries) || !queries.length) return [];
    const slots = new Array(queries.length);
    let seen = 0;
    let allIn;
    const collected = new Promise((resolve) => { allIn = resolve; });
    const runs = queries.map((q, i) => batchStore.run({
      collect: (slot) => { if (!slots[i]) { slots[i] = slot; if (++seen === queries.length) allIn(); } },
    }, () => (typeof q?.execute === "function" ? q.execute() : Promise.reject(new LivelyDbError(`묶음의 ${i + 1}번째가 Drizzle 쿼리가 아닙니다`, { status: 0 })))));
    let timeout;
    const timer = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new LivelyDbError("묶음의 쿼리가 SQL 을 만들지 않았습니다(Drizzle 쿼리만 넣으세요)", { status: 0 })), 2000);
    });
    timer.catch(() => {});
    //  Promise.race(runs) 는 쿼리 약속 전부를 구독한다 — 그래서 어느 실패 경로에서도 «처리 안 된 거절» 로 프로세스가 죽지 않는다(S7).
    try { await Promise.race([collected, timer, Promise.race(runs).then(() => undefined, (e) => { throw e; })]); }
    catch (e) { for (const s of slots) s?.reject(e); throw e; }
    finally { clearTimeout(timeout); }
    let res;
    try {
      res = await call("/api/ui/store/sql/batch", { statements: slots.map((s) => ({ sql: s.sql, params: s.params.map(encodeParam) })) });
    } catch (e) {
      for (const s of slots) s.reject(e);
      await Promise.allSettled(runs);
      throw e;
    }
    res.results.forEach((r, i) => slots[i].resolve({ rows: slots[i].method === "all" ? decodeRows(r) : decodeObjects(r, r.kind) }));
    return Promise.all(runs);
  }

  return { db, batch };
}

// ── 매니페스트 → Drizzle 스키마(소스 글자) ──────────────────────────────────────────────────
//  표·칸·제약은 매니페스트가 정본이다. Drizzle 스키마를 손으로 따로 쓰면 둘이 어긋난다(예: 매니페스트 timestamp 는
//  timestamptz 인데 Drizzle timestamp() 는 시간대 없는 형이라 날짜가 깨진다). 그래서 매니페스트에서 만든다:
//    node lively-db.mjs gen lively-app.json > db/schema.mjs
//  만든 파일은 JS 로도 TS 로도 그대로 쓴다(형 주석이 없다). 표마다 id(bigint) · created_at(timestamptz) 이 저절로 붙는다.
const camel = (s) => s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

function columnSource(c) {
  const t = String(c.type).trim().toLowerCase().replace(/\s+/g, " ");
  const isArray = t.endsWith("[]");
  const base = isArray ? t.slice(0, -2).trim() : t;
  const n = JSON.stringify(c.name);
  let src;
  const num = /^(numeric|decimal) ?(?:\( ?(\d+) ?(?:, ?(\d+) ?)?\))?$/.exec(base);
  const vc = /^varchar ?\( ?(\d+) ?\)$/.exec(base);
  if (num) src = num[2] !== undefined ? `numeric(${n}, { precision: ${num[2]}, scale: ${num[3] ?? 0} })` : `numeric(${n})`;
  else if (vc) src = `varchar(${n}, { length: ${vc[1]} })`;
  else {
    const M = {
      text: `text(${n})`, int: `bigint(${n}, { mode: "number" })`, integer: `bigint(${n}, { mode: "number" })`, bigint: `bigint(${n}, { mode: "number" })`,
      int8: `bigint(${n}, { mode: "number" })`, int4: `integer(${n})`, smallint: `smallint(${n})`, int2: `smallint(${n})`,
      float: `doublePrecision(${n})`, number: `doublePrecision(${n})`, double: `doublePrecision(${n})`, float8: `doublePrecision(${n})`, "double precision": `doublePrecision(${n})`,
      real: `real(${n})`, float4: `real(${n})`, bool: `boolean(${n})`, boolean: `boolean(${n})`,
      timestamp: `timestamp(${n}, { withTimezone: true })`, timestamptz: `timestamp(${n}, { withTimezone: true })`, date: `date(${n}, { mode: "string" })`,
      time: `time(${n})`, timetz: `time(${n}, { withTimezone: true })`, interval: `interval(${n})`, json: `jsonb(${n})`, jsonb: `jsonb(${n})`, uuid: `uuid(${n})`,
      bytea: `bytea(${n})`, bytes: `bytea(${n})`, inet: `inet(${n})`, cidr: `cidr(${n})`, varchar: `varchar(${n})`,
      enum: `text(${n}, { enum: ${JSON.stringify(c.values ?? [])} })`,
    };
    src = M[base];
    if (!src) throw new Error(`이 SDK 가 모르는 칸 타입입니다: ${c.type}`);
  }
  if (isArray) src += ".array()";
  if (c.not_null) src += ".notNull()";
  if (c.unique) src += ".unique()";
  const de = String(c.default_expr ?? "").toLowerCase();
  const dateLike = !isArray && ["timestamp", "timestamptz", "date", "time", "timetz"].includes(base);
  if ((de === "now()" || de === "current_timestamp") && dateLike) src += ".defaultNow()";
  else if (de === "gen_random_uuid()" && !isArray && base === "uuid") src += ".defaultRandom()";
  else if (de) src += `.default(sql\`${{ "now()": "now()", current_timestamp: "CURRENT_TIMESTAMP", current_date: "CURRENT_DATE", "gen_random_uuid()": "gen_random_uuid()" }[de] ?? "NULL"}\`)`;
  else if (c.default !== undefined && c.default !== null) src += `.default(${JSON.stringify(c.default)})`;
  return src;
}

/** 매니페스트(JSON 객체) → Drizzle 스키마 소스. 외래키(references)는 칸 .references() 와 관계(relations)로 — 관계 조회(db.query)가 된다. */
export function generateDrizzleSchema(manifest) {
  const tables = manifest?.data?.tables ?? [];
  const used = new Set(["pgTable", "bigint", "timestamp"]);
  for (const t of tables) for (const c of t.columns ?? []) {
    const m = /^([a-z0-9 ]+?)(?:\(.*\))?(\[\])?$/.exec(String(c.type).trim().toLowerCase());
    const b = m ? m[1].trim() : "";
    const name = { int: "bigint", integer: "bigint", int8: "bigint", int4: "integer", int2: "smallint", float: "doublePrecision", number: "doublePrecision",
      double: "doublePrecision", float8: "doublePrecision", "double precision": "doublePrecision", float4: "real", bool: "boolean", timestamptz: "timestamp",
      json: "jsonb", bytes: "bytea", enum: "text", decimal: "numeric", timetz: "time" }[b] ?? b;
    used.add(name);
  }
  const needsSql = tables.some((t) => (t.columns ?? []).some((c) => columnSource(c).includes(".default(sql`")));
  const hasBytea = used.delete("bytea");
  const lines = [
    "// 이 파일은 lively-db.mjs gen 이 매니페스트(lively-app.json)에서 만들었습니다 — 손으로 고치지 말고 매니페스트를 고친 뒤 다시 만드세요.",
    `import { ${[...used].sort().join(", ")}${hasBytea ? ", customType" : ""} } from "drizzle-orm/pg-core";`,
    `import { relations${needsSql ? ", sql" : ""} } from "drizzle-orm";`,
  ];
  if (hasBytea) lines.push('const bytea = customType({ dataType() { return "bytea"; } });');
  const refs = [];
  for (const t of tables) {
    const v = camel(t.name);
    lines.push("", `export const ${v} = pgTable(${JSON.stringify(t.name)}, {`);
    lines.push('  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),');
    for (const c of t.columns ?? []) {
      let src = columnSource(c);
      if (c.references) {
        const od = c.references.on_delete ? `, { onDelete: ${JSON.stringify(c.references.on_delete)} }` : "";
        src += `.references(() => ${camel(c.references.table)}.id${od})`;
        refs.push({ child: v, parent: camel(c.references.table), col: camel(c.name), name: camel(c.name.replace(/_id$/, "")) });
      }
      lines.push(`  ${camel(c.name)}: ${src},`);
    }
    lines.push('  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),', "});");
  }
  //  관계 — 자식 쪽 one(칸 이름에서 _id 를 뗀 이름) · 부모 쪽 many(자식 표 이름).
  const byTable = new Map();
  for (const r of refs) {
    if (!byTable.has(r.child)) byTable.set(r.child, []);
    byTable.get(r.child).push(`${r.name}: one(${r.parent}, { fields: [${r.child}.${r.col}], references: [${r.parent}.id] })`);
    if (!byTable.has(r.parent)) byTable.set(r.parent, []);
    byTable.get(r.parent).push(`${r.child}: many(${r.child})`);
  }
  for (const [t, entries] of byTable) {
    lines.push("", `export const ${t}Relations = relations(${t}, ({ one, many }) => ({`, ...[...new Set(entries)].map((e) => `  ${e},`), "}));");
  }
  return lines.join("\n") + "\n";
}

// ── 명령 줄: node lively-db.mjs gen lively-app.json ─────────────────────────────────────────
if (typeof process !== "undefined" && process.argv?.[2] === "gen" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import("node:fs");
  process.stdout.write(generateDrizzleSchema(JSON.parse(readFileSync(process.argv[3] ?? "lively-app.json", "utf8"))));
}
