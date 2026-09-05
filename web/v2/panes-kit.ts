// v2/panes-kit.ts — 곁칸 부품들이 함께 쓰는 **잎 도구**(#1819 분할). 의존은 core 한 방향뿐이라 순환이 없다.
//  여기 사는 것: 아이콘 · 인증 헤더 · 파일 종류 판정(미리보기 방식) · 이름 겹침 회피 · 그 자리 우클릭 메뉴.
//  부품 자신(세션·자료·지식…)은 panes-parts.ts / panes-files.ts 에 산다.
import { TOKEN_KEY, el, sv } from '../core.js';
import { EMBEDDED } from './embed.js';
import { tabNum, type TabKey } from '../lib/tab-key.js';

// ── 아이콘(스트로크 SVG) ──────────────────────────────────────────────────────
const ICON_PATHS: Record<string, string> = {
  chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  task: '<path d="M4 6h12M4 12h12M4 18h8"/><path d="M19 5l2 2-4 4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
  img: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  send: '<path d="M4 12l16-8-6 16-2-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  rows: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2L5.6 5.6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  cols: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/>',
  drop: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>',
  up: '<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M5 5h14"/>',
  box: '<path d="M3 7h18v4H3z"/><path d="M5 11v8h14v-8"/><path d="M10 15h4"/>',
  undo: '<path d="M4 9h11a5 5 0 0 1 0 10h-6"/><path d="M8 5L4 9l4 4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
  pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14 6l4 4"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
  // 프로젝트(#2116) — 사이드바·앱 목록이 쓰는 것과 **같은 그림**(v2/icons.ts ICONS.proj). 두 곳이 다른 프로젝트
  //  아이콘을 쓰면 같은 것을 가리키는지 사람이 알 수 없다. 여기 사본을 두는 건 pn-i 계열 크기·선굵기를 따르기 위해서다.
  proj: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/><path d="M8 10v4"/><path d="M12 10v2"/><path d="M16 10v6"/>',
  // #2116 공유 — 사람 + 더하기(구글 문서의 [공유]와 같은 뜻). 자물쇠가 아니다: 이 단추가 하는 일은 '잠그기'가 아니라 '부르기'다.
  share: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M18 8v6M15 11h6"/>',
  folderup: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 18v-6"/><path d="M9.4 14.4L12 11.8l2.6 2.6"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M9 4v5h6V4"/><path d="M8 20v-6h8v6"/>',
  ext: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
export function pnIcon(name: string, cls = 'pn-i'): SVGElement {
  const s = sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' });
  s.innerHTML = ICON_PATHS[name] || ICON_PATHS.doc;
  return s;
}


export const authHeaders = (): Record<string, string> => {
  const t = ((): string => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } })();
  return t ? { authorization: 'Bearer ' + t } : {};
};

// ══ 자료 — 공유 폴더에 쌓인 것. 끌어다 놓으면 올라간다 ═══════════════════════════
export type FileItem = { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: number; empty?: boolean };
export const MACHINE_FILES = new Set(['CLAUDE.md', 'AGENTS.md', '.DS_Store', 'package-lock.json', 'yarn.lock']);
export const NOISE_RE = /\/(__pycache__|node_modules|dist|build|\.next|coverage|venv)\//;
export const TRASH_DIR = '휴지통';
const isImg = (n: string): boolean => /\.(png|jpe?g|gif|webp|svg)$/i.test(n);
// 아이콘이 아니라 **내용이 보이게**(원준 2026-08-20) — kind 가 미리보기 방식을 정한다.
//  img=그대로 · pdf/page=축소해 실제로 렌더 · text=앞부분을 글자로 · video=첫 프레임 · file=아이콘(렌더할 방법이 없는 것들).
const TEXTY = /\.(md|markdown|txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|env|sql|sh|bash|zsh|ps1|py|rb|go|rs|java|kt|swift|c|h|cpp|cc|hpp|cs|php|pl|lua|r|ts|tsx|js|jsx|mjs|cjs|css|scss|less|xml|svg|gitignore|dockerfile|makefile)$/i;
export function kindOf(p: string): { kind: string; type: string } {
  if (isImg(p)) return { kind: 'img', type: '그림' };
  if (/\.pdf$/i.test(p)) return { kind: 'pdf', type: 'PDF' };
  if (/\.html?$/i.test(p)) return { kind: 'page', type: '시안' };
  if (/\.(mp4|webm|mov|m4v)$/i.test(p)) return { kind: 'video', type: '영상' };
  if (/\.(md|markdown|txt)$/i.test(p)) return { kind: 'text', type: '문서' };
  if (/\.(csv|tsv)$/i.test(p)) return { kind: 'text', type: '표' };
  if (/\.xlsx?$/i.test(p)) return { kind: 'file', type: '표' };
  if (/\.(pptx?|key)$/i.test(p)) return { kind: 'file', type: '장표' };
  if (/\.docx?$|\.hwpx?$/i.test(p)) return { kind: 'file', type: '문서' };
  if (/\.(zip|tar|gz|7z|rar)$/i.test(p)) return { kind: 'file', type: '묶음' };
  if (TEXTY.test(p)) return { kind: 'text', type: '코드' };
  return { kind: 'file', type: '파일' };
}
// 미리보기는 **작은 종이 한 장**(300×246)을 만들어 카드 크기에 맞춰 줄인다 — 글자·표가 뭉개지지 않고 비율이 산다.
export const PV_W = 300;   // 글 미리보기의 종이 폭 — 이 폭에서 글자가 읽을 만한 크기로 앉는다
/** 시안(HTML)의 종이 폭 (#762, 원준 2026-09-04: "엄청 확대된 게 썸네일에 보여서 있으나 마나").
 *  ⚠ 300px 짜리 창에 데스크톱용 페이지를 넣으면 그 페이지의 **왼쪽 300px 조각**만 보인다 — 축소가
 *   아니라 확대로 읽힌다. 논리 폭을 데스크톱만큼 주고 카드 크기로 줄여야 **한 장이 통째로** 들어온다. */
export const PV_PAGE_W = 1180;
export const PV_MAX = { pdf: 12e6, page: 4e6, text: 512e3, img: 24e6, video: 80e6 } as Record<string, number>;

// ── 보기 설정(맥 파인더 문법) — 브라우저에 기억한다. 칸마다 따로 두지 않는다(한 사람의 한 습관이다). ──
export const FV_VIEW = 'lively_pn_files_view';    // 'icon' | 'list'
export const FV_SIZE = 'lively_pn_files_iconsz';  // 아이콘 한 변(px) — 파인더의 크기 슬라이더
export const FV_SORT = 'lively_pn_files_sort';    // '<key>:<asc|desc>'
export const FV_NOTE = 'lively_pn_files_note';    // '0' = 맨 위 안내를 접어 둠
export type SortKey = 'name' | 'kind' | 'size' | 'date';
export const ICON_STEPS = [64, 84, 110, 148, 196];
export const SORT_LABEL: Record<SortKey, string> = { name: '이름', kind: '종류', size: '크기', date: '날짜' };
export const lsGet = (k: string, d: string): string => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
export const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* 사파리 사생활 모드 등 — 기억만 못 할 뿐 */ } };

/** 붙여넣기·새 폴더가 쓰는 이름 — 같은 폴더에 이미 있으면 '이름 2' 로 번호를 올린다(파인더와 같은 규칙). */
export function freeName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 500; i++) { const c = `${stem} ${i}${ext}`; if (!taken.has(c)) return c; }
  return `${stem} ${Date.now()}${ext}`;
}
export const stamp = (): string => {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 그 자리에 뜨는 작은 메뉴(우클릭). 밖을 누르거나 Esc 면 닫힌다. */
export function ctxMenu(x: number, y: number, rows: Array<{ label: string; run?: () => void; danger?: boolean; sep?: boolean; off?: boolean }>): void {
  document.querySelector('.pn-ctx')?.remove();
  const menu = el('div', { class: 'pn-ctx', role: 'menu' }) as HTMLElement;
  const close = (): void => { menu.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
  const away = (e: Event): void => { if (!menu.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  for (const r of rows) {
    if (r.sep) { menu.append(el('div', { class: 'pn-ctx-sep' })); continue; }
    const b = el('button', { class: 'pn-ctx-i' + (r.danger ? ' danger' : ''), type: 'button', text: r.label }) as HTMLButtonElement;
    if (r.off) b.disabled = true;
    else b.onclick = () => { close(); r.run?.(); };
    menu.append(b);
  }
  document.body.append(menu);
  // 화면 밖으로 나가지 않게 — 오른쪽·아래 끝에서 뒤집는다(좁은 곁칸에서 우클릭하면 늘 걸린다).
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', esc, true);
}


/** 붙여넣은 파일에 사람이 알아볼 이름을 준다 — 브라우저가 주는 'image.png' 는 누구의 것인지 말해 주지 않는다.
 *  ⚠ 확장자는 **이름을 갈아끼울 때만** MIME 에서 만든다. 원래 이름의 확장자 유무로 판단하면 'image.png' 처럼
 *   확장자는 있는데 이름을 버리는 경우에 확장자까지 같이 사라진다(실측: '붙여넣은 그림 20260820-194421' 로
 *   저장돼 그림으로 인식되지 않아 미리보기가 안 떴다). */
export function attachName(f: File, taken: string[]): string {
  const raw = String(f.name || '').split(/[/\\]/).pop() || '';
  const keep = !!raw && raw !== 'image.png' && raw !== 'blob';
  if (keep) return freeName(new Set(taken), raw);
  const sub = (f.type || '').split('/')[1] || 'png';
  const ext = (sub.split('+')[0].replace(/[^a-z0-9]/gi, '') || 'png').toLowerCase();   // image/svg+xml → svg
  return freeName(new Set(taken), `붙여넣은 그림 ${stamp()}.${ext}`);
}

// ── 칸 머리의 안내 한 줄 (#1819) ─────────────────────────────────────────────
//  칸이 "무엇을 담는 곳인지"가 아니라 **그래서 나에게 무슨 이득인지**를 말한다. 자료·지식처럼 계약이
//  눈에 안 보이는 칸은 이걸 모르면 덜 쓰게 된다(자료를 '이 세션 첨부'로 오해해 딱 한 개만 올리는 식).
//  접으면 그 선택을 기억한다 — 한 번 읽은 사람에게 같은 문장을 계속 보일 이유는 없다.
export function pnNote(key: string, text: string): HTMLElement {
  const note = el('div', { class: 'pn-fnote' },
    pnIcon('spark', 'pn-i sm'),
    el('p', { text }),
    el('button', {
      class: 'pn-fnote-x', type: 'button', title: '안내 접기', 'aria-label': '안내 접기', text: '✕',
      onclick: () => { lsSet(key, '0'); note.hidden = true; },
    })) as HTMLElement;
  note.hidden = lsGet(key, '1') === '0';
  return note;
}

// ── 지식 제목을 사람이 한눈에 읽는 한 줄로 (#1819) ───────────────────────────
//  위키 제목은 「짧은 이름 — 긴 설명」 규약을 따른다(실측: 표본 18건 중 15건이 ' — ' 를 가졌고 앞머리는
//  11~44자). 곁칸은 폭이 300px 남짓이라 전문을 그대로 걸면 슬러그처럼 읽히는 글자 덩어리가 된다.
//  그래서 **앞머리만** 남기고 이슈번호 같은 기계용 표식을 턴다. 전문은 title 속성과 상세 창이 갖는다.
//  ⚠ 저장된 제목을 바꾸지 않는다 — 화면에서만 줄인다(위키·검색·외부 미러의 정본은 그대로여야 한다).
export function knTitle(raw: string, name: string): string {
  let t = String(raw || '').trim();
  if (!t) t = String(name || '').replace(/[-_]+/g, ' ');       // 제목이 없으면 슬러그를 말처럼 편다
  t = t.split(/\s+[—–]\s+/)[0];                                // 「이름 — 설명」의 이름만
  t = t.replace(/\(?#\d+[^)]*\)?/g, ' ');                      // (#1819) · #1819 같은 표식은 사람에게 뜻이 없다
  t = t.replace(/^(as-built|as built)\s*[::]\s*/i, '');         // 문서 종류 접두어는 아래 배지가 말한다
  t = t.replace(/\s{2,}/g, ' ').replace(/[\s·,:;]+$/, '').trim();
  return t || String(name || '');
}

// ── 폴더 아이콘 — 맥 파인더 결 (#1819 원준) ──────────────────────────────────
//  다른 아이콘은 전부 선(stroke)이지만 폴더만은 **채운 그림**이다. 자료 격자에서 폴더는 아이콘이 아니라
//  파일 미리보기와 나란히 서는 한 장의 그림이라, 선 하나로 그리면 옆 카드의 실제 내용에 눌려 빈 칸이 된다.
//
//  ── 그라디언트를 낮게 잡는 이유 (초판이 "조잡하다"고 반려됨, 원준 2026-08-20) ──
//   초판은 위아래 명도차를 크게 주고(밝은 하늘색→진한 파랑) 앞판 위에 곡선 광택 덩어리를 얹었다. 그 결과
//   ⓐ 색이 아래로 갈수록 탁해져 '플라스틱' 느낌이 나고 ⓑ 광택 곡선이 어디서 왔는지 모를 얼룩으로 읽혔다.
//   파인더 폴더는 사실 **명도차가 아주 작은 한 톤**이고, 빛은 앞판 윗변의 **가는 선 하나**로만 표현된다.
//   그래서 여기서도: 낮은 대비 세로 그라디언트 + 윗변 1px 하이라이트. 광택 덩어리는 없앤다.
//
//  ── 빈 폴더 / 든 폴더 (원준: "맥은 둘이 다르다") ──
//   든 폴더는 뒤판과 앞판 **사이로 서류가 비쳐 나온다**. 목록을 훑을 때 "여긴 뭔가 있다"가 열어보기 전에 읽힌다.
//   서류는 흰 종이 두 장을 살짝 어긋나게 겹쳐 그린다(각도는 고정 — 무작위면 다시 그릴 때마다 흔들린다).
//  ⚠ 그라디언트 id 는 문서에 유일해야 한다 — 같은 id 가 여러 개면 브라우저가 첫 것만 쓴다(색이 굳는다).
let folderSeq = 0;
export function folderIcon(cls = 'pn-folder', opts?: { empty?: boolean; plain?: boolean }): SVGElement {
  const n = ++folderSeq;
  const back = `pnf-b${n}`, front = `pnf-f${n}`;
  const papers = !opts?.empty && !opts?.plain;
  const svg = sv('svg', { viewBox: '0 0 48 40', class: cls, 'aria-hidden': 'true' });
  svg.innerHTML = `<defs>
      <linearGradient id="${back}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8AC4F2"/><stop offset="1" stop-color="#6FB0E8"/>
      </linearGradient>
      <linearGradient id="${front}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#A6D6F8"/><stop offset="1" stop-color="#7CBBEF"/>
      </linearGradient>
    </defs>
    <path d="M2 9.6A3.6 3.6 0 0 1 5.6 6h11.5c.97 0 1.9.39 2.58 1.08l2.5 2.52H42.4A3.6 3.6 0 0 1 46 13.2v20.2a3.6 3.6 0 0 1-3.6 3.6H5.6A3.6 3.6 0 0 1 2 33.4z" fill="url(#${back})"/>
    ${papers ? `<g>
      <rect x="18.6" y="8.2" width="14.5" height="11" rx="1.5" fill="#EDF3FA" stroke="#D3E1F0" stroke-width=".6" transform="rotate(-6 25.8 13.7)"/>
      <rect x="26" y="9.2" width="14.5" height="11" rx="1.5" fill="#FFFFFF" stroke="#DAE5F3" stroke-width=".6" transform="rotate(5 33.2 14.7)"/>
    </g>` : ''}
    <path d="M2 17.6A3.6 3.6 0 0 1 5.6 14h36.8a3.6 3.6 0 0 1 3.6 3.6v15.8a3.6 3.6 0 0 1-3.6 3.6H5.6A3.6 3.6 0 0 1 2 33.4z" fill="url(#${front})"/>
    <path d="M5.9 14.75h36.2" stroke="#FFFFFF" stroke-opacity=".5" stroke-width="1.1" stroke-linecap="round" fill="none"/>`;
  return svg;
}

// ══ 뷰어 칸에 파일 펴기 — 자료 칸과 뷰어를 잇는 한 통로 (#762) ═══════════════════
/** 이 곁칸의 뷰어에 대고 쏘는 신호. ⚠ window 금지 — 문서 전체로 뿌리면 열려 있는 **모든 세션 탭**의
 *  뷰어가 같은 파일로 갈아입고 각자 자기 열쇠에 그걸 기억한다(pane-signal-scope-and-embed-isolation-1819). */
export const VIEWER_EVT = 'pn-viewer-open';
/** **배달** — 셸이 «어느 뷰어에 펼지» 정한 뒤 그 탭 앞으로 보내는 신호(#762). 요청(VIEWER_EVT)과 이름이
 *  달라야 한다: 같으면 셸이 자기 신호를 되받아 무한고리가 된다. 뷰어는 이 신호만 듣는다. */
export const VIEWER_TO_EVT = 'pn-viewer-to';
/** 어떤 파일을 펴 두었나 — 세션마다 따로(곁칸 부품은 그 세션의 것). */
export const ED_PATH_KEY = 'pn_ed_path';
/** 그 부품 인스턴스의 저장 열쇠 — 첫 탭은 세션 열쇠 **그대로**(옛 기억을 그대로 물려받는다),
 *  둘째부터 `#n` 이 붙는다. 두 뷰어가 각자 다른 파일을 펴 두려면 기억도 탭마다 갈라져야 한다(#762). */
export const slotStoreKey = (mem: string, slot: TabKey): string => (tabNum(slot) >= 2 ? mem + '#' + tabNum(slot) : mem);

/** 어느 탭에 펴 둘지 셸이 정한 뒤, 그 탭의 열쇠에 적는다 — 새로 만들어진 뷰어는 신호를 이미 놓친 뒤라
 *  저장된 값에서 읽기 때문이다(웹 칸의 openInWebPart 와 같은 규칙). */
export function rememberViewerPath(mem: string, slot: TabKey, path: string): void {
  if (EMBEDDED) return;                 // 끼워 넣은 판 — 바깥 사람이 펴 둔 파일을 덮어쓰지 않는다
  try {
    const m = JSON.parse(localStorage.getItem(ED_PATH_KEY) || '{}') || {};
    m[slotStoreKey(mem, slot)] = String(path || '');
    localStorage.setItem(ED_PATH_KEY, JSON.stringify(m));
  } catch (_) { /* 저장이 막혀도 알림으로 지금 떠 있는 칸은 바뀐다 */ }
}

/** 밖(자료 칸)에서 뷰어에 파일을 펴는 **유일한 통로** — 뷰어 칸이 없으면 셸(panes.ts)이 듣고 곁칸에 만든다.
 *  ⚠ **어느 뷰어에 펼지는 셸이 정한다**(#762): 뷰어가 여럿 뜰 수 있게 되면서, 부르는 쪽이 고를 수 있는 것은
 *   «지금 보던 뷰어에» 인가 «새 탭에» 인가 둘뿐이다. 그 판정과 저장(rememberViewerPath)은 셸이 한다 —
 *   부르는 쪽은 탭이 몇 개인지도, 어느 것이 켜져 있는지도 모른다. */
export function openInViewerPart(ctx: { id: number; paneRoot: () => HTMLElement }, path: string, opts?: { newTab?: boolean }): void {
  const p = String(path || '');
  if (!p) return;
  ctx.paneRoot().dispatchEvent(new CustomEvent(VIEWER_EVT, { detail: { id: ctx.id, path: p, newTab: !!opts?.newTab } }));
}
