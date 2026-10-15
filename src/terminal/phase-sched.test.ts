// #4695 T5 — 턴 끝 보고(@box_state)에 싣는 예약(wake·cron)의 형식. 사양 엣지 표 D(F1~F7).
//  틀리면 티가 크다:
//   🔴 한쪽만 온 예약을 «셌다» 로 읽으면 — cron 을 못 센 보고가 «예약 없음» 이 되어 반복 예약 세션이 꺼진다.
//   🔴 bg 를 세 번째 토큰 자리에서 밀어내면 — 옛 파서(세 번째 토큰만 bg 로 읽는 노드 번들·세션 호스트)가 bg 를 잃는다.
//   🔴 도는 턴(busy) 보고에 예약을 실으면 — 턴 중의 예약 수는 아직 정해지지 않았다(턴 끝에 센 값만 사실이다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { parseReportedPhase, formatReportedPhase, isReportedSched } from "./phase.js";

const T = 1_789_000_000;

test("F1 idle + bg + 예약 → «idle T bg=N wake=W cron=C» · 되읽으면 같다", () => {
  const s = formatReportedPhase("idle", T, 2, { wake: T + 1200, cron: 1 });
  assert.equal(s, `idle ${T} bg=2 wake=${T + 1200} cron=1`);
  assert.deepEqual(parseReportedPhase(s), { phase: "idle", at: T, bg: 2, wake: T + 1200, cron: 1 });
});
test("F2 idle + 예약만(bg 모름) → bg 키가 없고 예약은 실린다", () => {
  const s = formatReportedPhase("idle", T, null, { wake: 0, cron: 0 });
  assert.equal(s, `idle ${T} wake=0 cron=0`);
  assert.deepEqual(parseReportedPhase(s), { phase: "idle", at: T, wake: 0, cron: 0 });
});
test("F3 busy·waiting 보고엔 bg·예약을 싣지 않는다 — 실린 줄을 읽어도 버린다", () => {
  assert.equal(formatReportedPhase("busy", T, 1, { wake: T + 60, cron: 1 }), `busy ${T}`);
  assert.equal(formatReportedPhase("waiting", T, 1, { wake: T + 60, cron: 1 }), `waiting ${T}`);
  assert.deepEqual(parseReportedPhase(`busy ${T} bg=1 wake=${T + 60} cron=1`), { phase: "busy", at: T });
});
test("F4 예약 둘 중 하나만 있는 줄은 예약을 모르는 것이다(wake 도 cron 도 없음)", () => {
  assert.deepEqual(parseReportedPhase(`idle ${T} bg=0 wake=${T + 60}`), { phase: "idle", at: T, bg: 0 });
  assert.deepEqual(parseReportedPhase(`idle ${T} bg=0 cron=1`), { phase: "idle", at: T, bg: 0 });
  assert.deepEqual(parseReportedPhase(`idle ${T} bg=0`), { phase: "idle", at: T, bg: 0 }, "#4588 형식(예약 셈 전) — 예약 키 없음");
});
test("F5 옛 파서(세 번째 토큰만 bg 로 읽는다)가 새 형식을 읽어도 bg 는 그대로다", () => {
  //  #4588 판의 파서 — 세션 호스트·노드 번들이 롤 전까지 이 모양으로 읽는다.
  const oldParse = (raw: string): number | undefined => {
    const [, , third] = raw.trim().split(/\s+/);
    const m = /^bg=(\d{1,4})$/.exec(third || "");
    return m ? Number(m[1]) : undefined;
  };
  assert.equal(oldParse(formatReportedPhase("idle", T, 3, { wake: T + 600, cron: 2 })), 3);
});
test("F6 깨진 값(음수 · 문자 · 13자리 · 다섯 자리 cron)은 예약으로 받지 않는다", () => {
  for (const tail of [`wake=-5 cron=0`, `wake=abc cron=0`, `wake=${"9".repeat(13)} cron=0`, `wake=${T} cron=10000`, `wake= cron=0`]) {
    assert.deepEqual(parseReportedPhase(`idle ${T} bg=0 ${tail}`), { phase: "idle", at: T, bg: 0 }, tail);
  }
  //  깨진 예약은 실을 때도 버린다(형식이 깨진 줄을 tmux 에 새기지 않는다).
  assert.equal(formatReportedPhase("idle", T, 0, { wake: -1, cron: 0 }), `idle ${T} bg=0`);
  assert.equal(formatReportedPhase("idle", T, 0, { wake: 1.5, cron: 0 }), `idle ${T} bg=0`);
});
test("F7 isReportedSched 경계 — wake 0·12자리 허용 · 13자리 거부 · cron 9999 허용 · 10000 거부 · 둘 다 있어야 한다", () => {
  assert.equal(isReportedSched({ wake: 0, cron: 0 }), true);
  assert.equal(isReportedSched({ wake: 999_999_999_999, cron: 9999 }), true);
  assert.equal(isReportedSched({ wake: 1e12, cron: 0 }), false);
  assert.equal(isReportedSched({ wake: 0, cron: 10_000 }), false);
  assert.equal(isReportedSched({ wake: 0 }), false);
  assert.equal(isReportedSched({ cron: 0 }), false);
  assert.equal(isReportedSched({ wake: "0", cron: 0 }), false);
  assert.equal(isReportedSched(null), false);
});
