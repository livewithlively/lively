// 수집 실행 결과 판정 — 조건 조합 고정 (#3994 T2-a)
//
//  왜 이 표가 필요한가(실측): 수집 크론은 타깃 실패를 summary 에 담고도 무조건 status:"ok" 를 반환했다.
//   그 값이 org_cron.last_status 가 되고 연속실패 서킷브레이커는 status 로만 판정하므로 영원히 트립하지
//   않았다 — 15분마다 강제 종료되는 수집기가 무기한 초록불이었다.
//  그리고 부팅 스윕은 running 행을 무조건 error 로 닫고 pid kill 을 시도했다. 수집 자식은 부모와 함께
//   죽지 않으므로 kill 이 빗나가면 그 자식이 완주해 커서를 전진시키는데 행은 이미 error 였다(스플릿브레인).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { syncBatchStatus, orphanVerdict, childHeartbeatMs } from "./sync-outcome.js";

const r = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const CRON = r("../scheduler/actions/connector.ts");
const TRACKER = r("./run-tracker.ts");
const CHILD = r("./run-sync.ts");

test("표 A — 수집 tick 의 잡 상태는 타깃 결과에서 나온다", () => {
  //  A1 전부 성공
  assert.equal(syncBatchStatus([{ ok: true }, { ok: true }]), "ok", "A1 전부 성공인데 실패로 봤다");
  //  A2 타깃 0개 — 켜진 수집기가 없는 것은 실패가 아니다(빈 배열·null 둘 다).
  assert.equal(syncBatchStatus([]), "ok", "A2 빈 목록을 실패로 봤다");
  assert.equal(syncBatchStatus(null), "ok", "A2 null 을 실패로 봤다");
  assert.equal(syncBatchStatus(undefined), "ok", "A2 undefined 를 실패로 봤다");
  //  A3 이미 도는 중 — 기다리면 풀린다(정상 배압).
  assert.equal(syncBatchStatus([{ ok: true, skipped: "already_running" }]), "ok", "A3 정상 배압을 실패로 봤다");
  //  A4 하나라도 실패
  assert.equal(syncBatchStatus([{ ok: false, error: "boom" }]), "error", "A4 실패를 정상으로 적었다 — #968 계열 재발");
  //  A5 부분 실패 — 성공으로 접지 않는다.
  assert.equal(syncBatchStatus([{ ok: true }, { ok: false }, { ok: true }]), "error", "A5 부분 실패를 성공으로 접었다");
  //  A6 ★ 이번에 기대는 축(ok)이 비어 있는 경우 — 모르는 결과를 정상으로 적지 않는다.
  assert.equal(syncBatchStatus([{ run_id: 7 } as unknown]), "error", "A6 ok 가 없는 항목을 정상으로 봤다");
  //  A7 항목이 객체가 아님 — 호출부 방어.
  assert.equal(syncBatchStatus([null as unknown]), "error", "A7 null 항목을 정상으로 봤다");
  assert.equal(syncBatchStatus(["ok" as unknown]), "error", "A7 문자열 항목을 정상으로 봤다");
  //  A8 실패에 붙은 skipped 는 정상이 아니다.
  assert.equal(syncBatchStatus([{ ok: false, skipped: "already_running" }]), "error", "A8 실패의 skipped 를 정상으로 봤다");
  //  경계 — ok 가 truthy 지만 true 가 아닌 값(1·"true")을 통과시키지 않는다(엄격 판정).
  assert.equal(syncBatchStatus([{ ok: 1 as unknown }]), "error", "ok:1 을 성공으로 봤다 — 판정이 느슨하다");
});

test("표 C — 부모 재시작 시 살아 있는 자식은 이어받고, 죽었을 때만 닫는다", () => {
  //  C1 살아 있고 우리 것 → 이어받는다. 죽이지 않는다.
  const c1 = orphanVerdict({ pid: 1234, aliveAndOurs: true });
  assert.deepEqual(c1, { close: false, kill: false, adopt: true }, "C1 살아 있는 수집을 죽이거나 닫았다");
  //  C2 pid 는 있는데 그 프로세스가 없다 → 닫는다.
  const c2 = orphanVerdict({ pid: 1234, aliveAndOurs: false });
  assert.equal(c2.close, true, "C2 죽은 run 을 안 닫았다");
  assert.equal(c2.adopt, false, "C2 죽은 run 을 이어받았다");
  //  C3 pid 재사용 — 남의 프로세스다. 닫되 건드리지 않는다.
  assert.equal(orphanVerdict({ pid: 999, aliveAndOurs: false }).kill, false, "C3 남의 프로세스를 죽이려 했다");
  //  C4 pid 없음 — 확인할 수단이 없다. 닫는다.
  const c4 = orphanVerdict({ pid: null, aliveAndOurs: false });
  assert.equal(c4.close, true, "C4 pid 없는 running 을 안 닫았다");
  assert.equal(c4.adopt, false, "C4 확인 못 한 것을 이어받았다");
  //  ★ 어떤 조합에서도 부팅 스윕이 kill 을 지시하지 않는다 — 죽었으면 죽일 것이 없고,
  //   살아 있으면 이어받는다. (진짜 유령은 하트비트 임계로 잡는 별도 경로가 처리한다.)
  for (const pid of [null, undefined, 0, 1234] as Array<number | null | undefined>) {
    for (const alive of [true, false]) {
      assert.equal(orphanVerdict({ pid, aliveAndOurs: alive }).kill, false, `kill 지시가 나왔다 (pid=${String(pid)} alive=${alive})`);
    }
  }
});

test("표 B6 — 자식 하트비트 주기는 유령 판정 임계의 절반 이하다(경계값 포함)", () => {
  //  운영 실값
  assert.ok(childHeartbeatMs(120_000) <= 60_000, `120s 임계에 주기 ${childHeartbeatMs(120_000)}ms — 절반을 넘는다`);
  //  ★ 경계값 — 임계가 작아져도 규약이 깨지면 안 된다. 주기가 임계를 넘으면 살아 있는 자식이
  //   자기 하트비트를 찍기도 전에 유령으로 판정된다(이번 변경이 막으려던 바로 그 사고).
  for (const stale of [2_000, 4_000, 10_000, 60_000, 120_000, 600_000]) {
    const beat = childHeartbeatMs(stale);
    assert.ok(beat <= Math.floor(stale / 2), `임계 ${stale}ms 에 주기 ${beat}ms — 절반을 넘는다`);
    assert.ok(beat > 0, `임계 ${stale}ms 에 주기가 0 이하다`);
  }
});

test("표 D — 판정을 계산만 하고 안 쓰는 것을 막는다(배선)", () => {
  //  D1 수집 크론이 표 A 판정을 쓴다 — status 하드코딩이 남아 있으면 안 된다.
  assert.match(CRON, /syncBatchStatus\(out\)/, "D1 수집 크론이 결과 판정을 안 쓴다 — 실패가 다시 ok 로 기록된다");
  assert.ok(!/return \{ status: "ok", summary: \{ systems: out \} \}/.test(CRON),
    "D1 옛 하드코딩이 남아 있다");
  //  D2 자식이 자기 생존을 직접 적는다.
  assert.match(CHILD, /--run/, "D2 자식이 run 번호를 안 받는다");
  assert.match(CHILD, /UPDATE connector_run SET heartbeat_at=now\(\)/, "D2 자식이 하트비트를 안 찍는다 — 부모가 죽으면 살아 있는 수집이 유령이 된다");
  //  D3 부팅 스윕이 표 C 판정을 쓴다 — 무조건 닫는 UPDATE 가 남아 있으면 안 된다.
  assert.match(TRACKER, /orphanVerdict\(/, "D3 부팅 스윕이 입양 판정을 안 쓴다");
  assert.ok(!/WHERE status='running' AND NOT \(id = ANY\(\$1::bigint\[\]\)\) RETURNING/.test(TRACKER),
    "D3 무조건 error 로 닫는 옛 UPDATE 가 남아 있다");
  //  D4 부모가 자식에게 run 번호를 넘긴다 — 안 넘기면 D2 가 영원히 발동하지 않는다.
  assert.match(TRACKER, /"--run", String\(runId\)/, "D4 부모가 자식에게 run 번호를 안 넘긴다");
});
