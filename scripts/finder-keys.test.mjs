// #3870 — 곁칸 자료의 **키 판정**(맥 파인더 · 윈도 탐색기 두 표) · 방향키 다음 칸 · 타이핑으로 고르기 · 복사본 이름.
//
//  원준 2026-09-30: «맥이랑 윈도우의 Finder나 파일탐색기 수준으로 … 구현안된 단축키 등도 모두 실현가능하게.
//   예를 들어 맥은 파일 선택하고 엔터 누르면 이름 수정이고 이런게 있음.»
//  두 운영체제는 같은 키에 다른 뜻을 둔다(Enter · Backspace · ⌘D/Ctrl+D) — 표가 섞이면 한쪽 사람이 파일을 지우거나 못 연다.
//  시나리오 번호(K·N·T·Y)는 사양의 엣지 표 행이다.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "finder-keys-"));
const SRC = process.env.FK_SRC || path.join(root, "web/lib/finder-keys.ts");
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [SRC, "--rootDir", path.dirname(SRC), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const M = await import(path.join(out, path.basename(SRC).replace(/\.ts$/, ".js")));
const { finderKey, navIndex, typeSelect, typeChar, copyName, keyHint, isMacPlatform } = M;

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const eq = (got, want, n) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`));
const act = (e, mac) => { const r = finderKey(e, mac); return r ? r.act + (r.extend ? '+' : '') : null; };
const K = (key, code, mods = {}) => ({ key, code, ...mods });
const MAC = true, WIN = false;

// ── K. 두 표 ──
eq(act(K('Enter', 'Enter'), MAC), 'rename', 'K1 맥 Enter = 이름 바꾸기');
eq(act(K('Enter', 'Enter'), WIN), 'open', 'K1 윈도 Enter = 열기');
eq(act(K('F2', 'F2'), MAC), 'rename', 'K2 맥 F2 = 이름 바꾸기');
eq(act(K('F2', 'F2'), WIN), 'rename', 'K2 윈도 F2 = 이름 바꾸기');
eq(act(K(' ', 'Space'), MAC), 'quicklook', 'K3 맥 Space = 빠른 보기');
eq(act(K(' ', 'Space'), WIN), 'quicklook', 'K3 윈도 Space = 빠른 보기');
eq(act(K('o', 'KeyO', { metaKey: true }), MAC), 'open', 'K4 맥 ⌘O = 열기');
eq(act(K('ArrowDown', 'ArrowDown', { metaKey: true }), MAC), 'open', 'K4 맥 ⌘↓ = 열기');
eq(act(K('o', 'KeyO', { ctrlKey: true }), WIN), null, 'K4 윈도 Ctrl+O 는 이 칸의 키가 아니다');
eq(act(K('ArrowUp', 'ArrowUp', { metaKey: true }), MAC), 'parent', 'K5 맥 ⌘↑ = 위 폴더');
eq(act(K('ArrowUp', 'ArrowUp', { altKey: true }), WIN), 'parent', 'K5 윈도 Alt+↑ = 위 폴더');
eq(act(K('[', 'BracketLeft', { metaKey: true }), MAC), 'back', 'K6 맥 ⌘[ = 뒤로');
eq(act(K(']', 'BracketRight', { metaKey: true }), MAC), 'forward', 'K6 맥 ⌘] = 앞으로');
eq(act(K('ArrowLeft', 'ArrowLeft', { altKey: true }), WIN), 'back', 'K6 윈도 Alt+← = 뒤로');
eq(act(K('ArrowRight', 'ArrowRight', { altKey: true }), WIN), 'forward', 'K6 윈도 Alt+→ = 앞으로');
eq(act(K('Backspace', 'Backspace'), WIN), 'back', 'K6 윈도 Backspace = 뒤로(삭제가 아니다)');
eq(act(K('Backspace', 'Backspace', { metaKey: true }), MAC), 'delete', 'K7 맥 ⌘⌫ = 삭제');
eq(act(K('Backspace', 'Backspace'), MAC), 'delete', 'K7 맥 ⌫ = 삭제(종전 이 칸 그대로)');
eq(act(K('Delete', 'Delete'), WIN), 'delete', 'K7 윈도 Delete = 삭제');
eq(act(K('d', 'KeyD', { ctrlKey: true }), WIN), 'delete', 'K7 윈도 Ctrl+D = 삭제');
eq(act(K('d', 'KeyD', { metaKey: true }), MAC), 'duplicate', 'K8 맥 ⌘D = 복제');
for (const [c, a] of [['a', 'selectAll'], ['c', 'copy'], ['x', 'cut'], ['v', 'paste'], ['f', 'find'], ['z', 'undo']]) {
  eq(act(K(c, 'Key' + c.toUpperCase(), { metaKey: true }), MAC), a, `K9 맥 ⌘${c.toUpperCase()} = ${a}`);
  eq(act(K(c, 'Key' + c.toUpperCase(), { ctrlKey: true }), WIN), a, `K9 윈도 Ctrl+${c.toUpperCase()} = ${a}`);
}
eq(act(K('N', 'KeyN', { metaKey: true, shiftKey: true }), MAC), 'newFolder', 'K9 맥 ⇧⌘N = 새 폴더');
eq(act(K('N', 'KeyN', { ctrlKey: true, shiftKey: true }), WIN), 'newFolder', 'K9 윈도 Ctrl+Shift+N = 새 폴더');
eq(act(K('e', 'KeyE', { ctrlKey: true }), WIN), 'find', 'K9 윈도 Ctrl+E = 찾기');
eq(act(K('v', 'KeyV', { metaKey: true, altKey: true }), MAC), 'pasteMove', 'K10 맥 ⌥⌘V = 옮기기');
eq(act(K('ArrowRight', 'ArrowRight'), MAC), 'right', 'K11 → = 오른쪽');
eq(act(K('ArrowDown', 'ArrowDown', { shiftKey: true }), WIN), 'down+', 'K11 ⇧↓ = 넓히며 아래');
eq(act(K('Home', 'Home'), WIN), 'first', 'K11 Home = 처음');
eq(act(K('End', 'End', { shiftKey: true }), MAC), 'last+', 'K11 ⇧End = 넓히며 끝');
eq(act(K('ArrowUp', 'ArrowUp', { altKey: true }), MAC), 'first', 'K12 맥 ⌥↑ = 처음');
eq(act(K('ArrowDown', 'ArrowDown', { altKey: true }), MAC), 'last', 'K12 맥 ⌥↓ = 끝');
eq(act(K('ㅊ', 'KeyC', { metaKey: true }), MAC), 'copy', 'K13 한글 입력기 켜짐(key=ㅊ, code=KeyC) + ⌘ → 복사');
eq(act(K('ㅂ', 'KeyQ', { ctrlKey: true, shiftKey: true }), WIN), null, 'K13 한글 입력기에서도 없는 조합은 없다');
eq(act(K('ㅜ', 'KeyN', { ctrlKey: true, shiftKey: true }), WIN), 'newFolder', 'K13 윈도 한글 입력기 Ctrl+Shift+N(key=ㅜ) → 새 폴더');
eq(act(K('Enter', 'Enter', { isComposing: true }), MAC), null, 'K14 한글 조합 중 Enter 는 이 칸의 것이 아니다');
eq(act(K('c', 'KeyC', { ctrlKey: true }), MAC), null, 'K15 맥에서 Ctrl+C 는 복사가 아니다(터미널 중단 키)');
eq(act(K('c', 'KeyC', { metaKey: true }), WIN), null, 'K15 윈도에서 ⊞+C 는 복사가 아니다');
eq(act(K('a', 'KeyA'), MAC), null, 'K16 수식키 없는 글자는 null(타이핑 고르기 몫)');
eq(act(K('ㅅ', 'KeyT'), WIN), null, 'K16 수식키 없는 한글도 null');
eq(typeChar(K('ㅅ', 'KeyT')), { ch: 'ㅅ', cho: 'ㅅ' }, 'K16 typeChar 한글 그대로');
eq(typeChar(K('t', 'KeyT')), { ch: 't', cho: 'ㅅ' }, 'K16 typeChar 영문 t → 자판 초성 ㅅ');
eq(typeChar(K('c', 'KeyC', { metaKey: true })), null, 'K16 typeChar 수식키면 글자가 아니다');
eq(typeChar(K('Enter', 'Enter')), null, 'K16 typeChar 이름 있는 키는 글자가 아니다');
// 메뉴 표시가 실제 키와 같은가 — 표시만 따로 바뀌면 사람이 메뉴를 믿고 누른 키가 딴 일을 한다
eq([keyHint('rename', MAC), keyHint('rename', WIN), keyHint('open', MAC), keyHint('open', WIN), keyHint('delete', WIN), keyHint('newFolder', MAC)],
  ['↩', 'F2', '⌘O', 'Enter', 'Delete', '⇧⌘N'], 'K 메뉴 표시가 두 표와 맞는다');
eq([isMacPlatform({ platform: 'MacIntel' }), isMacPlatform({ platform: 'Win32' }), isMacPlatform({ platform: '', userAgent: 'iPad' }), isMacPlatform({})],
  [true, false, true, false], 'K 플랫폼 판정(iPad=맥 문법 · 모름=윈도 문법)');

// ── N. 방향키 다음 칸 ──
eq([navIndex(10, 4, -1, 'down'), navIndex(10, 4, -1, 'right'), navIndex(10, 4, -1, 'first')], [0, 0, 0], 'N1 안 골랐을 때 ↓·→·처음 = 첫 칸');
eq([navIndex(10, 4, -1, 'up'), navIndex(10, 4, -1, 'left'), navIndex(10, 4, -1, 'last')], [9, 9, 9], 'N2 안 골랐을 때 ↑·←·끝 = 끝 칸');
eq([navIndex(5, 1, 2, 'left'), navIndex(5, 1, 2, 'right')], [2, 2], 'N3 목록 ←→ 제자리');
eq([navIndex(5, 1, 0, 'up'), navIndex(5, 1, 4, 'down'), navIndex(5, 1, 2, 'down')], [0, 4, 3], 'N4 목록 ↑↓ 끝에선 제자리');
eq(navIndex(10, 4, 1, 'down'), 5, 'N5 격자 ↓ = 한 줄 아래');
eq(navIndex(10, 4, 7, 'down'), 9, 'N6 격자 ↓ 아래가 비었고 다음 줄 있음 = 마지막 칸');
eq(navIndex(10, 4, 9, 'down'), 9, 'N7 격자 ↓ 이미 마지막 줄 = 제자리');
eq(navIndex(10, 4, 8, 'down'), 8, 'N7 경계: 마지막 줄 첫 칸 ↓ = 제자리');
eq(navIndex(10, 4, 3, 'up'), 3, 'N8 격자 ↑ 첫 줄 = 제자리');
eq(navIndex(10, 4, 6, 'up'), 2, 'N8 대조: 격자 ↑ = 한 줄 위');
eq([navIndex(10, 4, 0, 'left'), navIndex(10, 4, 9, 'right'), navIndex(10, 4, 4, 'left')], [0, 9, 3], 'N9 ← 맨 앞·→ 맨 끝 제자리 · 줄 넘어 ← 는 윗줄 끝');
eq(navIndex(0, 4, -1, 'down'), -1, 'N10 빈 목록 = -1');
eq([navIndex(5, 0, 1, 'down'), navIndex(5, 2.7, 0, 'down')], [2, 2], 'N11 cols 0 은 1, 소수는 내림');

// ── T. 타이핑 고르기 ──
const names = ['docs', 'readme.md', 'Report.pdf', '보고서.txt', '사진.png', 'ㅂ메모.txt'];
eq(typeSelect(names, 'rea'), 1, 'T1 첫머리 그대로');
eq(typeSelect(names, 'REP'), 2, 'T2 대소문자 무시');
eq(typeSelect(names, 'ㅅ'), 4, 'T3 초성 ㅅ → 사진');
eq(typeSelect(names, 'q', 'ㅂ'), 3, 'T4 한글 입력기 꺼진 채 q(자판 ㅂ) → 보고서');
eq(typeSelect(names, 'ㅂ'), 5, 'T5 글자 그대로 맞는 것(ㅂ메모)이 초성(보고서)보다 먼저');
eq([typeSelect(names, 'zz', 'ㅋㅋ'), typeSelect(names, '')], [-1, -1], 'T6 없으면 -1 · 빈 버퍼 -1');
eq(typeSelect(names, '보ㄱ'), 3, 'T7 조합 섞인 버퍼(보ㄱ) → 보고서');

// ── Y. 복사본 이름 ──
eq(copyName('a.txt', new Set(['a.txt']), MAC, false), 'a 복사본.txt', 'Y1 맥 복사본');
eq(copyName('a.txt', new Set(['a.txt', 'a 복사본.txt']), MAC, false), 'a 복사본 2.txt', 'Y2 맥 겹치면 번호');
eq([copyName('a.txt', new Set(['a.txt']), WIN, false), copyName('a.txt', new Set(['a - 복사본.txt']), WIN, false)], ['a - 복사본.txt', 'a - 복사본 (2).txt'], 'Y3 윈도 복사본 · (2)');
eq(copyName('v1.2', new Set(), MAC, true), 'v1.2 복사본', 'Y4 폴더 이름은 점으로 자르지 않는다');
eq(copyName('.env', new Set(), MAC, false), '.env 복사본', 'Y5 점으로 시작하는 이름은 확장자가 아니다');

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
