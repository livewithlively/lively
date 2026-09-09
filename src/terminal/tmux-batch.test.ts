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
import { TMUX_BATCH_MAX_ARGV, chunkTmuxCommands, tmuxBatchable, tmuxBatchRefOf, tmuxReadOneRoundTrip, type TmuxCmd } from "./tmux-exec.js";

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

// ── E12·E13 라우팅 키 보존 (#3668 리뷰에서 발견 · 2026-09-08) ────────────────────────────
//  ⚠ 묶는 것은 전송의 최적화처럼 보이지만 **라우팅의 입력**을 바꾼다. 매니지드에서 이 argv 를 읽는 사람이
//   둘 더 있다 — 중계(`tmux-relay.cjs sessionOf`)가 `x-lvly-session` 헤더를 만들고, 브로커
//   (`sessionbroker.tmuxSessionOf`)가 세션 축 전달을 정한다. 둘 다 **한 명령** 문법이다:
//   첫 비옵션이 동사 → 동사에 따라 `-s`/`-t` 를 찾되 **비옵션 인자를 만나면 멈춘다**.
//  그래서 `set-option -g default-terminal xterm-256color` 처럼 **세션을 안 지목하는 명령**을 앞에 묶으면
//   파서가 세 번째 인자에서 멈춰 뒤의 `new-session -s <id>` 를 **아예 못 본다** → 지목이 null 이 되고
//   그 명령이 배치 노드가 아니라 테넌트 핀 노드로 간다(크로스노드 세션은 생성이 깨진다).
//  실측(2026-09-08, 실제 중계 파서를 그대로 실행): 묶으면 `null`, 안 묶으면 `<id>`.
//  ⇒ **규칙: 세션을 지목하지 않는 명령은 배치에 안 싣는다**(`;` 인자와 같은 취급 — 홀로 보낸다).

/** 세션 생성이 실제로 내는 모양 — 전역 옵션이 판보다 **먼저** 서야 한다(새 pane 에만 적용되므로). */
const GLOBAL_OPT: TmuxCmd = ["set-option", "-g", "default-terminal", "xterm-256color"];
const NEW_SESSION: TmuxCmd = ["new-session", "-d", "-s", "box-x-1", "-c", "/work"];

test("E12 세션을 안 지목하는 명령(-g 전역)은 세션 명령과 안 묶인다 — 라우팅 키가 살아야 한다", () => {
  const out = chunkTmuxCommands([GLOBAL_OPT, NEW_SESSION]);
  assert.equal(out.length, 2, "묶으면 중계·브로커가 new-session 의 -s 를 못 본다");
  assert.deepEqual(out[0], [...GLOBAL_OPT], "전역 옵션이 먼저, 홀로");
  assert.deepEqual(out[1], [...NEW_SESSION], "세션 명령은 자기 argv 의 첫 명령이어야 한다");
});

test("E13 세션을 지목하는 명령끼리는 그대로 묶인다 — 이 규칙이 배치를 무력화하지 않는다", () => {
  const out = chunkTmuxCommands([opt(0), opt(1), opt(2)]);
  assert.equal(out.length, 1, "@box_* 메타는 전부 -t <id> 라 한 왕복 그대로");
  assert.equal(out[0]![0], "set-option");
  assert.equal(out[0]![1], "-t", "묶음의 첫 명령이 세션을 지목한다");
});

test("E14 지목 없는 명령이 중간에 끼면 앞뒤가 따로 묶인다 — 뒤 묶음도 첫 명령이 세션을 지목한다", () => {
  const out = chunkTmuxCommands([opt(0), GLOBAL_OPT, opt(1), opt(2)]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[1], [...GLOBAL_OPT]);
  assert.deepEqual(flatten([out[2]!]), [...opt(1), ...opt(2)]);
});

// ── E15 지목 읽기 — 중계·브로커 문법의 거울 (#3668) ───────────────────────────────────────
//  이 표가 갈리면 배치 판정이 갈리고, 그러면 라우팅이 갈린다. 그래서 행마다 못박는다.
//  ⚠ `set-option -s <opt> <val>` 은 **서버 옵션**이라 `-s` 가 있어도 세션이 아니다 —
//   «`-s`/`-t` 가 들어 있나» 같은 순진한 검사로는 이 행을 틀린다.
test("E15 세션 지목 읽기 — 동사에 따라 -s/-t, 서버 옵션의 -s 는 세션이 아니다", () => {
  const rows: Array<[TmuxCmd, string | null]> = [
    [["new-session", "-d", "-s", "box-x-1", "-c", "/work"], "box-x-1"],
    [["detach-client", "-s", "box-x-1"], "box-x-1"],
    [["set-option", "-t", "box-x-1", "@box_owner", "u1"], "box-x-1"],
    [["set-window-option", "-t", "box-x-1", "window-size", "latest"], "box-x-1"],
    [["set-option", "-g", "default-terminal", "xterm-256color"], null],
    [["set-option", "-s", "exit-empty", "off"], null],
    [["list-sessions", "-F", "#{session_name}"], null],
    //  ⚠ 지목은 있는데 **이름 형식 밖**이면 소비자들이 그 키를 거절한다 — 묶어 봐야 그 묶음이 통째로
    //   핀 노드로 떨어지므로, «지목 있음» 으로 세면 안 된다(정본 tmuxSessionOf 의 unparsed).
    [["set-option", "-t", "not a sid", "@box_x", "1"], null],
    [["-L", "sock", "set-option", "-t", "box-x-1", "mouse", "on"], "box-x-1"],
    [["attach", "-t", "box-x-1"], "box-x-1"],
    //  ⚠ **값이 옵션처럼 생긴 경우** — 라벨·플래그는 사람이 정하므로 `-t…` 로 시작할 수 있다.
    //   옵션 구간이 끝나면 멈추지 않으면 그 값의 뒷토막(`ricky`)을 세션으로 읽는다(라우팅 키 오염).
    [["set-option", "-t", "box-x-1", "@box_label", "-tricky"], "box-x-1"],
    [[], null],
  ];
  for (const [cmd, want] of rows) {
    assert.equal(tmuxBatchRefOf(cmd), want, `${JSON.stringify(cmd)} → ${want}`);
    if (cmd.length) assert.equal(tmuxBatchable(cmd), want !== null, "배치 가능 여부는 지목 유무를 따른다");
  }
});

// ── E16 한 묶음 = 한 세션 (#3668) ────────────────────────────────────────────────────────
//  묶음의 argv 는 **첫 명령의 지목**으로 라우팅된다(중계·브로커·코어 `planTmux` 셋 다). 그래서 다른 세션의
//  명령이 같은 묶음에 실리면 그 명령이 **남의 세션 컨테이너에서** 돈다. 오늘 호출부는 전부 한 세션이지만,
//  그건 우연이지 규칙이 아니다 — 규칙으로 못박는다.
test("E16 지목이 다른 명령은 같은 묶음에 안 실린다 — 남의 컨테이너에서 돌지 않게", () => {
  const a: TmuxCmd = ["set-option", "-t", "box-x-1", "@box_owner", "u1"];
  const b: TmuxCmd = ["set-option", "-t", "box-y-2", "@box_owner", "u2"];
  const out = chunkTmuxCommands([a, a, b, b]);
  assert.equal(out.length, 2, "세션이 갈리는 자리에서 묶음도 갈려야 한다");
  assert.deepEqual(flatten([out[0]!]), [...a, ...a]);
  assert.deepEqual(flatten([out[1]!]), [...b, ...b]);
  for (const chunk of out) {
    const first = chunk.slice(0, chunk.indexOf(";") === -1 ? chunk.length : chunk.indexOf(";"));
    assert.ok(tmuxBatchRefOf(first), "묶음의 첫 명령이 라우팅 키를 쥔다");
  }
});

// ── 읽기 한 왕복(#2600 T2 d6) ───────────────────────────────────────────────
//  왜: 아웃박스 준비 판정이 `capture-pane` 과 `display-message` 를 각각 불러 대기 세션당 초당 4 왕복이었고,
//   계수에서 게이트웨이 tmux 호출의 41% 였다. 두 읽기는 같은 세션을 같은 순간에 보는 것이라 한 묶음이면 된다.
//  ★ 이 시험이 지키는 것은 **왕복 수**다 — 묶이지 않으면 조용히 두 번 나가고, 그러면 이 변경의 이유가 사라진다.
const READY_PROBE: TmuxCmd[] = [
  ["display-message", "-p", "-t", "box-a-1", "#{pane_current_command}"],
  ["capture-pane", "-t", "box-a-1", "-p"],
];

test("R1 ★ 준비 탐침 두 읽기는 한 묶음이 된다(= 한 왕복)", () => {
  assert.equal(chunkTmuxCommands(READY_PROBE).length, 1);
});

test("R2 ★ 세션 지목이 갈리면 한 왕복이 아니다 — 그때는 던져야 한다", () => {
  //  묶음이 둘이 되는 입력. `tmuxReadOneRoundTrip` 은 이걸 조용히 두 번 보내지 않는다(계약).
  const mixed: TmuxCmd[] = [
    ["display-message", "-p", "-t", "box-a-1", "#{pane_current_command}"],
    ["capture-pane", "-t", "box-b-2", "-p"],
  ];
  assert.equal(chunkTmuxCommands(mixed).length, 2);
});

test("R3 못 싣는 명령이 섞이면 묶음이 갈린다", () => {
  const bad: TmuxCmd[] = [READY_PROBE[0]!, [";"], READY_PROBE[1]!];
  assert.ok(chunkTmuxCommands(bad).length > 1);
});

test("R4 ★ 한 왕복이 안 되는 입력이면 **던진다** — 조용히 두 번 나가면 이 함수를 쓸 이유가 없다", async () => {
  //  던지는 판정은 tmux 를 부르기 **전**이라, 이 시험은 실제 tmux 를 건드리지 않는다.
  const mixed: TmuxCmd[] = [
    ["display-message", "-p", "-t", "box-a-1", "#{pane_current_command}"],
    ["capture-pane", "-t", "box-b-2", "-p"],
  ];
  await assert.rejects(() => tmuxReadOneRoundTrip(mixed), /한 왕복/);
});
