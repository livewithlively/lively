// #1943 후속 — "휠이 ↑/↓ 로 인식된다"가 **한 번 걸리면 안 풀리던** 래치를 끊는다.
//
// 구조(코드로 확정, 2026-08-27):
//   alt-screen + 클라 xterm 마우스 트래킹 off = xterm 이 휠을 화살표로 폴백한다(xterm 정상 설계).
//   그런데 재동기 질의는 handleTermData 의 `isMouseReport(d)` 게이트에 걸려 있다 — 트래킹이 꺼져 있으면
//   xterm 은 리포트 대신 화살표를 보내므로 그 조건이 **영영 성립하지 않는다**. 즉 자가복구 경로가 닫힌다.
//   실측: 강제로 한 번 끈 뒤 휠+이동을 24초간 계속해도 복구 질의가 한 번도 안 나갔다(매니지드 실세션).
//   복구는 탭 전환·포커스·재연결뿐 — 그래서 "자주 그러고, 잘 안 풀린다"로 보인다.
// 해법: 폴백이 **실제로 일어나는 순간**(휠 이벤트)에 상태를 한 번 물어 교정한다.
//   왕복은 매니지드 실측 중앙값 30ms(최대 64ms, WS 프레임 타임스탬프 10회) — 체감 전에 돌아온다.
//
// 틀리면 티가 크다:
//   🔴 너무 넓게 물으면 — 일반 화면 스크롤(스크롤백)마다 tmux 질의가 나가 셸을 쓰는 내내 트래픽이 는다.
//   🔴 스로틀이 없으면 — 휠 한 번에 이벤트가 수십 개라 질의가 폭주한다(휠은 한 번 굴려도 연속 발화).
//   🔴 아예 안 물으면 — 이 버그 그대로(탭 전환 전까지 마우스가 키보드처럼 동작).
// 실행: npm run build && node scripts/terminal-mouse-latch.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");
const { wheelResyncAction, WHEEL_RESYNC_GAP_MS } = await importTerminalModule();
assert.equal(typeof wheelResyncAction, "function", "wheelResyncAction 이 모듈에서 노출돼야 한다");

let pass = 0;
const eq = (got, want, n) => { assert.equal(got, want, `${n}: '${want}' 여야 하는데 '${got}'`); pass++; console.log(`ok  ${n}`); };
const W = (alt, mouseMode, sinceProbe) => wheelResyncAction({ alt, mouseMode, sinceProbe });
const FAR = WHEEL_RESYNC_GAP_MS + 1;

// ── 표 A. 폴백 상황인가(= 물어야 하는가) ──
eq(W(true, "none", FAR), "probe", "A1 alt + 트래킹 off = 폴백 중 → 상태를 묻는다 ★이 버그가 나는 그 상황");
eq(W(true, "any", FAR), "skip", "A2 alt + 트래킹 on → 리포트가 앱으로 나간다(정상) → 묻지 않는다");
eq(W(true, "drag", FAR), "skip", "A3 서브모드가 달라도 켜져 있으면 정상");
eq(W(true, "vt200", FAR), "skip", "A4 vt200 도 켜진 것");
eq(W(false, "none", FAR), "skip", "A5 일반 화면의 휠 = 스크롤백 스크롤이지 폴백이 아니다(셸 쓰는 내내 질의가 나가면 안 된다)");
eq(W(false, "any", FAR), "skip", "A6 일반 화면 + 트래킹 on 도 대상 아님");

// ── 표 B. 스로틀 — 휠 한 번에 이벤트가 수십 개 발화한다 ──
eq(W(true, "none", 0), "throttle", "B1 방금 물었으면 다시 묻지 않는다(폭주 방지)");
eq(W(true, "none", WHEEL_RESYNC_GAP_MS - 1), "throttle", "B2 경계: 간격 직전");
eq(W(true, "none", WHEEL_RESYNC_GAP_MS), "probe", "B3 경계: 간격에 도달하면 다시 묻는다");
eq(W(true, "none", undefined), "probe", "B4 아직 한 번도 안 물었으면(간격 미상) 즉시 묻는다 — 첫 휠에 바로 풀려야 한다");
eq(W(true, "none", Infinity), "probe", "B5 경계: 무한대도 즉시");

// ── 표 C. 방어 ──
eq(W(true, "", FAR), "probe", "C1 모드 문자열이 비어도 '꺼짐'으로 본다(xterm 읽기 실패 시 기본값)");
eq(wheelResyncAction(null), "skip", "C2 인자 없음 → 아무것도 안 한다");
eq(wheelResyncAction(undefined), "skip", "C3 undefined 도 안전");

// ── 배선 — 판정이 맞아도 안 부르면 버그는 그대로다 ──
assert.ok(/host\.addEventListener\('wheel'[\s\S]{0,700}?wheelResyncAction\(/.test(src),
  "term.open 뒤 휠 리스너가 wheelResyncAction 판정을 거쳐야 한다");
pass++; console.log("ok  D1 휠 이벤트가 판정을 거친다");
assert.ok(/wheelResyncAction\([\s\S]{0,200}?!== 'probe'\) return;[\s\S]{0,400}?t: 'st'/.test(src),
  "'probe' 일 때만 상태질의({t:'st'})를 보내야 한다");
pass++; console.log("ok  D2 probe 일 때만 상태를 묻는다");
assert.ok(/addEventListener\('wheel',[\s\S]{0,900}?passive: true/.test(src),
  "휠 리스너는 passive 여야 한다 — 관측만 하고 스크롤/폴백 동작 자체는 건드리지 않는다");
pass++; console.log("ok  D3 휠 리스너는 passive(관측 전용)");

// 껐을 때 **근거**가 진단에 남아야 한다 — 이게 없어서 트리거를 제보로만 추정해야 했다.
assert.ok(/dlog\('mouse', 'off ' \+ xtMode \+ ' ← '/.test(src),
  "마우스를 끌 때 그 근거(셸 오인인지 flag 0 인지)를 진단에 남겨야 한다");
pass++; console.log("ok  D4 마우스 off 근거가 진단에 남는다");
assert.ok(/dlog\('mouse', xtMode \+ ' → ' \+ wantMode/.test(src),
  "켤 때(전이)도 남겨야 짝이 맞는다 — off 만 남으면 언제 풀렸는지 모른다");
pass++; console.log("ok  D5 마우스 on 전이도 진단에 남는다");

console.log(`\n${pass} 개 통과`);
