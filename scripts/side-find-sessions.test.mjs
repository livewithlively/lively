#!/usr/bin/env node
// 사이드바에 **찾기 칸이 없다** — 그리고 `/` 를 가로채지 않는다 (#3977 회의, 2026-09-14)
//
//  회의 결정 원문: «사이드바 검색창 제거(안 씀 · `/` 키 충돌). 날짜 그룹·프로젝트 묶기 토글은 유지».
//  두 가지가 사유였다: ⓐ 아무도 안 썼다 ⓑ `/` 가 세션 화면에서 사람이 실제로 치는 글자인데(Claude 의
//  슬래시 명령) 사이드바가 그걸 가로채 엉뚱한 칸이 열렸다. 찾는 길은 통합검색(⌘K) 하나로 모은다.
//
//  ⚠ 이 파일은 종전에 그 찾기의 **계약**을 잠그고 있었다(#762 세션 이름으로도 찾힌다 외 8건).
//   기능이 사라졌으므로 단언을 **뒤집어** 되살아남을 잡는다 — 되살릴 생각이면 먼저 `/` 충돌부터 푼다.
//   아래 ⑩~⑬(펼침 기억 금지 · 홈 목록 날짜 컷)은 찾기와 무관해 그대로 남겨 둔다.
//
//  ⚠ 소스 계약 시험의 값어치는 «깨지면 빨간불이 되는가»에 있다. 아래 단언은 전부 수정 전 코드
//   (git show HEAD:web/v2/side.ts)로 빨간불을 확인했다.

import { readFileSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (name, v) => { console.log((v ? 'ok  ' : 'FAIL') + '  ' + name); v ? pass++ : fail++; };

const root = path.resolve(import.meta.dirname, '..');
const side = readFileSync(path.join(root, 'web/v2/side.ts'), 'utf8');
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
//  (이 파일의 «사이드바 검색창 제거» 같은 인용문이 그대로 걸리는 거짓 빨강도 여기서 막힌다.)
const code = side.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── 찾기 칸이 없다 ───────────────────────────────────────────────────────────
ok('① 사이드바가 목록을 거르는 검색 상태를 들지 않는다(sideFilter 없음)',
  !/\bsideFilter\b/.test(code));
ok('② 찾기 입력칸을 짓는 자가 없다 — .v2-find-in 을 만드는 곳은 자료 앱(sources.ts)뿐이다',
  !/class: 'v2-find-in'/.test(code) && !/function findInput\b/.test(code));
ok('③ 돋보기 토글(구역 머리글의 찾기 단추)이 없다',
  !/function findBtn\(\)/.test(code) && !/findBtn\(\)/.test(code));
ok('④ 목록을 찾기 잣대로 거르지 않는다 — lib/find.ts 를 사이드바가 끌어오지 않는다',
  !/from '\.\.\/lib\/find\.js'/.test(code));

// ── `/` 를 가로채지 않는다 (P1-6 「세션 안 / 입력 시 사이드바 검색 열림」) ────
ok('⑤ 키 핸들러가 `/` 를 보지 않는다',
  !/e\.key !== '\/'/.test(code) && !/e\.key === '\/'/.test(code));
ok('⑥ 남은 사이드바 키는 Esc(정리 끝내기) 하나다',
  /function bindSideKeys\(\)/.test(code) && /e\.key === 'Escape' && tidyOn/.test(code));

// ── 남은 렌즈는 그대로 — 회의가 «유지»라고 적은 것들 ─────────────────────────
ok('⑦ 프로젝트 묶기 토글은 남아 있다',
  /function axisBtn\(\)/.test(code) && /axisBtn\(\)/.test(code));
ok('⑧ 상태 필터(팝오버)는 남아 있다',
  /function filterBtn\(/.test(code) && /stateFilter/.test(code));
ok('⑨ 프로젝트 줄 그리기에서 «찾기에 걸렸으니 펴 준다» 인자가 사라졌다',
  (code.match(/projRow\(r, stateOf\(r\), pastOf\(r\), activeKey, selectedPk\)/g) || []).length === 2
    && !/hitInside/.test(code));

// ── 되풀이 금지 — 「지난 세션」 펼침은 기억하지 않는다 ────────────────────────
//  원준 2026-08-24: "난 연 적이 없는데 지멋대로 펼쳐져 있어". 이번 변경(방금 멈춘 것은 접지 않는다)이
//  그 지시를 되돌리는 쪽으로 새지 않았는지 여기서 잠근다.
ok('⑩ 편 상태를 브라우저에 저장하지 않는다(페이지 수명만)',
  /const pastSet = new Set<string>\(\);/.test(code) && !/saveSet\(PAST/.test(code));
ok('⑪ 옛 저장 기록은 부팅 때 지운다',
  /removeItem\(PAST_KEY_LEGACY\)/.test(code));

// ── 홈 목록 — 멈춘 세션을 **달력 자정**으로 자르지 않는다 ────────────────────
//  원준 2026-09-05 01:20 실측: 그 시각 그 사람의 멈춘 세션이 홈 목록에 0줄이었고(달력으로 갓 '오늘'이라
//  받을 것이 없었다), 찾던 「투어 영상 제작」은 최신에서 **2번째**였다. 자르는 자가 문제였지 목록이 짧아서가 아니다.
const main = readFileSync(path.join(root, 'web/v2/main.ts'), 'utf8');
const mcode = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
//  #3855 — 자르는 줄이 보임 축 판정(web/v2/sess-visibility.ts)으로 옮겨 갔다: 이제 날짜 컷은 «화면에서 한 번도 안 연 세션»
//   에만 걸리고, 그 자는 여전히 workDayStart 다. 비교(>=)와 경계는 scripts/sess-visibility.test.mjs S8·S9 가 값으로 잠근다.
ok('⑫ 홈 목록이 「오늘 일감의 시작」으로 자른다 — 달력 자정(dayGroup)이 아니다',
  /const dayStart = workDayStart\(now\);/.test(mcode) && /lastSeen: s\.lastSeen \|\| 0, dayStart,/.test(mcode)
    && !/dayGroup\(s\.lastSeen \|\| 0, now\) !== '오늘'/.test(mcode));
ok('⑬ 그 자를 폴더 접기와 **같은 잎 모듈**에서 가져온다(사본을 두지 않는다)',
  /import \{ workDayStart \} from '\.\.\/lib\/sess-fold\.js'/.test(mcode));

console.log(`\nside-no-find: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
