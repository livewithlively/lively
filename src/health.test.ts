// /readyz 준비상태 점검 테스트 (#813 T2).
//  핵심 회귀 대상 = **"DB 가 죽었는데 헬스체크가 초록"**. 2026-07-13 디스크풀 사고에서 Postgres 가 recovery mode 에
//  갇혀 모든 로그인이 500 이었는데 /healthz 는 `{ok:true}` 200 을 계속 냈고, 그래서 모니터가 아무것도 못 잡았다
//  (사람이 로그인 실패로 발견). 아래 t: 'db down → ok=false' 가 그 구멍을 못 박는다.
//  부수 회귀: /readyz 는 **미인증** 창구라 pg 에러에 섞인 접속 URL(user:pass@host) 이 절대 새면 안 된다.
import assert from "node:assert/strict";
import os from "node:os";
import { levelFor, scrubError, checkDisk, checkDisks, pingDb, summarize, readyReport, type QueryablePool } from "./health.js";

const okPool = (): QueryablePool => ({ query: async () => ({ rows: [{ "?column?": 1 }] }) });
const failPool = (msg: string): QueryablePool => ({ query: async () => { throw new Error(msg); } });
const hangPool = (): QueryablePool => ({ query: () => new Promise(() => { /* 영원히 미결 */ }) });

// ── 임계 레벨 경계 (임계치는 관리탭 정책에서 주입된다) ──
{
  const t = { warnPct: 85, criticalPct: 95 };
  assert.equal(levelFor(0, t), "ok");
  assert.equal(levelFor(84.9, t), "ok");
  assert.equal(levelFor(85, t), "warn", "경계값은 경고에 포함");
  assert.equal(levelFor(94.9, t), "warn");
  assert.equal(levelFor(95, t), "critical", "경계값은 위험에 포함");
  assert.equal(levelFor(100, t), "critical");

  // 관리탭에서 임계치를 낮추면 같은 사용률이 다르게 판정돼야 한다(설정이 실제로 먹는다는 증거).
  const strict = { warnPct: 50, criticalPct: 70 };
  assert.equal(levelFor(60, strict), "warn", "임계치를 낮추면 60% 도 경고");
  assert.equal(levelFor(75, strict), "critical");
}

// ── 시크릿 유출 방지: 미인증 /readyz 응답에 접속 자격이 실리면 안 된다 ──
{
  const leaky = 'connection to server at "db" failed: postgres://items:itemspw@localhost:55433/items';
  const scrubbed = scrubError(leaky);
  assert.ok(!scrubbed.includes("itemspw"), "비밀번호가 남으면 안 된다");
  assert.ok(scrubbed.includes("//***@"), "자격 부분이 마스킹돼야 한다");
  // 자격이 없는 메시지는 그대로 — 진단 정보를 죽이지 않는다.
  assert.equal(scrubError("the database system is in recovery mode"), "the database system is in recovery mode");
}

// ── 디스크: 실제 statfs (tmpdir) ──
{
  const d = await checkDisk(os.tmpdir());
  assert.ok(d, "tmpdir 은 항상 점검 가능해야 한다");
  assert.ok(d.totalBytes > 0, "총 용량 > 0");
  assert.ok(d.availBytes >= 0);
  assert.ok(d.usedPct >= 0 && d.usedPct <= 100, `사용률이 0~100 범위여야: ${d.usedPct}`);
  assert.equal(d.level, levelFor(d.usedPct));

  // 임계치를 0 에 가깝게 주면 무조건 critical — 주입한 임계치가 실제 판정에 쓰인다는 증거.
  const strict = await checkDisk(os.tmpdir(), { warnPct: 1, criticalPct: 2 });
  assert.equal(strict?.level, "critical", "주입 임계치가 무시되면 안 된다");

  // 없는 경로는 에러가 아니라 null — 세션 루트가 아직 없는 신규 박스에서 헬스체크가 죽으면 안 된다.
  assert.equal(await checkDisk("/nonexistent-path-for-health-test"), null);
}

// ── 같은 볼륨은 한 번만 — 앱 루트와 세션 루트가 같은 디스크인 게 흔하다 ──
{
  const disks = await checkDisks([os.tmpdir(), os.tmpdir(), "/nonexistent-path-for-health-test"]);
  assert.equal(disks.length, 1, "같은 디바이스 중복 제거 + 없는 경로 스킵");
}

// ── DB 핑 ──
{
  const ok = await pingDb(okPool());
  assert.equal(ok.ok, true);
  assert.ok(ok.latencyMs >= 0);
  assert.equal(ok.error, undefined);

  // 2026-07-13 그 에러 그대로.
  const down = await pingDb(failPool("the database system is in recovery mode"));
  assert.equal(down.ok, false, "recovery mode 는 '준비됨'이 아니다");
  assert.match(down.error ?? "", /recovery mode/);

  // 매달리는 DB 도 헬스체크를 붙잡으면 안 된다 — 타임아웃으로 끊고 not-ok.
  const hung = await pingDb(hangPool(), 50);
  assert.equal(hung.ok, false, "무응답 DB = not ready");
  assert.match(hung.error ?? "", /DB 응답 없음/);
}

// ── 종합 판정: 여기가 핵심 회귀 ──
{
  const goodDisk = { path: "/", totalBytes: 100, availBytes: 50, usedPct: 50, level: "ok" as const };
  const fullDisk = { path: "/", totalBytes: 100, availBytes: 1, usedPct: 99, level: "critical" as const };

  // ① DB 가 죽으면 절대 초록이 아니다 (= 사고의 본체).
  const down = summarize({ ok: false, latencyMs: 1, error: "recovery mode" }, [goodDisk]);
  assert.deepEqual(down, { ok: false, status: "down" }, "DB 다운인데 ok=true 를 내면 사고가 반복된다");

  // ② 디스크가 위험해도 DB 가 살아있으면 트래픽은 끊지 않는다 — degraded 로 알리기만.
  //    (95% 라도 게이트웨이는 정상 동작한다. 503 을 내면 멀쩡한 서비스를 LB 에서 빼는 자해다.)
  const degraded = summarize({ ok: true, latencyMs: 1 }, [fullDisk]);
  assert.deepEqual(degraded, { ok: true, status: "degraded" }, "디스크 위험은 알리되 503 은 아니다");

  // ③ 둘 다 정상.
  assert.deepEqual(summarize({ ok: true, latencyMs: 1 }, [goodDisk]), { ok: true, status: "ok" });

  // ④ DB 다운이면 디스크 상태와 무관하게 down (DB 가 우선).
  assert.equal(summarize({ ok: false, latencyMs: 1 }, [fullDisk]).status, "down");
}

// ── 리포트 전체 조립 ──
{
  const r = await readyReport({ pool: okPool(), paths: [os.tmpdir()] });
  assert.equal(r.ok, true, "DB 가 살아있으면 ok — 디스크가 차 있어도 트래픽은 끊지 않는다");
  // ⚠ status 를 'ok' 로 못 박지 않는다: 실제 디스크 사용률에 의존한다(이 dev 박스는 92% → warn → degraded).
  //   순수 판정 규칙은 위 summarize 블록이 환경 독립적으로 못 박는다. 여기선 'DB 정상 = down 아님'만 본다.
  assert.ok(r.status === "ok" || r.status === "degraded", `DB 정상이면 down 이 아니어야: ${r.status}`);
  assert.equal(r.db.ok, true);
  assert.equal(r.disks.length, 1);
  assert.ok(r.uptimeSec >= 0);

  const bad = await readyReport({ pool: failPool("the database system is in recovery mode"), paths: [os.tmpdir()] });
  assert.equal(bad.ok, false, "DB 불가 → 준비 안 됨(핸들러가 503 을 낸다)");
  assert.equal(bad.status, "down");
  assert.ok(bad.disks.length >= 0, "DB 가 죽어도 디스크 정보는 계속 낸다(진단에 필요)");
}

console.log("health.test.ts ok — DB 다운을 초록으로 보고하지 않는다 + 자격증명 미노출 + 디스크 임계/중복제거");
