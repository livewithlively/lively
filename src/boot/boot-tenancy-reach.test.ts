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
