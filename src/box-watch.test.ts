// 박스 경보 전이 규칙 테스트 (#813).
//
//  경보는 **두 방향으로** 실패한다 — 둘 다 사고로 이어진다:
//   ① 안 보내면: 디스크가 차고 DB 가 죽어도 아무도 모른다(= 2026-07-13 사고의 본질).
//   ② 너무 보내면: 5분마다 같은 경보가 오면 사람이 채널을 음소거한다(늑대소년) → 진짜 장애를 놓친다.
//  그래서 **상태가 바뀔 때만** 보내고, **복구도 반드시 알린다**(해제가 안 오면 경보를 못 믿는다).
import assert from "node:assert/strict";
import os from "node:os";
import { diskAlertFor, dbAlertFor, tickOnce, stopBoxWatch, type BoxAlert } from "./box-watch.js";
import type { DiskState } from "./disk-guard.js";
import type { QueryablePool } from "./health.js";

const st = (usedPct: number, level: DiskState["level"]): DiskState =>
  ({ usedPct, level, path: "/srv/lively/shared", availBytes: 2 * 1024 ** 3 });

// ── 디스크: 같은 상태를 반복 통지하지 않는다(늑대소년 방지) ──
{
  assert.equal(diskAlertFor("ok", "ok", st(50, "ok")), null, "상태 그대로면 침묵");
  assert.equal(diskAlertFor("warn", "warn", st(88, "warn")), null, "경고 유지 중엔 재통지 금지 — 5분마다 쏘면 음소거당한다");
  assert.equal(diskAlertFor("critical", "critical", st(97, "critical")), null, "위험 유지 중에도 재통지 금지");
}

// ── 디스크: 부팅 시 정상이면 굳이 알리지 않는다 ──
{
  assert.equal(diskAlertFor(null, "ok", st(40, "ok")), null, "첫 관측이 정상 → 침묵(기동할 때마다 알림이 오면 안 된다)");
  // 단, 첫 관측이 이미 나쁘면 **알려야 한다** — 위험한 상태로 뜬 박스를 침묵으로 넘기면 안 된다.
  assert.ok(diskAlertFor(null, "warn", st(88, "warn")), "첫 관측이 경고면 알린다");
  assert.ok(diskAlertFor(null, "critical", st(97, "critical")), "첫 관측이 위험이면 알린다");
}

// ── 디스크: 악화 전이 — 무엇이 막히는지, 무엇을 해야 하는지 말해야 한다 ──
{
  const a = diskAlertFor("warn", "critical", st(97, "critical"));
  assert.ok(a);
  assert.equal(a.severity, "critical");
  assert.match(a.title, /97/, "몇 % 인지");
  assert.match(a.text, /차단/, "지금 무엇이 막히는지");
  assert.match(a.text, /저장소·로그/, "무엇을 해야 하는지");
  assert.match(a.text, /수동 재시작/, "방치하면 어떻게 되는지(공간만 비워선 안 산다)");
  assert.equal(a.detail.from, "warn");
  assert.equal(a.detail.to, "critical");

  const w = diskAlertFor("ok", "warn", st(88, "warn"));
  assert.ok(w);
  assert.equal(w.severity, "warn");
  assert.match(w.text, /아직 정상 동작/, "경고는 '아직 괜찮다'는 것도 말해야 한다(불필요한 공포 금지)");
}

// ── 디스크: **복구도 반드시 알린다** — 해제가 안 오면 경보를 못 믿는다 ──
{
  const r = diskAlertFor("critical", "ok", st(40, "ok"));
  assert.ok(r, "위험 → 정상 복귀는 반드시 알린다");
  assert.equal(r.severity, "ok");
  assert.match(r.text, /해제/);

  assert.ok(diskAlertFor("warn", "ok", st(40, "ok")), "경고 → 정상도 알린다");
  // 위험 → 경고(부분 완화)도 상태 변화이므로 알린다.
  assert.ok(diskAlertFor("critical", "warn", st(88, "warn")), "위험 → 경고(부분 완화)도 알린다");
}

// ── DB: 다운은 최우선 경보 (= 7/13 사고의 그 상태) ──
{
  assert.equal(dbAlertFor(true, true), null, "정상 유지 → 침묵");
  assert.equal(dbAlertFor(false, false), null, "다운 유지 → 재통지 금지(장애 중에 채널을 도배하면 안 된다)");
  assert.equal(dbAlertFor(null, true), null, "부팅 시 정상 → 침묵");

  const down = dbAlertFor(true, false, "the database system is in recovery mode");
  assert.ok(down);
  assert.equal(down.severity, "critical");
  assert.match(down.text, /로그인/, "무엇이 안 되는지 — '전 기능 실패'를 사람 말로");
  assert.match(down.text, /recovery mode/, "원인 에러를 그대로 전달");
  assert.match(down.text, /재시작/, "공간만 비워선 안 산다는 것(7/13 에 실제로 겪은 함정)");

  const up = dbAlertFor(false, true);
  assert.ok(up, "복구도 알린다");
  assert.equal(up.severity, "ok");

  // 첫 관측이 이미 다운이면 알린다(위험한 상태로 뜬 박스를 침묵으로 넘기지 않는다).
  assert.ok(dbAlertFor(null, false, "connect ECONNREFUSED"), "첫 관측이 다운이면 알린다");
}

// ── 루프 통합: **알린 적 없는 문제의 '해제'는 보내지 않는다** ──
//  (예: 웹훅 min_severity=critical 이라 경고를 안 보냈는데, 경고→정상 복귀 때 "정상 복귀!" 만 오면
//   받는 사람은 "복귀? 언제 문제였는데?" 가 된다. 그래서 send 가 실제로 보냈는지를 보고 해제를 결정한다.)
{
  stopBoxWatch(); // 모듈 상태 초기화
  const sentTitles: string[] = [];
  // send 가 **거절**(false)하는 채널 — min_severity 게이트에 걸린 상황을 흉내낸다.
  const rejectingSend = async (a: BoxAlert): Promise<boolean> => { sentTitles.push("REJECTED:" + a.severity); return false; };

  const okPool: QueryablePool = { query: async () => ({ rows: [] }) };
  // 실제 디스크(tmpdir)를 쓰되 임계치를 조작해 상태를 만든다.
  const deps = (warnPct: number, criticalPct: number, send: (a: BoxAlert) => Promise<boolean>) => ({
    pool: okPool,
    paths: () => [os.tmpdir()],
    loadThresholds: async () => ({ warnPct, criticalPct }),
    send,
  });

  // ① 경고 상태인데 채널이 거절 → '보냈다'로 기록되면 안 된다.
  await tickOnce(deps(1, 100, rejectingSend)); // 실제 사용률은 1% 이상이므로 warn
  assert.ok(sentTitles.some((t) => t === "REJECTED:warn"), "경고 전이는 send 를 호출해야 한다(거절은 채널의 몫)");

  // ② 이제 정상으로 전이 → 앞서 **보낸 적이 없으므로** 해제를 보내면 안 된다.
  sentTitles.length = 0;
  await tickOnce(deps(99, 100, rejectingSend)); // 임계를 높여 ok 로
  assert.deepEqual(sentTitles, [], "⚠ 알린 적 없는 문제의 해제를 보냈다 — 받는 사람이 혼란스럽다");

  stopBoxWatch();

  // ③ 대조군: send 가 **수락**(true)하면 해제도 보낸다.
  const accepted: string[] = [];
  const okSend = async (a: BoxAlert): Promise<boolean> => { accepted.push(a.severity); return true; };
  await tickOnce(deps(1, 100, okSend));            // → warn 전송됨
  assert.deepEqual(accepted, ["warn"]);
  await tickOnce(deps(99, 100, okSend));           // → ok(해제) 전송돼야
  assert.deepEqual(accepted, ["warn", "ok"], "보낸 문제는 해제도 보내야 한다(해제가 안 오면 경보를 못 믿는다)");

  stopBoxWatch();
}

console.log("box-watch.test.ts ok — 전이 시에만 통지(늑대소년 방지) · 보낸 문제만 해제 통지 · 부팅 정상은 침묵 · DB 다운은 최우선");
