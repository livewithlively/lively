// 앱 설치 락(#4638) — 2026-10-11 매니지드 전면 정지의 고리를 못박는다.
//  종전: 키 = 앱 id 뿐(전 워크스페이스·롤 마이그레이터가 같은 키) + `pg_advisory_lock` 무기한 대기 + 기다리는 동안 풀 클라이언트를 쥠.
//  유령 DB 세션 하나가 락을 쥔 6분 동안 워크스페이스별 시딩이 풀 20개를 다 잡았고, 락을 얻은 쪽은 본 작업 안에서 두 번째
//  클라이언트를 못 얻어 영구 교착이 됐다(지식 gw-pool-deadlock-orphan-migrator-advisory-lock-2026-10-11).
//  가짜 풀로 «무엇을 체크아웃했고 · 무엇을 돌려줬고 · 어떤 키로 잠갔나» 를 부작용으로 잰다(문구가 아니라).
import { strict as assert } from "node:assert";
import test from "node:test";
import { itemsPool } from "../../db/client.js";
import { withTenant } from "../tenant-context.js";
import { appInstallLockKey, withAppInstallLock } from "./apps.js";

type Grant = boolean | Error;

/** 가짜 풀 — 잠금 시도는 `grants` 순서대로 답한다(Error 면 그 쿼리가 던진다). 체크아웃·반납·키를 적는다. */
function fakePool(grants: Grant[], opts: { unlockFails?: boolean } = {}) {
  const log = { connects: 0, releases: [] as unknown[], tryKeys: [] as string[], unlockKeys: [] as string[], out: 0, maxOut: 0 };
  const pool = itemsPool as unknown as { connect: unknown };
  const had = Object.hasOwn(pool, "connect");
  const orig = pool.connect;
  pool.connect = async () => {
    log.connects++; log.out++; log.maxOut = Math.max(log.maxOut, log.out);
    return {
      query: async (sql: string, params: unknown[]) => {
        if (/pg_try_advisory_lock/.test(sql) || /pg_advisory_lock\(/.test(sql)) {
          log.tryKeys.push(String(params[0]));
          const g = grants.length ? grants.shift()! : false;
          if (g instanceof Error) throw g;
          return { rows: [{ ok: g, pg_try_advisory_lock: g }] };
        }
        if (/pg_advisory_unlock/.test(sql)) {
          log.unlockKeys.push(String(params[0]));
          if (opts.unlockFails) throw new Error("connection gone");
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        throw new Error(`예상 밖 쿼리: ${sql}`);
      },
      release: (destroy?: unknown) => { log.out--; log.releases.push(destroy); },
    };
  };
  return {
    log,
    restore: () => { if (had) pool.connect = orig; else delete (pool as { connect?: unknown }).connect; },
  };
}

// ── A1~A4 키 ─────────────────────────────────────────────────────────────────
test("[A1] 다른 워크스페이스는 같은 앱이라도 다른 락이다 — 남의 설치를 기다리지 않는다", async () => {
  const p = fakePool([true, true]);
  try {
    await withTenant({ id: "ws-a", slug: "a" }, () => withAppInstallLock("hello", async () => undefined));
    await withTenant({ id: "ws-b", slug: "b" }, () => withAppInstallLock("hello", async () => undefined));
    assert.equal(p.log.tryKeys.length, 2, "배선 — 두 번 다 잠금을 시도했다");
    assert.notEqual(p.log.tryKeys[0], p.log.tryKeys[1], `같은 키로 잠갔다: ${p.log.tryKeys.join(" · ")}`);
  } finally { p.restore(); }
});

test("[A2] 같은 워크스페이스·같은 앱은 같은 락이다(직렬화 유지)", async () => {
  const p = fakePool([true, true]);
  try {
    await withTenant({ id: "ws-a", slug: "a" }, () => withAppInstallLock("hello", async () => undefined));
    await withTenant({ id: "ws-a", slug: "a" }, () => withAppInstallLock("hello", async () => undefined));
    assert.equal(p.log.tryKeys.length, 2);
    assert.equal(p.log.tryKeys[0], p.log.tryKeys[1]);
  } finally { p.restore(); }
});

test("[A3] 워크스페이스 맥락이 없으면 앱 id 하나로 잠근다(종전 키 — blue/green 프로세스 사이 직렬화)", async () => {
  const p = fakePool([true]);
  try {
    await withAppInstallLock("hello", async () => undefined);
    assert.deepEqual(p.log.tryKeys, ["app-install:hello"]);
    assert.equal(appInstallLockKey("hello", null), "app-install:hello");
    assert.equal(appInstallLockKey("hello", undefined), "app-install:hello");
  } finally { p.restore(); }
});

test("[A4] 워크스페이스 id 가 빈 문자열이면 맥락 없음과 같은 키다", () => {
  assert.equal(appInstallLockKey("hello", ""), appInstallLockKey("hello", null));
  assert.equal(withTenant({ id: "", slug: "" }, () => appInstallLockKey("hello")), "app-install:hello");
});

// ── A5~A8 기다림 ─────────────────────────────────────────────────────────────
test("[A5] 첫 시도에 얻으면 — 체크아웃 1회 · 본 작업 1회 · 풀기 1회 · 풀로 반납", async () => {
  const p = fakePool([true]);
  let runs = 0;
  try {
    const out = await withAppInstallLock("hello", async () => { runs++; return 42; }, { pollMs: 1 });
    assert.equal(out, 42);
    assert.equal(runs, 1);
    assert.equal(p.log.connects, 1);
    assert.equal(p.log.unlockKeys.length, 1);
    assert.equal(p.log.releases.length, 1);
    assert.ok(!p.log.releases[0], "푼 연결은 풀로 돌려준다(버리지 않는다)");
    assert.equal(p.log.out, 0);
  } finally { p.restore(); }
});

test("[A6] 기다리는 동안엔 풀 자리를 쥐지 않는다 — 두 번 못 얻고 세 번째에 얻어도 동시에 쥔 자리는 최대 1", async () => {
  const p = fakePool([false, false, true]);
  let runs = 0;
  let outDuringFn = -1;
  try {
    await withAppInstallLock("hello", async () => { runs++; outDuringFn = p.log.out; }, { pollMs: 1 });
    assert.equal(p.log.tryKeys.length, 3, "배선 — 세 번 시도했다");
    assert.equal(p.log.maxOut, 1, `실패한 시도의 클라이언트를 쥔 채 다음 시도를 했다(최대 ${p.log.maxOut}개)`);
    assert.equal(outDuringFn, 1, "본 작업 동안엔 락 연결 하나만 쥔다");
    assert.equal(runs, 1);
    assert.equal(p.log.out, 0);
  } finally { p.restore(); }
});

test("[A7] 상한 동안 못 얻으면 실패로 끝난다 — 본 작업 0회 · 쥔 자리 0 · 무기한 기다리지 않는다", async () => {
  const p = fakePool([]);
  let runs = 0;
  try {
    const t0 = Date.now();
    await assert.rejects(withAppInstallLock("hello", async () => { runs++; }, { waitMs: 30, pollMs: 2 }));
    assert.ok(Date.now() - t0 < 2_000, "상한 근처에서 끝나야 한다");
    assert.ok(p.log.tryKeys.length >= 2, "배선 — 상한 안에서 다시 시도했다");
    assert.equal(runs, 0);
    assert.equal(p.log.out, 0);
    assert.equal(p.log.unlockKeys.length, 0, "얻지 못한 락을 풀지 않는다");
  } finally { p.restore(); }
});

test("[A8] 상한 0 — 한 번 시도하고 곧바로 실패한다(잠들지 않는다)", async () => {
  const p = fakePool([]);
  try {
    await assert.rejects(withAppInstallLock("hello", async () => undefined, { waitMs: 0, pollMs: 5_000 }));
    assert.equal(p.log.tryKeys.length, 1);
    assert.equal(p.log.out, 0);
  } finally { p.restore(); }
});

// ── A9~A11 실패 경로 ─────────────────────────────────────────────────────────
test("[A9] 본 작업이 던지면 — 그 오류로 끝나고 · 락을 풀고 · 풀로 반납한다", async () => {
  const p = fakePool([true]);
  try {
    await assert.rejects(withAppInstallLock("hello", async () => { throw new Error("boom"); }), /boom/);
    assert.equal(p.log.unlockKeys.length, 1);
    assert.equal(p.log.releases.length, 1);
    assert.ok(!p.log.releases[0], "풀로 돌려준다(버리지 않는다)");
    assert.equal(p.log.out, 0);
  } finally { p.restore(); }
});

test("[A10] 풀기에 실패한 연결은 풀에 돌려주지 않고 버린다 — 락을 쥔 채 풀에 남지 않게", async () => {
  const p = fakePool([true], { unlockFails: true });
  try {
    await withAppInstallLock("hello", async () => undefined);
    assert.equal(p.log.releases.length, 1);
    assert.ok(p.log.releases[0], `연결을 버려야 한다(release 에 참값) — 받은 값: ${String(p.log.releases[0])}`);
    assert.equal(p.log.out, 0);
  } finally { p.restore(); }
});

test("[A11] 잠금 시도 자체가 DB 오류면 — 그 오류로 끝나고 · 본 작업 0회 · 쥔 자리 0", async () => {
  const p = fakePool([new Error("db down")]);
  let runs = 0;
  try {
    await assert.rejects(withAppInstallLock("hello", async () => { runs++; }, { pollMs: 1 }), /db down/);
    assert.equal(runs, 0);
    assert.equal(p.log.out, 0);
  } finally { p.restore(); }
});
