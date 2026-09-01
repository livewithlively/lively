// 테넌트별 부팅 스텝은 **매니지드에서 닿는 길**이 있어야 한다 (#2452).
//
//  ★ 이 파일이 있는 이유. 중앙 게이트웨이 모드는 프로세스가 **한 번** 뜨고 요청마다 테넌트를 바꿔
//   단다. 그래서 «부팅 때 한 번»과 «테넌트당 한 번»이 갈라지는데, `gate` 는 그 축을 안 본다
//   (`gate` 는 «스케줄러가 도는 배포인가»를 묻는다). 자가호스팅에선 둘이 같은 말이라 아무도
//   구별할 필요가 없었다.
//
//  ⚠ 그래서 실제로 일어난 일(2026-08-31 실측): `seed-builtin-apps` 는 `gate:"always"` 인데도
//   **한 번도 안 돌았다.** 라이브 테넌트 8개 중 7개가 `org_app=0` 이었고, ai-session 의
//   「답을 기다려요」 알림이 전이를 정확히 감지하고도 `notify-app-inactive` 로 전량 거절됐다
//   (20분 denied 6 / notified 0). 사람에게 도달하는 회귀였는데 **아무 시험도 이걸 안 봤다.**
//   그리고 그건 알림 버그를 쫓다 **우연히** 발견됐다 — 그게 이 게이트를 만든 이유다.
//
//  ⓘ 여기서 «닿는 길»은 셋 중 하나다:
//    ① 요청 정비표(`sessions/outbox-request-sweep.ts` 의 SWEEP_JOBS) — 요청을 받는 모든 테넌트
//    ② CP 하우스키핑 틱(`web.ts` 의 /api/ops/housekeeping/tick) — running 테넌트
//    ③ 프로비저닝(`capabilities/delivery/workspace-registry.ts`) — 새 워크스페이스 생성 시
//  각 경로는 커버 범위가 다르다(①만 stopped 테넌트를 덮는다) — 그래서 **어디에 얹었는지**를
//  스텝마다 아래 표에 적어 둔다. 표에 없으면 이 시험이 막는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { LISTEN_STEPS, DB_BOOT_STEPS, type BootStep } from "./housekeeping.js";

const SRC = "src/boot/housekeeping.ts";

/** 매니지드에서 그 스텝이 닿는 경로. 여기 없는 per-tenant 스텝은 **아무도 안 부른다**는 뜻이다. */
const REACH: Record<string, { via: string; file: string; needle: string }> = {
  "seed-default-content":       { via: "CP 하우스키핑 틱", file: "src/web.ts", needle: "seedDefaultContent()" },
  "seed-builtin-apps":          { via: "요청 정비표",       file: "src/sessions/outbox-request-sweep.ts", needle: "seedBuiltinApps()" },
  //  ↓ 아직 닿는 길이 없다. 지금은 데이터가 0이라 손해가 없지만(실측 2026-08-31:
  //   connector_run running 0건 · org_node_state 1건 · org_connector 0건), 데이터가 생기면 손해가 난다.
  //   **의도적으로 비워 두지 않는다** — 아래 시험이 이 셋을 «미해결»로 계속 세어 보여 준다.
};

/** 닿는 길이 아직 없다고 **명시적으로** 인정한 것들. 조용히 빠지는 것과 다르다. */
const KNOWN_UNREACHED: Record<string, string> = {
  "node-state-hydrate":         "org_node_state 복구 — 노드가 다시 push 하면 채워진다(실측 잔재 0)",
  "orphan-connector-run-sweep": "유령 connector_run 회수 — 커넥터 0개라 지금은 무해(실측 잔재 0)",
  "collector-migration":        "org_connector→org_collector 이관 — org_connector 0개라 무동작",
  "app-worker-recovery":        "앱 워커 run 회수 — 앱 워커 미사용",
};

const all = (): BootStep[] => [...LISTEN_STEPS, ...DB_BOOT_STEPS];
const perTenant = (): BootStep[] => all().filter((s) => s.tenancy === "per-tenant");

test("[K1] 테넌트별 스텝은 «닿는 길» 표 아니면 «미해결» 표 중 정확히 한 곳에 있다", () => {
  for (const s of perTenant()) {
    const inReach = s.name in REACH, inKnown = s.name in KNOWN_UNREACHED;
    assert.ok(inReach || inKnown,
      `'${s.name}' 은 테넌트별인데 매니지드에서 닿는 길이 없다 — 신규 테넌트는 이걸 영영 못 만난다. ` +
      `경로를 만들어 REACH 에 적거나, 지금 무해한 이유를 KNOWN_UNREACHED 에 적어라.`);
    assert.ok(!(inReach && inKnown), `'${s.name}' 이 두 표에 다 있다 — 어느 쪽이 사실인가`);
  }
});

test("[K2] «닿는 길»이 실제로 그 파일에 있다 — 표가 현실을 앞서지 않게", () => {
  for (const [name, r] of Object.entries(REACH)) {
    const src = readFileSync(r.file, "utf8");
    assert.ok(src.includes(r.needle),
      `'${name}' 의 길이 ${r.via}(${r.file})라고 적혀 있는데 그 파일에 ${r.needle} 이 없다 — 표가 낡았다`);
  }
});

test("[K3] 표에 적힌 이름이 실제 스텝이다 — 스텝이 사라져도 표만 남는 것을 막는다", () => {
  const names = new Set(all().map((s) => s.name));
  for (const n of [...Object.keys(REACH), ...Object.keys(KNOWN_UNREACHED)])
    assert.ok(names.has(n), `표에 '${n}' 이 있는데 그런 부팅 스텝이 없다 — 지워졌거나 이름이 바뀌었다`);
});

test("[K4] 표에 오른 것은 전부 per-tenant 로 표시돼 있다", () => {
  const marked = new Set(perTenant().map((s) => s.name));
  for (const n of [...Object.keys(REACH), ...Object.keys(KNOWN_UNREACHED)])
    assert.ok(marked.has(n), `'${n}' 이 표에 있는데 tenancy 표시가 빠졌다 — 표시가 사라지면 K1 이 헛돈다`);
});

test("[K5] tenancy 축이 gate 축과 **다르다** — gate 만 봐서는 이 결함이 안 보인다", () => {
  //  실제로 문제였던 seed-builtin-apps 는 gate:"always" 였다. per-tenant 중 always 가 하나라도
  //  있어야 이 축이 gate 로 환원되지 않음이 증명된다.
  const alwaysPerTenant = perTenant().filter((s) => s.gate === "always");
  assert.ok(alwaysPerTenant.length > 0,
    "per-tenant 가 전부 gate:'scheduler' 라면 새 축이 필요 없다 — 그렇지 않음을 여기서 못 박는다");
});

test("[K6] 미표시 스텝은 global 로 동작한다(기본값) — 새 스텝이 조용히 per-tenant 가 되지 않게", () => {
  const unmarked = all().filter((s) => s.tenancy === undefined);
  assert.ok(unmarked.length > 0, "전부 표시됐다면 기본값 경로가 죽은 것이다");
  for (const s of unmarked) assert.equal(s.tenancy ?? "global", "global");
});

test("[K7] 실측 근거가 파일에 남아 있다 — 왜 이 축을 만들었는지", () => {
  const src = readFileSync(SRC, "utf8");
  assert.match(src, /org_app=0/, "seed-builtin-apps 사고의 실측 수치가 사라지면 다음 사람이 이 축을 지운다");
});

// ── registry 축 (#2479) ───────────────────────────────────────────────────────
//
//  ★ 위 표는 **매니지드(중앙 모드)** 만 본다. 그래서 registry(#1750 셀프호스트 다중 워크스페이스)가
//   통째로 빠져 있었다 — 세 «닿는 길»이 registry 에선 전부 안 닿는다:
//    ① 요청 정비표 → `requestScopedTenancy()` 가 `&& !registryModeActive()` 라 무동작
//    ② CP 틱      → 셀프호스트엔 CP 자체가 없다
//    ③ 프로비저닝  → `seedBuiltinApps()` 를 안 불렀다(그게 아래 R3 이 막는 것)
//   registry 에서 하우스키핑은 **돌지만** 타이머가 컨텍스트 밖이라 primary 로만 떨어진다.
//   그래서 여기가 registry 의 유일한 길이다: 주기 정비를 `perTenant(...)` 로 순회시킨다.
//
//  ⚠ 실측 2026-09-01 dev.lvly.io(워크스페이스 약 90개): 아웃박스 청소 잔존이 비-primary 81곳에
//   **245건**(최고 12일)인데 **primary 는 0건** · 활성 비-primary **84곳 전부 `org_app=0`**(primary 만 5개).
//   primary 의 0/5 가 대조군이다 — 로직은 멀쩡하고 그 워크스페이스에 **안 온 것**이다.

/** 순회해야 하는 주기 정비 — 테넌트 스코프 데이터를 만지므로 primary 만 돌면 나머지가 방치된다. */
const MUST_FANOUT = [
  "outbox", "awaiting-notify", "builtin-app-seed", "embedding-backfill",
  "device-auth-reap", "oauth-reap", "session-log-reap", "session-title-backfill",
  "session-state-backfill", "ghost-instance-sweep",
];

/** 순회하면 **안 되는** 것 — 이유가 각자 다르다. 하나로 뭉뚱그리면 다음 사람이 잘못 푼다. */
const MUST_NOT_FANOUT: Record<string, string> = {
  reapIdleSessions:
    "**전역 트리거와 테넌트 동작이 한 함수에 용접돼 있다** — 압박 축(pressure_used_pct·pressure_swap_pct)은 "
    + "박스의 성질(/proc 물리·스왑)인데 회수 대상은 워크스페이스다. 순회하면 스왑 임계 하나에 "
    + "워크스페이스 수만큼의 tick 이 일제히 완화 TTL 로 회수한다(전역 신호를 테넌트마다 곱한다). "
    + "두 축을 가르기 전엔 얹지 않는다 — #2509. "
    + "⚠ 「남의 세션이 죽는다」는 이유가 아니다: 비-primary 는 정책이 전부 기본값이라 오늘은 no-op 이다",
  sweepLivSecondTurn:
    "워크스페이스를 **스스로** 해석한다(workspaceForSession→withTenant). 또 감싸면 전량 스윕이 N번 돈다",
};

test("[R1] 테넌트 스코프 주기 정비는 전부 순회에 실려 있다 — primary 만 돌면 나머지는 방치된다", () => {
  const src = readFileSync(SRC, "utf8");
  for (const job of MUST_FANOUT)
    assert.ok(src.includes(`perTenant("${job}"`),
      `'${job}' 이 순회에 없다 — registry 에서 이 정비는 primary 에만 온다(비-primary 는 영영 방치).`);
});

/**
 * `perTenant( … )` 호출들의 본문 — **괄호 균형을 세어** 잘라낸다.
 *
 *  ⚠ 처음엔 `/perTenant\([^)]*<이름>/` 로 짰고 **변이가 그대로 통과했다**:
 *   `[^)]*` 는 `perTenant("idle-reap", () => …` 의 **`()` 첫 닫는 괄호**에서 멈춰 인자 안쪽에
 *   영영 못 닿는다. 줄 단위 검사도 같은 이유로 약하다(호출이 두 줄로 갈리면 놓친다).
 *   균형 세기만이 실제로 잰다 — 그리고 아래 R5 가 그 성질을 직접 못 박는다.
 */
export function perTenantCalls(src: string): string[] {
  const out: string[] = [];
  const needle = "perTenant(";
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    let depth = 0;
    for (let j = i + needle.length - 1; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) { out.push(src.slice(i, j + 1)); break; }
    }
  }
  return out;
}

test("[R2] 파괴적이거나 스스로 순회하는 정비는 **순회에 얹지 않는다**", () => {
  const calls = perTenantCalls(readFileSync(SRC, "utf8"));
  //  ⚠ 배선 단언 — 파서가 헛돌면 아래 루프는 «0건 발견»으로 **통과하면서 아무것도 안 본다**.
  assert.ok(calls.length >= MUST_FANOUT.length,
    `perTenant 호출을 ${calls.length}개밖에 못 찾았다(순회 대상은 ${MUST_FANOUT.length}개) — 파서가 죽었다`);
  for (const [fn, why] of Object.entries(MUST_NOT_FANOUT)) {
    const bad = calls.filter((c) => c.includes(fn));
    assert.equal(bad.length, 0, `'${fn}' 이 순회에 실렸다 — ${why}\n  ${bad.join("\n  ")}`);
  }
});

// 파서 자체의 엣지 표 — R2 는 이 파서에 전부를 건다. 파서가 조용히 틀리면 R2 는 장식이 된다.
//  P1 인자 속 중첩 괄호(`() => f()`)  → 본문 **전체**를 잡는다 ← 정규식판이 죽은 바로 그 자리
//  P2 여러 호출                        → 각각 따로
//  P3 호출이 두 줄에 걸침              → 줄바꿈에 안 속는다
//  P4 호출 없음                        → 빈 배열(거짓 양성 금지)
test("[R5] 순회 탐지 파서가 중첩 괄호·줄바꿈을 뚫는다", () => {
  const [p1] = perTenantCalls(`void perTenant("idle-reap", () => reapIdleSessions());`);
  assert.ok(p1?.includes("reapIdleSessions"), "P1 — 중첩 괄호 안쪽까지 못 보면 R2 가 vacuous 해진다");

  assert.equal(perTenantCalls(`perTenant("a", () => x()); perTenant("b", () => y());`).length, 2, "P2");

  const [p3] = perTenantCalls(`void perTenant("idle-reap",\n  () => reapIdleSessions());`);
  assert.ok(p3?.includes("reapIdleSessions"), "P3 — 두 줄로 갈린 호출");

  assert.deepEqual(perTenantCalls(`void reapIdleSessions();`), [], "P4");
});

test("[R3] registry 프로비저닝이 빌트인 앱을 심는다 — 신규 워크스페이스가 앱 없이 태어나지 않게", () => {
  const src = readFileSync("src/capabilities/delivery/workspace-registry.ts", "utf8");
  assert.match(src, /seedBuiltinApps\(\)/,
    "새 워크스페이스에 빌트인 앱이 안 심기면 getApp('ai-session') 이 null 이라 "
    + "「답을 기다려요」 알림이 notify-app-inactive 로 전량 거절된다(#2246 이 매니지드에서 겪은 그 회귀).");
});

test("[R4] 순회 목록과 제외 목록이 겹치지 않는다 — 두 표가 서로를 부정하면 어느 쪽도 사실이 아니다", () => {
  for (const fn of Object.keys(MUST_NOT_FANOUT))
    assert.ok(!MUST_FANOUT.includes(fn), `'${fn}' 이 두 표에 다 있다 — 어느 쪽이 사실인가`);
});

/**
 * **부팅 직후가 가장 중요한** 정비 — `setInterval` 만 두면 첫 판이 주기 뒤다. 이유는 둘이다.
 *
 *  ① *밀린 것을 채우는* 백필: 배포 시점에 **이미** 비어 있다(빌트인 앱은 84곳이 그랬다).
 *  ② *재기동이 곧 피해인* 정비: 아웃박스가 그렇다 — 재기동이 배달 루프를 죽여 좀비를 만든다(#2244).
 *
 *  ⚠ 이 표는 관념이 아니라 실측에서 나왔다(2026-09-01 dev): stage 푸시마다 게이트웨이가 재시작하는데
 *   그 간격이 **2~4분**이었다(최근 1시간 9커밋). **5분 인터벌은 한 번도 발화하지 못했다** —
 *   같은 배포에서 45초 one-shot 은 매번 돌았는데. 「주기를 걸어 뒀다」는 「돈다」가 아니다:
 *   주기가 재기동 간격보다 길면 그 정비는 **영영 안 돈다.**
 *
 *  매니지드의 요청 정비표는 디바운스가 비어 있어 재기동 직후 **첫 요청에** 돈다. 같은 표를 쓰면서
 *  타이머 쪽만 주기를 기다리면 두 배포의 동작이 갈린다.
 */
const NEEDS_BOOT_ONESHOT = [
  "embedding-backfill", "session-title-backfill", "session-state-backfill", "builtin-app-seed", "outbox",
];

test("[R6] 부팅 직후가 중요한 정비는 **부팅 1회**를 갖는다 — 주기가 재기동보다 길면 영영 안 돈다", () => {
  const src = readFileSync(SRC, "utf8");
  for (const job of NEEDS_BOOT_ONESHOT)
    assert.ok(new RegExp(`setTimeout\\([^\\n]*perTenant\\("${job}"`).test(src),
      `'${job}' 이 interval 만 있다 — 배포 직후 밀린 분량이 다음 주기까지 그대로 남는다.`);
});
