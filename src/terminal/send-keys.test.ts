// 순수 단위 체크(node:assert) — 세션 주입 계획(#1664).
// 사양 7정책 · 엣지 16행(스크래치 spec.md)을 행마다 시나리오로 옮긴 것. 실행부(sendKeysToSession)는
//  프로세스를 띄우므로 여기서 안 잰다 — 계획을 순수하게 갈라 둔 이유가 **Windows 노드를 CI 에서 못 띄우기**
//  때문이다. 그 표면 규칙을 mac 에서도 표로 못박는다.
import assert from "node:assert/strict";
import { sendKeysPlan, injectFlushMs, splitUtf8, TMUX_LITERAL_CHUNK_BYTES } from "./send-keys.js";
import { HARNESSES } from "./catalog.js";

const TMUX = "/opt/homebrew/bin/tmux";
const PSMUX = "C:\\Users\\y\\.lively\\bin\\psmux\\psmux.exe";
const CHUNK = 512; // 사양의 '한 번에 보내는 토큰 상한'
const toks = (argv: string[]): string[] => argv.slice(3); // argv 머리 3개(send-keys/-t/id) 뒤가 키 토큰

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 1. 일반 mux ──────────────────────────────────────────────────────────────
t("[1] tmux — 텍스트는 리터럴 1회(옵션 끝 `--` 뒤), 제출은 Enter 키", () => {
  const p = sendKeysPlan("box-yoon-1", "안녕", TMUX);
  assert.deepEqual(p.keys, [["send-keys", "-t", "box-yoon-1", "-l", "--", "안녕"]]);
  assert.deepEqual(p.enter, ["send-keys", "-t", "box-yoon-1", "Enter"]);
});

// ── 치던 글 치워 두기(원준 2026-10-10 — 글을 치다가 모델·추론강도를 바꾸면 치던 글 뒤에 `/model …` 이 붙어 나갔다) ──
t("[1b] 모델·추론강도 명령 앞의 «치워 두기» 키(Ctrl+S)는 다듬기에서 살아남아 명령 앞에 그대로 실린다", () => {
  const claude = HARNESSES.find((h) => h.key === "claude")!;
  assert.equal(claude.runtimeDraftStash, "\x13", "claude 는 Ctrl+S 로 치던 글을 치워 둔다(2.1.296 실측)");
  const cmd = claude.runtimeDraftStash + claude.runtimeCmd!.effort!("high");
  const p = sendKeysPlan("box-yoon-1", cmd, TMUX);
  assert.deepEqual(p.keys, [["send-keys", "-t", "box-yoon-1", "-l", "--", "\x13/effort high"]]);
  const w = sendKeysPlan("box-yoon-1", cmd, PSMUX);
  assert.equal(toks(w.keys[0])[0], "0x13", "psmux 도 첫 토큰이 Ctrl+S");
  for (const h of HARNESSES) if (h.runtimeDraftStash) assert.ok(h.runtimeCmd, `${h.key}: 치워 두기 키는 런타임 명령이 있는 하네스에만`);
});

// ── 2~5. Windows mux 표면 ────────────────────────────────────────────────────
t("[2] psmux — 코드포인트 토큰 + 제출도 코드포인트(키 이름 Enter 아님)", () => {
  const p = sendKeysPlan("box-yoon-1", "ls", PSMUX);
  assert.deepEqual(p.keys, [["send-keys", "-t", "box-yoon-1", "0x6c", "0x73"]]);
  assert.deepEqual(p.enter, ["send-keys", "-t", "box-yoon-1", "0x0d"]);
  assert.ok(!p.enter.includes("Enter"), "psmux 에 키 이름 Enter 를 보내면 제출이 안 된다");
});

t("[3] psmux — 한글은 바이트가 아니라 코드포인트 1토큰", () => {
  // '한' = U+D55C. UTF-8 바이트(ed 95 9c) 3토큰으로 쪼개면 화면이 'íU\' 로 깨진다.
  assert.deepEqual(toks(sendKeysPlan("s", "한", PSMUX).keys[0]), ["0xd55c"]);
});

t("[4] psmux — BMP 밖 문자(이모지)도 1토큰 (서로게이트 쌍이 안 쪼개진다)", () => {
  assert.deepEqual(toks(sendKeysPlan("s", "🚀", PSMUX).keys[0]), ["0x1f680"]);
});

t("[5] psmux — 작은 제어문자도 토큰 폭 2자리 유지", () => {
  // ⚠ 제어문자를 양 끝에 두면 안 된다 — Tab(0x09)은 공백류라 정책 1(앞뒤 여백 버림)의 trim 에 먹힌다.
  //  여기서 재려는 건 폭이지 trim 이 아니므로 텍스트 **중간**에 둔다.
  const got = toks(sendKeysPlan("s", "a\x03\x09b", PSMUX).keys[0]);
  assert.deepEqual(got, ["0x61", "0x03", "0x09", "0x62"]);
  for (const tok of got) assert.ok(tok.length >= 4, `폭 부족(Ctrl-C·Tab 이 안 먹는다): ${tok}`);
});

// ── 6~7. 청크 (+ 경계값) ─────────────────────────────────────────────────────
t("[6] psmux — 상한 초과는 여러 묶음으로 갈리고 각 묶음이 자족적·순서 보존", () => {
  const text = Array.from({ length: CHUNK + 88 }, (_, i) => String.fromCodePoint(0x41 + (i % 26))).join("");
  const p = sendKeysPlan("s", text, PSMUX);
  assert.equal(p.keys.length, 2);
  assert.equal(toks(p.keys[0]).length, CHUNK);
  assert.equal(toks(p.keys[1]).length, 88);
  for (const argv of p.keys) assert.deepEqual(argv.slice(0, 3), ["send-keys", "-t", "s"], "묶음마다 대상 세션이 실려야 한다");
  // 순서 보존 — 이어붙이면 원문 그대로
  const flat = p.keys.flatMap(toks).map((h) => String.fromCodePoint(parseInt(h, 16))).join("");
  assert.equal(flat, text);
});

t("[7·경계] psmux — 정확히 상한이면 1묶음, +1이면 2묶음", () => {
  assert.equal(sendKeysPlan("s", "a".repeat(CHUNK), PSMUX).keys.length, 1);
  const over = sendKeysPlan("s", "a".repeat(CHUNK + 1), PSMUX);
  assert.equal(over.keys.length, 2);
  assert.equal(toks(over.keys[1]).length, 1);
});

// ── 8~10. 한 번만 제출 / 보낼 것 없음 ────────────────────────────────────────
t("[8] 개행은 공백으로 평탄화 — 안 하면 그 자리에서 조기 제출돼 프롬프트가 잘린다", () => {
  const p = sendKeysPlan("s", "첫 줄\n  둘째 줄\n\n셋째", TMUX);
  assert.equal(p.oneLine, "첫 줄 둘째 줄 셋째");
  assert.ok(!p.keys[0][5].includes("\n"), "실제로 보내는 인자에 개행이 남아 있다");
});

t("[9] 앞뒤 여백은 잘린다", () => {
  assert.equal(sendKeysPlan("s", "  일감  ", TMUX).oneLine, "일감");
});

t("[10] 빈 문자열·공백뿐이면 보낼 키가 없다 (양 mux)", () => {
  for (const bin of [TMUX, PSMUX]) {
    for (const raw of ["", "   ", "\n\n", " \t \n "]) {
      const p = sendKeysPlan("s", raw, bin);
      assert.equal(p.oneLine, "", `bin=${bin} raw=${JSON.stringify(raw)}`);
      assert.deepEqual(p.keys, [], `bin=${bin} raw=${JSON.stringify(raw)} — 빈 제출을 흘리면 안 된다`);
    }
  }
});

// ── 11. 인젝션 ───────────────────────────────────────────────────────────────
t("[11] mux 메타문자는 별도 명령이 되지 않는다", () => {
  const evil = "; kill-server ; new-session -d";
  const tm = sendKeysPlan("s", evil, TMUX);
  assert.equal(tm.keys.length, 1, "인자가 쪼개져 여러 명령이 됐다");
  assert.equal(tm.keys[0][5], evil, "리터럴 인자 하나로 머물러야 한다");
  for (const tok of toks(sendKeysPlan("s", evil, PSMUX).keys[0])) assert.match(tok, /^0x[0-9a-f]+$/);
});

// ── 12~14. 대기 시간 ─────────────────────────────────────────────────────────
t("[12] 대기 하한 — 짧아도 그릴 틈은 준다", () => {
  assert.equal(injectFlushMs(0), 500);
  assert.equal(injectFlushMs(100), 500);
});
t("[13] 대기 비례 구간", () => {
  assert.equal(injectFlushMs(1000), 600);
  assert.equal(injectFlushMs(2000), 1200);
});
t("[14] 대기 상한 — 크론 주입이 하염없이 느려지지 않게", () => {
  assert.equal(injectFlushMs(100000), 1500);
});

// ── 15. 세션 id 전파 ─────────────────────────────────────────────────────────
t("[15] 세션 id 는 텍스트·제출 모든 argv 에 실린다", () => {
  const id = "box-yoon-56c6ae98";
  for (const bin of [TMUX, PSMUX]) {
    const p = sendKeysPlan(id, "a".repeat(CHUNK + 5), bin); // 청크가 갈려도 전부
    for (const argv of [...p.keys, p.enter]) assert.equal(argv[2], id, `bin=${bin}`);
  }
});

// ── 16. 새 입력이 비었을 때 (정책 7) ─────────────────────────────────────────
t("[16] mux 경로를 모르면 일반 mux 취급 — Windows 전용 표면을 근거 없이 쓰지 않는다", () => {
  for (const bin of ["", "  ", "/usr/bin/tmux", "/opt/homebrew/bin/tmux-next"]) {
    const p = sendKeysPlan("s", "ls", bin);
    assert.deepEqual(p.keys, [["send-keys", "-t", "s", "-l", "--", "ls"]], `bin=${JSON.stringify(bin)}`);
    assert.deepEqual(p.enter, ["send-keys", "-t", "s", "Enter"], `bin=${JSON.stringify(bin)}`);
  }
});

// ── 17~21. tmux 청크 · 옵션 끝(#3870) ──────────────────────────────────────────
//  실측 2026-09-22(tmux 3.6a): 인자 하나가 16KiB 를 넘으면 `command too long` 으로 명령이 통째로 거절된다 —
//  음성 받아쓰기 첫 지시(한글 수천 자)가 한 글자도 안 들어갔다(box-wonjoon-jang-3da5e47e).
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
t("[17] tmux — 긴 한글 지시는 여러 리터럴로 갈리고, 각 인자는 상한 이하 · 이어붙이면 원문 그대로", () => {
  const text = "큰 데이터가 있단 말이야. 그치 아무래도 슬랙 수집기가 엄청 많이 돌잖아. ".repeat(400);   // ≈ 40KB
  const p = sendKeysPlan("s", text, TMUX);
  assert.ok(bytes(p.oneLine) > 16 * 1024, "시험 전제 — tmux 한 통을 넘는 길이여야 한다");
  assert.ok(p.keys.length >= 3, `청크 수 ${p.keys.length}`);
  for (const argv of p.keys) {
    assert.deepEqual(argv.slice(0, 5), ["send-keys", "-t", "s", "-l", "--"], "묶음마다 대상 세션·리터럴·옵션 끝이 실려야 한다");
    assert.equal(argv.length, 6);
    assert.ok(bytes(argv[5]) <= TMUX_LITERAL_CHUNK_BYTES, `인자 ${bytes(argv[5])}B — 상한 초과`);
  }
  assert.equal(p.keys.map((a) => a[5]).join(""), p.oneLine, "순서·내용 보존");
});
t("[18] 코드포인트 경계에서만 자른다 — 한글(3B)·이모지(4B, 서로게이트 쌍)가 가운데서 안 잘린다", () => {
  for (const unit of ["한", "🚀", "a한🚀"]) {
    const parts = splitUtf8(unit.repeat(5000), 100);
    for (const part of parts) {
      assert.ok(bytes(part) <= 100);
      assert.ok(!/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part), "서로게이트 쌍이 갈렸다");
      assert.equal(Buffer.from(part, "utf8").toString("utf8"), part, "UTF-8 왕복이 깨졌다");
    }
    assert.equal(parts.join(""), unit.repeat(5000));
  }
});
t("[19·경계] splitUtf8 — 정확히 상한이면 1조각, +1바이트면 2조각, 빈 문자열은 0조각", () => {
  assert.deepEqual(splitUtf8("a".repeat(10), 10), ["a".repeat(10)]);
  assert.deepEqual(splitUtf8("a".repeat(11), 10), ["a".repeat(10), "a"]);
  assert.deepEqual(splitUtf8("한한한", 9), ["한한한"]);
  assert.deepEqual(splitUtf8("한한한", 8), ["한한", "한"]);
  assert.deepEqual(splitUtf8("", 10), []);
});
t("[20] `-` 로 시작하는 지시(마크다운 목록 등)도 옵션이 아니라 글자로 간다 — `--` 뒤에 싣는다", () => {
  //  실측: `send-keys -l '-foo'` 는 `unknown flag -f` 로 거절, `-R` 은 조용히 삼켜져 아무것도 안 간다.
  for (const raw of ["- 이거 해 줘\n- 저거도", "-R", "--help"]) {
    const argv = sendKeysPlan("s", raw, TMUX).keys[0];
    assert.equal(argv[4], "--", `raw=${JSON.stringify(raw)}`);
    assert.ok(argv[5].startsWith("-"), "텍스트는 `--` 다음 인자여야 한다");
  }
});
t("[21] 짧은 지시는 여전히 한 번에 — 청크는 상한을 넘을 때만 생긴다", () => {
  assert.equal(sendKeysPlan("s", "가".repeat(Math.floor(TMUX_LITERAL_CHUNK_BYTES / 3)), TMUX).keys.length, 1);
  assert.equal(sendKeysPlan("s", "가".repeat(Math.floor(TMUX_LITERAL_CHUNK_BYTES / 3) + 1), TMUX).keys.length, 2);
});

// ── #4818 Claude Code 에는 붙여넣기로 싣는다(규약 ⑤) — 엣지 표는 스크래치패드 spec.md P1~P4 · L1~L6 ─────────────
//  실측(2.1.301): 친 글과 Enter 가 한 번에 읽히면(64자 이상) Enter 가 글자 CR 로 박혀 세 번째 Enter 에서야 제출된다.
//  붙여넣기 표지로 감싸면 같은 조건에서 첫 Enter 에 들어간다. 한 번이 800자를 넘으면 «[Pasted text]» 로 접히고 기록에
//  <pasted_content> 로 감싸여 적히므로 조각으로 나눈다.
//  새 이름은 네임스페이스로 받는다 — 옛 send-keys 에 대고 돌리면 이 행들만 빨간불이 나야 한다(파일 전체 링크 오류 대신).
const OPEN_HEX = ["1b", "5b", "32", "30", "30", "7e"];    // ESC [ 2 0 0 ~
const CLOSE_HEX = ["1b", "5b", "32", "30", "31", "7e"];   // ESC [ 2 0 1 ~
const isOpen = (a: string[]): boolean => a[3] === "-H" && JSON.stringify(a.slice(4)) === JSON.stringify(OPEN_HEX);
const isClose = (a: string[]): boolean => a[3] === "-H" && JSON.stringify(a.slice(4)) === JSON.stringify(CLOSE_HEX);
/** tmux 한 번(argv 하나)을 `;` 구분자로 명령들로 가른다 — 붙여넣기 조각은 «여는 표지 ; 글 ; 닫는 표지» 를 한 번에 싣는다. */
const commandsOf = (keys: string[][]): string[][] => keys.flatMap((argv) => {
  const cmds: string[][] = [[]];
  for (const a of argv) { if (a === ";") cmds.push([]); else cmds[cmds.length - 1]!.push(a); }
  return cmds;
});
/** 리터럴 명령들이 실제로 치는 글 — `-l` 몸 + `-H 3b`(`;`) 를 이어 붙인다. */
const typedOf = (cmds: string[][]): string => cmds.map((c) => (c[3] === "-l" ? c[5] : c[3] === "-H" && c.slice(4).every((h) => h === "3b") ? ";".repeat(c.length - 4) : "")).join("");
/** 붙여넣기 계획을 조각들로 읽는다 — «여는 표지 → 글(리터럴·`;` 바이트) → 닫는 표지» 의 되풀이여야 한다. 아니면 단언이 터진다. */
const pastePieces = (keys: string[][]): string[] => {
  const cmds = commandsOf(keys);
  assert.ok(cmds.length > 0, "실은 것이 없다");
  const pieces: string[] = [];
  for (let i = 0; i < cmds.length;) {
    assert.ok(isOpen(cmds[i]!), `조각 머리가 여는 표지가 아니다: ${JSON.stringify(cmds[i])}`);
    const body: string[][] = []; i++;
    while (i < cmds.length && !isClose(cmds[i]!) && !isOpen(cmds[i]!)) { if (cmds[i]![3] === "-l") assert.equal(cmds[i]![4], "--"); body.push(cmds[i]!); i++; }
    assert.ok(i < cmds.length && isClose(cmds[i]!), "조각 꼬리에 닫는 표지가 없다");
    i++;
    pieces.push(typedOf(body));
  }
  return pieces;
};
const sk = await import("./send-keys.js") as Record<string, any>;
const PASTE_OPEN_S = "\x1b[200~";
const PASTE_CLOSE_S = "\x1b[201~";
const UNITS: number = sk.PASTE_CHUNK_UNITS ?? 500;
/** 네 번째 인자(opts)를 받는 판으로 부른다 — 옛 판(세 인자)에 대고 돌려도 컴파일된다(그 판에선 opts 가 무시돼 빨간불). */
const planP = sendKeysPlan as (id: string, text: string, bin: string, opts?: unknown) => ReturnType<typeof sendKeysPlan>;

t("[22·P1] paste — 글을 표지 둘 사이에 싣는다(표지는 바이트 그대로 -H) · 한 조각 = tmux 한 번(`;` 로 이음) · 제출은 그 뒤 Enter 키", () => {
  const p = planP("box-yoon-1", "안녕하세요", TMUX, { paste: true });
  assert.deepEqual(p.keys, [[
    "send-keys", "-t", "box-yoon-1", "-H", ...OPEN_HEX, ";",
    "send-keys", "-t", "box-yoon-1", "-l", "--", "안녕하세요", ";",
    "send-keys", "-t", "box-yoon-1", "-H", ...CLOSE_HEX,
  ]], "표지와 글을 따로 부르면 중계 지연이 2초를 넘을 때 Claude Code 가 붙여넣기를 끊는다");
  assert.deepEqual(p.enter, ["send-keys", "-t", "box-yoon-1", "Enter"]);
  assert.equal(sk.PASTE_OPEN, "\x1b[200~"); assert.equal(sk.PASTE_CLOSE, "\x1b[201~");
});

t("[23·P2] paste — 긴 글은 조각마다 표지로 감싸고 조각은 상한(UTF-16) 이하 · 접힘 문턱(800) 아래 · 이어붙이면 원문", () => {
  const text = "가나다라마 ".repeat(200).trim();   // 1,199자
  const p = planP("s", text, TMUX, { paste: true });
  const pieces = pastePieces(p.keys);
  assert.ok(pieces.length >= 3, `조각 수 ${pieces.length}`);
  for (const pc of pieces) assert.ok(pc.length <= UNITS && pc.length < 800, `조각 ${pc.length}자`);
  assert.equal(pieces.join(""), p.oneLine);
  assert.ok(UNITS < 800, "접힘 문턱(800) 이상이면 Claude Code 가 [Pasted text] 로 접고 <pasted_content> 로 적는다");
});

t("[24·P2 경계] paste — 조각 경계는 코드포인트 경계(이모지 서로게이트 쌍을 안 가른다) · splitUnits 경계값", () => {
  const text = "a".repeat(UNITS - 1) + "😀" + "b";   // 이모지(2단위)가 경계에 걸친다
  const pieces = pastePieces(planP("s", text, TMUX, { paste: true }).keys);
  assert.deepEqual(pieces, ["a".repeat(UNITS - 1), "😀b"]);
  assert.equal(sk.splitUnits("x".repeat(UNITS), UNITS).length, 1, "정확히 상한이면 한 조각");
  assert.equal(sk.splitUnits("x".repeat(UNITS + 1), UNITS).length, 2, "+1 이면 두 조각");
  assert.deepEqual(sk.splitUnits("", UNITS), [], "빈 글은 0조각");
});

t("[25·P2] paste — 조각 하나의 인자 바이트도 tmux 상한 아래(한글 3B·이모지 4B)", () => {
  for (const ch of ["가", "😀"]) {
    const keys = planP("s", ch.repeat(3000), TMUX, { paste: true }).keys;
    assert.ok(keys.length > 0 && isOpen(commandsOf(keys)[0]!), `${ch}: 붙여넣기 계획이 아니다`);
    for (const argv of keys) for (const arg of argv.slice(3)) assert.ok(Buffer.byteLength(arg, "utf8") <= TMUX_LITERAL_CHUNK_BYTES);
  }
});

t("[26·P2] paste — `-` 로 시작하는 조각도 `--` 뒤에 싣는다(옵션으로 안 읽힌다)", () => {
  const cmds = commandsOf(planP("s", "- 이거 해 줘", TMUX, { paste: true }).keys);
  assert.deepEqual(cmds[1], ["send-keys", "-t", "s", "-l", "--", "- 이거 해 줘"]);
  assert.ok(isOpen(cmds[0]!) && isClose(cmds[2]!));
});

t("[27·P3] paste 를 안 주거나 거짓이면 종전 그대로(리터럴 한 번) · psmux 는 paste 를 무시한다 · 빈 글이면 표지도 안 싣는다", () => {
  for (const opts of [undefined, {}, { paste: false }]) {
    assert.deepEqual(planP("s", "안녕", TMUX, opts).keys, [["send-keys", "-t", "s", "-l", "--", "안녕"]]);
  }
  assert.deepEqual(planP("s", "ls", PSMUX, { paste: true }), sendKeysPlan("s", "ls", PSMUX));
  assert.deepEqual(planP("s", "  \n ", TMUX, { paste: true }).keys, []);
});

t("[28·P4 L1~L6] 한 줄로 펴기 — CR(치면 그 자리 제출)·CRLF·U+2028·U+2029(Claude Code 가 지우며 제출을 멈춘다)도 공백 하나로", () => {
  const cases: Array<[string, string]> = [
    ["첫\n둘", "첫 둘"],                    // L1
    ["첫\r둘", "첫 둘"],                    // L2
    ["첫\r\n둘", "첫 둘"],                  // L3
    ["첫\u2028둘\u2029셋", "첫 둘 셋"],     // L4
    ["  a \r\n\r\n  b \n\r c ", "a b c"],  // L5
    [" \r\n ", ""],                         // L6
  ];
  for (const [raw, want] of cases) {
    assert.equal(sendKeysPlan("s", raw, TMUX).oneLine, want, JSON.stringify(raw));
    for (const argv of sendKeysPlan("s", raw, TMUX).keys) assert.ok(!/[\r\n\u2028\u2029]/.test(argv[5] ?? ""), `치는 인자에 줄 가르는 글자: ${JSON.stringify(raw)}`);
  }
});

t("[30·P14] 글이 키(제어 글자)로 **시작하면** 붙여넣지 않고 친다 — 설정 명령의 «치던 글 치워 두기»(Ctrl+S)가 키로 가야 한다", () => {
  const claude = HARNESSES.find((h) => h.key === "claude")!;
  const cmd = claude.runtimeDraftStash + claude.runtimeCmd!.model!("opus");
  assert.deepEqual(planP("s", cmd, TMUX, { paste: true }).keys, [["send-keys", "-t", "s", "-l", "--", "\x13/model opus"]],
    "붙여넣기 안의 Ctrl+S 는 키가 아니라 글자다 — 치워 두기가 안 되고 제출이 «보이지 않는 글자» 로 멈춘다");
  for (const k of ["\x03", "\x7f", "\x00", "\x1f", "\x01", "\x1a", "\x1c"]) {
    assert.deepEqual(planP("s", `${k}뒤`, TMUX, { paste: true }).keys, [["send-keys", "-t", "s", "-l", "--", `${k}뒤`]], JSON.stringify(k));
  }
});

t("[30c·#4852] ESC 로 **시작하는** 글(색 입힌 로그)은 붙여넣는다 — 치면 ESC 가 Esc 키가 되고 긴 글은 앞 약 4KB 를 잃는다 · 키로서의 Esc 는 글로 싣지 않는다", () => {
  const log = "\x1b[31mERROR\x1b[0m 디스크 가득 — 로그를 그대로 붙였다";
  assert.deepEqual(pastePieces(planP("s", log, TMUX, { paste: true }).keys), [log]);
  assert.equal(sk.startsWithKey(log), false);
  assert.equal(sk.startsWithKey("\x1b"), false, "ESC 하나도 키로 치지 않는다");
});

t("[30b·L2·#4852] 글 **가운데**의 제어 글자(색 입힌 로그의 ESC · 벨 · Ctrl+A)는 붙여넣는다 — 치면 키가 돼 글이 뒤섞이고 긴 친 글은 앞이 잘린다", () => {
  for (const k of ["\x1b", "\x03", "\x7f", "\x00", "\x1f", "\x01", "\x07"]) {
    assert.deepEqual(pastePieces(planP("s", `앞${k}뒤`, TMUX, { paste: true }).keys), [`앞${k}뒤`], JSON.stringify(k));
  }
  const log = "로그: \x1b[31mERROR\x1b[0m 디스크 가득 \x07 끝";
  assert.deepEqual(pastePieces(planP("s", log, TMUX, { paste: true }).keys), [log]);
  assert.equal(typeof sk.startsWithKey, "function", "startsWithKey 가 없다");
  for (const [text, want] of [["\x13/model opus", true], ["\x01앞", true], ["/model opus", false], ["a\x13", false], ["로그 \x1b[31m", false], ["\x1b[31m로그", false], ["", false]] as const) {
    assert.equal(sk.startsWithKey(text), want, JSON.stringify(text));
  }
});

t("[31·P14 경계] 탭은 글이다 — 붙여넣는다(붙이면 공백 넷 · 치면 자동완성을 부른다)", () => {
  const keys = planP("s", "가\t나", TMUX, { paste: true }).keys;
  assert.deepEqual(pastePieces(keys), ["가\t나"]);
});

t("[32·S1~S4] 끝이 `;` 인 글 — tmux 가 구분자로 먹으므로 끝의 `;` 들은 바이트(-H 3b)로 · 가운데 `;` 는 그대로 · `-l` 인자는 `;` 로 안 끝난다", () => {
  const cases: Array<[string, string[][]]> = [
    ["do it;", [["send-keys", "-t", "s", "-l", "--", "do it"], ["send-keys", "-t", "s", "-H", "3b"]]],
    ["a;;", [["send-keys", "-t", "s", "-l", "--", "a"], ["send-keys", "-t", "s", "-H", "3b", "3b"]]],
    [";", [["send-keys", "-t", "s", "-H", "3b"]]],
    ["a;b", [["send-keys", "-t", "s", "-l", "--", "a;b"]]],
  ];
  for (const [raw, want] of cases) assert.deepEqual(sendKeysPlan("s", raw, TMUX).keys, want, JSON.stringify(raw));
});

t("[33·S5] 붙여넣기 조각 경계의 `;` — 조각 끝에 걸려도 사라지지 않는다(격리 리뷰 재현: 499자 + `;` + 10자)", () => {
  const text = "a".repeat(UNITS - 1) + ";" + "b".repeat(10);
  const keys = planP("s", text, TMUX, { paste: true }).keys;
  assert.deepEqual(pastePieces(keys), ["a".repeat(UNITS - 1) + ";", "b".repeat(10)]);
  for (const c of commandsOf(keys)) if (c[3] === "-l") assert.ok(!c[5]!.endsWith(";"), `-l 인자가 ; 로 끝난다: …${c[5]!.slice(-8)}`);
});

t("[34·S6] `;` 가 아주 많아도 한 명령의 `;` 토큰은 16개까지 · 인자는 브로커 상한(64) 안 · 묶음은 60 안 · 첫 명령이 세션을 지목한다", () => {
  const cases = [[";".repeat(40), false], ["끝" + ";".repeat(40), true], ["x".repeat(UNITS - 3) + ";;;", true],
    [";".repeat(200), false], ["끝" + ";".repeat(200), true]] as const;
  for (const [raw, paste] of cases) {
    const keys = planP("box-yoon-1", raw, TMUX, { paste });
    for (const argv of keys.keys) {
      assert.ok(argv.length <= 60, `argv ${argv.length}개`);
      assert.deepEqual(argv.slice(0, 3), ["send-keys", "-t", "box-yoon-1"], "묶음의 첫 명령이 세션을 지목해야 라우팅된다");
    }
    for (const c of commandsOf(keys.keys)) {
      const semis = c.filter((a) => a === "3b").length;
      assert.ok(semis <= 16, `한 명령에 3b ${semis}개 — 64 를 넘는 명령은 매니지드 브로커가 거절한다`);
    }
    assert.equal(paste ? pastePieces(keys.keys).join("") : typedOf(commandsOf(keys.keys)), keys.oneLine, JSON.stringify(raw).slice(0, 30));
  }
});

//  ── 이미지 경로(I1~I5) — Claude Code 2.1.301 의 붙여넣기 처리(번들 handlePaste)를 **그 코드 그대로** 옮긴 판정으로 잰다 ──
//   붙여넣은 글을 « (?=/|X:\)» 와 줄바꿈에서 자르고, 조각이 통째로 이미지 경로(따옴표·역슬래시 풀고 kAt)면 그 조각을 글에서 빼고 이미지로 붙인다.
//   실측: «… The file is /…/dot.png» 붙여넣기 → «[Image #1]… The file is»(기록에 경로 없음) · 친 글은 그대로였다.
const kAt = /\.(png|jpe?g|gif|webp)$/i;
const ccUnquote = (e: string): string => (e.startsWith('"') && e.endsWith('"') || e.startsWith("'") && e.endsWith("'")) ? e.slice(1, -1) : e;
const ccUnescape = (e: string): string => { const c = "__DOUBLE_BACKSLASH__"; return e.replaceAll("\\\\", c).replace(/\\(.)/g, "$1").replace(new RegExp(c, "g"), "\\"); };
/** 붙여넣기 한 번에 Claude Code 가 이미지로 바꿀 조각들(번들 코드의 옮김 — 구현과 따로 쓴다). */
const ccImageSegments = (Q: string): string[] => Q.split(/ (?=\/|[A-Za-z]:\\)/).flatMap((j) => j.split("\n")).filter((j) => j.trim())
  .filter((j) => kAt.test(ccUnescape(ccUnquote(j.trim()))));
const pastedOf = (text: string): string[] => pastePieces(planP("s", text, TMUX, { paste: true }).keys);

t("[35·I1] 끝이 이미지 경로인 글 — 경로가 붙여넣기 하나에 통째로 안 든다(확장자 가운데서 나눔) · 이어 붙이면 원문", () => {
  const text = "Reply with only the word OK. The file is /work/shared/project/1/dot.png";
  assert.equal(ccImageSegments(text).length, 1, "배선 — 옮긴 판정이 이 글을 이미지로 본다(관측 장치가 살아 있다)");
  const pieces = pastedOf(text);
  assert.deepEqual(pieces, ["Reply with only the word OK. The file is /work/shared/project/1/dot.p", "ng"]);
  for (const pc of pieces) assert.deepEqual(ccImageSegments(pc), [], JSON.stringify(pc));
});

t("[36·I2] 경로가 글 가운데(뒤에 낱말)면 이미지로 안 바뀐다 — 나누지 않는다 · 이미지 아닌 확장자도 그대로", () => {
  for (const text of ["The file /a/dot.png is a dot.", "see /a/notes.txt", "see /a/x.pngx", "png 파일을 봐 줘", "/a/b.png로 바꿔 줘"]) {
    assert.deepEqual(ccImageSegments(text), [], `전제: ${text}`);
    assert.deepEqual(pastedOf(text), [text], text);
  }
});

t("[37·I3] 여러 경로 · 대소문자 · 윈도우 경로 · 따옴표 · 역슬래시 공백 — 어느 붙여넣기에도 이미지 조각이 없다", () => {
  //  따옴표는 조각이 통째로 감싸였을 때만 풀린다(조각은 « /» 앞에서 시작하니 글 맨 앞일 때뿐이다).
  //  역슬래시는 풀고 본다 — 확장자 안에 낀 것(`c.pn\g`)도 Claude Code 에겐 `.png` 다.
  for (const text of ["compare /a/x.png /b/y.JPG", "C:\\Users\\me\\shot.jpeg", "'/a b/c.webp'", "\"/a b/c.gif\"", "look /a\\ b/c.png", "see /a/c.pn\\g", "/only.png", ".png"]) {
    assert.ok(ccImageSegments(text).length > 0, `전제(이미지로 바뀌는 글): ${text}`);
    const pieces = pastedOf(text);
    assert.equal(pieces.join(""), text, text);
    for (const pc of pieces) assert.deepEqual(ccImageSegments(pc), [], `${text} → ${JSON.stringify(pc)}`);
  }
});

t("[38·I4] 경로가 조각 경계(500)에 딱 걸려도 — 그 붙여넣기가 이미지 경로로 끝나지 않는다", () => {
  const path = " /p/q.png";
  const text = "가".repeat(UNITS - path.length) + path + " 그리고 이어지는 말";
  assert.equal(sk.splitUnits(text, UNITS)[0].endsWith("/p/q.png"), true, "전제 — 단순 자르기면 첫 조각이 경로로 끝난다");
  const pieces = pastedOf(text);
  assert.equal(pieces.join(""), text);
  for (const pc of pieces) { assert.ok(pc.length <= UNITS); assert.deepEqual(ccImageSegments(pc), [], JSON.stringify(pc.slice(-12))); }
});

//  포커스 꼬리(F1~F2) — Claude Code 는 붙여넣기 하나가 `[I`·`[O` 로 끝나면 그 두 글자를 지우고, 딱 그것뿐이면 빈 붙여넣기로 버린다(번들 Fde —
//   옮긴 판정). 실측: 498자+«[I» · «NFO] x» 를 붙이면 «…NFO] x», «[OK] done» 이 경계에 걸리면 «K] done».
const ccDropsTail = (raw: string): boolean => raw.endsWith("[I") || raw.endsWith("[O");
const ccEmpty = (raw: string): boolean => raw.length === 0 || raw === "[I" || raw === "[O";

t("[40·F1] 조각 경계에 걸린 «[INFO»·«[OK» — 붙여넣기가 «[I»·«[O» 로 끝나지 않는다(한 글자 앞에서 자른다) · 이어 붙이면 원문", () => {
  const info = "a".repeat(UNITS - 2) + "[INFO] boot ok";
  assert.equal(ccDropsTail(sk.splitUnits(info, UNITS)[0]), true, "전제 — 단순 자르기면 첫 조각이 «[I» 로 끝난다");
  assert.deepEqual(pastedOf(info), ["a".repeat(UNITS - 2) + "[", "INFO] boot ok"]);
  for (const text of ["a".repeat(UNITS - 2) + "[OK] done", "상태 [O", "[I", "[O", "x[I", "끝[I[O"]) {
    const pieces = pastedOf(text);
    assert.equal(pieces.join(""), text, text);
    for (const pc of pieces) assert.ok(!ccDropsTail(pc) && !ccEmpty(pc), `${JSON.stringify(text)} → ${JSON.stringify(pc)}`);
  }
});

t("[41·F2] 포커스 꼬리 처리와 이미지 경로 처리가 겹쳐도 — «[» 로 끝난 조각은 이미지 경로가 아니다 · 다음 조각이 경로면 다시 나눈다", () => {
  for (const text of ["a".repeat(UNITS - 2) + "[I /x/y.png", "/a.png[I", "[O/b.png", "a".repeat(UNITS - 8) + "/p.png[I"]) {
    const pieces = pastedOf(text);
    assert.equal(pieces.join(""), text, text);
    for (const pc of pieces) {
      assert.ok(!ccDropsTail(pc) && !ccEmpty(pc), `${JSON.stringify(text).slice(0, 20)} → ${JSON.stringify(pc).slice(-12)}`);
      assert.deepEqual(ccImageSegments(pc), [], `${JSON.stringify(text).slice(0, 20)} → ${JSON.stringify(pc).slice(-12)}`);
    }
  }
});

t("[39·I5] 무작위 글 300개 — 이어 붙이면 원문 · 조각마다 상한 이하 · 어느 붙여넣기도 Claude Code 가 이미지로 바꾸거나 꼬리를 지우지 않는다", () => {
  const atoms = ["a", " ", "/", ".", "png", "JPG", "jpeg", "gif", "webp", "C:\\", "\\", "'", '"', "가", "😀", ";", "x.png", " /d/e.png", "[", "I", "O", "[I", "[O"];
  let seed = 4818;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 300; k++) {
    let text = "";
    const len = 1 + rnd(k % 10 === 0 ? 900 : 60);
    for (let i = 0; i < len; i++) text += atoms[rnd(atoms.length)];
    const oneLine = planP("s", text, TMUX, { paste: true }).oneLine;
    const pieces = pastedOf(text);
    assert.equal(pieces.join(""), oneLine, `#${k}`);
    for (const pc of pieces) {
      assert.ok(pc.length <= UNITS, `#${k} 조각 ${pc.length}`);
      assert.deepEqual(ccImageSegments(pc), [], `#${k} ${JSON.stringify(pc).slice(0, 80)}`);
      assert.ok(!ccDropsTail(pc) && !ccEmpty(pc), `#${k} 포커스 꼬리 ${JSON.stringify(pc).slice(-12)}`);
    }
  }
});

t("[42·K1~K4·#4852] 치는 인자 하나는 UTF-16 4,000 단위 이하 — 매니지드 브로커 중계는 4,096자 넘는 인자를 거절한다 · 이어붙이면 원문", () => {
  const units = Number(sk.TMUX_LITERAL_CHUNK_UNITS ?? 4000);
  assert.ok(units <= 4096, `상한 ${units} — 브로커 상한(4,096) 안이어야 한다`);
  const argOf = (k: string[][]): string[] => k.map((a) => { assert.deepEqual(a.slice(0, 5), ["send-keys", "-t", "s", "-l", "--"]); return a[5]!; });
  //  K1 — 영문 9,000자(바이트 상한 8KiB 로는 8,192자 한 덩어리가 된다)
  const ascii = "lorem ipsum dolor sit amet ".repeat(400).slice(0, 9000);
  const a = argOf(sendKeysPlan("s", ascii, TMUX).keys);
  for (const arg of a) assert.ok(arg.length <= 4000 && bytes(arg) <= TMUX_LITERAL_CHUNK_BYTES, `${arg.length}자 · ${bytes(arg)}B`);
  assert.equal(a.join(""), ascii);
  //  K2 — 경계
  assert.equal(sendKeysPlan("s", "x".repeat(units), TMUX).keys.length, 1, "정확히 상한이면 한 덩어리");
  assert.equal(sendKeysPlan("s", "x".repeat(units + 1), TMUX).keys.length, 2, "+1 이면 두 덩어리");
  //  K3 — 한글은 바이트 상한이 먼저(2,730자) · 단위 상한도 지킨다
  const ko = "가".repeat(3000);
  const k = argOf(sendKeysPlan("s", ko, TMUX).keys);
  for (const arg of k) assert.ok(arg.length <= units && bytes(arg) <= TMUX_LITERAL_CHUNK_BYTES);
  assert.equal(k.join(""), ko);
  //  K4 — 이모지(서로게이트 쌍)가 단위 경계에 걸쳐도 안 가른다
  assert.deepEqual(argOf(sendKeysPlan("s", "x".repeat(units - 1) + "😀y", TMUX).keys), ["x".repeat(units - 1), "😀y"]);
});

//  #4852 N7 — 첫 지시가 아닌 지시도 넣은 뒤 지킨다. 실행부(노드 RPC·tmux)는 이 파일 밖이라 배선은 소스로 잰다(outbox-exec W12 와 같은 방식).
const srcOf = async (rel: string): Promise<string> => (await import("node:fs")).readFileSync(new URL(rel, import.meta.url), "utf8");
const OPS_SRC = await srcOf("../../src/terminal/session-ops.ts");
const INJECT_SRC = await srcOf("../../src/node/session-inject.ts");
t("[43·N7·#4852] 노드 sendKeys · 로컬 주입 — 넣은 **뒤에** 지킴이(guardAfterSend)를 띄운다 · 기다리지 않는다(void) · 붙였는지를 넘긴다", () => {
  //  무엇을 지키나(붙인 글만 · 설정 명령 빼고 · 던져도 안 던짐)는 session-first-prompt.test F4~F6 이 함수로 잰다. 여기는 두 실행부의 배선만.
  const caseBody = /case "sendKeys": \{([\s\S]*?)\n {4}\}/.exec(OPS_SRC)?.[1] ?? "";
  assert.ok(caseBody, "session-ops 의 sendKeys 갈래를 못 찾았다");
  assert.match(caseBody, /await sendKeysToSession\(id, text, \{ paste \}\);\s*(?:\/\/[^\n]*\n\s*)*void guardAfterSend\(id, text, paste\);/, "노드 sendKeys 가 넣은 뒤 지키지 않는다(또는 기다린다)");
  assert.match(INJECT_SRC, /await sendKeysToSession\(sessionId, text, \{ paste \}\);\s*(?:\/\/[^\n]*\n\s*)*void guardAfterSend\(sessionId, text, paste\);/, "로컬 주입이 넣은 뒤 지키지 않는다(또는 기다린다)");
});

//  #4852 격리 리뷰 — 글 속의 붙여넣기 표지 · 조각 경계의 제어열. 제어열을 지우는 규칙은 Claude Code 와 같게 둔 ANSI_SEQ(submit-check)로 잰다.
const { ANSI_SEQ } = await import("./submit-check.js") as { ANSI_SEQ: RegExp };
const stripAnsi = (x: string): string => x.replace(ANSI_SEQ, "");
const literalArgs = (keys: string[][]): string[] => keys.flatMap((cmd) => {
  const out: string[] = [];
  for (let i = 0; i < cmd.length; i++) if (cmd[i] === "-l" && cmd[i + 1] === "--") out.push(cmd[i + 2] ?? "");
  return out;
});
t("[44·#4852] 글 속의 붙여넣기 표지는 지운다 — 남기면 붙여넣기가 그 자리에서 닫히고 나머지가 키로 읽힌다 · 지운 자리에 새로 생긴 표지도", () => {
  assert.equal(typeof sk.withoutPasteMarks, "function", "withoutPasteMarks 가 없다");
  const evil = "앞 \x1b[201~\x03\x04 뒤";
  const keys = planP("s", evil, TMUX, { paste: true }).keys;
  assert.deepEqual(pastePieces(keys), ["앞 \x03\x04 뒤"]);
  for (const a of literalArgs(keys)) assert.ok(!a.includes("\x1b[201~") && !a.includes("\x1b[200~"), `글 인자에 표지: ${JSON.stringify(a)}`);
  assert.equal(sk.withoutPasteMarks("\x1b[20\x1b[201~1~끝"), "끝", "지운 자리에서 표지가 다시 생겼다");
  assert.equal(sk.withoutPasteMarks("\x1b[200~가\x1b[201~나"), "가나");
  assert.equal(sk.withoutPasteMarks("표지 없음"), "표지 없음");
  //  겹겹이 쌓은 표지(«ESC[20» × k + 표지 + «1~» × k — 지울 때마다 새 표지가 생긴다)도 한 번 훑기로 — 종전 «다 지울 때까지 다시» 는 제곱 시간이었다
  //   (격리 리뷰 실측 94KB 4초 · 본문 상한 1MB). 200KB 를 넉넉히 1.5초 안에(한 번 훑기는 수 ms · 제곱이면 십수 초).
  const k = 200_000 / 7 | 0;
  const nested = "\x1b[20".repeat(k) + "\x1b[201~" + "1~".repeat(k) + "끝";
  const t0 = Date.now();
  assert.equal(sk.withoutPasteMarks(nested), "끝");
  assert.ok(Date.now() - t0 < 1_500, `겹친 표지 ${nested.length}자에 ${Date.now() - t0}ms`);
});
t("[45·#4852] 제어열이 붙여넣기 조각 경계(500)에 걸리면 통째로 다음 조각으로 — 갈린 반쪽은 Claude Code 가 글자로 남긴다(«1m») · 이어 붙이면 원문", () => {
  for (const intro of ["\x1b[", "\u{9B}"]) {
    const text = "x".repeat(498) + intro + "31mERR" + "\x1b[0m 끝";
    const pieces = sk.piecesToPaste(text);
    assert.equal(pieces.join(""), text);
    assert.equal(pieces[0], "x".repeat(498), JSON.stringify(intro));
    assert.equal(pieces.map(stripAnsi).join(""), stripAnsi(text), "조각마다 지운 것이 통째로 지운 것과 다르다");
  }
  //  닫힌 OSC 가 경계에 걸려도 · 한 조각보다 긴 제어열(맨 앞이라 못 넘긴다)도 멈추지 않고 원문을 잇는다
  const osc = "y".repeat(480) + "\x1b]8;;https://example.test/path\x1b\\링크\x1b]8;;\x1b\\ 끝";
  assert.equal(sk.piecesToPaste(osc).map(stripAnsi).join(""), stripAnsi(osc));
  const huge = "\x1b]0;" + "z".repeat(1200) + "\x07 뒤";
  assert.equal(sk.piecesToPaste(huge).join(""), huge);
});
t("[46·#4852] 무작위 글 300개(색 코드·8비트 CSI·OSC·한글·이모지) — 이어 붙이면 원문 · 조각마다 상한 이하 · 조각마다 지운 것이 통째로 지운 것과 같다", () => {
  let seed = 4852;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  const parts = ["가나다", "abc ", "😀", "\x1b[31m", "\x1b[0m", "\x1b[1;2m", "\u{9B}32m", "\x1b]0;제목\x07", "\x1b(B", " ", "x".repeat(37)];
  for (let n = 0; n < 300; n++) {
    let text = "";
    while (text.length < 400 + rnd(1600)) text += parts[rnd(parts.length)];
    const pieces = sk.piecesToPaste(text);
    assert.equal(pieces.join(""), text, `#${n}`);
    for (const p of pieces) assert.ok(p.length > 0 && p.length <= sk.PASTE_CHUNK_UNITS, `#${n} 조각 ${p.length}`);
    assert.equal(pieces.map(stripAnsi).join(""), stripAnsi(text), `#${n} 제어열이 갈렸다`);
  }
});

t("[29·P3] 붙여넣기는 Claude Code 만 — 다른 하네스·모름은 종전대로 친다", () => {
  assert.equal(typeof sk.pastesFor, "function", "pastesFor 가 없다");
  assert.equal(sk.pastesFor("claude"), true);
  for (const h of ["codex", "gemini", "antigravity", "opencode", "", null, undefined]) assert.equal(sk.pastesFor(h), false, String(h));
});

console.log(`\n${pass} passed`);

// ── #2154 '한 글자도 안 갔다' 를 호출자가 알 수 있어야 한다 ────────────────────────────────
//  이 파일은 원래 순수 계획만 잰다(머리말). 이 두 건만 실행부를 띄우는 이유: 고치는 대상이 **어느 단계에서
//  죽었나**라 계획으로는 표현되지 않는다. 대신 tmux 를 가짜 중계(node 한 줄)로 갈아 끼워 프로세스는 가볍게 둔다.
//  실측 2026-08-27: 아웃박스의 진짜 유실 5건 중 하나가 `send: … has-session … node channel unavailable`
//  이었다 — 노드 채널이 순간 빈 것뿐인데 사람의 지시가 통째로 버려졌다.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { sendKeysToSession, SendKeysNotStarted } = await import("./send-keys.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  /** failOn 이 argv 에 있으면 그 단계에서 비-0 으로 죽는 가짜 tmux. */
  const fakeTmux = (name: string, failOn: string, stderr: string): string => {
    const f = path.join(tmp, `${name}.mjs`);
    fs.writeFileSync(f, [
      `if (process.argv.slice(2).includes(${JSON.stringify(failOn)})) {`,
      `  process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);`,
      "}",
      "process.stdout.write('');",
    ].join("\n"));
    return `${process.execPath} ${f}`;
  };
  const saved = process.env.LIVELY_TMUX_EXEC;
  const at = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

  process.env.LIVELY_TMUX_EXEC = fakeTmux("nostart", "has-session", "lvly tmux-relay: node channel unavailable\n");
  await at("[#2154] 존재 확인에서 죽으면 SendKeysNotStarted — 한 글자도 안 갔으니 호출자가 되돌릴 수 있다", async () => {
    const e = await sendKeysToSession("box-yoon-1", "안녕").then(() => null, (x) => x);
    assert.ok(e instanceof SendKeysNotStarted, `받은 것: ${e && e.name}`);
    assert.match(String((e.cause as { stderr?: string })?.stderr ?? ""), /node channel unavailable/,
      "원래 tmux 오류를 그대로 들고 있어야 gone 확답 판정에 쓸 수 있다");
  });

  process.env.LIVELY_TMUX_EXEC = fakeTmux("midsend", "-l", "boom\n");
  await at("[#2154] 글자를 싣기 시작한 뒤 죽으면 **그냥 오류** — 입력칸에 반쪽이 남았을 수 있어 재전송 금지", async () => {
    const e = await sendKeysToSession("box-yoon-1", "안녕").then(() => null, (x) => x);
    assert.ok(e instanceof Error, "실패는 실패다");
    assert.ok(!(e instanceof SendKeysNotStarted), "여기서 '안 갔다'고 말하면 같은 지시가 두 번 간다");
  });

  //  #3773 PR1 후속 — 치기 순서가 두 벌이었다(여기 sendKeysToSession · 세션 호스트의 아웃박스 치기). 한 함수(runSendKeysPlan)로 접었고,
  //   그 약속을 **실제로 부른 tmux 순서**로 잰다 — 한쪽만 순서가 바뀌면 같은 지시가 어디로 가느냐에 따라 다르게 들어간다.
  {
    const log = path.join(tmp, "argv.log");
    const recorder = path.join(tmp, "record.mjs");
    fs.writeFileSync(recorder, [
      'import { appendFileSync } from "node:fs";',
      "const a = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, (a[0] === "send-keys" ? "send-keys " + a.slice(3).join(" ") : a[0]) + "\\n");`,
    ].join("\n"));
    process.env.LIVELY_TMUX_EXEC = `${process.execPath} ${recorder}`;
    await at("[#3773] 게이트웨이 sendKeysToSession 과 세션 호스트의 치기가 **같은 순서**로 tmux 를 부른다(확인 → 글자 → Enter)", async () => {
      await sendKeysToSession("box-yoon-1", "첫 줄\n둘째 줄");
      const gateway = fs.readFileSync(log, "utf8").trim().split("\n");
      assert.deepEqual(gateway, ["has-session", "send-keys -l -- 첫 줄 둘째 줄", "send-keys Enter"]);
      const { runOutboxStep } = await import("./outbox-host-step.js");
      const host: string[] = [];
      await runOutboxStep({ step: "type", id: "box-yoon-1", text: "첫 줄\n둘째 줄" }, {
        tmux: async (argv) => { host.push(argv[0] === "send-keys" ? `send-keys ${argv.slice(3).join(" ")}` : String(argv[0])); return ""; },
        sleep: async () => {},
        bin: "tmux",
      });
      assert.deepEqual(host, gateway, "호스트 치기의 tmux 순서가 게이트웨이와 다르다");
    });

    //  #4818 X2 — 붙여넣기로 실어도 두 자리가 같은 순서다(확인 → 여는 표지 → 글 → 닫는 표지 → Enter). 호스트는 `paste: true` 인자로 받는다.
    await at("[#4818 X2] paste — 게이트웨이 sendKeysToSession 과 세션 호스트 치기가 같은 순서(확인 → 표지 → 글 → 표지 → Enter)", async () => {
      fs.writeFileSync(log, "");
      const send = sendKeysToSession as (id: string, text: string, opts?: unknown) => Promise<void>;
      await send("box-yoon-1", "첫 줄\n둘째 줄", { paste: true });
      const gateway = fs.readFileSync(log, "utf8").trim().split("\n");
      assert.deepEqual(gateway, [
        "has-session",
        "send-keys -H 1b 5b 32 30 30 7e ; send-keys -t box-yoon-1 -l -- 첫 줄 둘째 줄 ; send-keys -t box-yoon-1 -H 1b 5b 32 30 31 7e",
        "send-keys Enter",
      ], "붙여넣기 조각(표지·글·표지)은 tmux 한 번이어야 한다");
      const { runOutboxStep } = await import("./outbox-host-step.js");
      const host: string[] = [];
      await runOutboxStep({ step: "type", id: "box-yoon-1", text: "첫 줄\n둘째 줄", paste: true }, {
        tmux: async (argv) => { host.push(argv[0] === "send-keys" ? `send-keys ${argv.slice(3).join(" ")}` : String(argv[0])); return ""; },
        sleep: async () => {},
        bin: "tmux",
      });
      assert.deepEqual(host, gateway, "붙여넣기 치기의 tmux 순서가 게이트웨이와 호스트에서 다르다");
    });
  }

  //  #4818 N1~N5 — 노드 sendKeys 의 붙여넣기 판정: 하네스를 받으면 그것으로(tmux 안 봄), 없으면 이 호스트 tmux 의 @box_harness 로.
  //   못 읽거나 비면 **종전대로 친다**(붙여넣기를 모르는 앱에 표지를 흘리지 않는다).
  {
    const sessionPastes = (await import("./send-keys.js") as Record<string, any>).sessionPastes as
      ((id: string, harness?: string | null) => Promise<boolean>) | undefined;
    const calls = path.join(tmp, "opt-calls.log");
    /** show-options(@box_harness)엔 `harness`, display-message(포그라운드)엔 `fg` 로 답하는 가짜 tmux — null 이면 비-0 으로 죽는다. 불린 명령을 남긴다. */
    const optTmux = (name: string, harness: string | null, fg: string | null = "claude"): string => {
      const f = path.join(tmp, `${name}.mjs`);
      const answer = (v: string | null): string => (v === null ? "{ process.stderr.write('no server running\\n'); process.exit(1); }" : `process.stdout.write(${JSON.stringify(v + "\n")});`);
      fs.writeFileSync(f, [
        'import { appendFileSync } from "node:fs";',
        "const a = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n");`,
        `if (a[0] === "show-options") ${answer(harness)}`,
        `else if (a[0] === "display-message") ${answer(fg)}`,
      ].join("\n"));
      return `${process.execPath} ${f}`;
    };
    const seen = (): string[] => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
    await at("[#4818 N1·N2] 하네스를 받으면 그것으로 정한다 — 하네스 표식은 안 읽는다 · codex 면 화면도 안 본다", async () => {
      assert.equal(typeof sessionPastes, "function", "sessionPastes 가 없다");
      fs.writeFileSync(calls, "");
      process.env.LIVELY_TMUX_EXEC = optTmux("opt-claude-1", "claude");
      assert.equal(await sessionPastes!("box-yoon-1", "claude"), true);
      assert.ok(!seen().some((l) => l.startsWith("show-options")), "하네스를 받았는데 표식을 읽었다");
      fs.writeFileSync(calls, "");
      assert.equal(await sessionPastes!("box-yoon-1", "codex"), false, "tmux 표식이 claude 여도 받은 하네스가 이긴다");
      assert.deepEqual(seen(), [], "붙여넣지 않을 하네스인데 tmux 를 물었다");
    });
    await at("[#4818 N6] 포그라운드가 셸이면(하네스가 끝난 뒤) 친다 — macOS bash 3.2 는 표지를 글자로 찍는다", async () => {
      for (const sh of ["zsh", "bash", "-bash", "sh"]) {
        process.env.LIVELY_TMUX_EXEC = optTmux(`opt-fg-${sh.replace(/\W/g, "")}`, "claude", sh);
        assert.equal(await sessionPastes!("box-yoon-1", "claude"), false, sh);
      }
      process.env.LIVELY_TMUX_EXEC = optTmux("opt-fg-fail", "claude", null);
      assert.equal(await sessionPastes!("box-yoon-1", "claude"), true, "포그라운드를 못 읽으면 하네스 표식대로(매니지드 gVisor 는 box-spawn 으로만 보인다)");
    });
    await at("[#4818 N3~N5] 하네스가 없으면 @box_harness — claude 면 참 · 조회 실패·빈 표식이면 거짓", async () => {
      assert.equal(typeof sessionPastes, "function", "sessionPastes 가 없다");
      fs.writeFileSync(calls, "");
      process.env.LIVELY_TMUX_EXEC = optTmux("opt-claude-2", "claude");
      assert.equal(await sessionPastes!("box-yoon-1"), true, "N3");
      assert.ok(seen().some((l) => l.includes("show-options") && l.includes("@box_harness")), "표식을 안 읽었다(배선)");
      process.env.LIVELY_TMUX_EXEC = optTmux("opt-fail", null);
      assert.equal(await sessionPastes!("box-yoon-1", null), false, "N4");
      process.env.LIVELY_TMUX_EXEC = optTmux("opt-empty", "");
      assert.equal(await sessionPastes!("box-yoon-1"), false, "N5");
    });
  }

  //  #4818 R1 — **진짜 tmux 가 무엇을 치나**(격리 리뷰: argv 만 재면 tmux 가 `;` 로 끝나는 인자를 먹는 것을 못 본다 — rc 0 · 경고 없음).
  //   tmux 가 없으면 건너뛴다(윈도우 CI · login-job-script 와 같은 규약). 받는 쪽은 셸의 `read` — 붙여넣기 표지는 바이트 그대로 들어온다.
  {
    const { spawnSync, execFileSync } = await import("node:child_process");
    const TMUX = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout?.trim();
    if (!TMUX || process.platform === "win32") console.log("skip  [#4818 R1] tmux 없음");
    else {
      const { runSendKeysPlan } = await import("./send-keys.js");
      //  소켓은 이 시험의 임시 폴더에(-S) — `-L` 이면 tmux 공용 소켓 폴더에 판마다 하나씩 남는다(격리 리뷰).
      const sock = path.join(tmp, "sk.sock");
      const out = path.join(tmp, "typed.out");
      const T = (argv: string[]): string => execFileSync(TMUX, ["-S", sock, "-f", "/dev/null", ...argv], { encoding: "utf8" });
      const typedBy = async (raw: string, paste: boolean): Promise<{ got: string; oneLine: string }> => {
        fs.rmSync(out, { force: true });
        spawnSync(TMUX, ["-S", sock, "kill-server"]);
        T(["new-session", "-d", "-s", "sk", "-x", "200", "-y", "10", `bash -c 'IFS= read -r line; printf %s "$line" > ${out}'`]);
        const plan = planP("sk", raw, "tmux", { paste });
        const r = await runSendKeysPlan("sk", plan, { tmux: async (argv) => T(argv), sleep: async () => {} });
        assert.ok(r.ok, `치기 실패: ${JSON.stringify(r)}`);
        for (let i = 0; i < 60 && !fs.existsSync(out); i++) await new Promise((res) => setTimeout(res, 50));
        assert.ok(fs.existsSync(out), "배선 — 셸이 받은 글을 못 남겼다(관측 장치가 죽었다)");
        return { got: fs.readFileSync(out, "utf8"), oneLine: plan.oneLine };
      };
      try {
        await at("[#4818 R1] 진짜 tmux — 끝·조각 경계의 `;` 가 사라지지 않는다(치기·붙여넣기) · 붙여넣기는 표지로 감싸 들어간다", async () => {
          const cases: Array<[string, boolean]> = [
            ["do it;", false], ["a;;", false], [";", false], ["a;b ; c", false],
            ["a".repeat(UNITS - 1) + ";" + "b".repeat(10), true], ["끝;;;", true], ["보통 지시", true],
          ];
          for (const [raw, paste] of cases) {
            const { got, oneLine } = await typedBy(raw, paste);
            assert.equal(got.split(PASTE_OPEN_S).join("").split(PASTE_CLOSE_S).join(""), oneLine, `${JSON.stringify(raw).slice(0, 24)} paste=${paste}`);
            assert.equal(got.includes(PASTE_OPEN_S), paste, `${JSON.stringify(raw).slice(0, 24)}: 표지 유무`);
          }
        });
      } finally { spawnSync(TMUX, ["-S", sock, "kill-server"]); }
    }
  }

  if (saved === undefined) delete process.env.LIVELY_TMUX_EXEC; else process.env.LIVELY_TMUX_EXEC = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
}
