// 노션 수집기 결속 판정(#1881 N7) — 워크스페이스↔수집기 매칭과 '접수해도 되는 껍데기' 규칙.
//  실행: npm run build && node dist/capabilities/notion-connect.test.js
//
//  여기서 지키는 것 둘:
//   ① 워크스페이스마다 수집기 하나 — token_source='org:<id>' 가 유일한 확정 표식이다.
//   ② 접수(adopt)는 **빈 껍데기**에만 — 토큰이 들어 있거나 실행 이력이 있으면 남의 살림이다.
//      (셀프호스팅에서 내부 통합 토큰으로 잘 돌던 수집기를 토글이 가로채면 조용히 수집이 끊긴다.)
import assert from "node:assert/strict";
import { __notionCollectTestables, LEGACY_INSTANCE_KEY } from "./notion-connect.js";
import type { CollectorView } from "../org/store/collectors.js";

const { boundWorkspace, adoptable, keyForWorkspace, shouldStampInstance } = __notionCollectTestables;

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

let nextId = 1;
function col(p: Partial<CollectorView>): CollectorView {
  return {
    id: nextId++, key: "notion", preset_key: "notion", instance_key: "_", label: "Notion", enabled: false,
    config: {}, secretsSet: {}, sync_interval_sec: 600, output_mode: "preset", output_config: {}, note: null,
    sort: 0, updated_at: null, preset_label: "Notion", fields: [], secrets_enabled: true, sync_job: null, last_run: null,
    ...p,
  } as CollectorView;
}

t("token_source=org:<id> 만 확정 결속으로 본다", () => {
  assert.equal(boundWorkspace(col({ config: { token_source: "org:ws-1" } })), "ws-1");
  assert.equal(boundWorkspace(col({ config: { token_source: "org" } })), null, "'org' 은 아직 안 묶인 것");
  assert.equal(boundWorkspace(col({ config: {} })), null);
  assert.equal(boundWorkspace(col({ config: { token_source: "org:" } })), null, "빈 id 는 결속이 아니다");
});

t("첫 워크스페이스는 옛 단일 인스턴스(lively-notion)를 최우선으로 접수한다", () => {
  const shell = col({ instance_key: "_" });
  const legacy = col({ instance_key: LEGACY_INSTANCE_KEY, config: { token_source: "org" }, enabled: true });
  assert.equal(adoptable([shell, legacy], true)?.id, legacy.id, "기존 자료를 가진 쪽을 먼저 물려받아야 한다");
});

t("두 번째 이후 워크스페이스는 레거시를 접수하지 않는다 — A 의 자료가 B 밑으로 들어가면 안 된다", () => {
  const legacy = col({ instance_key: LEGACY_INSTANCE_KEY, config: { token_source: "org" }, enabled: true });
  assert.equal(adoptable([legacy], false), null);
  const shell = col({ instance_key: "_" });
  assert.equal(adoptable([legacy, shell], false)?.id, shell.id, "빈 껍데기는 두 번째에도 접수 가능");
});

t("토큰이 든 껍데기는 접수하지 않는다(붙여넣기로 돌던 수집기 보호)", () => {
  const withToken = col({ secretsSet: { token: true } });
  assert.equal(adoptable([withToken], true), null);
});

t("한 번이라도 돈 수집기는 접수하지 않는다", () => {
  const ran = col({ last_run: { id: 9, status: "ok", mode: "full", started_at: "2026-08-01T00:00:00Z", finished_at: null } });
  assert.equal(adoptable([ran], true), null);
});

t("빈 껍데기(CP 프로비저너가 심는 칸)는 접수한다 — 화면에 노션이 둘 보이지 않게", () => {
  const shell = col({ instance_key: "_", key: "notion" });
  assert.equal(adoptable([shell], true)?.id, shell.id);
});

t("이미 다른 워크스페이스에 묶인 수집기는 접수 후보가 아니다", () => {
  const bound = col({ config: { token_source: "org:ws-9" } });
  assert.equal(adoptable([bound], true), null);
});

t("노션 아닌 프리셋은 후보에서 제외된다", () => {
  const slack = col({ preset_key: "slack", key: "slack" });
  assert.equal(adoptable([slack], true), null);
});

// ── 스탬프(external_instance) — 이 규칙이 틀리면 두 워크스페이스가 같은 축을 공유해 서로를 아카이브한다. ──
t("신규 수집기는 workspace_id 로 스탬프한다", () => {
  assert.equal(shouldStampInstance(null), true);
});

t("빈 껍데기 접수는 **반드시** 새로 스탬프한다 — 안 박으면 둘 다 'default' 를 써서 서로를 아카이브한다", () => {
  const shell = col({ instance_key: "_", config: {} });
  assert.equal(shouldStampInstance(shell), true);
});

t("옛 단일 인스턴스 접수는 스탬프를 **그대로 둔다** — 그 축으로 이미 자료를 쌓아 뒀다", () => {
  const legacy = col({ instance_key: LEGACY_INSTANCE_KEY, config: { token_source: "org" } });
  assert.equal(shouldStampInstance(legacy), false);
});

t("이미 묶인 수집기는 스탬프를 다시 박지 않는다(관리자가 바꿔 뒀을 수 있다)", () => {
  const bound = col({ instance_key: "notion-testws", config: { token_source: "org:ws-1", instance: "손댄값" } });
  assert.equal(shouldStampInstance(bound), false);
});

t("스탬프를 일부러 지정해 둔 칸은 접수 후보가 아니다 — 그 밑에 자료가 있다", () => {
  const curated = col({ instance_key: "_", config: { instance: "acme" } });
  assert.equal(adoptable([curated], true), null);
});

t("워크스페이스 키는 uuid 앞 8자 — 짧고 사람이 읽을 수 있다", () => {
  assert.equal(keyForWorkspace("11112222-3333-4444-5555-666677778888"), "notion-11112222");
  assert.notEqual(keyForWorkspace("aaaaaaaa-0000-0000-0000-000000000000"), keyForWorkspace("bbbbbbbb-0000-0000-0000-000000000000"));
});

console.log(`\n${pass} passed`);
