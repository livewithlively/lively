// #1943 — "백필이 되돌리는 커서 좌표를 믿어도 되는가"의 판정 표를 고정한다.
//
// 이 갈림길은 눈으로 확인하기 비싸다: 증상이 나려면 ① 상태 스냅샷이 '앱이 렌더 중인 순간'을 떠야 하고
//  ② 그 뒤 앱이 idle 이어야 하며 ③ **한글 IME 로 조합해야** 보인다(영문은 매 타 재그리기라 가려진다).
//  실측(2026-08-25 매니지드 도그푸드): 중계 왕복이 140ms(dev 20ms)라 ①의 창이 넓어져 재현됐다.
// 틀리면 티가 크다:
//   🔴 못 믿을 좌표를 그대로 박으면 — 커서가 프롬프트 맨 앞(`>` 위)에 고정되고 앱이 idle 이라 **영영 안 풀린다**.
//   🔴 반대로 좌표를 그냥 버리면 — #1092 버그2·3(커서가 화면 맨 아래) 이 되돌아온다. 버리는 게 아니라 '미룬다'.
//   🔴 재동기가 앱 출력을 무시하면 — 앱이 놓은 커서를 우리가 덮어 새 desync 를 만든다.
// 판정 2종은 **모듈에서 직접 import**(전역 의존 없는 순수 함수라는 성질이 노드 import 로 강제된다).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";
import { stateCmd } from "../dist/terminal/terminal-pty.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 배선(호출부가 실제로 이 판정을 쓰는가)만 소스 텍스트로 확인한다 — 판정이 맞아도 호출부가 빠지면 버그는 그대로다.
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");

const { backfillCursorAction, cursorResyncAction, parsePaneState } = await importTerminalModule();
assert.equal(typeof backfillCursorAction, "function");
assert.equal(typeof cursorResyncAction, "function");

let pass = 0;
const eq = (got, want, n) => { assert.equal(got, want, `${n}: '${want}' 여야 하는데 '${got}'`); pass++; console.log(`ok  ${n}`); };
const ok = (cond, n) => { assert.ok(cond, n); pass++; console.log(`ok  ${n}`); };

// 서버가 실제로 보내는 한 줄을 그대로 파싱해 상태를 만든다 — 손으로 객체를 짜면 파서와 판정 사이의 계약이 빠진다.
const line = (extra) => `__LTSTATE__ mux=tmux alt=1 any=0 btn=0 std=0 sgr=0 ${extra} cmd=2.1.245`;
const stOf = (extra) => parsePaneState(line(extra));

// ── 표 A. 백필 시점 판정 ──
eq(backfillCursorAction(stOf("cx=2 cy=43 cf=1")), "apply", "A1 커서 보임 + 좌표 → 적용(사용자 입력점)");
eq(backfillCursorAction(stOf("cx=0 cy=43 cf=0")), "defer", "A2 커서 숨김(앱 렌더 중) → 미적용 + 재동기 예약");
eq(backfillCursorAction(stOf("cx=2 cy=43")), "apply", "A3 cf 없음(구 서버) → 종전 동작 유지 · '없음'을 '숨김'으로 읽지 않는다");
eq(backfillCursorAction(stOf("cf=1")), "skip", "A4 좌표 없음 → 할 일 없음");
eq(backfillCursorAction(stOf("cf=0")), "skip", "A5 좌표 없이 숨김 → 예약도 안 한다(맞출 좌표가 애초에 없다)");
eq(backfillCursorAction(null), "skip", "A6 상태 자체가 없음 → 방어");

// ── 표 B. 재동기 응답 판정 ──
const R = (extra, o) => cursorResyncAction(extra === null ? null : stOf(extra), o);
eq(R("cx=2 cy=43 cf=1", { triesLeft: 2, outputSinceBackfill: false }), "apply", "B1 idle + 좌표 → 맞추고 종료");
eq(R("cx=2 cy=43 cf=1", { triesLeft: 2, outputSinceBackfill: true }), "stop", "B2 앱이 출력했다 → 앱이 놓은 커서를 덮지 않는다");
eq(R("cx=0 cy=43 cf=0", { triesLeft: 2, outputSinceBackfill: false }), "retry", "B3 아직 렌더 중 → 다시 묻는다");
eq(R("cx=0 cy=43 cf=0", { triesLeft: 0, outputSinceBackfill: false }), "stop", "B4 경계: 남은 횟수 0 → 무한 폴링 금지");
eq(R("cx=0 cy=43 cf=0", { triesLeft: 2, outputSinceBackfill: true }), "stop", "B5 출력이 횟수보다 우선");
eq(R("cf=1", { triesLeft: 2, outputSinceBackfill: false }), "retry", "B6 좌표가 아직 안 옴 → 재시도");
eq(R(null, { triesLeft: 2, outputSinceBackfill: false }), "retry", "B7 상태 없음 → 방어적으로 재시도");
eq(R(null, {}), "stop", "B8 경계: 옵션이 비면(횟수 미지정) 멈춘다 — 기본값이 무한이 되면 안 된다");

// ── 표 C. 서버 상태 한 줄 ──
ok(stateCmd().includes("cf=#{cursor_flag}"), "C1 서버가 커서 표시 여부를 실어 보낸다(이게 없으면 클라는 판정 자체를 못 한다)");
ok(/ cmd=#\{pane_current_command\}'$/.test(stateCmd()), "C2 cmd 는 여전히 마지막 토큰(프로세스명 공백이 앞 항목 파싱을 깨지 않게)");
eq(parsePaneState(line("cx=2 cy=43 cf=1")).cursorVisible, true, "C3 파서가 cf=1 을 '보임'으로 읽는다");
eq(parsePaneState(line("cx=2 cy=43")).hasCursorFlag, false, "C4 파서가 cf 부재를 '모름'으로 구분한다(숨김 아님)");

// ── 표 D. 배선 ──
ok(/backfillCursorAction\(st\)/.test(src), "D1 백필 핸들러가 판정을 거친다(hasCursor 로 직접 쓰지 않는다)");
ok(/cursorResyncAction\(/.test(src) && /t: 'st'/.test(src), "D2 재동기는 상태 재질의(t:'st')로 한다");
ok(/lastOutputAt = Date\.now\(\)/.test(src), "D3 앱 출력 시각을 실제로 기록한다(안 하면 B2·B5 가 영원히 거짓)");

console.log(`\n${pass} 개 통과`);
