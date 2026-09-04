// 하우스키핑 리더 선출 (#2664 3단계) — 무중단 롤이 게이트웨이를 **겹쳐** 띄우기 때문에 생겼다.
//
//  ★ 이 시험이 지키는 계약 셋 — 셋 다 틀리면 «조용히» 틀린다:
//   ① 자격이 없으면 주기 잡을 **안 돈다**(안 그러면 커넥터 싱크·증류가 두 번 = 중복 지식)
//   ② 락을 쥔 커넥션을 **풀에 돌려주지 않는다**(돌려주면 그 자리가 영구 점유돼 아무도 리더가 못 된다)
//   ③ 선출이 실패해도 **게이트웨이 기동을 막지 않는다**(관측이 배포를 죽이지 않는다)
//
//  단언은 문구가 아니라 **부작용**으로 한다 — 발행된 SQL·커넥션 반납 방식(반납/폐기)·시도 횟수.
//  엣지 표는 스크래치패드 spec-leader.md (E1~E12), 아래 L1~L12 가 그 행들이다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { itemsPool } from "../db/client.js";
import {
  LEADER_LOCK_CLASS, LEADER_LOCK_OBJ,
  isSchedulerLeader, releaseSchedulerLeadership,
  __test_acquireOnce, __test_reset,
} from "./leader.js";

const SRC = join(process.cwd(), "src");
const read = (p: string): string => readFileSync(join(SRC, p), "utf8");

interface FakeClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ got: boolean }> }>;
  on: (ev: string, fn: (e: Error) => void) => void;
  release: (destroy?: boolean) => void;
  /** 반납 기록 — `true` 는 폐기, `undefined` 는 풀로 정상 반납. 이 구분이 계약 ②다. */
  released: Array<boolean | undefined>;
  queries: Array<{ sql: string; params?: unknown[] }>;
  fire: (e: Error) => void;
}

/** got=null 이면 커넥션 획득 자체가 실패한다(DB 없음·풀 고갈). */
function fakePool(got: boolean | null): FakeClient {
  const handlers: Array<(e: Error) => void> = [];
  const c: FakeClient = {
    queries: [], released: [],
    query: async (sql, params) => { c.queries.push({ sql, params }); return { rows: [{ got: got === true }] }; },
    on: (ev, fn) => { if (ev === "error") handlers.push(fn); },
    release: (destroy) => { c.released.push(destroy); },
    fire: (e) => handlers.forEach((h) => h(e)),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (itemsPool as any).connect = async () => {
    if (got === null) throw new Error("ITEMS_DATABASE_URL 이 설정되지 않았습니다");
    return c;
  };
  return c;
}

test.afterEach(() => {
  __test_reset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (itemsPool as any).connect;
});

// ── E1 ──────────────────────────────────────────────────────────────────────
test("L1 선출을 시작하지 않았으면 자격이 없다", () => {
  assert.equal(isSchedulerLeader(), false);
});

// ── E2 ──────────────────────────────────────────────────────────────────────
test("L2 락을 잡으면 자격을 얻고, 그 커넥션을 **계속 쥔다**", async () => {
  const c = fakePool(true);
  await __test_acquireOnce();
  assert.equal(isSchedulerLeader(), true);
  //  ★ 반납하면 안 된다 — 세션 스코프 락이라 커넥션을 놓는 순간 자격이 사라진다.
  assert.deepEqual(c.released, [], "락을 쥔 커넥션을 풀에 돌려줬다(자격이 조용히 사라진다)");
});

// ── E3 ──────────────────────────────────────────────────────────────────────
test("L3 못 잡으면 자격이 없고, 커넥션은 **그냥 반납**한다(폐기가 아니다)", async () => {
  const c = fakePool(false);
  await __test_acquireOnce();
  assert.equal(isSchedulerLeader(), false);
  //  락을 안 쥐었으니 이 커넥션은 멀쩡하다 — 폐기하면 재시도마다 커넥션을 하나씩 버린다.
  assert.deepEqual(c.released, [undefined], "못 잡은 커넥션을 폐기했거나(낭비) 안 돌려줬다(누수)");
});

// ── E4 ──────────────────────────────────────────────────────────────────────
test("L4 이미 자격이 있으면 **추가 시도를 하지 않는다**(재시도가 풀을 갉지 않게)", async () => {
  const c = fakePool(true);
  await __test_acquireOnce();
  await __test_acquireOnce();
  await __test_acquireOnce();
  assert.equal(c.queries.length, 1, "이미 리더인데 또 락을 시도했다");
});

// ── E5 ──────────────────────────────────────────────────────────────────────
test("L5 커넥션이 죽으면 자격을 잃고 커넥션을 **폐기**한다", async () => {
  const c = fakePool(true);
  await __test_acquireOnce();
  assert.equal(isSchedulerLeader(), true);
  c.fire(new Error("connection terminated"));
  //  ★ 이 감지가 없으면 **락은 이미 풀렸는데 이 프로세스만 자기가 리더라고 믿는다** — 그때 둘이 함께 돈다.
  assert.equal(isSchedulerLeader(), false, "커넥션이 죽었는데 자기가 리더라고 믿는다");
  assert.deepEqual(c.released, [true], "죽은 커넥션을 폐기하지 않고 풀에 돌려줬다");
});

// ── E6 ──────────────────────────────────────────────────────────────────────
test("L6 자리를 비워 주면 해제 신호를 보내고 폐기한다 — 후임이 즉시 이어받는다", async () => {
  const c = fakePool(true);
  await __test_acquireOnce();
  await releaseSchedulerLeadership();
  assert.equal(isSchedulerLeader(), false);
  assert.match(c.queries.at(-1)!.sql, /pg_advisory_unlock\(\$1::int, \$2::int\)/);
  //  ⚠ 해제가 실패했을 수 있으므로 **항상** 폐기한다. 락이 붙은 커넥션을 돌려주면
  //   그 조직의 리더 자리가 아무도 모르게 영구 점유된다.
  assert.deepEqual(c.released, [true], "해제 뒤 커넥션을 폐기하지 않았다");
});

// ── E7 ──────────────────────────────────────────────────────────────────────
test("L7 ★ 커넥션 획득이 실패해도 던지지 않는다 — 관측이 기동을 막지 않는다", async () => {
  fakePool(null);
  await __test_acquireOnce(); // 여기서 throw 하면 이 시험이 실패한다
  assert.equal(isSchedulerLeader(), false);
});

// ── E8 ──────────────────────────────────────────────────────────────────────
test("L8 락이 풀리면 후임이 **이어받는다** — 한 번 놓쳤다고 영영 못 잡으면 안 된다", async () => {
  fakePool(false);                     // 옛 리더가 살아 있다
  await __test_acquireOnce();
  assert.equal(isSchedulerLeader(), false, "이미 리더가 있는데 잡았다");
  const free = fakePool(true);         // 옛 리더가 죽어 락이 풀렸다
  await __test_acquireOnce();
  assert.equal(isSchedulerLeader(), true, "락이 풀렸는데 후임이 못 잡는다 — 주기 잡이 영영 안 돈다");
  assert.deepEqual(free.released, []);
});

// ── E9 ★ 새로 도입한 값이 만드는 새 엣지 ────────────────────────────────────
test("L9 ★ 락 식별자는 **두 정수 상수**다 — 갈리면 둘 다 리더가 된다", async () => {
  const c = fakePool(true);
  await __test_acquireOnce();
  const q = c.queries[0]!;
  assert.match(q.sql, /pg_try_advisory_lock\(\$1::int, \$2::int\)/);
  assert.deepEqual(q.params, [LEADER_LOCK_CLASS, LEADER_LOCK_OBJ]);
  //  ⚠ 옛 프로세스와 새 프로세스가 **서로 다른 락**을 잡으면 둘 다 리더가 된다 — 이 장치가
  //   있는데도 크론이 두 번 도는, 제일 알아채기 어려운 실패다. 값을 여기서 못박는다.
  assert.equal(LEADER_LOCK_CLASS, 0x6c766c79, "락 클래스가 바뀌었다(구·신 프로세스가 다른 락을 잡는다)");
  assert.equal(LEADER_LOCK_OBJ, 1);
  //  문서화되지 않은 내부 함수(hashtext)는 판이 바뀌면 값이 갈릴 수 있어 쓰지 않는다.
  //  ⚠ **발행된 SQL** 로 본다. 파일을 grep 하면 「쓰지 말라」고 적어 둔 주석 자신이 걸린다
  //   (실제로 걸렸다) — 그건 행위가 아니라 문서를 검사하는 것이다.
  assert.ok(!c.queries.some((x) => x.sql.includes("hashtext")), "락 키를 내부 함수로 만든다");
});

// ── E10·E11 배선 — 만들어만 두고 아무도 안 보면 아무것도 안 막은 것이다 ──────
test("L10 ★ 크론 틱이 자격을 실제로 본다", () => {
  const src = read("scheduler/engine.ts");
  assert.match(src, /async function tickAllTenants\(\)[\s\S]{0,800}?if \(!isSchedulerLeader\(\)\) return;/,
    "tickAllTenants 가 자격을 안 본다 — 겹치는 동안 같은 크론이 두 번 발화한다");
  assert.match(src, /startSchedulerLeadership\(\)/, "스케줄러가 선출을 시작하지 않는다");
});

test("L11 ★ 위탁 큐 틱도 같은 자격을 본다 — 같은 위탁이 두 노드에 배치되지 않게", () => {
  const src = read("node/task-scheduler.ts");
  assert.match(src, /if \(!isSchedulerLeader\(\)\) return;/, "위탁 스케줄러가 자격을 안 본다");
  assert.match(src, /startSchedulerLeadership\(\)/, "위탁 스케줄러가 선출을 시작하지 않는다");
});

// ── E12 ─────────────────────────────────────────────────────────────────────
test("L12 온디맨드 경로에는 자격을 걸지 않는다 — 사람이 «지금 돌려» 라고 부른 것이다", () => {
  const src = read("scheduler/engine.ts");
  //  `runSchedulerTickOnce`(ops 틱)·`runCronById`(refresh now)는 명시적 요청이다. 여기에 자격을
  //   걸면 비-리더가 받은 요청이 **조용히 아무 일도 안 하고 성공**한다 — 최악의 모양이다.
  const once = src.slice(
    src.indexOf("export async function runSchedulerTickOnce"),
    src.indexOf("async function tickAllTenants"),
  );
  assert.ok(once.length > 0, "runSchedulerTickOnce 를 못 찾았다(시험이 헛돈다)");
  assert.ok(!once.includes("isSchedulerLeader"), "온디맨드 틱에 자격을 걸었다(비-리더에서 조용한 no-op 이 된다)");
});

test("L13 정상 종료가 자리를 비워 준다 — 교대 창에 «아무도 안 도는» 구간을 줄인다", () => {
  const src = read("index.ts");
  //  안 불러도 커넥션이 닫히며 락은 풀린다. 다만 그때 후임은 **재시도 주기만큼** 기다린다 —
  //   무중단 롤의 교대 창에서 주기 잡이 그만큼 멈춰 있다. 명시적 해제가 그 구간을 없앤다.
  assert.match(src, /SIGTERM[\s\S]{0,900}?releaseSchedulerLeadership\(\)/,
    "종료 경로가 리더 자리를 안 비운다");
});
