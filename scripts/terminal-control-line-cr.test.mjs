// #1943 — tmux control-mode 줄 끝의 **잔여 CR** 이 pane 데이터로 새어 화면 커서를 0열로 밀던 것.
//
// 실측(2026-08-25, 매니지드 도그푸드 · 브라우저 CDP 로 xterm 버퍼를 직접 읽어 확인):
//   앱(Claude TUI)이 그린 한 프레임은 절대 CUP 로 끝난다 — `…\e[45;1H\e[43;5H\e[?25h`.
//   그런데 그 뒤에 CR 이 하나 더 붙어 xterm 에 써졌다 → 커서가 **매번 0열**로 밀렸다.
//   같은 순간: tmux `cursor_x=5`, xterm `buffer.x=0`. 그 CR 만 걷어내자 5/5 로 일치했다(A/B 실측).
// 사용자에게 보인 증상: 커서가 클로드 프롬프트 맨 왼쪽(`>` 위)에 붙박이고, 한글 IME 조합 글자가 확정 전까지
//   거기 그려졌다(xterm 은 조합 오버레이를 버퍼 커서 자리에 그린다). 영문은 매 타 앱이 다시 그려 눈에 덜 띈다.
//
// 왜 dev(셀프호스팅)에선 안 나고 매니지드에서만 났나 — 같은 코드, **PTY 층수가 다르다**:
//   dev      코어 node-pty → tmux                                        → 줄 끝 `\r\n`   (CR 1개)
//   매니지드  코어 node-pty → tmux-relay.cjs → docker exec(Tty:true) → tmux → 줄 끝 `\r\r\n` (CR 2개)
//   ONLCR(`\n`→`\r\n`)이 PTY 마다 한 번씩 걸린다. 파서가 CR 을 **한 개만** 벗기던 게 문제였다.
//
// 왜 '전부 벗기기'가 안전한가: tmux 는 `%output` 값의 제어바이트를 **전부 8진으로 이스케이프**한다(`\015`).
//   그래서 줄 끝에 오는 '리터럴' CR 은 값일 수가 없다 — 프레이밍뿐이다. 아래 D 표가 그 경계를 고정한다.
// 실행: npm run build && node scripts/terminal-control-line-cr.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");
const { makeControl } = await importTerminalModule();
assert.equal(typeof makeControl, "function", "makeControl 이 모듈에서 노출돼야 한다");

let pass = 0;
const eq = (got, want, n) => { assert.deepEqual(got, want, `${n}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${n}`); };

const DCS = "\x1bP1000p";            // control mode 도입자
const enc = (s) => new TextEncoder().encode(s);
// 한 스트림을 통째로 먹이고 (write 조각들, backfill 텍스트들) 을 돌려준다.
function run(stream) {
  const out = [], back = [];
  const c = makeControl({ write: (s) => out.push(s), backfill: (t) => back.push(t), state: () => {}, onExit: () => {} });
  c.feed(enc(DCS + stream));
  return { write: out.join(""), backfill: back };
}

// ── 표 A. %output 줄 끝의 CR 은 값이 아니다(프레이밍) ──
eq(run("%output %0 \\033[43;5H\r\n").write, "\x1b[43;5H", "A1 CR 1개(dev 경로) → 값만 남는다");
eq(run("%output %0 \\033[43;5H\r\r\n").write, "\x1b[43;5H",
  "A2 CR 2개(매니지드 릴레이 경로) → 남은 CR 이 없어야 한다 ★이 버그 그 자체(고치기 전엔 끝에 \\r 이 붙는다)");
eq(run("%output %0 \\033[43;5H\r\r\r\n").write, "\x1b[43;5H", "A3 경계: CR 3개여도(PTY 가 더 끼어도) 전부 프레이밍");
eq(run("%output %0 \\033[43;5H\n").write, "\x1b[43;5H", "A4 경계: CR 없이 LF 만 와도 그대로");

// ── 표 B. 커서를 0열로 미는 그 CR 이 정말 사라졌나(증상 축으로 직접) ──
const frame = "%output %0 \\033[?25l\\033[H\\015\\033[3C\\033[42Bb\\033[45;1H\\033[43;5H\\033[?25h\r\r\n";
eq(run(frame).write.endsWith("\r"), false, "B1 앱 프레임이 CR 로 끝나지 않는다(끝나면 커서가 0열로 밀린다)");
eq(run(frame).write.endsWith("\x1b[?25h"), true, "B2 프레임의 진짜 끝은 앱이 놓은 커서(CUP) + 커서 표시");

// ── 표 C. 여러 줄·부분 청크에서도 같은가(파서는 바이트 스트림을 조각으로 받는다) ──
{
  const s1 = "%output %0 ab\r\r\n%output %0 cd\r\r\n";
  eq(run(s1).write, "abcd", "C1 연속 프레임 — 사이에 CR 이 끼지 않는다");
  // 청크 경계가 CR 사이를 갈라도 결과가 같아야 한다(스트림은 조각으로 도착한다)
  const outs = [];
  const split = makeControl({ write: (s) => outs.push(s), backfill: () => {}, state: () => {}, onExit: () => {} });
  split.feed(enc(DCS + "%output %0 ab\r"));
  split.feed(enc("\r\n%output %0 cd\r\r\n"));
  eq(outs.join(""), "abcd", "C2 청크가 CR 사이에서 갈려도 같다");
}

// ── 표 D. 경계 — '값인 CR'(8진 이스케이프)은 반드시 살아남는다 ──
// 이걸 틀리면 앱이 의도한 CR(줄 처음으로 이동)을 삼켜 화면이 어긋난다. 벗기는 건 프레이밍뿐이다.
eq(run("%output %0 a\\015b\r\r\n").write, "a\rb", "D1 값 가운데의 \\015 는 CR 로 복원");
eq(run("%output %0 abc\\015\r\r\n").write, "abc\r", "D2 ★값 '끝'의 \\015 도 살아남는다(프레이밍만 벗긴다는 증거)");
eq(run("%output %0 \\015\\015\r\r\n").write, "\r\r", "D3 경계: 값이 CR 만이어도 그대로");

// ── 표 E. 블록(capture-pane 백필)도 같은 규칙 ──
{
  const blk = "%begin 1 1 1\r\r\nline-one\r\r\nline-two\r\r\n%end 1 1 1\r\r\n";
  const got = run(blk).backfill;
  eq(got.length, 1, "E1 블록 하나 = 백필 한 번");
  eq(got[0].includes("\r\r"), false, "E2 백필 텍스트에 잔여 CR 이 섞이지 않는다");
  eq(got[0], "line-one\x1b[0m\r\nline-two", "E3 줄 구분자는 파서가 넣는 `\\e[0m\\r\\n` 뿐이다");
}

// ── 배선 — 판정이 맞아도 호출부가 빠지면 버그는 그대로다 ──
assert.ok(/while \(e > s && pending\[e - 1\] === 0x0d\) e--;/.test(src),
  "handleLine 이 줄 끝 CR 을 **전부**(while) 벗겨야 한다 — if 한 번이면 매니지드에서 CR 이 하나 남는다");
pass++; console.log("ok  F1 줄 끝 CR 은 while 로 전부 벗긴다");

// 백필 커서 복원은 **조건 없이** 적용한다(#1943 초판의 cursor_flag 게이팅은 오진이라 되돌렸다).
//  커서를 숨긴 채 idle 인 TUI(선택 프롬프트·less·fzf)에서 '미루면' 영영 안 맞춰진다.
assert.ok(/if \(st && st\.hasCursor\) writeCursor\(st\);/.test(src),
  "백필은 tmux 실커서를 조건 없이 복원해야 한다(#1092 버그2·3 방지)");
pass++; console.log("ok  F2 백필 커서 복원은 게이팅 없이 적용");
assert.ok(!/hasCursorFlag|cursorVisible|backfillCursorAction|cursorResyncAction/.test(src),
  "오진이었던 cursor_flag 게이팅의 잔재가 남으면 안 된다(같은 오진이 다시 자란다)");
pass++; console.log("ok  F3 cursor_flag 게이팅 잔재 없음");

console.log(`\n${pass} 개 통과`);
