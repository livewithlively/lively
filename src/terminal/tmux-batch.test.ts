// tmux 명령 묶어 보내기 (#3537) — 사양.
//
//  매니지드에서 tmux 호출 하나는 **중계**다(새 Node 프로세스 → 허브 → 브로커 → `docker exec`). 실측 0.45~1.0초.
//  세션 생성이 그 왕복을 15번 순차로 해서 7~15초가 걸렸다. tmux 는 한 호출에서 `;` 로 여러 명령을 받으므로
//  왕복 수를 명령 수에서 떼어낸다. 여기 잠그는 것은 **그 나누기 규칙**이다.
//
//  ⚠ tmux 쪽 계약은 실측으로 확인했다(2026-09-04, tmux 3.x — tmux-exec.ts 머리말):
//   인자 **안**의 `;` 는 값이고, 인자가 **정확히** `;` 이면 구분자다. 그래서 후자는 못 묶는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { TMUX_BATCH_MAX_ARGV, chunkTmuxCommands, tmuxBatchable, type TmuxCmd } from "./tmux-exec.js";

/** 5-인자짜리 set-option 한 벌 — 실제로 이 함수가 나르는 모양(@box_* 메타)이다. */
const opt = (n: number): TmuxCmd => ["set-option", "-t", "box-x-1", `@box_m${n}`, String(n)];

/** 묶음에서 구분자를 뺀 평탄한 인자열 — 값이 유실·재배열되지 않았나 보는 눈. */
const flatten = (chunks: string[][]): string[] => chunks.flat().filter((a) => a !== ";");

test("E1 빈 목록 → 묶음 0개", () => {
  assert.deepEqual(chunkTmuxCommands([]), []);
});

test("E2 명령 1개 → 묶음 1개, 구분자 없음", () => {
  const out = chunkTmuxCommands([opt(0)]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], ["set-option", "-t", "box-x-1", "@box_m0", "0"]);
  assert.equal(out[0]!.includes(";"), false, "명령이 하나면 구분자가 붙을 자리가 없다");
});

test("E3 상한 이내의 여러 명령 → 한 묶음, 구분자 n-1 개", () => {
  const out = chunkTmuxCommands([opt(0), opt(1), opt(2)], 60);
  assert.equal(out.length, 1, "한 왕복으로 나가야 한다 — 이 함수의 존재 이유");
  assert.equal(out[0]!.filter((a) => a === ";").length, 2);
  assert.deepEqual(flatten(out), [...opt(0), ...opt(1), ...opt(2)]);
});

test("E4 상한 초과 → 여러 묶음, 각 묶음이 상한 이하, 순서 보존", () => {
  const cmds = Array.from({ length: 13 }, (_v, i) => opt(i));
  const out = chunkTmuxCommands(cmds, 60);
  assert.ok(out.length > 1, "13개(argv 77)는 상한 60 을 넘으므로 나뉘어야 한다");
  for (const c of out) assert.ok(c.length <= 60, `묶음이 상한을 넘었다: ${c.length}`);
  assert.deepEqual(flatten(out), cmds.flatMap((c) => [...c]), "순서·값이 그대로여야 한다");
});

// ★ 오프바이원 — 표에 이 두 행이 없으면 `>` / `>=` 실수는 영원히 안 잡힌다.
test("E5·E6 경계 — 정확히 상한이면 한 묶음, 하나 더 넘으면 두 묶음", () => {
  // 명령 하나 5인자 + 구분자 1 = 6. 명령 4개 = 5*4 + 3 = 23.
  const four = [opt(0), opt(1), opt(2), opt(3)];
  assert.equal(chunkTmuxCommands(four, 23).length, 1, "합이 정확히 상한이면 «넘은 것»이 아니다");
  assert.equal(chunkTmuxCommands(four, 22).length, 2, "1 만 모자라면 나뉜다");
});

test("E7 인자가 정확히 ';' 인 명령은 홀로 나가고 앞뒤는 정상 배치", () => {
  const weird: TmuxCmd = ["set-option", "-t", "box-x-1", "@box_label", ";"];
  assert.equal(tmuxBatchable(weird), false);
  const out = chunkTmuxCommands([opt(0), weird, opt(1)], 60);
  assert.equal(out.length, 3, "못 묶는 명령이 앞뒤를 갈라 세 묶음이 된다");
  assert.deepEqual(out[1], [...weird], "그 명령은 종전처럼 홀로 — 값을 고치거나 버리지 않는다");
  assert.equal(out[0]!.includes(";"), false);
  assert.equal(out[2]!.includes(";"), false);
});

test("E8 빈 명령은 버린다 — 빈 묶음·떠도는 구분자를 만들지 않는다", () => {
  const out = chunkTmuxCommands([[], opt(0), [], opt(1), []], 60);
  assert.equal(out.length, 1);
  assert.deepEqual(flatten(out), [...opt(0), ...opt(1)]);
  assert.equal(out[0]![0], "set-option", "첫 인자가 옵션·구분자면 브로커가 통째로 거부한다");
});

test("E9 단독으로 상한을 넘는 명령은 쪼갤 수 없다 — 그대로 내보낸다(유실 금지)", () => {
  const huge: TmuxCmd = ["set-option", "-t", "box-x-1", "@box_flags", "x".repeat(10)];
  const out = chunkTmuxCommands([huge], 3);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], [...huge]);
});

test("E10 기본 상한은 브로커의 종전 상한(64)보다 작다 — 상한 완화 배포와 순서 의존이 없게", () => {
  assert.ok(TMUX_BATCH_MAX_ARGV < 64, `기본 ${TMUX_BATCH_MAX_ARGV} 는 64 보다 작아야 한다`);
  const cmds = Array.from({ length: 13 }, (_v, i) => opt(i));
  for (const c of chunkTmuxCommands(cmds)) {
    assert.ok(c.length <= TMUX_BATCH_MAX_ARGV);
    assert.ok(c.length <= 64, "옛 브로커(상한 64)에서도 거부되지 않아야 한다");
  }
});

test("E11 평탄화 정합 — 어떤 상한에서도 명령 순서·값이 보존된다", () => {
  const cmds = Array.from({ length: 9 }, (_v, i) => opt(i));
  const want = cmds.flatMap((c) => [...c]);
  for (const max of [3, 6, 11, 17, 23, 60, 1000]) {
    assert.deepEqual(flatten(chunkTmuxCommands(cmds, max)), want, `상한 ${max} 에서 어긋났다`);
  }
});
