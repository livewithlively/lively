// 스키마 전용 부팅(#4638) — 공용 DB 마이그레이터용 스위치 `LIVELY_BOOT_SCHEMA_ONLY`.
//
//  ★ 이 파일이 있는 이유. 마이그레이터(lvly-cloud/deploy/lvly-shared-migrate.sh)는 코어를 통째로 부팅하고 self-rls 의 완료
//   마커를 보자마자 컨테이너를 걷는다. 체인은 그 뒤에도 돌아서(seed-default-content → seed-builtin-apps …) 걷히는 순간의
//   시더가 전역 앱 설치 락을 쥔 채 버려졌고, 그 유령 DB 세션이 6분간 매니지드 전 워크스페이스를 멈췄다(2026-10-11).
//   스위치가 켜지면 체인은 self-rls 에서 멈춰야 하고, 꺼져 있으면 종전처럼 끝까지 돌아야 한다.
//  스텝의 run 을 전부 스파이로 바꿔 «무엇이 실제로 불렸나» 를 잰다(실 DB·express 를 만지지 않는다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { DB_BOOT_STEPS, LISTEN_STEPS, runBootHousekeeping, requestScopedTenancy, SCHEMA_ONLY_LAST_STEP } from "./housekeeping.js";
import { _resetSchemaBootForTest, schemaBootPhase } from "./boot-state.js";
import { POOL_CLIENT_WAIT_MS } from "../db/client.js";
import { itemsPool } from "../db/client.js";

/** 사양이 이름으로 고정하는 경계 — 마이그레이터가 grep 하는 완료 마커 «self 소스 공개범위 준비됨» 을 내는 스텝. */
const MARKER_STEP = "self-rls";

/** env 키 몇 개를 바꿨다가 종전 값으로 되돌린다(undefined 였으면 delete). */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  const apply = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  apply(patch);
  try { return await fn(); } finally { apply(saved); }
}

/** 마이그레이터와 같은 모양 — 단일 테넌트(바인딩 없음) · DB 주소 있음 · 스케줄러 스텝도 세도록 켜 둔다. */
const SINGLE_TENANT_ENV = {
  LIVELY_TENANT_BINDING: undefined, LIVELY_TENANT_ID: undefined, LIVELY_TENANCY_MODE: undefined,
  LIVELY_NO_SCHEDULER: undefined, ITEMS_DATABASE_URL: "postgres://x",
};

/** 체인을 돌리고(스파이) 불린 DB 스텝 이름을 순서대로 돌려준다. 체인은 비동기라 상태가 pending 을 벗어날 때까지 기다린다. */
async function runChain(schemaOnly: string | undefined): Promise<{ ran: string[]; phase: string }> {
  const ran: string[] = [];
  const origListen = LISTEN_STEPS.map((s) => s.run);
  const origDb = DB_BOOT_STEPS.map((s) => s.run);
  try {
    for (const s of LISTEN_STEPS) s.run = () => undefined;
    for (const s of DB_BOOT_STEPS) s.run = () => { ran.push(s.name); };
    return await withEnv({ ...SINGLE_TENANT_ENV, LIVELY_BOOT_SCHEMA_ONLY: schemaOnly }, async () => {
      assert.equal(requestScopedTenancy(), false, "배선 — 이 env 는 단일 테넌트 체인을 도는 모양이어야 한다");
      _resetSchemaBootForTest();
      runBootHousekeeping({ app: {}, server: {}, verifier: {} } as never);
      for (let i = 0; i < 1_000 && schemaBootPhase() === "pending"; i++) await new Promise((r) => setImmediate(r));
      return { ran, phase: schemaBootPhase() };
    });
  } finally {
    LISTEN_STEPS.forEach((s, i) => { s.run = origListen[i]; });
    DB_BOOT_STEPS.forEach((s, i) => { s.run = origDb[i]; });
    _resetSchemaBootForTest();
  }
}

const ALL = (): string[] => DB_BOOT_STEPS.map((s) => s.name);
const UPTO_MARKER = (): string[] => ALL().slice(0, ALL().indexOf(MARKER_STEP) + 1);

test("★★ [C6] 끊는 기준 스텝은 체인에 실재하고, 시딩 스텝들보다 앞이다 — 없으면 스위치가 조용히 무력하다", () => {
  assert.equal(SCHEMA_ONLY_LAST_STEP, MARKER_STEP, "기준은 마이그레이터가 기다리는 마커 스텝이어야 한다");
  const at = ALL().indexOf(MARKER_STEP);
  assert.ok(at >= 0, `'${MARKER_STEP}' 가 DB_BOOT_STEPS 에 없다`);
  for (const seed of ["seed-default-content", "seed-builtin-apps"]) {
    const s = ALL().indexOf(seed);
    assert.ok(s > at, `'${seed}'(${s}) 는 '${MARKER_STEP}'(${at}) 뒤여야 한다 — 앞이면 스위치를 켜도 마이그레이터가 시딩을 돈다`);
  }
});

test("★★ [C1] 켜지면 self-rls 까지 돌고 멈춘다 — 시딩 스텝은 0회", async () => {
  const { ran } = await runChain("1");
  assert.ok(ran.length > 0, "배선 — 스파이가 실제로 불렸다");
  assert.deepEqual(ran, UPTO_MARKER());
  assert.ok(!ran.includes("seed-builtin-apps") && !ran.includes("seed-default-content"), ran.join(" · "));
});

test("★ [C2] 미설정이면 종전처럼 끝까지 돈다", async () => {
  const { ran } = await runChain(undefined);
  assert.deepEqual(ran, ALL());
});

test("★ [C3] 정확히 \"1\" 이 아니면 꺼짐 — \"0\" · \"true\" · \"\" 는 끝까지 돈다", async () => {
  for (const v of ["0", "true", ""]) {
    const { ran } = await runChain(v);
    assert.deepEqual(ran, ALL(), `값 ${JSON.stringify(v)} 에서 체인이 끊겼다`);
  }
});

test("[C4] 앞뒤 공백은 허용한다 — \" 1 \" 은 켜짐", async () => {
  const { ran } = await runChain(" 1 ");
  assert.deepEqual(ran, UPTO_MARKER());
});

test("[C5] 끊은 뒤에도 부팅 상태는 ready 로 정리된다(pending 에 걸리지 않는다)", async () => {
  const { phase } = await runChain("1");
  assert.equal(phase, "ready");
});

test("★ [D1] 전역 풀은 클라이언트 대기에 유한한 상한이 있다 — 없으면 교착 하나가 재기동 전까지 전 API 를 멈춘다", () => {
  const opt = (itemsPool as unknown as { options: { connectionTimeoutMillis?: number } }).options.connectionTimeoutMillis;
  assert.ok(typeof opt === "number" && Number.isFinite(opt) && opt > 0, `connectionTimeoutMillis=${String(opt)}`);
  assert.equal(opt, POOL_CLIENT_WAIT_MS);
});
