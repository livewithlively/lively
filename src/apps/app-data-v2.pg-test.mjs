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
//  T8 기본 키 (id) — `GROUP BY id` 뒤 다른 칸 고르기 · 외래키 대상 (tenant_id, id) 유일 키 · 공유 표는 (tenant_id, id) 그대로
//     · 예전 판 표(기본 키 (tenant_id, id) + 그것에 기댄 외래키)는 다음 보장 때 옮긴다 · id 가 겹치면 그대로 둔다
//  T11 #4724 지켜야 할 칸 — 공개 판의 칸은 깨지 않고(지우기·이름·형 바꾸기·조이기는 미룸), 풀기·새 칸은 바로 · 미룬 이름의 새 칸은 안 만든다 ·
//      지킴 없이 다시 보장(공개하기)하면 미룬 것이 다 된다 · 공유 표는 있는 칸 전부를 지킨다 · 초안에서만 생긴 칸은 바로 바뀐다 ·
//      공개 판이 쓰는 표의 새 칸에 기본값 없는 not_null · not_null 칸의 기본값 빼기는 미룬다(옛 코드 INSERT 가 새 칸을 빼고 넣는다) ·
//      D9 미룬 칸(이름 · 형 바꾸기)에 걸린 규칙도 미룸 · D10 같은 값 기본값 새 칸의 unique · 외래키 미룸 · D11 한 트랜잭션 공개(별도 DDL 연결) ·
//      D12 공유 표는 옛 검사를 걷지 않음 · D13 공유 표는 지킬 칸 목록을 줘도 있는 칸 전부를 지킴
//  T12 바뀌는 것 없는 표 보장은 표를 통째로 잠그지 않는다(읽는 사람이 있어도 기다리지 않는다)
//  T10 다른 트랜잭션이 표를 잡고 있으면 표 보장은 잠금 상한(LIVELY_APP_DDL_LOCK_MS) 안에 실패한다 — 멎지 않는다 · 풀리면 된다
//  T9 형 바꾸기 + 검사 — 옛 형을 전제로 한 검사(length(code) > 0)가 걸린 칸도 바꾼다(검사를 먼저 떼고 새 검사를 건다) ·
//     바뀐 형에 맞지 않는 검사를 그대로 두면 503 이 아니라 400 · 그 표는 그대로
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
const { ensureAppTables, emptyTableReport, declaredColumnsOf } = await import(`${DIST}/apps/store-schema.js`);
const { appSqlRoleName, parseColumnType } = await import(`${DIST}/apps/store-ddl.js`);
const { planAppSql } = await import(`${DIST}/apps/app-sql.js`);
const X = await import(`${DIST}/apps/app-sql-exec.js`);
const { itemsPool } = await import(`${DIST}/db/client.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

let tablesNow = [];
let g1 = null, dupOut = null, t9 = null;
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

  // ── T8 기본 키 ──
  {
    const rel = (t) => `"${SA}"."${t}"`;
    const defs = async (t, type) => (await su.query(
      `SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = $2 ORDER BY conname`, [rel(t), type])).rows;
    const pkOf = async (t) => (await defs(t, "p"))[0]?.d;
    const spec = [{ table: "guests", columns: [{ name: "name", type: "text" }] },
      { table: "stays", columns: [{ name: "guest_id", type: "bigint", references: { table: "guests" } }, { name: "note", type: "text" }] }];
    const groupBy = "SELECT p.name, count(v.id)::int AS n FROM guests p LEFT JOIN stays v ON v.guest_id = p.id GROUP BY p.id ORDER BY p.id";
    const rep = await ensure(spec);
    await run("INSERT INTO guests(name) VALUES ('가'), ('나')");
    await run("INSERT INTO stays(guest_id, note) SELECT id, '첫' FROM guests");
    await run("INSERT INTO stays(guest_id, note) SELECT id, '둘' FROM guests WHERE name = '가'");
    const g = await errOf(run(groupBy).then((r) => { g1 = r; }));
    chk("T8 PK1 새 설치 앱 표 기본 키 = (id) · GROUP BY p.id 뒤 p.name 을 고를 수 있다",
      (await pkOf("crm__guests")) === "PRIMARY KEY (id)" && (await pkOf("crm__stays")) === "PRIMARY KEY (id)" && g === null
        && JSON.stringify(g1?.rows) === JSON.stringify([{ name: "가", n: 2 }, { name: "나", n: 1 }]),
      JSON.stringify({ pk: await pkOf("crm__guests"), g: g?.message, rows: g1?.rows }));
    const uq = await defs("crm__guests", "u");
    chk("T8 PK5 외래키가 가리키는 표엔 (tenant_id, id) 유일 키 · 보고서에 unique added · 가리키지 않는 표엔 없다",
      uq.length === 1 && uq[0].d === "UNIQUE (tenant_id, id)" && uq[0].n.startsWith("lvuq_") && (await defs("crm__stays", "u")).length === 0
        && rep.constraints.some((c) => c.table === "guests" && c.kind === "unique" && c.action === "added"),
      JSON.stringify({ uq, c: rep.constraints }));

    await ensureAppTables("pgtb", [{ table: "marks", columns: [{ name: "u", type: "text" }] }], { schema: SA, strict: true, tenantScopedIndexes: true });
    chk("T8 PK2 공유 표(tenantScoped)는 기본 키 (tenant_id, id) 그대로", (await pkOf("pgtb__marks")) === "PRIMARY KEY (tenant_id, id)", await pkOf("pgtb__marks"));

    // 예전 판 모양으로 되돌린다 — 기본 키 (tenant_id, id) · 외래키는 그 기본 키 인덱스에 기댄다 · lvuq_ 없음
    const fk = (await defs("crm__stays", "f"))[0];
    await su.query(`ALTER TABLE ${rel("crm__stays")} DROP CONSTRAINT "${fk.n}"`);
    await su.query(`ALTER TABLE ${rel("crm__guests")} DROP CONSTRAINT "${uq[0].n}"`);
    for (const t of ["crm__guests", "crm__stays"]) {
      await su.query(`ALTER TABLE ${rel(t)} DROP CONSTRAINT "${t}_pkey", ADD CONSTRAINT "${t}_pkey" PRIMARY KEY (tenant_id, id)`);
    }
    await su.query(`ALTER TABLE ${rel("crm__stays")} ADD CONSTRAINT "${fk.n}" FOREIGN KEY (tenant_id, guest_id) REFERENCES ${rel("crm__guests")} (tenant_id, id)`);
    const legacy = await errOf(run(groupBy));
    chk("T8 PK3a (재현) 예전 판 모양에선 GROUP BY p.id 뒤 p.name 이 거절된다(42803)", legacy?.status === 400 && legacy?.body?.pg_code === "42803",
      JSON.stringify([legacy?.status, legacy?.body]));
    const before = JSON.stringify((await su.query(`SELECT tenant_id, id, guest_id, note FROM ${rel("crm__stays")} ORDER BY id`)).rows);
    const moved = await ensure(spec);
    const after = JSON.stringify((await su.query(`SELECT tenant_id, id, guest_id, note FROM ${rel("crm__stays")} ORDER BY id`)).rows);
    const fkAfter = await defs("crm__stays", "f");
    const g2 = await errOf(run(groupBy));
    chk("T8 PK3 예전 판 표를 다시 보장 — 기본 키 (id) 로 · 행 그대로 · 보고서 primary_key changed(표 둘) · GROUP BY 가 된다",
      (await pkOf("crm__guests")) === "PRIMARY KEY (id)" && (await pkOf("crm__stays")) === "PRIMARY KEY (id)" && before === after && g2 === null
        && ["guests", "stays"].every((t) => moved.constraints.some((c) => c.table === t && c.kind === "primary_key" && c.action === "changed")),
      JSON.stringify({ moved: moved.constraints, g2: g2?.message, pk: await pkOf("crm__guests") }));
    chk("T8 PK6 옛 기본 키에 기댔던 외래키가 옮긴 뒤에도 같은 이름·(tenant_id, 칸)→(tenant_id, id) 로 있다 · 지켜진다",
      fkAfter.length === 1 && fkAfter[0].n === fk.n && /^FOREIGN KEY \(tenant_id, guest_id\) REFERENCES .*\(tenant_id, id\)$/.test(fkAfter[0].d)
        && (await errOf(run("INSERT INTO stays(guest_id, note) VALUES (987654, 'x')")))?.body?.pg_code === "23503",
      JSON.stringify(fkAfter));
    const again = await ensure(spec);
    chk("T8 PK4 이미 (id) 인 표를 다시 보장 — 아무것도 안 바뀐다", again.constraints.length === 0 && again.created.length === 0, JSON.stringify(again.constraints));

    // id 가 겹치는 표 — 한 표에 두 테넌트가 같은 id 로(공유 표를 잘못 넘겨받은 경우)
    await ensure([{ table: "dups", columns: [{ name: "v", type: "text" }] }]);
    await su.query(`ALTER TABLE ${rel("crm__dups")} DROP CONSTRAINT "crm__dups_pkey", ADD CONSTRAINT "crm__dups_pkey" PRIMARY KEY (tenant_id, id)`);
    await su.query(`INSERT INTO ${rel("crm__dups")} (tenant_id, id, v) OVERRIDING SYSTEM VALUE VALUES ($1, 7, 'a'), ($2, 7, 'b')`, [TA, TB]);
    const dupRep = await errOf(ensure([{ table: "dups", columns: [{ name: "v", type: "text" }] }]).then((r) => { dupOut = r; }));
    chk("T8 PK7 id 가 겹치는 표 — 보장은 성공 · 기본 키는 (tenant_id, id) 그대로 · 보고서에 primary_key 없음",
      dupRep === null && (await pkOf("crm__dups")) === "PRIMARY KEY (tenant_id, id)" && !dupOut?.constraints.some((c) => c.kind === "primary_key"),
      JSON.stringify({ err: dupRep?.message, pk: await pkOf("crm__dups"), c: dupOut?.constraints }));
  }
  // ── T9 형 바꾸기 + 검사 ──
  {
    await ensure([{ table: "codes", columns: [{ name: "code", type: "text", check: "length(code) > 0" }] }]);
    await run("INSERT INTO codes(code) VALUES ('12'), ('345')", [], { tables: ["codes"] });
    const conv = await errOf(ensure([{ table: "codes", columns: [{ name: "code", type: "bigint", check: "code > 0" }] }]).then((r) => { t9 = r; }));
    const after = await cols("codes");
    const ck = (await su.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'c' AND conname LIKE 'lvck\\_%'`,
      [`"${SA}"."crm__codes"`])).rows.map((r) => r.d);
    const neg = await errOf(run("INSERT INTO codes(code) VALUES (-1)", [], { tables: ["codes"] }));
    chk("T9 옛 형 검사(length(code) > 0)가 걸린 text 칸을 bigint 로 — 바뀌고 새 검사(code > 0)만 남아 지켜진다",
      conv === null && after.code?.t === "bigint" && t9?.converted_columns?.some((x) => x.column === "code") && ck.length === 1 && /code > 0/.test(ck[0])
        && neg?.status === 409, JSON.stringify({ conv: conv?.message, after: after.code, ck, neg: neg?.status }));
    await ensure([{ table: "codes", columns: [{ name: "code", type: "text", check: "length(code) > 0" }] }]);
    const kept = await errOf(ensure([{ table: "codes", columns: [{ name: "code", type: "bigint", check: "length(code) > 0" }] }]));
    const still = await cols("codes");
    chk("T9b 바뀐 형에 맞지 않는 검사를 그대로 두면 400(503 아님) · 그 표는 그대로(text)", kept?.status === 400 && /검사/.test(kept?.message ?? "") && still.code?.t === "text",
      JSON.stringify({ kept: [kept?.status, kept?.message], still: still.code }));
  }
  // ── T10 잠금 상한 ──
  {
    process.env.LIVELY_APP_DDL_LOCK_MS = "500";
    const holder = new pg.Client({ connectionString: SUPER }); await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE "${SA}"."crm__codes" IN ACCESS SHARE MODE`);     // 읽기 하나가 오래 걸리는 것과 같다
      const t0 = Date.now();
      const hung = Symbol("hung");
      const r = await Promise.race([
        errOf(ensure([{ table: "codes", columns: [{ name: "code", type: "text", check: "length(code) > 0" }, { name: "memo", type: "text" }] }])),
        new Promise((res) => setTimeout(() => res(hung), 8000)),
      ]);
      const ms = Date.now() - t0;
      await holder.query("ROLLBACK");
      const again = await errOf(ensure([{ table: "codes", columns: [{ name: "code", type: "text", check: "length(code) > 0" }, { name: "memo", type: "text" }] }]));
      chk("T10 표를 잡은 트랜잭션이 있으면 표 보장이 잠금 상한 안에 실패(멎지 않음) · 풀리면 된다",
        r !== hung && r?.status === 503 && /lock timeout|잠금/i.test(r?.message ?? "") && ms < 5000 && again === null && "memo" in (await cols("codes")),
        JSON.stringify({ hung: r === hung, status: r?.status, msg: r?.message, ms, again: again?.message }));
    } finally {
      await holder.end().catch(() => {});
      delete process.env.LIVELY_APP_DDL_LOCK_MS;
    }
  }
  // ── T11 지켜야 할 칸(#4724) ──
  {
    const T = (table, columns, extra = {}) => ({ table, columns, ...extra });
    const acc = T("acc", [{ name: "name", type: "text" }]);
    const pubItems = T("items", [
      { name: "title", type: "text", not_null: true }, { name: "code", type: "text" }, { name: "nick", type: "text" },
      { name: "qty", type: "text" }, { name: "note", type: "text" }, { name: "score", type: "int4", check: "score >= 0" },
      { name: "email", type: "text" }, { name: "acc_id", type: "bigint" }, { name: "status", type: "text", default: "new" },
      { name: "kind", type: "text", default: "a" }, { name: "memo", type: "text" },
    ]);
    const draftItems = T("items", [
      { name: "title", type: "text" }, { name: "handle", type: "text", renamed_from: "nick" }, { name: "qty", type: "int4" },
      { name: "note", type: "text", not_null: true, default: "" }, { name: "score", type: "int4" }, { name: "email", type: "text", unique: true },
      { name: "acc_id", type: "bigint", references: { table: "acc" } }, { name: "status", type: "text", default: "open" }, { name: "kind", type: "text" },
      { name: "memo", type: "text", default: "x" },
      { name: "fresh", type: "text", unique: true }, { name: "fresh2", type: "text", not_null: true, default: "f" },
      { name: "fresh_acc", type: "bigint", references: { table: "acc" } },
    ], { drop_columns: ["code"] });
    const protect = declaredColumnsOf({ data: { tables: [acc, pubItems].map((t) => ({ name: t.table, columns: t.columns })) } });
    await ensure([acc, pubItems]);
    await run("INSERT INTO items(title, code, nick, qty, note, score, email) VALUES ('a', 'c1', 'n1', '5', NULL, 1, 'a@x'), ('b', 'c2', 'n2', '7', 'ok', 2, 'b@x')", [], { tables: ["acc", "items"] });
    const rep = await ensure([acc, draftItems], { protect });
    const c1 = await cols("items");
    const defs = async (type) => (await su.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = $2`, [`"${SA}"."crm__items"`, type])).rows.map((r) => r.d);
    const dflt = async (col) => (await su.query(`SELECT pg_get_expr(d.adbin, d.adrelid) AS e FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = to_regclass($1) AND a.attname = $2`, [`"${SA}"."crm__items"`, col])).rows[0]?.e ?? null;
    const uniqIx = async () => (await su.query(`SELECT array_to_string(array(SELECT a.attname::text FROM unnest(x.indkey) k JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k), ',') AS c
      FROM pg_index x WHERE x.indrelid = to_regclass($1) AND x.indisunique AND NOT x.indisprimary`, [`"${SA}"."crm__items"`])).rows.map((r) => r.c).sort();
    const deferred = rep.deferred.map((d) => d.change);
    const want = ["칸 지우기 items.code", "이름 바꾸기 items.nick → handle", "형 바꾸기 items.qty (text → integer)", "not_null 더하기 items.note",
      "unique 인덱스 더하기 items(email)", "외래키 더하기 items.acc_id", "기본값 바꾸기 items.status", "기본값 빼기 items.kind",
      "기본값 더하기 items.note", "기본값 더하기 items.memo"];
    chk("T11 D1 지킨 칸 — 지우기·이름·형 바꾸기·not_null·unique·외래키 더하기·기본값 더하기·바꾸기·빼기는 안 하고 미룬 목록에 한 줄씩",
      "code" in c1 && "nick" in c1 && c1.qty.t === "text" && c1.note.nn === false && !(await uniqIx()).includes("email")
        && !(await defs("f")).some((d) => /\(tenant_id, acc_id\)/.test(d)) && /'new'/.test(await dflt("status") ?? "") && /'a'/.test(await dflt("kind") ?? "")
        && (await dflt("note")) === null && (await dflt("memo")) === null
        && want.every((w) => deferred.includes(w)) && deferred.length === want.length,
      JSON.stringify({ deferred, c1: Object.keys(c1), qty: c1.qty, note: c1.note, uniq: await uniqIx(), status: await dflt("status"), kind: await dflt("kind") }));
    chk("T11 D2 풀기·새 칸은 바로 — title not_null 빼기 · score 검사 빼기 · 새 칸(unique · not_null+기본값) · fresh_acc 외래키",
      c1.title.nn === false && !(await defs("c")).some((d) => /score/.test(d))
        && "fresh" in c1 && (await uniqIx()).includes("fresh") && c1.fresh2?.nn === true && (await defs("f")).some((d) => /\(tenant_id, fresh_acc\)/.test(d)),
      JSON.stringify({ title: c1.title, checks: await defs("c"), note: await dflt("note"), memo: await dflt("memo"), fresh2: c1.fresh2, uniq: await uniqIx(), fks: await defs("f") }));
    chk("T11 D3 미룬 이름 바꾸기의 새 이름 칸(handle)은 만들지 않는다", !("handle" in c1), JSON.stringify(Object.keys(c1)));
    // 공개 판 코드(옛 칸 이름·형)가 그대로 돈다
    const pubWrite = await errOf(run("INSERT INTO items(title, code, nick, qty, note) VALUES ('p', 'c3', 'n3', '9', NULL) RETURNING status, kind", [], { tables: ["acc", "items"] }));
    chk("T11 D1b 공개 판의 옛 코드(옛 칸·옛 형·note 를 비워 쓰기)가 그대로 쓰인다 · 기본값도 옛 그대로", pubWrite === null, String(pubWrite?.message));
    // D6 — 초안에서만 생긴 칸(fresh)은 지키지 않는다: 다음 초안 저장에서 지우면 바로 지워진다
    const draft2 = T("items", draftItems.columns.filter((c) => c.name !== "fresh"), { drop_columns: ["code", "fresh"] });
    await ensure([acc, draft2], { protect });
    chk("T11 D6 초안에서만 생긴 칸은 지키지 않는다 — 지우기가 바로 된다", !("fresh" in (await cols("items"))), JSON.stringify(Object.keys(await cols("items"))));
    // D4 — 지킴 없이(= 공개하기). 표가 Map 에 없으면(acc 만 지킴) items 는 다 맞춘다(D7) · note 의 빈 값은 초안 작성자가 먼저 채운다
    await su.query(`UPDATE "${SA}"."crm__items" SET note = '' WHERE note IS NULL`);
    const nickBefore = (await su.query(`SELECT id, nick FROM "${SA}"."crm__items" ORDER BY id`)).rows;
    const full = await ensure([acc, draft2], { protect: new Map([["acc", new Set(["tenant_id", "id", "created_at", "name"])]]) });
    const c2 = await cols("items");
    const handles = (await su.query(`SELECT id, handle AS nick FROM "${SA}"."crm__items" ORDER BY id`)).rows;
    chk("T11 D4·D7 지킴 없이 다시 보장 — 미룬 것이 다 된다(code 지움·보관 · nick→handle 값 그대로 · qty 정수 · note not_null · email unique · acc_id 외래키 · 기본값)",
      !("code" in c2) && "handle" in c2 && !("nick" in c2) && c2.qty.t === "integer" && c2.note.nn === true && (await uniqIx()).includes("email")
        && (await defs("f")).some((d) => /\(tenant_id, acc_id\)/.test(d)) && /'open'/.test(await dflt("status") ?? "") && (await dflt("kind")) === null
        && /''/.test(await dflt("note") ?? "") && /'x'/.test(await dflt("memo") ?? "")
        && JSON.stringify(handles) === JSON.stringify(nickBefore) && full.dropped_columns.some((d) => d.column === "code" && d.archived_as) && full.deferred.length === 0,
      JSON.stringify({ c2: Object.keys(c2), qty: c2.qty, note: c2.note, dropped: full.dropped_columns, deferred: full.deferred, handles, nickBefore }));
    // D8 — 공개 판이 쓰는 표의 새 칸: 기본값 없는 not_null · not_null 칸의 기본값 빼기는 미룬다(옛 코드의 INSERT 는 새 칸을 빼고 넣는다).
    //  표가 비어 있어도(NULL 행이 없어 걸 수 있어도) 미룬다 — 걸면 그다음 옛 코드의 INSERT 가 깨진다. 기본값과 함께인 not_null 은 바로.
    const tPub = T("tasks", [{ name: "title", type: "text" }]);
    const tProtect = declaredColumnsOf({ data: { tables: [{ name: "tasks", columns: tPub.columns }] } });
    await ensure([tPub]);
    const d8a = await ensure([T("tasks", [...tPub.columns, { name: "prio", type: "int4", not_null: true }, { name: "lvl", type: "text", not_null: true, default: "x" }])], { protect: tProtect });
    const t1 = await cols("tasks");
    const oldIns1 = await errOf(run("INSERT INTO tasks(title) VALUES ('옛 코드 1')", [], { tables: ["tasks"] }));
    const d8b = await ensure([T("tasks", [...tPub.columns, { name: "prio", type: "int4", not_null: true }, { name: "lvl", type: "text", not_null: true }])], { protect: tProtect });
    const lvlDef = (await su.query(`SELECT pg_get_expr(d.adbin, d.adrelid) AS e FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = to_regclass($1) AND a.attname = 'lvl'`, [`"${SA}"."crm__tasks"`])).rows[0]?.e ?? null;
    const oldIns2 = await errOf(run("INSERT INTO tasks(title) VALUES ('옛 코드 2')", [], { tables: ["tasks"] }));
    chk("T11 D8 공개 판이 쓰는 표의 새 칸 — 기본값 없는 not_null(빈 표라도) · not_null 칸의 기본값 빼기는 미룸 · 기본값과 함께인 not_null 은 바로 · 옛 코드 INSERT 통과",
      t1.prio?.nn === false && t1.lvl?.nn === true && d8a.deferred.map((d) => d.change).join(" | ") === "not_null 더하기 tasks.prio"
        && d8b.deferred.map((d) => d.change).sort().join(" | ") === "not_null 더하기 tasks.prio | 기본값 빼기 tasks.lvl" && /'x'/.test(lvlDef ?? "")
        && oldIns1 === null && oldIns2 === null,
      JSON.stringify({ t1: { prio: t1.prio, lvl: t1.lvl }, d8a: d8a.deferred, d8b: d8b.deferred, lvlDef, oldIns1: oldIns1?.message, oldIns2: oldIns2?.message }));
    //  공개(지킴 없이) — 빈 prio 를 채운 뒤 다 된다
    await su.query(`UPDATE "${SA}"."crm__tasks" SET prio = 0 WHERE prio IS NULL`);
    const d8c = await ensure([T("tasks", [...tPub.columns, { name: "prio", type: "int4", not_null: true }, { name: "lvl", type: "text", not_null: true }])]);
    const t2 = await cols("tasks");
    const lvlDef2 = (await su.query(`SELECT count(*)::int AS n FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = to_regclass($1) AND a.attname = 'lvl'`, [`"${SA}"."crm__tasks"`])).rows[0].n;
    chk("T11 D8b 공개하면(지킴 없이) 미룬 not_null · 기본값 빼기가 된다", t2.prio?.nn === true && lvlDef2 === 0 && d8c.deferred.length === 0,
      JSON.stringify({ prio: t2.prio, lvlDef2, deferred: d8c.deferred }));
    // D5 — 공유 표(tenantScoped): 지킬 칸을 안 줘도 지금 있는 칸 전부를 지킨다 · 새 칸은 더한다
    const shared = (cols2, extra) => [{ table: "marks", columns: cols2, ...extra }];
    await ensureAppTables("crmb", shared([{ name: "url", type: "text" }, { name: "hits", type: "text" }]), { schema: SA, strict: true, tenantScopedIndexes: true });
    const srep = emptyTableReport();
    await ensureAppTables("crmb", shared([{ name: "hits", type: "int4" }, { name: "tag", type: "text" }], { drop_columns: ["url"] }), { schema: SA, strict: true, tenantScopedIndexes: true, report: srep });
    const sc = Object.fromEntries((await su.query(`SELECT attname AS n, format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`,
      [`"${SA}"."crmb__marks"`])).rows.map((r) => [r.n, r.t]));
    chk("T11 D5 공유 표는 있는 칸 전부를 지킨다 — url 안 지움 · hits 형 그대로 · 새 칸 tag 는 더함 · 미룬 목록",
      sc.url === "text" && sc.hits === "text" && sc.tag === "text" && srep.deferred.map((d) => d.change).join(" | ") === "칸 지우기 marks.url | 형 바꾸기 marks.hits (text → integer)",
      JSON.stringify({ sc, deferred: srep.deferred }));
    const conDefs = async (physical, type) => (await su.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = $2`,
      [`"${SA}"."${physical}"`, type])).rows.map((r) => r.d);
    const defs9 = (type) => conDefs("crm__combo", type);
    const defs10 = (type) => conDefs("crm__dflt", type);
    const uniqIxOf = async (physical) => (await su.query(`SELECT array_to_string(array(SELECT a.attname::text FROM unnest(x.indkey) k JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k), ',') AS c
      FROM pg_index x WHERE x.indrelid = to_regclass($1) AND x.indisunique AND NOT x.indisprimary`, [`"${SA}"."${physical}"`])).rows.map((r) => r.c).sort();
    // D9 — 미룬 칸에 걸린 규칙도 미룬다(격리 리뷰 차단): 이름 바꾸기 + unique · 인덱스 · enum · 검사 · 외래키 / 형 바꾸기 + 새 기본값.
    //  지킴(초안)은 503·400 없이 저장되고 미룬 목록에 · 옛 코드 INSERT 그대로 · 지킴 없이 한 트랜잭션(공개)이면 다 된다 · 값은 그대로.
    const cPub = T("combo", [{ name: "nick", type: "text", unique: true }, { name: "lab", type: "text", values: ["a", "b"] }, { name: "qty", type: "int4" }, { name: "tag2", type: "bigint" }]);
    const cDraft = T("combo", [
      { name: "handle", type: "text", unique: true, check: "length(handle) > 0", renamed_from: "nick" },
      { name: "lab2", type: "text", values: ["a", "b", "c"], renamed_from: "lab" },
      { name: "qty", type: "text", default: "none" },
      { name: "acc_ref", type: "bigint", references: { table: "acc" }, renamed_from: "tag2" },
    ], { indexes: [{ columns: ["handle", "qty"] }] });
    const p9 = declaredColumnsOf({ data: { tables: [acc, cPub].map((t) => ({ name: t.table, columns: t.columns })) } });
    await ensure([acc, cPub]);
    await run("INSERT INTO combo(nick, lab, qty, tag2) VALUES ('n1', 'a', 5, NULL)", [], { tables: ["acc", "combo"] });
    let rep9 = null;
    const e9 = await errOf((async () => { rep9 = await ensure([acc, cDraft], { protect: p9 }); })());
    const c9 = await cols("combo");
    const old9 = await errOf(run("INSERT INTO combo(nick, lab, qty, tag2) VALUES ('n2', 'b', 7, NULL)", [], { tables: ["acc", "combo"] }));
    const d9 = (rep9?.deferred ?? []).map((d) => d.change);
    const want9 = ["이름 바꾸기 combo.nick → handle", "이름 바꾸기 combo.lab → lab2", "이름 바꾸기 combo.tag2 → acc_ref", "형 바꾸기 combo.qty (integer → text)",
      "기본값 맞추기 combo.qty(형 바꾸기와 함께)", "unique 인덱스 더하기 combo(handle)", "인덱스 더하기 combo(handle,qty)", "인덱스 더하기 combo(acc_ref)",
      "검사 더하기 combo.handle: length(handle) > 0", "검사 더하기 combo.lab2: lab2 IN ('a', 'b', 'c')", "외래키 더하기 combo.acc_ref", "unique 인덱스 빼기 combo(nick)"];
    chk("T11 D9 미룬 칸(이름 · 형 바꾸기)에 걸린 unique · 인덱스 · enum · 검사 · 외래키 · 새 기본값도 미룬다 — 오류 없이 저장 · 옛 칸 그대로 · 옛 코드 INSERT 통과",
      e9 === null && want9.every((w) => d9.includes(w)) && d9.length === want9.length
        && "nick" in c9 && "lab" in c9 && "tag2" in c9 && c9.qty.t === "integer" && !("handle" in c9) && !("lab2" in c9) && !("acc_ref" in c9) && old9 === null,
      JSON.stringify({ e9: e9?.message, d9, c9: Object.keys(c9), qty: c9.qty, old9: old9?.message }));
    const full9 = await errOf(ensure([acc, cDraft], { atomic: true }));
    const c9b = await cols("combo");
    const v9 = (await su.query(`SELECT handle, lab2, qty FROM "${SA}"."crm__combo" ORDER BY id`)).rows.map((r) => `${r.handle}/${r.lab2}/${r.qty}`).join(",");
    const fk9 = (await defs9("f")).some((d) => /\(tenant_id, acc_ref\)/.test(d));
    const ck9 = (await defs9("c")).length;
    const dup9 = await errOf(run("INSERT INTO combo(handle, lab2) VALUES ('n1', 'a')", [], { tables: ["acc", "combo"] }));
    chk("T11 D9b 공개(지킴 없이 · 한 트랜잭션)하면 다 된다 — 이름 셋 바뀜 · qty 글자 · 값 그대로 · 외래키 · 검사 둘 · handle unique",
      full9 === null && "handle" in c9b && "lab2" in c9b && "acc_ref" in c9b && !("nick" in c9b) && c9b.qty.t === "text" && v9 === "n1/a/5,n2/b/7"
        && fk9 && ck9 === 2 && dup9 !== null,
      JSON.stringify({ full9: full9?.message, c9b: Object.keys(c9b), v9, fk9, ck9, dup9: dup9?.message }));

    // D10 — 공개 판이 쓰는 표의 새 칸에 같은 값이 들어가는 기본값이 있으면 그 칸의 unique · 외래키는 미룬다(옛 코드 INSERT 마다 같은 값) ·
    //  무작위 uuid 기본값의 unique 는 바로 · 옛 코드가 두 번 넣어도 된다 · 공개 때 겹친 값이면 409(어느 표도 안 바뀜)
    const dPub = T("dflt", [{ name: "name", type: "text" }]);
    const dDraft = T("dflt", [{ name: "name", type: "text" }, { name: "code", type: "text", unique: true, default: "x" },
      { name: "uid", type: "uuid", unique: true, default_expr: "gen_random_uuid()" }, { name: "acc_id2", type: "bigint", references: { table: "acc" }, default: 1 }]);
    await ensure([acc, dPub]);
    const r10 = await ensure([acc, dDraft], { protect: declaredColumnsOf({ data: { tables: [acc, dPub].map((t) => ({ name: t.table, columns: t.columns })) } }) });
    const old10 = await errOf(run("INSERT INTO dflt(name) VALUES ('a'), ('b')", [], { tables: ["acc", "dflt"] }));
    const ix10 = await uniqIxOf("crm__dflt");
    const d10 = r10.deferred.map((d) => d.change).sort().join(" | ");
    chk("T11 D10 새 칸의 같은 값 기본값 — unique(code) · 외래키(acc_id2) 미룸 · uuid 기본값 unique 는 바로 · 옛 코드 두 번 INSERT 통과",
      d10 === "unique 인덱스 더하기 dflt(code) | 외래키 더하기 dflt.acc_id2" && ix10.includes("uid") && !ix10.includes("code") && old10 === null,
      JSON.stringify({ d10, ix10, old10: old10?.message }));
    const pub10 = await errOf(ensure([acc, dDraft], { atomic: true }));
    const ix10b = await uniqIxOf("crm__dflt");
    await su.query(`UPDATE "${SA}"."crm__dflt" SET code = name, acc_id2 = NULL`);
    const pub10b = await errOf(ensure([acc, dDraft], { atomic: true }));
    chk("T11 D10b 공개 때 겹친 기본값이면 409 · 아무것도 안 바뀜 → 고치면 unique · 외래키가 걸린다",
      pub10?.status === 409 && /겹치는 묶음이 1개/.test(pub10?.message ?? "") && !ix10b.includes("code") && pub10b === null && (await uniqIxOf("crm__dflt")).includes("code")
        && (await defs10("f")).some((d) => /\(tenant_id, acc_id2\)/.test(d)),
      JSON.stringify({ pub10: [pub10?.status, pub10?.message], ix10b, pub10b: pub10b?.message }));

    // D11 — 한 트랜잭션 공개 중 뒤 단계(외래키)가 409 면 앞 표의 칸 지우기도 되돌린다 · 보관 표도 안 남는다(별도 DDL 연결 — 매니지드 꼴)
    await ensure([T("pa", [{ name: "x", type: "text" }, { name: "y", type: "text" }]), T("pb", [{ name: "z", type: "bigint" }])]);
    await run("INSERT INTO pa(x, y) VALUES ('1', 'Y1')", [], { tables: ["pa", "pb"] });
    await run("INSERT INTO pb(z) VALUES (999)", [], { tables: ["pa", "pb"] });                  // pa 에 없는 id
    const e11 = await errOf(ensure([T("pa", [{ name: "x", type: "text" }], { drop_columns: ["y"] }), T("pb", [{ name: "z", type: "bigint", references: { table: "pa" } }])], { atomic: true }));
    const arch11 = (await su.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'crm\\_\\_pa\\_\\_y%'`, [`${SA}_archive`])).rows[0].n;
    chk("T11 D11 한 트랜잭션 — 뒤 표 외래키가 409 면 앞 표 칸 지우기도 되돌린다(y 남음 · 보관 표 0) · 문구 «어느 표도 바뀌지 않았습니다»",
      e11?.status === 409 && /어느 표도 바뀌지 않았습니다/.test(e11?.message ?? "") && "y" in (await cols("pa")) && arch11 === 0,
      JSON.stringify({ e11: [e11?.status, e11?.message], arch11, pa: Object.keys(await cols("pa")) }));

    // D12 — 공유 표는 옛 검사를 걷지 않는다(새 검사는 영영 안 오므로) — enum 넓히기는 미룸 · 옛 검사 그대로
    await ensureAppTables("crmc", [{ table: "kinds", columns: [{ name: "k", type: "text", values: ["a", "b"] }] }], { schema: SA, strict: true, tenantScopedIndexes: true });
    const ck12 = async () => (await su.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'c'`, [`"${SA}"."crmc__kinds"`])).rows.map((r) => r.d);
    const before12 = await ck12();
    const rep12 = emptyTableReport();
    await ensureAppTables("crmc", [{ table: "kinds", columns: [{ name: "k", type: "text", values: ["a", "b", "c"] }] }], { schema: SA, strict: true, tenantScopedIndexes: true, report: rep12 });
    const after12 = await ck12();
    chk("T11 D12 공유 표 — enum 넓히기는 미루고 옛 검사를 걷지 않는다(검사 없는 표가 되지 않게)",
      before12.length === 1 && JSON.stringify(after12) === JSON.stringify(before12) && rep12.deferred.some((d) => /^검사 더하기 kinds\.k: /.test(d.change)),
      JSON.stringify({ before12, after12, deferred: rep12.deferred }));
    // D13 — 공유 표는 지킬 칸 목록(Map)을 따로 줘도 지금 있는 칸 전부를 지킨다(초안이 걸린 기본 앱의 지연 복구가 공개 판의 칸만 주던 자리 — 격리 리뷰)
    await ensureAppTables("crmd", [{ table: "marks", columns: [{ name: "url", type: "text" }, { name: "hits", type: "text" }] }], { schema: SA, strict: true, tenantScopedIndexes: true });
    const rep13 = emptyTableReport();
    await ensureAppTables("crmd", [{ table: "marks", columns: [{ name: "url", type: "text" }], drop_columns: ["hits"] }],
      { schema: SA, strict: true, tenantScopedIndexes: true, protect: new Map([["marks", new Set(["url"])]]), report: rep13 });
    const c13 = (await su.query(`SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`, [`"${SA}"."crmd__marks"`])).rows.map((r) => r.attname);
    chk("T11 D13 공유 표 — 지킬 칸 목록을 따로 줘도(url 만) 있는 칸 전부를 지킨다 — hits 안 지움 · 미룬 목록",
      c13.includes("hits") && rep13.deferred.map((d) => d.change).join(" | ") === "칸 지우기 marks.hits", JSON.stringify({ c13, deferred: rep13.deferred }));
  }
  // ── T12 바뀌는 것 없는 표 보장은 표를 통째로 잠그지 않는다(#4724 격리 리뷰 — 공개 때 한 트랜잭션이 안 바뀌는 표까지 끝까지 잠갔다) ──
  {
    const lk = { table: "locky", columns: [{ name: "a", type: "text", default: "x" }, { name: "n", type: "int4", default: 5 }, { name: "b", type: "bool", default: true },
      { name: "at", type: "timestamptz", default_expr: "now()" }, { name: "u", type: "uuid", default_expr: "gen_random_uuid()" }, { name: "v", type: "numeric(10,2)", default: "1.5" }] };
    await ensure([lk]);
    const protect12 = declaredColumnsOf({ data: { tables: [{ name: "locky", columns: lk.columns }] } });
    process.env.LIVELY_APP_DDL_LOCK_MS = "500";
    const holder = new pg.Client({ connectionString: SUPER }); await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE "${SA}"."crm__locky" IN ACCESS SHARE MODE`);     // 그 표를 오래 읽는 사람
      const t0 = Date.now();
      const plain = await errOf(ensure([lk]));
      const guarded = await errOf(ensure([lk], { protect: protect12 }));
      const atomic = await errOf(ensure([lk], { atomic: true }));
      const ms = Date.now() - t0;
      await holder.query("ROLLBACK");
      chk("T12 바뀌는 것 없는 표 보장(기본값 여섯 꼴 · 지킴 · 한 트랜잭션)은 읽는 사람이 있어도 기다리지 않는다 — 표를 통째로 잠그지 않는다",
        plain === null && guarded === null && atomic === null && ms < 3000, JSON.stringify({ plain: plain?.message, guarded: guarded?.message, atomic: atomic?.message, ms }));
    } finally {
      await holder.end().catch(() => {});
      delete process.env.LIVELY_APP_DDL_LOCK_MS;
    }
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
