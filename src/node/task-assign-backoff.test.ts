// 순수 단위 체크(node:assert) — 위탁 배정 실패의 백오프(#3629). 근거는 task-scheduler.ts 의 assignBackoffDelayMs 머리말.
// 실행: npm run build && node dist/node/task-assign-backoff.test.js
//
// 왜 이 시험이 있나(실측 2026-09-07, 매니지드 lively-46e3):
//   게이트웨이 로그에 «위탁 배정 실패 — 다음 tick 재시도» **693건**(6분에 200건). tick 5초 × 큐 상한 10분이라
//   태스크 하나가 **약 120회** 재시도했고, 시도마다 새 세션 id 를 만들어 대장에 유령 행을 쌓았다.
//   2 vCPU 박스의 load average 가 6 을 넘었고, 그 사이 사람이 여는 새 세션은 용량 부족으로 503 이었다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assignBackoffDelayMs, pruneAssignBackoff } from "./task-scheduler.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const SRC = readFileSync(new URL("../../src/node/task-scheduler.ts", import.meta.url), "utf8");
//  ⚠ 배정 함수의 **이름**을 앵커로 쓰지 않는다 — stage 는 워크스페이스 순회(#2418) 때문에
//   `assignQueuedWith(counts, extra)` 이고 main 은 `assignQueued()` 다. 본문의 첫 줄을 앵커로 삼으면
//   두 모양 모두에서 같은 자리를 잡는다.
const BODY = (() => {
  const i = SRC.indexOf("const queued = await queuedTasks();");
  if (i < 0) throw new Error("배정 함수 본문을 못 찾았다 — 앵커가 바뀌었으면 이 시험부터 고쳐라");
  return SRC.slice(i, SRC.indexOf("\n}\n", i));
})();

t("E1..E3 첫 실패부터 배증한다 — 15 → 30 → 60초", () => {
  assert.equal(assignBackoffDelayMs(1), 15_000);
  assert.equal(assignBackoffDelayMs(2), 30_000);
  assert.equal(assignBackoffDelayMs(3), 60_000);
});

t("E4..E5 경계값 — 상한 120초에서 멈추고 그 뒤로는 안 자란다", () => {
  assert.equal(assignBackoffDelayMs(4), 120_000, "네 번째에 상한에 닿는다");
  assert.equal(assignBackoffDelayMs(5), 120_000);
  assert.equal(assignBackoffDelayMs(20), 120_000, "오래 실패해도 상한을 넘지 않는다");
});

t("E6 경계값 — 0·음수도 최소 간격 아래로 안 내려간다(호출부가 1부터 세지만 방어한다)", () => {
  assert.equal(assignBackoffDelayMs(0), 15_000);
  assert.equal(assignBackoffDelayMs(-3), 15_000);
});

t("E10 ★ 큐 상한 10분 안의 시도 횟수가 120회에서 한 자리로 준다 — 이 변경의 값어치 그 자체", () => {
  let elapsed = 0, tries = 0;
  while (elapsed < 600_000 && tries < 500) { tries++; elapsed += assignBackoffDelayMs(tries); }
  assert.ok(tries >= 5 && tries <= 12, `10분 안 시도 ${tries}회 — 너무 적으면 복구가 늦고 너무 많으면 폭풍이 남는다`);
  //  종전(백오프 없음): 600초 / tick 5초 = 120회.
  assert.ok(tries < 120 / 5, `종전 120회 대비 최소 5배는 줄어야 한다(지금 ${tries}회)`);
});

// ── 소스 규율 — 순수 함수만으로는 못 지키는 배선을 소스에서 잰다 ─────────────
//  (assignQueued 는 DB·노드 RPC 를 타서 순수 시험이 안 된다. 그래서 «어느 자리에 걸었나» 를 본다.)

t("E8 ★★ 백오프는 **던진 경우에만** 건다 — 용량 부족은 값싼 판정이라 자리가 나면 즉시 가야 한다", () => {
  assert.ok(/catch \(err\)[\s\S]{0,400}assignBackoff\.set\(/.test(BODY),
    "catch 안에서 백오프를 건다");
  assert.ok(/await assignOne\(t, counts, extra\);[\s\S]{0,200}assignBackoff\.delete\(t\.id\)/.test(BODY),
    "던지지 않았으면(성공·용량부족 모두) 연속을 끊는다 — 용량 부족에 백오프가 걸리면 자리가 나도 늦게 간다");
});

t("E7 ★ 큐 대기 상한 판정이 백오프 skip **앞**에 있다 — 백오프 중인 태스크도 제 시각에 끝나야 한다", () => {
  const cap = BODY.indexOf("no_capacity_timeout");
  const skip = BODY.indexOf("now < bo.nextAt");
  assert.ok(cap > 0 && skip > 0, "두 판정이 다 있어야 한다");
  assert.ok(cap < skip, "상한이 백오프 뒤에 있으면 실패 확정이 최대 2분 미뤄진다");
});

t("E9a..E9c 오래 안 건드린 항목만 잊는다 — 경계값 포함", () => {
  const H = 600_000;
  const m = new Map<number, { n: number; nextAt: number }>([
    [1, { n: 1, nextAt: 1_000_000 }],                    // 미래(백오프 중)
    [2, { n: 3, nextAt: 1_000_000 - H }],                // 경계값 — 정확히 horizon
    [3, { n: 5, nextAt: 1_000_000 - H - 1 }],            // horizon 초과
  ]);
  pruneAssignBackoff(m, 1_000_000, H);
  assert.equal(m.has(1), true, "E9a 백오프 중인 항목은 남는다");
  assert.equal(m.has(2), true, "E9b 경계값은 남는다(> 이지 >= 가 아니다)");
  assert.equal(m.has(3), false, "E9c horizon 을 넘긴 항목만 지운다");
});

t("E9d ★★ 남의 워크스페이스 항목을 지우지 않는다 — 이 함수는 워크스페이스마다 불린다(#2418)", () => {
  //  «이번 큐에 없으면 지운다» 로 짜면 매 호출이 남의 카운터를 지워 백오프가 사실상 사라진다.
  assert.ok(!/live\.has\(/.test(BODY) && !/assignBackoff\.clear\(/.test(BODY),
    "큐 구성원으로 표를 정리하면 안 된다(워크스페이스 순회에서 남의 것을 지운다)");
  assert.ok(/pruneAssignBackoff\(assignBackoff, now,/.test(BODY),
    "정리는 시간 기준 한 곳(pruneAssignBackoff)에서만 한다");
  //  큐가 비어도 **먼저** 정리하고 나간다 — 안 그러면 조용한 워크스페이스의 표가 영영 안 줄어든다.
  const prune = BODY.indexOf("pruneAssignBackoff(");
  const empty = BODY.indexOf("if (!queued.length) return;");
  assert.ok(prune > 0 && empty > 0 && prune < empty, "빈 큐로 빠져나가기 전에 정리한다");
});

console.log(`\n${pass} passed`);
