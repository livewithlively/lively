// 순수 배선 스텝은 **요청별 테넌시에서도 걸려야 한다** (#4135 후속).
//
//  ★ 이 파일이 있는 이유. `runBootHousekeeping` 은 `LISTEN_STEPS` 를 먼저 동기·무조건 돌리고, 그 뒤
//   `requestScopedTenancy()` 가 참이면(매니지드 중앙 게이트웨이: rls 바인딩 + 고정 테넌트 없음 + registry 아님)
//   `DB_BOOT_STEPS` 체인을 **통째로 건너뛴다.** `member-deactivation-hook` 과 `node-session-discovery` 는
//   DB 를 만지지 않는 동기 배선(구독자 등록)인데 종전엔 `DB_BOOT_STEPS` 끝에 있어서 매니지드에서는
//   한 번도 걸리지 않았다 — 노드 세션 발견도, #4135 세션 토큰 되채우기도 돌지 않았다.
//   그래서 두 스텝은 `LISTEN_STEPS` 에 있어야 하고, 이 파일이 그 자리를 못 박는다.
//
//  ⓘ 검사 축(스펙 A~E):
//    A  두 스텝이 LISTEN_STEPS 에 있다 · gate:"always" · tenancy 미지정
//    B  DB_BOOT_STEPS 에는 없다(구독 슬롯은 하나 — 중복 배선 금지)
//    C  node-session-discovery 는 node-upgrade **뒤**(노드 WS 수신 배선 뒤 · 첫 스냅샷 전)
//    D  요청별 테넌시 env 에서 runBootHousekeeping 을 부르면 두 스텝의 run 이 실제로 호출된다(스파이) + 소스 순서
//    E  무회귀 — boot-tenancy-reach 의 규약(tenancy 미지정 = global)을 깨지 않는다
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  LISTEN_STEPS, DB_BOOT_STEPS, runBootHousekeeping, requestScopedTenancy, type BootStep,
} from "./housekeeping.js";

const SRC = "src/boot/housekeeping.ts";

/** 이 파일이 지키는 두 스텝 — 이름은 스펙에서 고정한다(이름이 바뀌면 여기부터 깨져야 한다). */
const MOVED = ["member-deactivation-hook", "node-session-discovery"] as const;

const byName = (steps: BootStep[], name: string): BootStep | undefined => steps.find((s) => s.name === name);
const indexOfName = (steps: BootStep[], name: string): number => steps.findIndex((s) => s.name === name);

// ── A ─────────────────────────────────────────────────────────────────────────
test("★★ [A] 두 배선 스텝은 LISTEN_STEPS 에 있다 — gate:'always' · tenancy 미지정", () => {
  for (const name of MOVED) {
    const step = byName(LISTEN_STEPS, name);
    assert.ok(step, `'${name}' 이 LISTEN_STEPS 에 없다 — 요청별 테넌시(매니지드)에서 이 배선은 영영 안 걸린다`);
    assert.equal(step.gate, "always",
      `'${name}' 은 gate:'always' 여야 한다 — scheduler 게이트면 requestScopedTenancy 에서 건너뛰어진다`);
    assert.equal(step.tenancy, undefined,
      `'${name}' 은 tenancy 를 지정하지 않는다(= global) — 인메모리 배선이지 테넌트 데이터가 아니다`);
    assert.equal(typeof step.run, "function", `'${name}' 의 run 이 함수가 아니다`);
  }
});

test("★ [A'] LISTEN_STEPS 안에서 두 이름은 각각 한 번씩만 있다", () => {
  for (const name of MOVED) {
    const n = LISTEN_STEPS.filter((s) => s.name === name).length;
    assert.equal(n, 1, `'${name}' 이 LISTEN_STEPS 에 ${n}번 있다 — 구독 슬롯은 하나다`);
  }
});

// ── B ─────────────────────────────────────────────────────────────────────────
test("★★ [B] DB_BOOT_STEPS 에는 두 이름이 없다 — 중복 배선 금지(구독 슬롯은 하나)", () => {
  for (const name of MOVED) {
    assert.equal(byName(DB_BOOT_STEPS, name), undefined,
      `'${name}' 이 DB_BOOT_STEPS 에도 있다 — LISTEN_STEPS 와 이중 배선이면 구독자가 두 번 걸린다`);
  }
});

test("★ [B'] 전체 스텝 이름은 유일하다 — 두 표를 합쳐도 같은 이름이 두 번 나오지 않는다", () => {
  const names = [...LISTEN_STEPS, ...DB_BOOT_STEPS].map((s) => s.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dup, [], `중복 스텝 이름: ${dup.join(", ")}`);
});

// ── C ─────────────────────────────────────────────────────────────────────────
test("★★ [C] node-session-discovery 는 LISTEN_STEPS 에서 node-upgrade **뒤**에 온다", () => {
  const up = indexOfName(LISTEN_STEPS, "node-upgrade");
  const disc = indexOfName(LISTEN_STEPS, "node-session-discovery");
  assert.ok(up >= 0, "'node-upgrade' 가 LISTEN_STEPS 에 없다 — 순서를 잴 기준이 사라졌다");
  assert.ok(disc >= 0, "'node-session-discovery' 가 LISTEN_STEPS 에 없다");
  assert.ok(disc > up,
    `node-session-discovery(${disc}) 는 node-upgrade(${up}) 뒤여야 한다 — 노드 WS 수신 배선 뒤 · 첫 스냅샷 전`);
});

// ── D ─────────────────────────────────────────────────────────────────────────

/** env 키 몇 개를 바꿨다가 **정확히 종전 값**으로 되돌린다(undefined 였으면 delete). */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  const apply = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  apply(patch);
  try { return fn(); } finally { apply(saved); }
}

/** 요청별 테넌시(매니지드 중앙 게이트웨이) env — rls 바인딩 · 고정 테넌트 없음 · registry 아님 · DB URL 있음. */
const REQUEST_SCOPED_ENV = {
  LIVELY_TENANT_BINDING: "rls",
  LIVELY_TENANT_ID: "",
  LIVELY_TENANCY_MODE: "",
  ITEMS_DATABASE_URL: "postgres://x",
};

test("★★ [D] 요청별 테넌시에서 runBootHousekeeping 을 부르면 두 스텝의 run 이 호출된다", () => {
  const listenCalls = new Map<string, unknown[][]>();
  const dbCalls = new Map<string, unknown[][]>();
  const originalListen = LISTEN_STEPS.map((s) => s.run);
  const originalDb = DB_BOOT_STEPS.map((s) => s.run);
  const ctx = { app: {}, server: {}, verifier: {} };

  try {
    // 다른 LISTEN_STEPS(terminal-proxy 등)는 실제 express app/server 를 요구한다 — **전부** no-op 스파이로 바꾼다.
    for (const s of LISTEN_STEPS) {
      listenCalls.set(s.name, []);
      s.run = (...args: unknown[]) => { listenCalls.get(s.name)!.push(args); };
    }
    // DB 체인은 건너뛰어져야 하지만, 혹시 안 건너뛰면 실 DB 를 만지지 않도록 역시 스파이로 막는다.
    for (const s of DB_BOOT_STEPS) {
      dbCalls.set(s.name, []);
      s.run = (...args: unknown[]) => { dbCalls.get(s.name)!.push(args); };
    }

    withEnv(REQUEST_SCOPED_ENV, () => {
      assert.equal(requestScopedTenancy(), true,
        "이 env 가 요청별 테넌시로 판정되지 않으면 아래 검사는 아무것도 증명하지 않는다");

      runBootHousekeeping(ctx as never);

      for (const name of MOVED) {
        const calls = listenCalls.get(name);
        assert.ok(calls, `'${name}' 이 LISTEN_STEPS 에 없어서 스파이를 못 심었다`);
        assert.equal(calls.length, 1, `'${name}' 의 run 이 ${calls.length}번 호출됐다(1번이어야 한다)`);
        assert.equal(calls[0][0], ctx, `'${name}' 의 run 에 ctx 가 그대로 넘어와야 한다`);
      }
    });
  } finally {
    LISTEN_STEPS.forEach((s, i) => { s.run = originalListen[i]; });
    DB_BOOT_STEPS.forEach((s, i) => { s.run = originalDb[i]; });
  }

  // 되돌렸는지 — 다음 테스트 파일/스텝이 스파이를 물려받으면 안 된다.
  LISTEN_STEPS.forEach((s, i) => assert.equal(s.run, originalListen[i], `'${s.name}' run 복원 실패`));
  DB_BOOT_STEPS.forEach((s, i) => assert.equal(s.run, originalDb[i], `'${s.name}' run 복원 실패`));
});

test("★ [D'] 같은 호출에서 DB 부팅 체인은 걸리지 않는다 — 두 스텝이 «LISTEN 쪽»에서 걸렸음을 대조한다", () => {
  //  체인 첫 스텝의 run 은 async IIFE 안에서 **동기적으로** 호출된다(첫 await 전). 그러니 여기서 0건이면
  //  requestScopedTenancy 차단이 실제로 걸린 것이고, 두 스텝은 그 차단 **앞**(LISTEN_STEPS)에서 돌았다는 뜻이다.
  const dbHits: string[] = [];
  const originalListen = LISTEN_STEPS.map((s) => s.run);
  const originalDb = DB_BOOT_STEPS.map((s) => s.run);
  const movedHits: string[] = [];
  try {
    for (const s of LISTEN_STEPS) s.run = () => { if ((MOVED as readonly string[]).includes(s.name)) movedHits.push(s.name); };
    for (const s of DB_BOOT_STEPS) s.run = () => { dbHits.push(s.name); };
    withEnv(REQUEST_SCOPED_ENV, () => {
      assert.equal(requestScopedTenancy(), true);
      runBootHousekeeping({ app: {}, server: {}, verifier: {} } as never);
    });
    assert.deepEqual(dbHits, [], `요청별 테넌시인데 DB 체인이 돌았다: ${dbHits.join(", ")}`);
    assert.deepEqual([...movedHits].sort(), [...MOVED].sort(), "두 스텝이 LISTEN 쪽에서 걸려야 한다");
  } finally {
    LISTEN_STEPS.forEach((s, i) => { s.run = originalListen[i]; });
    DB_BOOT_STEPS.forEach((s, i) => { s.run = originalDb[i]; });
  }
});

test("★ [D''] 소스 순서 — runBootHousekeeping 은 LISTEN_STEPS 를 requestScopedTenancy 판정보다 **앞에서** 돈다", () => {
  const src = readFileSync(SRC, "utf8");
  const fnStart = src.indexOf("export function runBootHousekeeping(");
  assert.ok(fnStart >= 0, "runBootHousekeeping 정의를 못 찾았다");
  const body = src.slice(fnStart);
  const listenLoop = body.indexOf("for (const step of LISTEN_STEPS)");
  const guard = body.indexOf("if (requestScopedTenancy()) {");
  const dbLoop = body.indexOf("for (const step of DB_BOOT_STEPS)");
  assert.ok(listenLoop >= 0, "LISTEN_STEPS 루프가 없다");
  assert.ok(guard >= 0, "requestScopedTenancy 차단 분기가 없다");
  assert.ok(dbLoop >= 0, "DB_BOOT_STEPS 루프가 없다");
  assert.ok(listenLoop < guard, `LISTEN_STEPS 루프(${listenLoop})가 차단(${guard})보다 앞이어야 한다`);
  assert.ok(guard < dbLoop, `차단(${guard})이 DB 체인(${dbLoop})보다 앞이어야 한다`);
});

// ── E ─────────────────────────────────────────────────────────────────────────
test("★★ [E] 무회귀 — 옮긴 두 스텝은 tenancy 미지정이라 boot-tenancy-reach 규약대로 global 로 본다", () => {
  for (const name of MOVED) {
    const step = byName(LISTEN_STEPS, name);
    assert.ok(step, `'${name}' 이 LISTEN_STEPS 에 없다`);
    assert.equal(step.tenancy, undefined, `'${name}' 에 tenancy 가 붙었다 — 붙이면 K1(닿는 길 표) 이 요구된다`);
    assert.equal(step.tenancy ?? "global", "global");
  }
});

test("★ [E'] 무회귀 — 모든 스텝의 tenancy 는 미지정·'global'·'per-tenant' 중 하나이고 미지정이 남아 있다", () => {
  const all = [...LISTEN_STEPS, ...DB_BOOT_STEPS];
  assert.ok(all.length > 0, "스텝이 하나도 없다");
  for (const s of all) {
    assert.ok(s.tenancy === undefined || s.tenancy === "global" || s.tenancy === "per-tenant",
      `'${s.name}' 의 tenancy 값이 이상하다: ${String(s.tenancy)}`);
    assert.ok(s.gate === "always" || s.gate === "scheduler", `'${s.name}' 의 gate 값이 이상하다: ${String(s.gate)}`);
  }
  // K6 의 전제 — 미표시(=global 기본값) 스텝이 하나도 없으면 기본값 경로가 죽은 것이다.
  assert.ok(all.some((s) => s.tenancy === undefined), "미지정 스텝이 0개다 — 기본값(global) 경로가 사라졌다");
});
