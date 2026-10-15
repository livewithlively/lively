// 앱 주소 일회용 코드(#4480 v2-1) — 사양 표 C. DB 없이 가짜 풀로. 실행: npm run build && node dist/apps/app-launch-store.test.js
//  가짜 풀은 session-mint.test 와 같은 원칙이다: 조건을 여기 하드코딩하지 않고 **도착한 SQL 에 그 조건이 있을 때만** 적용한다 —
//   구현에서 조건 하나(주소 · 자리 묶음 · 미사용 · 미만료)를 지우는 mutation 이 여기서 빨간불이 되게.
//  이게 틀리면: 남이 받은 코드를 링크로 밀어 넣어 «그 사람으로 로그인» 시키거나(자리 묶음), 다른 앱 주소에서 코드를 쓰거나(주소 묶음),
//   묶음이 틀린 잡음이 진짜 사람의 코드를 먼저 태워 버린다(소비 안 함 규칙).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Db } from "../db/client.js";
import {
  APP_LAUNCH_TTL_MS, genAppLaunchCode, isAppLaunchCodeShape, mintAppLaunchCode, redeemAppLaunchCode,
} from "./app-launch-store.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

interface Row { code_hash: string; member_id: string; app_id: string; variant: string; host: string; mode: string; state_hash: string | null; expires_at: string; used_at: string | null }
function fakePool() {
  const rows = new Map<string, Row>();
  const members: Record<string, { state: string; kind: string }> = {
    alice: { state: "active", kind: "human" }, bob: { state: "inactive", kind: "human" }, robo: { state: "active", kind: "agent" },
  };
  const audits: unknown[][] = [];
  const f = {
    now: Date.now(), rows, audits, calls: 0, inserts: [] as unknown[][],
    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
      f.calls++;
      if (sql.includes("org_content_audit")) { audits.push(params); return { rows: [], rowCount: 1 }; }
      if (sql.includes("INSERT INTO app_launch_code")) {
        f.inserts.push(params);
        const [hash, member, app, variant, host, mode, stateHash, exp] = params as [string, string, string, string, string, string, string | null, string];
        rows.set(hash, { code_hash: hash, member_id: member, app_id: app, variant, host, mode, state_hash: stateHash, expires_at: exp, used_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM app_launch_code")) {
        let n = 0;
        for (const [k, r] of rows) if (Date.parse(r.expires_at) < f.now - 3_600_000) { rows.delete(k); n++; }
        return { rows: [], rowCount: n };
      }
      if (sql.includes("UPDATE app_launch_code")) {
        const [hash, host, dest, stateHash] = params as [string, string, string, string];
        const r = rows.get(hash);
        if (!r) return { rows: [], rowCount: 0 };
        if (sql.includes("used_at IS NULL") && r.used_at !== null) return { rows: [], rowCount: 0 };
        if (sql.includes("expires_at > now()") && !(Date.parse(r.expires_at) > f.now)) return { rows: [], rowCount: 0 };
        if (sql.includes("host=$2") && r.host !== host) return { rows: [], rowCount: 0 };
        const embedRule = sql.includes("mode='embed' AND $3='iframe'");
        const topRule = sql.includes("mode='top' AND state_hash IS NOT NULL AND state_hash=$4");
        if (embedRule || topRule) {
          const embedOk = r.mode === "embed" && (!embedRule || dest === "iframe");
          const topOk = r.mode === "top" && (!topRule || (r.state_hash !== null && r.state_hash === stateHash));
          if (!embedOk && !topOk) return { rows: [], rowCount: 0 };
        }
        if (sql.includes("SET used_at=now()")) r.used_at = new Date(f.now).toISOString();
        return { rows: [{ member_id: r.member_id, app_id: r.app_id, variant: r.variant, mode: r.mode }], rowCount: 1 };
      }
      if (sql.includes("FROM org_member")) {
        const m = members[String(params[0])];
        return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
      }
      throw new Error("가짜 풀이 모르는 SQL: " + sql.slice(0, 60));
    },
  };
  return f;
}
const asDb = (f: ReturnType<typeof fakePool>): Db => f as unknown as Db;
const HOST = "deck-edit-lively-46e3.lvly.app";
const STATE = "s".repeat(43);

// ── C0 코드 꼴 ──
{
  const c = genAppLaunchCode();
  assert.match(c, /^lva_[A-Za-z0-9_-]{32}$/);
  assert.ok(isAppLaunchCodeShape(c));
  for (const bad of ["", "lva_", "lvm_" + "a".repeat(32), "lva_" + "a".repeat(31), "lva_" + "a".repeat(33), "lva_" + "a".repeat(31) + "/"]) assert.ok(!isAppLaunchCodeShape(bad), bad);
  assert.notEqual(genAppLaunchCode(), genAppLaunchCode());
  ok("C0 코드 꼴 — lva_ + 32자 · 매번 다름");
}

// ── C1 발급 — 지문만 저장 · 60초 · state 도 지문 ──
{
  const f = fakePool();
  const before = Date.now();
  const { code, expiresAt } = await mintAppLaunchCode({ memberId: "alice", appId: "deck-edit", variant: "pub", host: HOST, mode: "top", state: STATE }, asDb(f));
  const row = f.rows.get(sha256(code));
  assert.ok(row, "지문으로 저장");
  assert.ok(!JSON.stringify(f.inserts).includes(code), "평문 코드는 저장에 없다");
  assert.ok(!JSON.stringify(f.inserts).includes(STATE), "평문 state 도 저장에 없다");
  assert.equal(row!.state_hash, sha256(STATE));
  const ttl = expiresAt.getTime() - before;
  assert.ok(ttl >= APP_LAUNCH_TTL_MS - 5 && ttl <= APP_LAUNCH_TTL_MS + 1000 && APP_LAUNCH_TTL_MS === 60_000, `TTL 60초(${ttl})`);
  assert.equal(f.audits.length, 0, "발급은 감사에 남기지 않는다(앱을 열 때마다 생긴다)");
  ok("C1 발급 — 지문만 · 60초 · state 지문");
}

// ── C2 top 발급인데 state 없음/꼴 틀림 → 던진다 · embed 는 state 안 둔다 ──
{
  const f = fakePool();
  await assert.rejects(mintAppLaunchCode({ memberId: "alice", appId: "a1", variant: "pub", host: HOST, mode: "top" }, asDb(f)));
  await assert.rejects(mintAppLaunchCode({ memberId: "alice", appId: "a1", variant: "pub", host: HOST, mode: "top", state: "짧다" }, asDb(f)));
  assert.equal(f.rows.size, 0, "던지면 저장도 없다");
  const { code } = await mintAppLaunchCode({ memberId: "alice", appId: "a1", variant: "pub", host: HOST, mode: "embed", state: STATE }, asDb(f));
  assert.equal(f.rows.get(sha256(code))!.state_hash, null, "embed 는 state 를 두지 않는다");
  ok("C2 top 은 state 필수 · embed 는 state 없음");
}

const mint = async (f: ReturnType<typeof fakePool>, over: Partial<{ memberId: string; mode: "embed" | "top"; state: string; host: string }> = {}) =>
  (await mintAppLaunchCode({ memberId: over.memberId ?? "alice", appId: "deck-edit", variant: "pub", host: over.host ?? HOST, mode: over.mode ?? "embed", state: over.state ?? (over.mode === "top" ? STATE : null) }, asDb(f))).code;

// ── C3 embed + iframe + 같은 주소 → 성공 · 소비 · 감사 1 ──
{
  const f = fakePool();
  const code = await mint(f);
  const r = await redeemAppLaunchCode({ code, host: HOST, dest: "iframe", state: "" }, asDb(f));
  assert.deepEqual(r, { memberId: "alice", appId: "deck-edit", variant: "pub", mode: "embed" });
  assert.ok(f.rows.get(sha256(code))!.used_at, "소비됨");
  assert.equal(f.audits.length, 1, "성공은 감사 1건");
  assert.ok(!JSON.stringify(f.audits).includes(code), "감사에도 평문 코드 없음");
  ok("C3 embed 성공 — 소비 · 감사 1");
}

// ── C4 embed 를 최상위로(dest=document) → 실패 · 소비 안 함 · 그 뒤 iframe 이면 성공 ──
{
  const f = fakePool();
  const code = await mint(f);
  assert.equal(await redeemAppLaunchCode({ code, host: HOST, dest: "document", state: "" }, asDb(f)), null);
  assert.equal(await redeemAppLaunchCode({ code, host: HOST, dest: "", state: "" }, asDb(f)), null, "dest 없음도 실패");
  assert.equal(f.rows.get(sha256(code))!.used_at, null, "소비되지 않았다");
  assert.equal(f.audits.length, 0);
  assert.ok(await redeemAppLaunchCode({ code, host: HOST, dest: "iframe", state: "" }, asDb(f)), "그 뒤 맞는 자리로 오면 성공");
  ok("C4 embed 최상위 거부 — 소비 안 함 · 나중 iframe 성공");
}

// ── C5 다른 주소 → 실패 · 소비 안 함 ──
{
  const f = fakePool();
  const code = await mint(f);
  assert.equal(await redeemAppLaunchCode({ code, host: "other-lively-46e3.lvly.app", dest: "iframe", state: "" }, asDb(f)), null);
  assert.equal(f.rows.get(sha256(code))!.used_at, null);
  assert.ok(await redeemAppLaunchCode({ code, host: HOST.toUpperCase(), dest: "iframe", state: "" }, asDb(f)), "주소는 대소문자 무시(소문자로 맞춘다)");
  ok("C5 다른 주소 거부 — 소비 안 함 · 대소문자 무시");
}

// ── C6 top — 같은 state 성공 · 다른/없는 state 실패(소비 안 함) ──
{
  const f = fakePool();
  const code = await mint(f, { mode: "top" });
  assert.equal(await redeemAppLaunchCode({ code, host: HOST, dest: "document", state: "t".repeat(43) }, asDb(f)), null, "다른 state");
  assert.equal(await redeemAppLaunchCode({ code, host: HOST, dest: "document", state: "" }, asDb(f)), null, "state 없음");
  assert.equal(await redeemAppLaunchCode({ code, host: HOST, dest: "iframe", state: "" }, asDb(f)), null, "top 코드를 iframe 으로(state 없이)");
  assert.equal(f.rows.get(sha256(code))!.used_at, null, "소비되지 않았다");
  const r = await redeemAppLaunchCode({ code, host: HOST, dest: "document", state: STATE }, asDb(f));
  assert.equal(r?.mode, "top", "같은 state 면 성공");
  ok("C6 top — state 묶음");
}

// ── C7 한 번만 · 만료 ──
{
  const f = fakePool();
  const code = await mint(f);
  assert.ok(await redeemAppLaunchCode({ code, host: HOST, dest: "iframe", state: "" }, asDb(f)));
  assert.equal(await redeemAppLaunchCode({ code, host: HOST, dest: "iframe", state: "" }, asDb(f)), null, "두 번째는 실패");
  const code2 = await mint(f);
  f.now = Date.now() + APP_LAUNCH_TTL_MS + 1;
  assert.equal(await redeemAppLaunchCode({ code: code2, host: HOST, dest: "iframe", state: "" }, asDb(f)), null, "만료");
  assert.equal(f.audits.length, 1, "감사는 성공 1건뿐");
  ok("C7 1회 · 만료");
}

// ── C8 비활성 · 에이전트 구성원 → 실패(코드는 소비) · 감사 0 ──
{
  const f = fakePool();
  const c1 = await mint(f, { memberId: "bob" });
  const c2 = await mint(f, { memberId: "robo" });
  assert.equal(await redeemAppLaunchCode({ code: c1, host: HOST, dest: "iframe", state: "" }, asDb(f)), null);
  assert.equal(await redeemAppLaunchCode({ code: c2, host: HOST, dest: "iframe", state: "" }, asDb(f)), null);
  assert.ok(f.rows.get(sha256(c1))!.used_at && f.rows.get(sha256(c2))!.used_at, "소비됨");
  assert.equal(f.audits.length, 0);
  ok("C8 비활성 · 에이전트 — 실패(소비) · 감사 0");
}

// ── C9 꼴 틀린 코드 → DB 0회 ──
{
  const f = fakePool();
  for (const bad of ["", "lvm_" + "a".repeat(32), "x"]) assert.equal(await redeemAppLaunchCode({ code: bad, host: HOST, dest: "iframe", state: "" }, asDb(f)), null);
  assert.equal(f.calls, 0, "DB 를 건드리지 않았다");
  ok("C9 꼴 틀림 — DB 0회");
}

// ── C10 청소 — 만료 1시간 지난 행만 ──
{
  const f = fakePool();
  const c = await mint(f);
  const keep = await mint(f);
  f.rows.get(sha256(c))!.expires_at = new Date(Date.now() - 3_600_000 - 2000).toISOString();
  f.rows.get(sha256(keep))!.expires_at = new Date(Date.now() - 3_600_000 + 60_000).toISOString();
  await redeemAppLaunchCode({ code: genAppLaunchCode(), host: HOST, dest: "iframe", state: "" }, asDb(f));
  assert.ok(!f.rows.has(sha256(c)) && f.rows.has(sha256(keep)), "1시간 지난 것만 지운다");
  ok("C10 청소 — 만료 1시간 지난 행만");
}

console.log(`\n${pass} passed`);
