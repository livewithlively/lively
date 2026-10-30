import { strict as assert } from "node:assert";
import test from "node:test";
import { parseSync } from "libpg-query";
import { drizzle } from "drizzle-orm/pg-proxy";
import {
  pgTable, pgEnum, bigint, text, numeric, integer, smallint, boolean, timestamp, date, jsonb, json, varchar, uuid, real,
  doublePrecision, time, interval, inet, alias, unionAll, union, intersect, except,
} from "drizzle-orm/pg-core";
import {
  relations, eq, and, or, not, sql, inArray, notInArray, like, ilike, notIlike, isNull, isNotNull, between, gt, gte, lte, ne,
  exists, notExists, desc, asc, count, sum, avg, min, max, countDistinct, arrayContains, arrayContained, arrayOverlaps,
} from "drizzle-orm";
import { planAppSql, ensureAppSqlParser } from "./app-sql.js";

// Drizzle 가 만드는 SQL 은 앱 SQL 검사기를 **전부** 통과해야 한다(#4483 완료 조건 — SDK 를 따르면 문제가 없게).
//  조회·조인·관계 조회·집계·집합·삽입/upsert/RETURNING·수정·삭제·행 잠금을 Drizzle 쿼리 빌더로 만들고(DB 없이 toSQL),
//  ① 검사기가 받고 ② 바꿔 쓴 SQL 을 다시 해석했을 때 선언 테이블은 전부 워크스페이스 스키마의 물리 이름이고, 스키마 없는
//  테이블 자리는 WITH·별칭 이름뿐인지 본다. 실제 DB 에서 도는지는 SDK 끝단 PG 시험이 잰다.
//  Drizzle 판을 올리면 이 시험이 먼저 말한다(devDependencies 의 drizzle-orm 은 SDK 가 맞춘 판).

const SCHEMA = "app_0123456789abcdef0123456789abcdef";
const DECLARED = ["contacts", "orders", "notes"];

const stage = pgEnum("stage", ["lead", "customer", "lost"]);
const contacts = pgTable("contacts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  email: varchar("email", { length: 200 }).unique(),
  stage: stage("stage").default("lead"),
  tags: text("tags").array(),
  meta: jsonb("meta"),
  score: integer("score").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
const orders = pgTable("orders", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  contactId: bigint("contact_id", { mode: "number" }).references(() => contacts.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  qty: smallint("qty").default(1),
  paid: boolean("paid").default(false),
  orderedOn: date("ordered_on"),
  memo: json("memo"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
const notes = pgTable("notes", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  contactId: bigint("contact_id", { mode: "number" }).references(() => contacts.id),
  body: text("body"),
  ref: uuid("ref").defaultRandom(),
  ratio: real("ratio"),
  weight: doublePrecision("weight"),
  at: time("at"),
  dur: interval("dur"),
  ip: inet("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
const contactsRelations = relations(contacts, ({ many }) => ({ orders: many(orders), notes: many(notes) }));
const ordersRelations = relations(orders, ({ one }) => ({ contact: one(contacts, { fields: [orders.contactId], references: [contacts.id] }) }));
const notesRelations = relations(notes, ({ one }) => ({ contact: one(contacts, { fields: [notes.contactId], references: [contacts.id] }) }));
const db = drizzle(async () => ({ rows: [] }), { schema: { contacts, orders, notes, contactsRelations, ordersRelations, notesRelations } });

type Q = { toSQL(): { sql: string; params: unknown[] } };
const corpus: Array<[string, () => Q]> = [];
const add = (name: string, q: () => Q): void => { corpus.push([name, q]); };

// ── 조회 ──
add("select all", () => db.select().from(contacts));
add("select cols", () => db.select({ id: contacts.id, name: contacts.name }).from(contacts));
add("where eq", () => db.select().from(contacts).where(eq(contacts.email, "a@b.c")));
add("and/or", () => db.select().from(contacts).where(and(eq(contacts.stage, "lead"), or(gt(contacts.score, 3), isNull(contacts.email)))));
add("not/ne", () => db.select().from(contacts).where(and(not(eq(contacts.stage, "lost")), ne(contacts.name, "x"))));
add("inArray", () => db.select().from(contacts).where(inArray(contacts.id, [1, 2, 3])));
add("notInArray", () => db.select().from(contacts).where(notInArray(contacts.id, [1, 2])));
add("like/ilike", () => db.select().from(contacts).where(or(like(contacts.name, "%kim%"), ilike(contacts.email, "%@x.com"), notIlike(contacts.name, "a%"))));
add("between numeric", () => db.select().from(orders).where(between(orders.amount, "10.00", "99.99")));
add("dates", () => db.select().from(orders).where(and(gte(orders.orderedOn, "2026-01-01"), lte(orders.orderedOn, "2026-12-31"))));
add("order/limit/offset", () => db.select().from(contacts).orderBy(desc(contacts.createdAt), asc(contacts.name)).limit(20).offset(40));
add("distinct", () => db.selectDistinct({ stage: contacts.stage }).from(contacts));
add("distinct on", () => db.selectDistinctOn([contacts.stage], { stage: contacts.stage, name: contacts.name }).from(contacts).orderBy(contacts.stage, desc(contacts.createdAt)));
add("isNotNull", () => db.select().from(contacts).where(isNotNull(contacts.meta)));
add("json ->>", () => db.select().from(contacts).where(sql`${contacts.meta}->>'city' = ${"Seoul"}`));
add("arrayContains", () => db.select().from(contacts).where(arrayContains(contacts.tags, ["vip"])));
add("arrayOverlaps", () => db.select().from(contacts).where(arrayOverlaps(contacts.tags, ["a", "b"])));
add("arrayContained", () => db.select().from(contacts).where(arrayContained(contacts.tags, ["a", "b"])));
add("sql expr", () => db.select({ n: sql`lower(${contacts.name})`, y: sql`extract(year from ${contacts.createdAt})` }).from(contacts));
add("coalesce/case", () => db.select({ s: sql`coalesce(${contacts.score}, 0)`, c: sql`case when ${contacts.score} > 5 then 'hi' else 'lo' end` }).from(contacts));
add("date_trunc", () => db.select({ d: sql`date_trunc('month', ${orders.createdAt})`, total: sum(orders.amount) }).from(orders).groupBy(sql`1`));
add("now interval", () => db.select().from(orders).where(gt(orders.createdAt, sql`now() - interval '7 days'`)));
add("cast", () => db.select({ a: sql`${orders.amount}::numeric(14,2)`, b: sql`cast(${orders.qty} as text)` }).from(orders));
add("for update", () => db.select().from(contacts).where(eq(contacts.id, 1)).for("update"));
add("for update skip locked", () => db.select().from(contacts).where(eq(contacts.stage, "lead")).limit(1).for("update", { skipLocked: true }));
add("exists", () => db.select().from(contacts).where(exists(db.select({ x: sql`1` }).from(orders).where(eq(orders.contactId, contacts.id)))));
add("notExists", () => db.select().from(contacts).where(notExists(db.select().from(orders).where(eq(orders.contactId, contacts.id)))));
add("inArray subquery", () => db.select().from(contacts).where(inArray(contacts.id, db.select({ id: orders.contactId }).from(orders).where(eq(orders.paid, true)))));
add("$count subquery", () => db.select({ n: db.$count(orders, eq(orders.contactId, contacts.id)) }).from(contacts));
// ── 조인 ──
add("inner join", () => db.select().from(contacts).innerJoin(orders, eq(orders.contactId, contacts.id)));
add("left join", () => db.select({ c: contacts.name, a: orders.amount }).from(contacts).leftJoin(orders, eq(orders.contactId, contacts.id)));
add("right join", () => db.select().from(orders).rightJoin(contacts, eq(orders.contactId, contacts.id)));
add("full join", () => db.select().from(orders).fullJoin(contacts, eq(orders.contactId, contacts.id)));
add("cross join", () => db.select().from(contacts).crossJoin(notes));
add("two joins", () => db.select().from(contacts).leftJoin(orders, eq(orders.contactId, contacts.id)).leftJoin(notes, eq(notes.contactId, contacts.id)));
const c2 = alias(contacts, "c2");
add("self join alias", () => db.select({ a: contacts.name, b: c2.name }).from(contacts).innerJoin(c2, eq(c2.email, contacts.email)));
const sq = db.select({ contactId: orders.contactId, total: sum(orders.amount).as("total") }).from(orders).groupBy(orders.contactId).as("sq");
add("join subquery", () => db.select({ name: contacts.name, total: sq.total }).from(contacts).leftJoin(sq, eq(sq.contactId, contacts.id)));
add("lateral join", () => db.select().from(contacts).leftJoinLateral(db.select().from(orders).where(eq(orders.contactId, contacts.id)).limit(1).as("lo"), sql`true`));
add("from subquery", () => db.select().from(sq));
const vip = db.$with("vip").as(db.select().from(contacts).where(gt(contacts.score, 10)));
add("with cte", () => db.with(vip).select().from(vip));
add("with cte join", () => db.with(vip).select({ n: vip.name, a: orders.amount }).from(vip).innerJoin(orders, eq(orders.contactId, vip.id)));
// ── 집계 ──
add("count(*)", () => db.select({ n: count() }).from(contacts));
add("count col", () => db.select({ n: count(contacts.email) }).from(contacts));
add("countDistinct", () => db.select({ n: countDistinct(contacts.stage) }).from(contacts));
add("sum/avg/min/max", () => db.select({ s: sum(orders.amount), a: avg(orders.amount), mn: min(orders.amount), mx: max(orders.amount) }).from(orders));
add("group by having", () => db.select({ c: orders.contactId, s: sum(orders.amount) }).from(orders).groupBy(orders.contactId).having(({ s }) => gt(s, "100")));
add("group by join", () => db.select({ name: contacts.name, n: count(orders.id) }).from(contacts).leftJoin(orders, eq(orders.contactId, contacts.id)).groupBy(contacts.id));
add("filter agg", () => db.select({ paid: sql`count(*) filter (where ${orders.paid})` }).from(orders));
add("window fn", () => db.select({ id: orders.id, rk: sql`row_number() over (partition by ${orders.contactId} order by ${orders.amount} desc)` }).from(orders));
// ── 집합 ──
add("union", () => union(db.select({ n: contacts.email }).from(contacts), db.select({ n: notes.body }).from(notes)));
add("unionAll", () => unionAll(db.select({ n: contacts.email }).from(contacts), db.select({ n: notes.body }).from(notes)));
add("intersect", () => intersect(db.select({ id: notes.contactId }).from(notes), db.select({ id: orders.contactId }).from(orders)));
add("except", () => except(db.select({ id: notes.contactId }).from(notes), db.select({ id: orders.contactId }).from(orders)));
// ── 관계 조회 ──
add("rq findMany", () => db.query.contacts.findMany());
add("rq with", () => db.query.contacts.findMany({ with: { orders: true } }));
add("rq with where/orderBy/limit", () => db.query.contacts.findMany({ where: eq(contacts.stage, "lead"), with: { orders: { where: eq(orders.paid, true), orderBy: [desc(orders.amount)], limit: 5 } }, limit: 10, orderBy: [desc(contacts.createdAt)] }));
add("rq findFirst two relations", () => db.query.contacts.findFirst({ where: eq(contacts.id, 1), with: { orders: true, notes: true } }));
add("rq nested", () => db.query.orders.findMany({ with: { contact: { with: { notes: true } } } }));
add("rq columns extras", () => db.query.contacts.findMany({ columns: { id: true, name: true }, extras: { lower: sql<string>`lower(${contacts.name})`.as("lower") } }));
// ── 쓰기 ──
add("insert one", () => db.insert(contacts).values({ name: "a", email: "a@b.c" }));
add("insert returning", () => db.insert(contacts).values({ name: "a", email: "a@b.c" }).returning());
add("insert returning id", () => db.insert(contacts).values({ name: "a" }).returning({ id: contacts.id }));
add("insert many numeric", () => db.insert(orders).values([{ contactId: 1, amount: "10.50" }, { contactId: 1, amount: "3.00", qty: 2 }]).returning());
add("insert defaults", () => db.insert(notes).values({}));
add("insert json/array", () => db.insert(contacts).values({ name: "z", tags: ["a", "b"], meta: { city: "Seoul" } }));
add("upsert do nothing", () => db.insert(contacts).values({ name: "a", email: "a@b.c" }).onConflictDoNothing());
add("upsert do nothing target", () => db.insert(contacts).values({ name: "a", email: "a@b.c" }).onConflictDoNothing({ target: contacts.email }));
add("upsert do update", () => db.insert(contacts).values({ name: "a", email: "a@b.c" }).onConflictDoUpdate({ target: contacts.email, set: { name: "b" } }).returning());
add("upsert excluded", () => db.insert(contacts).values({ name: "a", email: "a@b.c", score: 1 }).onConflictDoUpdate({ target: contacts.email, set: { name: sql`excluded.name`, score: sql`${contacts.score} + excluded.score` } }));
add("upsert setWhere", () => db.insert(contacts).values({ name: "a", email: "a@b.c" }).onConflictDoUpdate({ target: contacts.email, set: { name: "b" }, setWhere: sql`${contacts.stage} <> 'lost'` }));
add("insert select", () => db.insert(notes).select(sql`select ${contacts.id}, ${contacts.name} from ${contacts}`));
add("update set", () => db.update(contacts).set({ name: "x", score: 3 }).where(eq(contacts.id, 1)));
add("update returning", () => db.update(contacts).set({ stage: "customer" }).where(eq(contacts.email, "a@b.c")).returning());
add("update increment", () => db.update(contacts).set({ score: sql`${contacts.score} + 1` }).where(eq(contacts.id, 1)).returning({ score: contacts.score }));
add("update from", () => db.update(orders).set({ paid: true }).from(contacts).where(and(eq(orders.contactId, contacts.id), eq(contacts.stage, "customer"))));
add("update jsonb ||", () => db.update(contacts).set({ meta: sql`${contacts.meta} || ${JSON.stringify({ a: 1 })}::jsonb` }).where(eq(contacts.id, 1)));
add("delete", () => db.delete(notes).where(eq(notes.id, 1)));
add("delete returning", () => db.delete(orders).where(and(eq(orders.contactId, 1), eq(orders.paid, false))).returning());
add("delete inArray", () => db.delete(notes).where(inArray(notes.id, [1, 2, 3])));
add("delete subquery", () => db.delete(notes).where(inArray(notes.contactId, db.select({ id: contacts.id }).from(contacts).where(eq(contacts.stage, "lost")))));
add("delete exists", () => db.delete(notes).where(exists(db.select({ x: sql`1` }).from(contacts).where(and(eq(contacts.id, notes.contactId), eq(contacts.stage, "lost"))))));

type J = Record<string, unknown>;
/** 다시 해석한 트리의 테이블 자리 전부(스키마·이름) — FOR UPDATE OF 의 이름(FROM 자리 별칭)은 뺀다. */
function rangeVars(x: unknown, out: Array<{ schema?: string; rel: string }>, skip = false): void {
  if (Array.isArray(x)) { for (const e of x) rangeVars(e, out, skip); return; }
  if (!x || typeof x !== "object") return;
  const o = x as J;
  if (typeof o.relname === "string" && !skip) out.push({ schema: o.schemaname as string | undefined, rel: o.relname });
  for (const [k, v] of Object.entries(o)) rangeVars(v, out, skip || k === "lockedRels");
}

test("Drizzle 말뭉치 — 검사기가 전부 받고, 선언 테이블은 전부 워크스페이스 스키마의 물리 이름으로 바뀐다", async () => {
  await ensureAppSqlParser();
  assert.ok(corpus.length >= 80, `말뭉치 ${corpus.length}`);
  const failed: string[] = [];
  let rewritten = 0;
  for (const [name, build] of corpus) {
    const { sql: text } = build().toSQL();
    try {
      const p = await planAppSql(text, { appId: "crm", schema: SCHEMA, tables: DECLARED });
      const rvs: Array<{ schema?: string; rel: string }> = [];
      rangeVars(parseSync(p.sql), rvs);
      for (const r of rvs) {
        if (r.schema) {
          assert.equal(r.schema, SCHEMA, `${name}: ${p.sql}`);
          assert.match(r.rel, /^crm__(contacts|orders|notes)$/, `${name}: ${p.sql}`);
          rewritten++;
        } else {
          assert.ok(!DECLARED.includes(r.rel), `${name}: 바뀌지 않은 선언 테이블 '${r.rel}' — ${p.sql}`);
        }
      }
      assert.ok(p.tables.length > 0, `${name}: 테이블을 못 찾았다`);
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}\n    ${text}`);
    }
  }
  assert.deepEqual(failed, [], failed.join("\n"));
  // 배선 — 바꿔 쓴 자리를 실제로 셌다(빈 트리를 훑고 통과하지 않았다).
  assert.ok(rewritten >= corpus.length, `바꿔 쓴 테이블 자리 ${rewritten}`);
});

test("Drizzle 쓰기·잠금 — 대상 테이블·RETURNING·잠금을 바르게 판정한다", async () => {
  const o = { appId: "crm", schema: SCHEMA, tables: DECLARED };
  const p1 = await planAppSql(db.insert(orders).values({ contactId: 1, amount: "1.00" }).returning().toSQL().sql, o);
  assert.deepEqual([p1.kind, p1.writes, p1.returning, p1.targets], ["insert", true, true, ["orders"]]);
  const p2 = await planAppSql(db.update(orders).set({ paid: true }).from(contacts).where(eq(orders.contactId, contacts.id)).toSQL().sql, o);
  assert.deepEqual([p2.kind, p2.returning, p2.targets, p2.tables], ["update", false, ["orders"], ["contacts", "orders"]]);
  const p3 = await planAppSql(db.select().from(contacts).for("update", { skipLocked: true }).toSQL().sql, o);
  assert.deepEqual([p3.kind, p3.writes, p3.locks], ["select", false, true]);
  const p4 = await planAppSql(db.query.contacts.findMany({ with: { orders: true } }).toSQL().sql, o);
  assert.deepEqual([p4.kind, p4.tables], ["select", ["contacts", "orders"]]);
});
