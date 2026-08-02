// 박스 경보 전이 규칙 테스트 (#813).
//
//  경보는 **두 방향으로** 실패한다 — 둘 다 사고로 이어진다:
//   ① 안 보내면: 디스크가 차고 DB 가 죽어도 아무도 모른다(= 2026-07-13 사고의 본질).
//   ② 너무 보내면: 5분마다 같은 경보가 오면 사람이 채널을 음소거한다(늑대소년) → 진짜 장애를 놓친다.
//  그래서 **상태가 바뀔 때만** 보내고, **복구도 반드시 알린다**(해제가 안 오면 경보를 못 믿는다).
import assert from "node:assert/strict";
import os from "node:os";
import { diskAlertFor, dbAlertFor, memAlertFor, memLevelOf, ptyAlertFor, ptyLevelOf, earlyoomAlertFor, tickOnce, stopBoxWatch, type BoxAlert } from "./box-watch.js";
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
  assert.match(a.text, /저장소/, "무엇을 해야 하는지(관리 ▸ 컴퓨팅 리소스 ▸ 저장소)");
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

// ── 메모리(#1059): 단계 판정 — 0 임계는 그 단계 끔, 나머지는 디스크와 같은 방향(used% 클수록 나쁨) ──
{
  // 0/0 = 완전 끔 → 아무리 높아도 ok(경보 안 함).
  assert.equal(memLevelOf(99, { warnPct: 0, criticalPct: 0 }), "ok", "0/0 = 끔 → 항상 ok");
  // 경계값(>=): 정확히 임계면 그 단계.
  assert.equal(memLevelOf(85, { warnPct: 85, criticalPct: 95 }), "warn", "정확히 warn 임계 → warn");
  assert.equal(memLevelOf(84, { warnPct: 85, criticalPct: 95 }), "ok", "warn 임계 미만 → ok");
  assert.equal(memLevelOf(95, { warnPct: 85, criticalPct: 95 }), "critical", "정확히 critical 임계 → critical");
  assert.equal(memLevelOf(94, { warnPct: 85, criticalPct: 95 }), "warn", "critical 미만·warn 이상 → warn");
  // 한쪽만 켠 경우: critical 만(warn=0) → warn 단계는 안 뜨고 critical 만.
  assert.equal(memLevelOf(90, { warnPct: 0, criticalPct: 95 }), "ok", "warn 끔·critical 미만 → ok");
  assert.equal(memLevelOf(96, { warnPct: 0, criticalPct: 95 }), "critical", "warn 끔이어도 critical 은 동작");
  // warn 만(critical=0) → critical 단계는 안 뜸.
  assert.equal(memLevelOf(99, { warnPct: 85, criticalPct: 0 }), "warn", "critical 끔이면 아무리 높아도 warn 까지만");
}

// ── 메모리: 전이 규칙(디스크와 동형) — 같은상태 침묵 · 부팅정상 침묵 · 악화 알림 · 복구 알림 ──
{
  const ms = (usedPct: number, availableMb: number) => ({ usedPct, availableMb, totalMb: 16000 });
  assert.equal(memAlertFor("warn", "warn", ms(88, 1900)), null, "경고 유지 → 침묵(늑대소년 방지)");
  assert.equal(memAlertFor("critical", "critical", ms(97, 400)), null, "위험 유지 → 침묵");
  assert.equal(memAlertFor(null, "ok", ms(40, 9000)), null, "부팅 시 정상 → 침묵");
  assert.ok(memAlertFor(null, "critical", ms(97, 400)), "첫 관측이 위험이면 알린다(위험 상태로 뜬 박스 방치 금지)");

  const a = memAlertFor("warn", "critical", ms(97, 400));
  assert.ok(a);
  assert.equal(a.severity, "critical");
  assert.match(a.title, /97|400/, "몇 %·가용 몇 MB 인지");
  assert.match(a.text, /OOM/, "OOM 위험임을 명시(#1059 다운의 그 상태)");
  assert.match(a.text, /메모리/, "무엇을 해야 하는지(관리 ▸ 컴퓨팅 리소스 ▸ 메모리)");
  assert.equal(a.detail.from, "warn");
  assert.equal(a.detail.to, "critical");

  const w = memAlertFor("ok", "warn", ms(88, 1900));
  assert.ok(w); assert.equal(w.severity, "warn");

  const r = memAlertFor("critical", "ok", ms(40, 9000));
  assert.ok(r, "위험 → 정상 복귀는 반드시 알린다"); assert.equal(r.severity, "ok");
}

// ── PTY(#687 후속): 단계 판정 — 메모리·디스크와 동형(0=끔, >= 경계) ──
{
  assert.equal(ptyLevelOf(99, { warnPct: 0, criticalPct: 0 }), "ok", "0/0 = 끔 → 항상 ok");
  assert.equal(ptyLevelOf(70, { warnPct: 70, criticalPct: 85 }), "warn", "정확히 warn 임계 → warn");
  assert.equal(ptyLevelOf(69, { warnPct: 70, criticalPct: 85 }), "ok", "warn 미만 → ok");
  assert.equal(ptyLevelOf(85, { warnPct: 70, criticalPct: 85 }), "critical", "정확히 critical 임계 → critical");
  // 한도를 이미 넘긴 상태(>100%)도 실제로 관측된다(맥미니 527/511) — 그때도 critical 이어야 한다.
  assert.equal(ptyLevelOf(103, { warnPct: 70, criticalPct: 85 }), "critical", "한도 초과(100% 넘음)도 critical");
  assert.equal(ptyLevelOf(99, { warnPct: 70, criticalPct: 0 }), "warn", "critical 끔이면 아무리 높아도 warn 까지만");
}

// ── PTY: 전이 규칙 + 누수 판별(장부 대비 실제) ──
{
  const ps = (used: number, attachCount: number | null, fdLeak: number | null = 0, procLeak: number | null = 0, orphans: number | null = 0) =>
    ({ used, max: 511, usedPct: Math.round((used / 511) * 100), attachCount, fdLeak, procLeak, orphans });

  assert.equal(ptyAlertFor("warn", "warn", ps(370, 12)), null, "경고 유지 → 침묵(늑대소년 방지)");
  assert.equal(ptyAlertFor(null, "ok", ps(60, 8)), null, "부팅 시 정상 → 침묵");
  assert.ok(ptyAlertFor(null, "critical", ps(470, 10)), "첫 관측이 위험이면 알린다");

  // 악화 — '무엇이 막히는지'가 핵심이다. PTY 고갈은 ssh 까지 끊어 원격 복구 자체를 불가능하게 만든다.
  const a = ptyAlertFor("warn", "critical", ps(470, 10, 460, 0));
  assert.ok(a);
  assert.equal(a.severity, "critical");
  assert.match(a.title, /470|511/, "몇 개 중 몇 개인지");
  assert.match(a.text, /ssh/, "ssh 까지 막힌다는 사실 — 이게 디스크·메모리와 다른 지점");
  assert.match(a.text, /재시작/, "즉시 조치(게이트웨이 재시작으로 회수)");
  assert.equal(a.detail.from, "warn");
  assert.equal(a.detail.fdLeak, 460);

  // ── 누수 판별은 **장부 대비 실제**로 한다(시스템 사용량과의 차이가 아니라) ──
  assert.match(a.text, /누수 감지/, "fd 축 누수는 누수라고 짚는다");
  assert.match(a.text, /fd 460/, "어느 축이 얼마나 샜는지 수치로");

  const procOnly = ptyAlertFor("ok", "warn", ps(370, 6, 0, 333));
  assert.ok(procOnly);
  assert.match(procOnly.text, /attach 프로세스 333/, "프로세스 축 누수도 별도로 짚는다(리눅스 SIGHUP 축)");

  // ⚠ 오탐 회귀 가드 — 이게 이 지표를 바꾼 이유다.
  //  고객사 A 실박스 실측: 시스템 112 / attach 6 이라 '차이'는 106 이지만 전부 정상 사용분이었다
  //  (tmux pane ~50 · root ssh 17 · 멤버 pty ~39). 옛 차이 기반 판정은 여기서 상시 "누수 의심"을 띄웠다.
  //  장부 대비 실제로 보면 누수 0 이므로 누수라고 말하면 안 된다 — 박스 규모가 아무리 커도.
  const ernest = ptyAlertFor("ok", "warn", ps(112, 6, 0, 0));
  assert.ok(ernest);
  assert.doesNotMatch(ernest.text, /누수 감지/, "정상분이 아무리 많아도 누수 0 이면 누수라고 하지 않는다");
  assert.match(ernest.text, /누수는 없습니다/, "대신 '실사용'임을 명시해 조치를 세션 정리로 돌린다");
  const huge = ptyAlertFor("ok", "warn", ps(5000, 3, 0, 0)); // baseline 이 극단적으로 큰 박스
  assert.ok(huge);
  assert.doesNotMatch(huge.text, /누수 감지/, "baseline 크기와 무관 — 판정은 장부 대비 실제만 본다");

  // ── 고아(PPID=1) 축 — 자식 게이트로 세는 procLeak 엔 **원리적으로** 안 잡히므로 따로 말해야 한다(#687 버그B).
  //  부모가 죽어 장부에도 없으니 '차이'가 아니라 절대 개수 그대로 싣는다.
  const orphaned = ptyAlertFor("ok", "warn", ps(370, 4, 0, 0, 88));
  assert.ok(orphaned);
  assert.match(orphaned.text, /누수 감지/, "자식 누수가 0 이어도 고아가 있으면 누수다");
  assert.match(orphaned.text, /고아 attach 88/, "고아 수를 그대로 짚는다");
  assert.equal(orphaned.detail.procLeak, 0, "고아를 프로세스 축에 섞지 않는다(출처가 다르다)");

  // 못 잰 경우(미배선·플랫폼 미지원)엔 추측하지 않는다 — 있지도 않은 누수도, 없다는 단정도 하지 않는다.
  const unknown = ptyAlertFor("ok", "warn", ps(370, 10, null, null, null));
  assert.ok(unknown);
  assert.doesNotMatch(unknown.text, /누수/, "못 쟀으면 누수 여부를 말하지 않는다");

  const r = ptyAlertFor("critical", "ok", ps(60, 8));
  assert.ok(r, "위험 → 정상 복귀는 반드시 알린다"); assert.equal(r.severity, "ok");
}

// ── #1240 earlyoom kill 경보 ────────────────────────────────────────────────────────────
// 다른 경보와 성격이 다르다: **임계가 없고, 전이가 아니라 사건**이다. 그래서 늑대소년 방지 장치도 다르다 —
//  '상태가 바뀔 때만'이 아니라 '**아직 안 알린 사건만**'(커서)으로 억제한다.
const kill = (over: Partial<{ at: number; vmRssMb: number; name: string }> = {}) =>
  ({ at: 1, signal: "SIGTERM", pid: 1, uid: 1002, name: "claude", badness: 978, vmRssMb: 177, ...over });

// A1 — 사건이 없으면 침묵
assert.equal(earlyoomAlertFor([]), null, "kill 이 없으면 알리지 않는다");

// A2 — 1건: critical + **회수량**이 실린다(#1220 교훈 — badness 가 아니라 이 값이 실제로 되찾은 RAM 이다)
{
  const a = earlyoomAlertFor([kill()]);
  assert.equal(a?.severity, "critical", "사용자 프로세스가 이미 강제 종료된 사건이므로 critical");
  assert.equal((a?.detail as any).freedMb, 177);
  assert.equal((a?.detail as any).chainSuspected, false, "1건은 연쇄 판정 대상이 아니다");
  assert.ok(a!.title.includes("177MB"), "회수량이 제목에 보여야 한다(사람이 한눈에 '풀렸나'를 안다)");
}

// A3 — 여러 건인데 건당 회수량이 작다 = **죽여도 압박이 안 풀려 연쇄로 죽는 상태**(#1220 이 고친 바로 그 증상)
{
  const a = earlyoomAlertFor([kill({ vmRssMb: 10 }), kill({ vmRssMb: 12 }), kill({ vmRssMb: 8 })]);
  assert.equal((a?.detail as any).chainSuspected, true, "연쇄 학살 징후를 표시해야 한다");
  assert.ok(a!.text.includes("연쇄"), "본문이 그 뜻을 사람 말로 설명해야 한다");
}

// A4 — 여러 건이어도 건당 회수량이 크면 연쇄가 아니다(큰 놈을 제대로 걷어낸 정상 동작)
{
  const a = earlyoomAlertFor([kill({ vmRssMb: 3300, name: "llama-server" }), kill({ vmRssMb: 900 })]);
  assert.equal((a?.detail as any).chainSuspected, false, "회수량이 크면 연쇄로 오인하면 안 된다");
}

// ── T: tick 통합 — 커서로 '아직 안 알린 사건만' ─────────────────────────────────────────
{
  stopBoxWatch();                                   // 모듈 커서 초기화
  const okPool2: QueryablePool = { query: async () => ({ rows: [] }) };
  const sent: BoxAlert[] = [];
  let kills: any[] = [];
  let throwOnRead = false;
  const d = {
    pool: okPool2,
    paths: () => [os.tmpdir()],
    loadThresholds: async () => ({ warnPct: 99, criticalPct: 100 }),   // 디스크는 조용하게
    readKills: async () => { if (throwOnRead) throw new Error("insufficient permissions"); return kills; },
    send: async (a: BoxAlert) => { sent.push(a); return true; },
  };
  const eo = () => sent.filter((a) => a.title.includes("earlyoom"));

  // T1 — 첫 tick 은 커서만 세우고 **알리지 않는다**. 재시작마다 옛 kill 이 다시 울리면 아무도 경보를 안 믿는다.
  kills = [kill({ at: Date.now() - 60_000 })];
  await tickOnce(d as any);
  assert.equal(eo().length, 0, "부팅 후 첫 tick 은 지난 kill 을 재방송하지 않는다");

  // T2 — 그 다음 tick 에 새 사건이 있으면 알린다
  const future = Date.now() + 60_000;
  kills = [kill({ at: future })];
  await tickOnce(d as any);
  assert.equal(eo().length, 1, "커서 이후의 새 kill 은 알린다");

  // T3 — 같은 사건이 다시 조회돼도 **중복 통지하지 않는다**(저널은 조회할 때마다 같은 줄을 준다)
  await tickOnce(d as any);
  assert.equal(eo().length, 1, "이미 알린 사건은 다시 알리지 않는다(커서가 전진해야 한다)");

  // T4 — 저널을 못 읽어도 tick 자체는 죽지 않는다(관측 실패가 감시를 멈추면 본말전도)
  throwOnRead = true;
  await tickOnce(d as any);
  assert.equal(eo().length, 1, "읽기 실패는 조용히 넘어간다");
  throwOnRead = false;

  // T5 — 더 나중 사건이 오면 다시 알린다(커서가 미래로 고정돼 영영 침묵하지 않는지)
  kills = [kill({ at: future + 60_000 })];
  await tickOnce(d as any);
  assert.equal(eo().length, 2, "커서보다 나중 사건은 계속 알려야 한다");
  stopBoxWatch();
}

// ── #1251 kill → 세션 되짚기 ────────────────────────────────────────────────────────────
// 이 매핑은 **틀리면 안 붙이는 쪽**으로 설계됐다. 엉뚱한 세션에 '메모리 부족으로 종료됨'이 박히면
//  사용자는 있지도 않은 원인을 쫓는다. 못 붙였을 때의 손실은 '종전과 같음'뿐이다.
{
  stopBoxWatch();
  const okPool3: QueryablePool = { query: async () => ({ rows: [] }) };
  const marked: string[] = [];
  let owners = new Map<number, { sessionId: string; name: string }>();
  let liveIds = new Set<string>();
  let liveKnown = true;   // #1251 — 이번 tick 에 tmux 를 실제로 읽었나
  let kills: any[] = [];
  const d = {
    pool: okPool3,
    paths: () => [os.tmpdir()],
    loadThresholds: async () => ({ warnPct: 99, criticalPct: 100 }),
    readKills: async () => kills,
    snapshotSessions: async () => ({ owners, liveIds, liveKnown }),
    markOomKilled: async (id: string) => { marked.push(id); return true; },
    send: async () => true,
  };
  const K = (over: any = {}) => ({ at: Date.now() + 60_000, signal: "SIGTERM", pid: 500, uid: 1002, name: "claude", badness: 978, vmRssMb: 177, ...over });

  // S1 — 첫 tick: 스냅샷이 아직 없다 → 되짚을 근거가 없으므로 안 붙인다.
  owners = new Map(); liveIds = new Set(["box-a"]); kills = [K()];
  await tickOnce(d as any);
  assert.deepEqual(marked, [], "첫 tick 은 스냅샷이 없어 매핑하지 않는다");

  // 이제 스냅샷이 생겼다(box-a 의 pid 500 = claude). 그리고 그 세션이 사라졌다.
  owners = new Map([[500, { sessionId: "box-a", name: "claude" }]]);
  await tickOnce(d as any);            // 스냅샷을 채우는 tick — 이 kill 은 조건①(직전 스냅샷이 빔)에 막혀 안 붙는다
  marked.length = 0;

  // S2 — 세션이 **아직 살아있다** → 그 kill 은 이 세션 것이 아니다(pid 재사용의 결정적 반증)
  liveIds = new Set(["box-a"]); kills = [K({ at: Date.now() + 120_000 })];
  await tickOnce(d as any);
  assert.deepEqual(marked, [], "세션이 살아있으면 안 붙인다");

  // S3 — 사라졌고 comm 도 일치 → **붙인다**
  liveIds = new Set(); kills = [K({ at: Date.now() + 180_000 })];
  await tickOnce(d as any);
  assert.deepEqual(marked, ["box-a"], "pid 소유 + comm 일치 + 실제 소멸 → 라벨을 붙인다");

  // S4 — comm 불일치(그 사이 pid 가 재사용됨) → 안 붙인다
  marked.length = 0; owners = new Map([[500, { sessionId: "box-a", name: "claude" }]]);
  await tickOnce(d as any); marked.length = 0;
  kills = [K({ at: Date.now() + 240_000, name: "python3" })];
  await tickOnce(d as any);
  assert.deepEqual(marked, [], "comm 이 다르면 pid 재사용으로 보고 안 붙인다");

  // S5 — 우리 세션 pid 가 아니면 안 붙인다(시스템 프로세스가 죽은 경우)
  marked.length = 0; kills = [K({ at: Date.now() + 300_000, pid: 9999 })];
  await tickOnce(d as any);
  assert.deepEqual(marked, [], "스냅샷에 없는 pid 는 우리 세션이 아니다");

  // S6 — 기록이 throw 해도 **같은 배치의 나머지 kill 은 계속 처리된다**(한 건의 DB 실패가 나머지를 삼키면 안 된다).
  marked.length = 0;
  owners = new Map([[500, { sessionId: "box-a", name: "claude" }], [501, { sessionId: "box-b", name: "claude" }]]);
  await tickOnce(d as any); marked.length = 0;
  liveIds = new Set();
  const okAfterThrow: string[] = [];
  const boom = {
    ...d,
    markOomKilled: async (id: string) => { if (id === "box-a") throw new Error("db down"); okAfterThrow.push(id); return true; },
  };
  kills = [K({ at: Date.now() + 360_000, pid: 500 }), K({ at: Date.now() + 361_000, pid: 501 })];
  await tickOnce(boom as any);   // throw 가 새면 여기서 터진다
  assert.deepEqual(okAfterThrow, ["box-b"], "한 세션의 기록 실패가 나머지 세션 처리를 막으면 안 된다");

  // ── S7: ⚠ blocking 회귀락 — **liveness 를 못 재면 아무것도 안 붙인다** ──
  //  조건 ③은 '목록에 없음'을 죽음의 결정적 증거로 쓴다. 그런데 tmux 조회가 실패하면 목록이 통째로 비어
  //  **살아있는 모든 세션이 죽은 것으로 보인다.** 그 실패는 하필 메모리 압박(스래싱·tmux 타임아웃)에서
  //  잘 나므로 — earlyoom 이 도는 바로 그 순간 — 가장 위험할 때 가장 크게 틀린다.
  marked.length = 0;
  owners = new Map([[500, { sessionId: "box-a", name: "claude" }]]);
  liveKnown = true; liveIds = new Set(["box-a"]);
  await tickOnce(d as any); marked.length = 0;
  liveKnown = false; liveIds = new Set();        // tmux 조회 실패 → 목록이 비어 보인다(세션은 살아 있다)
  kills = [K({ at: Date.now() + 420_000, pid: 500 })];
  await tickOnce(d as any);
  assert.deepEqual(marked, [], "tmux 를 못 읽은 tick 에는 절대 라벨을 붙이지 않는다(살아있는 세션 오표기 방지)");
  liveKnown = true;
  stopBoxWatch();
}

console.log("box-watch.test.ts ok — 전이 시에만 통지(늑대소년 방지) · 보낸 문제만 해제 통지 · 부팅 정상은 침묵 · DB 다운은 최우선 · 메모리 경보(#1059) 단계·전이 · PTY 경보(#687 후속) 단계·전이·누수판별 · earlyoom kill(#1240) 사건 통지·커서 중복억제");
