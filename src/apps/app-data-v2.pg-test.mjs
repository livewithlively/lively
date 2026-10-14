// 앱 데이터 v2(#4483) PG 통합 테스트 — 칸 타입 · 제약 · 구조 변경. **실제 Postgres 필요**(CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-data-v2.pg-test.mjs
//
// 매니지드와 같은 역할 구조(런타임 · 앱 DDL+CREATEROLE)를 세우고 매니페스트 선언 → ensureAppTables → 앱 SQL(앱 역할)로 잰다.
//  T1 새 타입 — format_type 이 선언 이름(canonical)과 같다 · 값이 형 그대로 오간다(numeric 정확 · varchar 길이 · 배열 · interval · bytea · inet)
//  T2 제약 — not_null · default(값·식) · unique · check · enum 값 목록 · 외래키(cascade · set null · 고아 거부)
//  T3 테넌트를 넘는 외래키는 걸리지 않는다((tenant_id, 칸) → (tenant_id, id))
//  T4 구조 변경 — 이름 바꾸기(값 그대로) · 무손실 변환 · 손실 변환 거절(그대로 · 알림) · drop_columns(값은 보관) · 선언에 없는 칸은 제약만 푼다
//  T5 있던 데이터가 새 제약에 어긋나면 409(몇 행인지) · 그 표의 다른 변경도 함께 되돌린다(한 트랜잭션)
//  T6 검사 식 — 위험 함수 · 다른 표 · 없는 칸 · 파라미터는 400(표를 건드리기 전)
//  T7 같은 선언으로 다시 — 아무것도 안 바뀐다(멱등)
import pg from "pg";

const SUPER = process.env.ITEMS_DATABASE_URL;
if (!SUPER) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }

const RT = "pgt4483_app", DDL = "pgt4483_appddl";
const PW = { [RT]: "rt_pw_4483", [DDL]: "ddl_pw_4483" };
const TA = "6f477586-8eed-4e75-a321-3a1f0c9d2e41";
const TB = "7a588697-9ffe-4f86-b432-4b2a1dae3f52";
const dsnAs = (user) => { const u = new URL(SUPER); u.username = user; u.password = PW[user]; return u.toString(); };
const su = new pg.Client({ connectionString: SUPER });
await su.connect();
const dbName = (await su.query("SELECT current_database() AS d")).rows[0].d;
const SA = `app_${TA.replace(/-/g, "")}`;

async function dropAll() {
  for (const suf of ["", "_archive"]) await su.query(`DROP SCHEMA IF EXISTS "${SA}${suf}" CASCADE`);
  const appRoles = (await su.query(
    `SELECT r.rolname FROM pg_roles r JOIN pg_auth_members am ON am.roleid = r.oid JOIN pg_roles m ON m.oid = am.member
      WHERE m.rolname = ANY($1) AND r.rolname LIKE 'lvly\\_appsql\\_%'`, [[RT, DDL]])).rows.map((r) => r.rolname);
  for (const r of [...new Set(appRoles)]) { await su.query(`DROP OWNED BY "${r}" CASCADE`).catch(() => {}); await su.query(`DROP ROLE IF EXISTS "${r}"`); }
  for (const r of [RT, DDL]) {
    if ((await su.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [r])).rowCount) { await su.query(`DROP OWNED BY "${r}" CASCADE`); await su.query(`DROP ROLE "${r}"`); }
  }
}
await dropAll();
await su.query(`CREATE ROLE "${RT}" LOGIN PASSWORD '${PW[RT]}'`);
await su.query(`CREATE ROLE "${DDL}" LOGIN CREATEROLE PASSWORD '${PW[DDL]}'`);
await su.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${RT}", "${DDL}"`);
await su.query(`GRANT CREATE ON DATABASE "${dbName}" TO "${DDL}"`);

process.env.ITEMS_DATABASE_URL = dsnAs(RT);
process.env.LIVELY_APP_DB_ROLE = RT;
process.env.LIVELY_APP_DDL_DATABASE_URL = dsnAs(DDL);
delete process.env.LIVELY_OWNER_DATABASE_URL;
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { ensureAppTables, emptyTableReport } = await import(`${DIST}/apps/store-schema.js`);
const { appSqlRoleName, parseColumnType } = await import(`${DIST}/apps/store-ddl.js`);
const { planAppSql } = await import(`${DIST}/apps/app-sql.js`);
const X = await import(`${DIST}/apps/app-sql-exec.js`);
const { itemsPool } = await import(`${DIST}/db/client.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

let tablesNow = [];
const ensure = async (tables, o = {}) => {
  const report = emptyTableReport();
  await ensureAppTables("crm", tables, { schema: SA, strict: true, sqlRole: true, report, ...o });
  tablesNow = tables.map((t) => t.table);
  return report;
};
const run = async (sql, params = [], o = {}) => {
  const plan = await planAppSql(sql, { appId: "crm", schema: SA, tables: o.tables ?? tablesNow });
  return X.runAppSql({ plan, params, role: appSqlRoleName(dbName, SA, "crm"), appId: "crm", schema: SA, physicalPrefix: "crm__", tenantId: o.tenant ?? TA, format: o.format });
};
const cols = async (t) => Object.fromEntries((await su.query(
  `SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t, a.attnotnull AS nn FROM pg_attribute a
    WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`, [`"${SA}"."crm__${t}"`])).rows.map((r) => [r.n, { t: r.t, nn: r.nn }]));

try {
  X.resetAppSqlLimits({ ...process.env });

  // ── T1 새 타입 ──
  {
    const TYPES = ["text", "int", "bigint", "int4", "smallint", "real", "double", "float", "numeric", "numeric(12,2)", "decimal(5)", "varchar(5)", "varchar",
      "bool", "timestamp", "date", "time", "timetz", "interval", "json", "uuid", "bytea", "inet", "cidr", "text[]", "int4[]", "numeric(10,2)[]", "uuid[]", "jsonb[]"];
    const name = (t) => "c_" + t.replace("[]", "_arr").replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
    const rep = await ensure([{ table: "types", columns: TYPES.map((t) => ({ name: name(t), type: t })) }]);
    const actual = await cols("types");
    const wrong = TYPES.filter((t) => actual[name(t)]?.t !== parseColumnType(t).canonical).map((t) => `${t}: ${actual[name(t)]?.t} ≠ ${parseColumnType(t).canonical}`);
    chk("T1 새 타입 표 생성 · format_type 이 선언의 canonical 과 같다(다시 설치해도 «타입 다름» 이 안 생긴다)", rep.created.join() === "types" && wrong.length === 0, JSON.stringify(wrong));
    const again = await ensure([{ table: "types", columns: TYPES.map((t) => ({ name: name(t), type: t })) }]);
    chk("T1b 같은 선언 다시 — 변환·불일치·추가 0", again.type_mismatches.length === 0 && again.converted_columns.length === 0 && again.added_columns.length === 0, JSON.stringify(again));
    await run(`INSERT INTO types(c_numeric_12_2, c_varchar_5, c_interval, c_bytea, c_inet, c_text_arr, c_int4_arr, c_numeric_10_2_arr) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ["1234567890.25", "abcde", "1 day 02:03:04", "\\x0102ff", "10.1.2.3", ["a", "b,c", "d\"e"], [1, 2], ["1.10", "2.20"]]);
    const w = await run("SELECT c_numeric_12_2, c_varchar_5, c_interval, c_bytea, c_inet, c_text_arr, c_int4_arr, c_numeric_10_2_arr FROM types", [], { format: "wire" });
    const r = w.rows[0];
    chk("T1c 값이 형 그대로 — numeric 소수 둘째 자리까지 정확 · interval · bytea · inet · 배열(쉼표·따옴표 원소)",
      r[0] === "1234567890.25" && r[1] === "abcde" && r[2] === "1 day 02:03:04" && r[3] === "\\x0102ff" && r[4] === "10.1.2.3" && r[5] === '{a,"b,c","d\\"e"}' && r[6] === "{1,2}" && r[7] === "{1.10,2.20}",
      JSON.stringify(r));
    const long = await errOf(run("INSERT INTO types(c_varchar_5) VALUES ('abcdef')"));
    const scale = await run("INSERT INTO types(c_numeric_12_2) VALUES (1.005) RETURNING c_numeric_12_2", [], { format: "wire" });
    chk("T1d varchar(5) 에 6자는 400(22001) · numeric(12,2) 는 둘째 자리로 반올림", long?.status === 400 && /long|길/.test(long?.message ?? "") && scale.rows[0][0] === "1.01", JSON.stringify({ st: long?.status, m: long?.message, s: scale.rows }));
  }

  // ── T2 제약 ──
  {
    const tables = [
      { table: "contacts", columns: [
        { name: "name", type: "text", not_null: true },
        { name: "email", type: "varchar(200)", unique: true },
        { name: "stage", type: "enum", values: ["lead", "customer", "lost"], default: "lead", not_null: true },
        { name: "score", type: "int4", default: 0, check: "score >= 0 AND score <= 100" },
        { name: "tags", type: "text[]", default: ["new"] },
        { name: "meta", type: "jsonb", default: { src: "app" } },
        { name: "ref", type: "uuid", default_expr: "gen_random_uuid()" },
        { name: "seen_at", type: "timestamp", default_expr: "now()" },
      ] },
      { table: "orders", columns: [
        { name: "contact_id", type: "bigint", not_null: true, references: { table: "contacts", on_delete: "cascade" } },
        { name: "amount", type: "numeric(12,2)", not_null: true, check: "amount >= 0" },
        { name: "paid", type: "bool", default: false },
      ], checks: ["NOT paid OR amount > 0"] },
      { table: "notes", columns: [
        { name: "contact_id", type: "int", references: { table: "contacts", on_delete: "set null" } },
        { name: "body", type: "text" },
      ] },
    ];
    const rep = await ensure(tables);
    chk("T2 표 셋 생성 · 제약 보고(not_null·default·check·foreign_key)",
      rep.created.join() === "contacts,orders,notes" && rep.constraints.filter((c) => c.kind === "foreign_key").length === 2
      && rep.constraints.some((c) => c.kind === "check") && rep.constraints.some((c) => c.kind === "not_null"), JSON.stringify(rep.constraints));
    const c1 = await run("INSERT INTO contacts(name, email) VALUES ('가', 'a@x') RETURNING id, stage, score, tags, meta, ref, seen_at", [], { format: "wire" });
    const r = c1.rows[0];
    chk("T2b 기본값 — enum 'lead' · 0 · 배열 · jsonb · gen_random_uuid() · now()",
      r[1] === "lead" && r[2] === "0" && r[3] === "{new}" && r[4] === '{"src": "app"}' && /^[0-9a-f-]{36}$/.test(r[5]) && !!r[6], JSON.stringify(r));
    const cid = Number(r[0]);
    const nn = await errOf(run("INSERT INTO contacts(email) VALUES ('b@x')"));
    const uq = await errOf(run("INSERT INTO contacts(name, email) VALUES ('나', 'a@x')"));
    const ck = await errOf(run("INSERT INTO contacts(name, score) VALUES ('다', 101)"));
    const en = await errOf(run("INSERT INTO contacts(name, stage) VALUES ('라', 'vip')"));
    chk("T2c 위반은 전부 409 — not_null · unique · check · enum 값",
      [nn, uq, ck, en].every((e) => e?.status === 409), JSON.stringify([nn, uq, ck, en].map((e) => [e?.status, e?.body?.pg_code, String(e?.message).slice(0, 80)])));
    const o1 = await run("INSERT INTO orders(contact_id, amount) VALUES ($1, '19.99') RETURNING id", [cid]);
    const orphan = await errOf(run("INSERT INTO orders(contact_id, amount) VALUES (999999, 1)"));
    const neg = await errOf(run("INSERT INTO orders(contact_id, amount) VALUES ($1, -1)", [cid]));
    const paid0 = await errOf(run("INSERT INTO orders(contact_id, amount, paid) VALUES ($1, 0, true)", [cid]));
    await run("INSERT INTO notes(contact_id, body) VALUES ($1, '메모')", [cid]);
    chk("T2d 외래키 — 있는 id 는 된다 · 없는 id 409(23503) · 칸 check · 표 checks(여러 칸)",
      o1.changed === 1 && orphan?.status === 409 && orphan?.body?.pg_code === "23503" && neg?.status === 409 && paid0?.status === 409,
      JSON.stringify([orphan, neg, paid0].map((e) => [e?.status, e?.body?.pg_code])));
    await run("DELETE FROM contacts WHERE id = $1", [cid]);
    const ords = (await run("SELECT count(*)::int AS n FROM orders")).rows[0].n;
    const nts = (await run("SELECT contact_id, body FROM notes")).rows;
    chk("T2e 앱 역할로 지우면 — orders 는 cascade 로 사라지고 notes 는 contact_id 만 NULL(set null)", ords === 0 && nts.length === 1 && nts[0].contact_id === null && nts[0].body === "메모", JSON.stringify({ ords, nts }));
    const fkdef = (await su.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'f'`, [`"${SA}"."crm__notes"`])).rows[0]?.d ?? "";
    chk("T2f 외래키는 (tenant_id, 칸) → (tenant_id, id) · set null 은 그 칸만", /FOREIGN KEY \(tenant_id, contact_id\) REFERENCES .*\(tenant_id, id\) ON DELETE SET NULL \(contact_id\)/.test(fkdef), fkdef);
  }

  // ── T3 테넌트를 넘는 외래키 ──
  {
    const b = await run("INSERT INTO contacts(name) VALUES ('B사람') RETURNING id", [], { tenant: TB });
    const bid = Number(b.rows[0].id);
    const cross = await errOf(run("INSERT INTO orders(contact_id, amount) VALUES ($1, 1)", [bid], { tenant: TA }));
    chk("T3 A 워크스페이스 행이 B 의 contacts id 를 가리킬 수 없다(23503)", cross?.status === 409 && cross?.body?.pg_code === "23503", JSON.stringify([cross?.status, cross?.body]));
    await run("DELETE FROM contacts WHERE id = $1", [bid], { tenant: TB });
  }

  // ── T4 구조 변경 ──
  {
    await ensure([{ table: "people", columns: [
      { name: "nick", type: "text" }, { name: "age_txt", type: "text" }, { name: "zip", type: "text" }, { name: "price", type: "numeric(8,2)" },
      { name: "old_note", type: "text", not_null: true, default: "x" }, { name: "empty_col", type: "text" }, { name: "keep_me", type: "text", not_null: true, default: "k" },
    ] }]);
    await run("INSERT INTO people(nick, age_txt, zip, price, old_note) VALUES ('kim', '42', '01234', 12.34, '보관할 값'), ('lee', '7', '99999', 1.5, 'y')");
    const rep = await ensure([{ table: "people", columns: [
      { name: "handle", type: "text", renamed_from: "nick" },          // 이름 바꾸기
      { name: "age_txt", type: "int4" },                                // 무손실 변환('42','7')
      { name: "zip", type: "int4" },                                    // 손실 변환('01234' → 1234 → '1234') — 거절
      { name: "price", type: "numeric(12,2)" },                         // 넓히기 — 무손실
    ], drop_columns: ["old_note", "empty_col"] }]);                     // keep_me 는 선언에서 빠짐 — 그대로 · NOT NULL 풀기
    const c = await cols("people");
    const arch = rep.dropped_columns.find((d) => d.column === "old_note")?.archived_as;
    const saved = arch ? (await su.query(`SELECT value FROM ${arch.split(".").map((x) => `"${x}"`).join(".")} ORDER BY id`)).rows.map((x) => x.value) : [];
    chk("T4 이름 바꾸기 — 값 그대로", rep.renamed_columns.length === 1 && (await run("SELECT handle FROM people ORDER BY id", [], { tables: ["people"] })).rows.map((x) => x.handle).join() === "kim,lee", JSON.stringify(rep.renamed_columns));
    chk("T4b 무손실 변환(text→int4 · numeric(8,2)→numeric(12,2)) · 손실 변환은 거절하고 알린다",
      c.age_txt?.t === "integer" && c.price?.t === "numeric(12,2)" && c.zip?.t === "text"
      && rep.converted_columns.map((x) => x.column).sort().join() === "age_txt,price" && rep.type_mismatches.length === 1 && rep.type_mismatches[0].column === "zip" && /달라집니다/.test(rep.type_mismatches[0].reason),
      JSON.stringify({ c, conv: rep.converted_columns, mm: rep.type_mismatches }));
    chk("T4c drop_columns — 값 있는 칸은 보관 표로((tenant_id, id, value) 2행) 옮기고 지운다 · 빈 칸은 그냥 지운다",
      !c.old_note && !c.empty_col && saved.join() === "보관할 값,y" && rep.dropped_columns.find((d) => d.column === "empty_col")?.archived_as === null,
      JSON.stringify({ dropped: rep.dropped_columns, saved }));
    chk("T4d 선언에서 빠진 칸(keep_me)은 지우지 않고 NOT NULL·기본값만 푼다(알림)",
      c.keep_me && c.keep_me.nn === false && rep.undeclared_columns.some((u) => u.column === "keep_me"), JSON.stringify({ keep: c.keep_me, und: rep.undeclared_columns }));
    const ins = await run("INSERT INTO people(handle, age_txt) VALUES ('park', 30) RETURNING id", [], { tables: ["people"] });
    chk("T4e 바뀐 표에 선언대로 쓴다(빠진 칸 때문에 깨지지 않는다)", ins.changed === 1, JSON.stringify(ins));
  }

  // ── T5 있던 데이터가 새 제약에 어긋나면 — 409 · 그 표 전체 되돌림 ──
  {
    await run("INSERT INTO people(handle) VALUES (NULL)", [], { tables: ["people"] });
    const before = await cols("people");
    const e = await errOf(ensure([{ table: "people", columns: [
      { name: "handle", type: "text", not_null: true },                 // NULL 인 행이 있다 → 409
      { name: "age_txt", type: "int4" }, { name: "zip", type: "text" }, { name: "price", type: "numeric(12,2)" },
      { name: "added_now", type: "text" },                              // 같은 표의 다른 변경 — 함께 되돌아가야 한다
    ] }]));
    const after = await cols("people");
    chk("T5 NOT NULL 을 걸 수 없는 행 → 409 · 몇 행인지 말한다 · 같은 표의 칸 추가도 되돌렸다",
      e?.status === 409 && /NULL.*1개|1개/.test(e?.message ?? "") && !after.added_now && JSON.stringify(after) === JSON.stringify(before),
      JSON.stringify({ st: e?.status, m: e?.message, added: !!after.added_now }));
    const e2 = await errOf(ensure([{ table: "people", columns: [{ name: "handle", type: "text", check: "length(handle) > 3" },
      { name: "age_txt", type: "int4" }, { name: "zip", type: "text" }, { name: "price", type: "numeric(12,2)" }] }]));
    chk("T5b 검사에 어긋나는 행 → 409(몇 행)", e2?.status === 409 && /검사/.test(e2?.message ?? "") && /2개|3개/.test(e2?.message ?? ""), String(e2?.message));
  }

  // ── T6 검사 식 거부 ──
  {
    const base = [{ name: "a", type: "int4" }];
    const bad = async (check) => errOf(ensure([{ table: "chk", columns: [{ ...base[0], check }] }]));
    const r1 = await bad("set_config('role','none',true) = 'x'");
    const r2 = await bad("a > (SELECT count(*) FROM pg_class)");
    const r3 = await bad("b > 0");
    const r4 = await bad("a > 0) OR (true");
    const r5 = await bad("a > $1");
    const made = (await su.query("SELECT to_regclass($1) AS r", [`"${SA}"."crm__chk"`])).rows[0].r;
    chk("T6 검사 식 — 위험 함수 · 다른 표 · 없는 칸 · 괄호 밖으로 새기 · 파라미터는 400, 표는 만들지 않는다",
      [r1, r2, r3, r4, r5].every((e) => e?.status === 400) && made === null,
      JSON.stringify([r1, r2, r3, r4, r5].map((e) => [e?.status, String(e?.message).slice(0, 70)])));
  }

  // ── T7 멱등 ──
  {
    const spec = [{ table: "contacts", columns: [
      { name: "name", type: "text", not_null: true }, { name: "email", type: "varchar(200)", unique: true },
      { name: "stage", type: "enum", values: ["lead", "customer", "lost"], default: "lead", not_null: true },
      { name: "score", type: "int4", default: 0, check: "score >= 0 AND score <= 100" },
      { name: "tags", type: "text[]", default: ["new"] }, { name: "meta", type: "jsonb", default: { src: "app" } },
      { name: "ref", type: "uuid", default_expr: "gen_random_uuid()" }, { name: "seen_at", type: "timestamp", default_expr: "now()" },
    ] }];
    const once = await ensure(spec);
    const twice = await ensure(spec);
    const empty = (r) => r.created.length + r.added_columns.length + r.converted_columns.length + r.renamed_columns.length + r.dropped_columns.length
      + r.constraints.length + r.added_indexes.length + r.type_mismatches.length === 0;
    chk("T7 같은 선언 두 번 — 두 번째는 아무것도 안 바뀐다(기본값 식까지 같게 알아본다)", empty(twice), JSON.stringify({ once: once.constraints, twice }));
  }
} catch (e) {
  fail++; console.error("FAIL (예외)", e);
} finally {
  X.resetAppSqlLimits({ ...process.env });
  await X.closeAppSqlPool();
  await itemsPool.end().catch(() => {});
  await dropAll().catch((e) => console.error("정리 실패", e));
  await su.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
