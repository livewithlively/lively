// 세션 SSO 브리지(#1454 S1) 단위검증 — 코드 지문(해시)·만료·1회성 계약을 DB 없이 못박는다.
//  실행: npm run build && node dist/org/store/session-mint.test.js
//  사양·엣지 표: 발급=평문 무저장(지문만)·TTL 60초 / 교환=형태·일치·미사용·미만료·멤버 active 전부 충족 시에만
//  성공, 실패 사유 비노출·실패 무감사 / 1회성 / 멤버 부적격 실패는 코드 소진(만료 실패는 아님) / 만료+1h 경과 행 GC.
//  실 DB 대신 **가짜 풀**을 db seam(mintToken 의 client 오버로드와 같은 주입 자리)에 꽂는다. 가짜의 claim 은
//  자기 로직을 갖지 않고 **실제로 도착한 SQL 문장의 조건(used_at IS NULL·expires_at > now()) 유무에서 파생**한다 —
//  구현 SQL 에서 조건 하나를 지우는 mutation 이 여기서 빨간불이 되게(재진술 방지, fail-first 로 입증).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Db } from "../../db/client.js";
import {
  SESSION_MINT_TTL_MS, genSessionMintCode, isSessionMintCodeShape, mintSessionCode, exchangeSessionCode,
} from "./session-mint.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

// ── 가짜 풀 — pending_session_mint(Map) + org_member(고정) + org_content_audit(배열). 시계(now)는 테스트 소유. ──
interface MintRow { code_hash: string; member_id: string; expires_at: string; used_at: string | null; created_by: string | null }
function fakePool() {
  const rows = new Map<string, MintRow>();
  const members: Record<string, string> = { alice: "active", bob: "inactive" }; // carol = 행 자체가 없음(삭제된 멤버)
  const audits: Array<{ params: unknown[] }> = [];
  const f = {
    now: Date.now(),
    rows, audits,
    calls: 0,
    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
      f.calls++;
      if (sql.includes("org_content_audit")) { audits.push({ params }); return { rows: [], rowCount: 1 }; }
      if (sql.includes("INSERT INTO pending_session_mint")) {
        const [hash, memberId, expiresAt, createdBy] = params as [string, string, string, string | null];
        rows.set(hash, { code_hash: hash, member_id: memberId, expires_at: expiresAt, used_at: null, created_by: createdBy });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM pending_session_mint")) {
        // GC 사양: 만료 후 1시간이 '지난'(strict) 행만 삭제.
        let n = 0;
        for (const [k, r] of rows) if (Date.parse(r.expires_at) < f.now - 3_600_000) { rows.delete(k); n++; }
        return { rows: [], rowCount: n };
      }
      if (sql.includes("UPDATE pending_session_mint")) {
        // claim — 조건을 여기 하드코딩하지 않고 **도착한 SQL 에 그 조건이 있을 때만** 적용한다:
        //  구현이 'AND used_at IS NULL' 또는 'expires_at > now()' 를 잃으면 이 가짜는 그대로 통과시켜
        //  1회성/만료 테스트가 빨간불이 된다(가짜가 계약을 대신 지켜 주는 vacuous 화 방지).
        const hash = String(params[0]);
        const r = rows.get(hash);
        if (!r) return { rows: [], rowCount: 0 };
        if (sql.includes("used_at IS NULL") && r.used_at !== null) return { rows: [], rowCount: 0 };
        if (sql.includes("expires_at > now()") && !(Date.parse(r.expires_at) > f.now)) return { rows: [], rowCount: 0 };
        if (sql.includes("SET used_at=now()")) r.used_at = new Date(f.now).toISOString();
        return { rows: [{ member_id: r.member_id }], rowCount: 1 };
      }
      if (sql.includes("FROM org_member")) {
        const state = members[String(params[0])];
        return { rows: state ? [{ state }] : [], rowCount: state ? 1 : 0 };
      }
      throw new Error("가짜 풀이 모르는 SQL: " + sql.slice(0, 60));
    },
  };
  return f;
}
const asDb = (f: ReturnType<typeof fakePool>): Db => f as unknown as Db;

// ── 표14: 코드 형태·무작위성 — 'lvm_' + base64url 정확히 32자. 31/33자·타 prefix·비허용 문자 거부. ──
{
  const c = genSessionMintCode();
  assert.match(c, /^lvm_[A-Za-z0-9_-]{32}$/, "생성 코드는 lvm_ + base64url 32자");
  assert.ok(isSessionMintCodeShape(c), "생성 코드는 형태검증 통과");
  for (const bad of ["", "lvm_", "lvk_" + "a".repeat(32), "lvm_" + "a".repeat(31), "lvm_" + "a".repeat(33), "lvm_" + "a".repeat(30) + "+/"]) {
    assert.ok(!isSessionMintCodeShape(bad), `형태 거부: ${JSON.stringify(bad)}`);
  }
  assert.notEqual(genSessionMintCode(), genSessionMintCode(), "코드는 매번 달라야 한다");
  ok("표14 — 코드 형태(lvm_+32자) · 무작위성");
}

// ── 표1: 발급 — 저장·감사 어디에도 평문 없음(지문만), TTL 정확히 60초. ──
{
  const f = fakePool();
  const t0 = Date.now();
  const { code, codeHash, expiresAt } = await mintSessionCode("alice", "admin-1", "web", asDb(f));
  assert.equal(codeHash, sha256(code), "반환 지문 = sha256(평문)");
  assert.ok(f.rows.has(codeHash), "저장 키는 지문(해시)");
  assert.ok(!JSON.stringify([...f.rows.values()]).includes(code), "평문 코드는 테이블 어디에도 없다");
  const ttl = expiresAt.getTime() - t0;
  assert.ok(ttl >= SESSION_MINT_TTL_MS - 1000 && ttl <= SESSION_MINT_TTL_MS + 5000, `TTL ≈ 60초(실측 ${ttl}ms)`);
  assert.equal(SESSION_MINT_TTL_MS, 60_000, "TTL 상수는 60초");
  assert.equal(f.audits.length, 1, "발급 감사 1건");
  assert.ok(!JSON.stringify(f.audits).includes(code), "감사에도 평문 코드는 없다(지문 prefix 만)");
  ok("표1 — 발급: 지문 저장 · TTL 60초 · 평문 무유출");
}

// ── 표2+3: 정상 교환 1회 성공(소모 표시·감사 1건) → 같은 코드 재교환 실패(1회성). ──
{
  const f = fakePool();
  const { code, codeHash } = await mintSessionCode("alice", "admin-1", "web", asDb(f));
  const auditsAfterMint = f.audits.length;
  const r1 = await exchangeSessionCode(code, { ip: "10.0.0.1" }, asDb(f));
  assert.deepEqual(r1, { memberId: "alice" }, "유효 코드는 멤버로 교환");
  assert.ok(f.rows.get(codeHash)!.used_at, "성공 교환은 코드를 소모(used_at)");
  assert.equal(f.audits.length, auditsAfterMint + 1, "성공 교환 감사 1건");
  assert.equal(await exchangeSessionCode(code, {}, asDb(f)), null, "🔴 같은 코드 재교환 거부(1회성)");
  ok("표2+3 — 교환 성공 · 🔴 1회성");
}

// ── 표4+5: 만료 — 60s+1s 뒤 거부(소모 표시 없음) · **경계: 만료 시각 정각도 이미 만료**. ──
{
  const f = fakePool();
  const { code, codeHash, expiresAt } = await mintSessionCode("alice", undefined, "web", asDb(f));
  f.now = expiresAt.getTime(); // 경계: now == expires 정각 — '>' 엄격이라 거부여야 한다
  assert.equal(await exchangeSessionCode(code, {}, asDb(f)), null, "🔴 만료 정각(now==expires)은 이미 만료");
  f.now = expiresAt.getTime() + 1000;
  assert.equal(await exchangeSessionCode(code, {}, asDb(f)), null, "🔴 만료 후 교환 거부");
  assert.equal(f.rows.get(codeHash)!.used_at, null, "만료 거부는 소모 표시를 만들지 않는다");
  ok("표4+5 — 🔴 만료 거부 · 경계(정각=만료)");
}

// ── 표6+7: GC 경계 — 만료+정확히 1h 는 잔존, 1h 초과는 다음 교환 시도가 치운다. ──
{
  const f = fakePool();
  const { codeHash, expiresAt } = await mintSessionCode("alice", undefined, "web", asDb(f));
  f.now = expiresAt.getTime() + 3_600_000; // 경계: 만료+정확히 1h
  await exchangeSessionCode(genSessionMintCode(), {}, asDb(f)); // 아무 교환 시도나 GC 트리거
  assert.ok(f.rows.has(codeHash), "만료+정확히 1h 는 아직 잔존('지난' 것만 삭제)");
  f.now = expiresAt.getTime() + 3_600_000 + 1000;
  await exchangeSessionCode(genSessionMintCode(), {}, asDb(f));
  assert.ok(!f.rows.has(codeHash), "만료+1h 초과 행은 lazy GC 로 회수");
  ok("표6+7 — GC 경계(정확히 1h 잔존 · 초과 삭제)");
}

// ── 표8+9+10: 형태 게이트 — 잡문자열·빈 값·null/undefined 는 왕복 0, 미지 코드는 조용히 실패. ──
{
  const f = fakePool();
  assert.equal(await exchangeSessionCode("abc", {}, asDb(f)), null, "잡문자열 거부");
  assert.equal(await exchangeSessionCode("", {}, asDb(f)), null, "빈 문자열 거부");
  // 신규 입력 부재 엣지 — 호출부가 값 없이 부를 수 있다(?code= 생략). 크래시 없이 null 이어야 한다.
  assert.equal(await exchangeSessionCode(null as unknown as string, {}, asDb(f)), null, "null 거부(크래시 없음)");
  assert.equal(await exchangeSessionCode(undefined as unknown as string, {}, asDb(f)), null, "undefined 거부(크래시 없음)");
  assert.equal(f.calls, 0, "형태 불일치 4건 모두 저장소 왕복 0");
  assert.equal(await exchangeSessionCode("lvm_" + "A".repeat(32), {}, asDb(f)), null, "형태만 규격인 미지 코드 거부");
  ok("표8+9+10 — 형태 게이트(왕복 0) · null/undefined 무크래시 · 미지 코드 거부");
}

// ── 표11+12: 멤버 부적격 — 비활성·행 없음(삭제) 둘 다 거부하되 코드는 소진. ──
{
  const f = fakePool();
  const a = await mintSessionCode("bob", "admin-1", "web", asDb(f));   // bob = inactive
  const b = await mintSessionCode("carol", "admin-1", "web", asDb(f)); // carol = org_member 행 없음
  assert.equal(await exchangeSessionCode(a.code, {}, asDb(f)), null, "🔴 비활성 멤버 교환 거부");
  assert.ok(f.rows.get(a.codeHash)!.used_at, "비활성 거부여도 코드는 소진(재시도 무의미)");
  assert.equal(await exchangeSessionCode(b.code, {}, asDb(f)), null, "🔴 멤버 행 없음(삭제)도 거부");
  assert.ok(f.rows.get(b.codeHash)!.used_at, "멤버 부재 거부여도 코드는 소진");
  ok("표11+12 — 🔴 비활성·부재 멤버 거부(코드 소진)");
}

// ── 표13: 실패 무감사 — 위 실패 조합을 한 풀에서 재연해 감사가 '성공 건수'만 남는지 본다. ──
{
  const f = fakePool();
  const good = await mintSessionCode("alice", "admin-1", "web", asDb(f)); // 감사 1(발급)
  const dead = await mintSessionCode("bob", "admin-1", "web", asDb(f));   // 감사 2(발급)
  await exchangeSessionCode("garbage", {}, asDb(f));                      // 실패 — 무감사
  await exchangeSessionCode("lvm_" + "B".repeat(32), {}, asDb(f));        // 실패(미지) — 무감사
  await exchangeSessionCode(dead.code, {}, asDb(f));                      // 실패(비활성) — 무감사
  await exchangeSessionCode(good.code, {}, asDb(f));                      // 성공 — 감사 3
  await exchangeSessionCode(good.code, {}, asDb(f));                      // 실패(재사용) — 무감사
  assert.equal(f.audits.length, 3, "감사 = 발급 2 + 성공 교환 1 (실패 교환 0)");
  ok("표13 — 실패 교환 무감사(발급·성공만 기록)");
}

console.log(`session-mint.test.ts OK (${pass} blocks)`);
