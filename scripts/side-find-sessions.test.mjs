#!/usr/bin/env node
// 사이드바 트리 찾기 — **세션 이름으로도 찾힌다** (#762, 원준 2026-09-05)
//
//  신고의 절반은 "폴더를 펼쳐도 안 보였다"였고(→ side-folder-fold.test.mjs), 나머지 절반은 **되찾을 길이
//  없었다**는 것이다: 트리 찾기가 프로젝트 이름만 봐서 세션 이름을 치면 0건이었고, 걸려도 폴더·묶음이
//  접혀 있으면 그 줄이 화면에 없었다. 그 규칙들은 화면 코드(web/v2/side.ts)에 있어 DOM 없이 못 돌린다 —
//  이 저장소의 관례대로(scripts/pane-session-scope.test.mjs) **소스 계약**으로 잠근다.
//
//  ⚠ 소스 계약 시험의 값어치는 «깨지면 빨간불이 되는가»에 있다. 아래 단언은 전부 mutation 으로
//   빨간불을 확인했다(그 문장을 지우거나 조건을 뒤집으면 실패한다).

import { readFileSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (name, v) => { console.log((v ? 'ok  ' : 'FAIL') + '  ' + name); v ? pass++ : fail++; };

const root = path.resolve(import.meta.dirname, '..');
const side = readFileSync(path.join(root, 'web/v2/side.ts'), 'utf8');
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
const code = side.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── 찾기 ─────────────────────────────────────────────────────────────────────
ok('① 트리 찾기가 세션 이름을 본다 — 프로젝트 이름만 보지 않는다',
  /sessHit[^\n]*=>[^\n]*match\(s\.label\)/.test(code));
ok('② 프로젝트 이름 또는 세션 이름 중 하나만 걸려도 그 줄은 남는다',
  /const hit\s*=\s*\(r: Row\)\s*=>\s*projHit\(r\)\s*\|\|\s*sessHit\(r\)/.test(code));
ok('③ 세션 이름만 걸린 줄은 **걸린 세션만** 남긴다(프로젝트가 걸렸으면 그대로 다 보여 준다)',
  /const narrow\s*=[^\n]*!q \|\| projHit\(r\) \? arr : arr\.filter\(\(s\) => match\(s\.label\)\)/.test(code));
ok('④ 그 좁히기를 도는 세션·지난 세션 **양쪽에** 건다',
  /const stateOf =[^\n]*narrow\(/.test(code) && /const pastOf =[^\n]*narrow\(/.test(code));

// ── 걸렸으면 보여야 한다 — 접힘이 찾기를 가리지 않는다 ────────────────────────
ok('⑤ 안쪽이 걸린 줄의 폴더는 펴진 채 그려진다',
  /const isOpen = has > 0 && \(stateFilter \|\| hitInside \? true :/.test(code));
ok('⑥ 걸린 세션이 「지난 세션」 안이면 그 묶음도 펴진다',
  /const pastOpen = cold\.length > 0 && \(pastSet\.has\(pk\) \|\| hitInside \|\|/.test(code));
ok('⑦ 걸린 세션이 **완료된 프로젝트** 안이어도 숨기지 않는다',
  /r\.done && !showDone && !r\.live\.length && !isPinned\(r\.key\) && !hitInside\(r\)/.test(code));
ok('⑧ 안쪽이 걸렸다 = 프로젝트 이름은 안 걸렸는데 세션 이름이 걸린 것',
  /const hitInside\s*=\s*\(r: Row\)\s*=>\s*!projHit\(r\) && sessHit\(r\)/.test(code));
ok('⑨ 그 값이 실제로 두 그림 경로(진행 중·전체 프로젝트) 모두에 넘어간다',
  (code.match(/projRow\(r, stateOf\(r\), pastOf\(r\), activeKey, selectedPk, hitInside\(r\)\)/g) || []).length === 2);

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
ok('⑫ 홈 목록이 「오늘 일감의 시작」으로 자른다 — 달력 자정(dayGroup)이 아니다',
  /!liveNow && \(s\.lastSeen \|\| 0\) < workDayStart\(now\)/.test(mcode) && !/dayGroup\(s\.lastSeen \|\| 0, now\) !== '오늘'/.test(mcode));
ok('⑬ 그 자를 폴더 접기와 **같은 잎 모듈**에서 가져온다(사본을 두지 않는다)',
  /import \{ workDayStart \} from '\.\.\/lib\/sess-fold\.js'/.test(mcode));

console.log(`\nside-find-sessions: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
