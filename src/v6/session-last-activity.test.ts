// `session.last_seen` 이 '대화가 마지막으로 움직인 시각' 을 가리키게 하는 판정 (#2050).
//  실행: npm run build && node dist/v6/session-last-activity.test.js
//
// 왜 필요했나
//   종전엔 `ON CONFLICT … DO UPDATE SET last_seen=now()` 였다 — 그 값은 **미러가 받은 시각**이지
//   대화가 마지막으로 움직인 시각이 아니다. 목록은 `ORDER BY s.last_seen DESC` 라, 몇 달 전 대화가
//   훅을 통해 **처음** 올라오는 순간 목록 맨 위에 새것처럼 섰다. 그것이 세션 창이 저절로 남의 세션으로
//   넘어가던 사고의 방아쇠였다(화면 폴백이 '맨 위'를 골랐다).
//
// ⚠ 이 파일은 순수 판정만 본다. 값을 실제로 쓰는 SQL(COALESCE 폴백 · GREATEST 단조성)은 DB 를 타므로
//   itest 영역이다 — 아래 13행 주석 참조.
import assert from "node:assert/strict";
import { lastActivityAt } from "./session-log-store.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const NOW = Date.parse("2026-08-26T10:00:00.000Z");
const L = (o: unknown): string => JSON.stringify(o);

// ── 1행: 줄 여럿 → 마지막 줄의 시각 ─────────────────────────────────────────
{
  const jsonl = [
    L({ type: "user", timestamp: "2026-08-26T09:00:00.000Z" }),
    L({ type: "assistant", timestamp: "2026-08-26T09:05:00.000Z" }),
  ].join("\n");
  assert.equal(lastActivityAt(jsonl, NOW)?.toISOString(), "2026-08-26T09:05:00.000Z");
  ok("1 여러 줄 — 마지막 timestamp 를 고른다");
}

// ── 2행: 꼬리 메타 줄은 건너뛰고 그 앞의 유효 시각 ───────────────────────────
//  실측(dev 트랜스크립트): 앞뒤에 `last-prompt`·`mode` 처럼 timestamp 없는 줄이 붙는다.
{
  const jsonl = [
    L({ type: "assistant", timestamp: "2026-08-26T09:05:00.000Z" }),
    L({ type: "mode" }),
    L({ type: "last-prompt" }),
  ].join("\n");
  assert.equal(lastActivityAt(jsonl, NOW)?.toISOString(), "2026-08-26T09:05:00.000Z");
  ok("2 꼬리 메타 줄을 건너뛰고 그 앞 시각");
}

// ── 3~6행: 못 읽으면 null(= 호출부가 now() 로 폴백) ─────────────────────────
{
  assert.equal(lastActivityAt("", NOW), null, "3 빈 문자열");
  assert.equal(lastActivityAt("not json\nalso not json", NOW), null, "4 JSON 아님");
  assert.equal(lastActivityAt(L({ type: "mode" }), NOW), null, "5 timestamp 부재");
  assert.equal(lastActivityAt(L({ type: "user", timestamp: "그런날없음" }), NOW), null, "6 파싱 불가 날짜");
  assert.equal(lastActivityAt(L({ type: "user", timestamp: 1234 }), NOW), null, "6' 문자열이 아닌 timestamp");
  ok("3~6 못 읽으면 null — 모르는 것을 지어내지 않는다");
}

// ── 7~9행: 미래 시각 — 여유(5분) 경계 ───────────────────────────────────────
//  시계가 앞선 기계의 보고를 그대로 쓰면 그 세션이 목록 맨 위에 **영구히** 박힌다.
{
  const over = new Date(NOW + 5 * 60_000 + 1).toISOString();     // 여유 초과(+1ms)
  assert.equal(lastActivityAt(L({ type: "user", timestamp: over }), NOW), null, "7 여유 초과 = 버림");

  const edge = new Date(NOW + 5 * 60_000).toISOString();          // ★ 경계값: 정확히 5분
  assert.equal(lastActivityAt(L({ type: "user", timestamp: edge }), NOW)?.toISOString(), edge,
    "8 정확히 여유 경계 = 허용(경계 포함)");

  const inside = new Date(NOW + 60_000).toISOString();
  assert.equal(lastActivityAt(L({ type: "user", timestamp: inside }), NOW)?.toISOString(), inside, "9 여유 안");
  ok("7~9 미래 — 여유 5분 경계에서 갈린다(경계 포함)");
}

// ── 10행: 과거는 그대로 — 이 함수의 존재 이유 ───────────────────────────────
{
  const old = "2026-03-01T12:00:00.000Z";
  assert.equal(lastActivityAt(L({ type: "user", timestamp: old }), NOW)?.toISOString(), old);
  ok("10 아주 오래된 시각도 그대로 — 오래된 대화를 맨 위에 세우지 않기 위한 것");
}

// ── 11~12행: 꼬리 훑기 상한 경계 ────────────────────────────────────────────
//  큰 델타를 전수 파싱하지 않는다. 상한 밖이면 '못 찾음'(null)으로 조용히 폴백한다.
{
  const stamped = L({ type: "user", timestamp: "2026-08-26T09:00:00.000Z" });
  const filler = (n: number): string[] => Array.from({ length: n }, () => L({ type: "mode" }));

  // ★ 경계값: timestamp 줄이 꼬리에서 정확히 400번째(마지막 줄 포함해 세어 상한 안) → 찾는다
  assert.equal(lastActivityAt([stamped, ...filler(399)].join("\n"), NOW)?.toISOString(),
    "2026-08-26T09:00:00.000Z", "12 상한 경계 안이면 찾는다");

  // 한 줄 더 밀어내면 상한 밖 → null
  assert.equal(lastActivityAt([stamped, ...filler(400)].join("\n"), NOW), null,
    "11 상한 밖이면 null(안전한 실패)");
  ok("11~12 꼬리 상한 — 경계에서 갈린다");
}

// ── 13행 (★ 새로 도입한 것이 '부재'인 경우) ──────────────────────────────────
//  이 함수는 **null 을 정상 반환값으로 갖는다**. 그 자리를 SQL 이 받는다:
//    last_seen = GREATEST(session.last_seen, COALESCE($7::timestamptz, now()))
//  · COALESCE — null 이면 종전 동작(now()) 그대로. 새 코드가 기존 동작을 좁히지 않는다.
//  · GREATEST — 같은 델타 재전송(멱등)에도 값이 과거로 되돌지 않는다.
//  여기서는 그 계약의 **입력 쪽**만 못박는다(SQL 은 DB 를 타므로 itest 영역):
//  '읽어낼 수 없는 델타'는 반드시 null 이어야 하고, 예외를 던지면 안 된다 — 대화 기록 저장이 먼저다.
{
  for (const bad of ["", "\n\n\n", "{", '{"timestamp":null}', '{"timestamp":{}}', "[]", "null"]) {
    assert.doesNotThrow(() => lastActivityAt(bad, NOW), `깨진 입력에 throw 하면 안 된다: ${bad}`);
    assert.equal(lastActivityAt(bad, NOW), null, `깨진 입력은 null 이어야 한다: ${bad}`);
  }
  ok("13 읽을 수 없는 델타는 예외 없이 null — SQL 이 now() 로 받는다");
}

console.log(`\nPASS — ${pass} groups`);
