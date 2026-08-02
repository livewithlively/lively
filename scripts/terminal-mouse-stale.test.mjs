// #1092 재발분 — "tmux 가 마우스 ON 이라고 말할 때 클라가 정말 켜야 하는가"의 판정 표를 고정한다.
//  이 갈림길은 눈으로 확인하기 비싸다(앱이 마우스를 켠 채 비정상 종료한 pane 을 실제로 만들어야 보이고,
//  증상은 실제 마우스를 움직여야 난다 — 합성 이벤트로는 xterm 전달이 재현되지 않는다). 그런데 틀리면 티가 크다:
//   🔴 너무 넓게 켜면 — 앱이 죽으며 못 끈 flag 를 붙을 때마다 되살려, 셸 프롬프트에 마우스 이동마다 리포트가
//      주입된다(`;EB1` 류 garbage). 붙을 때마다 되살아나므로 **새로고침해도 안 풀린다**.
//   🔴 너무 좁게 끄면 — 실행 중인 앱(Claude 등)에 재접속했을 때 마우스가 죽는다(#252 에서 고쳤던 것의 되돌림).
//   🔴 리포트 판별이 헐거우면 — 평범한 타이핑을 리포트로 오인해 상태질의가 폭주한다.
//  판정 함수 2종은 **모듈에서 직접 import** 한다 — 종전엔 브라우저용 클래식 스크립트라 소스에서 선언만 잘라
//  평가했는데(#1313 R51 이전), 페이지가 TS 로 편입되면서 실제 모듈을 그대로 부를 수 있게 됐다.
//  ('전역 의존 없는 순수 함수'라는 성질은 여전히 강제된다 — 전역을 잡으면 노드 import 에서 터진다.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 배선(무엇이 무엇을 부르는가)만 소스 텍스트로 확인한다 — 판정이 맞아도 호출부가 빠지면 버그는 그대로다.
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");

const { paneMouseMode, isMouseReport } = await importTerminalModule();
assert.equal(typeof paneMouseMode, "function");
assert.equal(typeof isMouseReport, "function");

let pass = 0;
const eq = (got, want, n) => { assert.equal(got, want, `${n}: '${want}' 여야 하는데 '${got}'`); pass++; console.log(`ok  ${n}`); };

// tmux 상태 한 줄을 만드는 헬퍼 — 클라 parsePaneState 가 내는 모양과 같은 형태(플래그 + foreground).
const st = (flags, cmd) => ({ any: !!flags.any, btn: !!flags.btn, std: !!flags.std, cmd });

// ── 표 A. 목표 마우스모드 판정 ──
eq(paneMouseMode(st({}, "zsh")), "none", "A1 앱도 flag 도 없음 → 끔");
eq(paneMouseMode(st({ any: 1 }, "zsh")), "none", "A2 flag 는 ON 인데 foreground 가 셸 → 죽은 앱의 잔재라 끔(재발 버그 그 자체)");
eq(paneMouseMode(st({ any: 1 }, "node")), "any", "A3 앱이 실행 중이면 되살린다(#252 보존)");
eq(paneMouseMode(st({ btn: 1 }, "node")), "drag", "A4 버튼 트래킹");
eq(paneMouseMode(st({ std: 1 }, "node")), "vt200", "A5 표준 트래킹");
eq(paneMouseMode(st({ any: 1, btn: 1, std: 1 }, "node")), "any", "A6 여러 모드가 켜져 있으면 상위모드 우선");
eq(paneMouseMode(st({ any: 1 }, "")), "any", "A7 foreground 를 모르면(구 서버) 게이팅 없이 종전 동작으로 degrade");
eq(paneMouseMode(st({ any: 1 }, "-zsh")), "none", "A8 로그인 셸(-zsh)도 셸");
eq(paneMouseMode(st({ any: 1 }, "/bin/bash")), "none", "A9 경로형으로 와도 셸");
eq(paneMouseMode(st({ any: 1 }, "ZSH")), "none", "A10 대소문자 무관");
eq(paneMouseMode(st({ any: 1 }, "fzf")), "any", "A11 normal 화면에서 마우스 쓰는 앱은 보존(alt-screen 여부로 가르면 안 되는 이유)");
eq(paneMouseMode(st({ any: 1 }, "2.1.220")), "any", "A12 실측 Claude Code foreground 이름 — 셸이 아니면 보존");
eq(paneMouseMode(st({ any: 1 }, "zsh-completions")), "any", "A13 경계: 셸 이름을 접두로 가진 남 — 부분일치로 끄면 안 된다");
eq(paneMouseMode(null), "none", "A14 상태가 아예 없으면 끔(방어)");

// ── 표 B. 마우스 리포트 판별 ──
eq(isMouseReport("\x1b[<35;70;12M"), true, "B1 SGR 누름/이동");
eq(isMouseReport("\x1b[<35;70;12m"), true, "B2 SGR 뗌");
eq(isMouseReport("\x1b[M" + String.fromCharCode(67, 69, 66)), true, "B3 X10 인코딩(ESC[M + 3바이트)");
eq(isMouseReport("\x1b[32;70;12M"), true, "B4 urxvt 인코딩");
eq(isMouseReport("ls\r"), false, "B5 평범한 타이핑");
eq(isMouseReport("\x1b\r"), false, "B6 경계: Shift+Enter 승격 바이트 — 오검출하면 상태질의가 폭주한다");
eq(isMouseReport("\x1b[A"), false, "B7 화살표");
eq(isMouseReport(""), false, "B8 빈 값(방어)");
eq(isMouseReport(undefined), false, "B8 없음(방어)");

// ── 배선 — 판정이 맞아도 아무도 안 부르면 버그는 그대로다(순수함수만 있고 호출부가 빠지는 게 가장 흔한 헛수정) ──
// 선언부터 '다음 최상위 선언' 직전까지의 텍스트를 본다(평가하지 않는다 — 호출이 적혀 있는지만 확인).
function fnText(name) {
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `web/standalone/terminal.ts 에 ${name} 이 없습니다 — 이름이 바뀌었다면 이 테스트도 같이 고치세요`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:export )?(?:async )?function |\n(?:export )?(?:const|let) /);
  return rest.slice(0, next < 0 ? undefined : next);
}
const applySrc = fnText("applyPaneState");
assert.ok(applySrc.length > 120, "applyPaneState 본문을 못 읽었습니다 — 관측 장치가 죽은 채 표만 통과하는 걸 막는다");
assert.ok(applySrc.includes("paneMouseMode(st)"),
  "배선: applyPaneState 가 paneMouseMode 로 목표 모드를 정해야 한다 — 옛 인라인 판정이 남으면 stale 게이팅이 통째로 죽는다");
assert.ok(applySrc.includes("requestMouseReset()"),
  "배선: stale 관측 시 tmux 쪽 상태 복구를 요청해야 한다 — 이 클라만 안 켜면 다른 클라·실 터미널 attach 는 계속 flood 를 받는다");
pass++; console.log("ok  배선 applyPaneState → paneMouseMode + requestMouseReset");

// 정의 자체가 먼저 매치되므로(indexOf 는 첫 등장) onData 이후 구간에서 '호출'을 찾는다.
const onDataAt = src.indexOf("term.onData");
assert.ok(onDataAt > 0 && src.indexOf("isMouseReport(", onDataAt) > onDataAt,
  "배선: 입력 경로(onData)에서 리포트를 감지해 상태를 다시 물어야 한다 — 없으면 붙어 있는 동안 앱이 죽었을 때 다음 포커스까지 flood 가 지속된다");
pass++; console.log("ok  배선 onData → isMouseReport 드리프트 가드");

console.log(`\n${pass} passed`);
