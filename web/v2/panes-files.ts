// v2/panes-files.ts — 곁칸의 **자료** 부품(#1819). 프로젝트 공유 폴더를 맥 파인더 문법으로 다룬다.
//
//  왜 파인더를 베끼나 — 이 칸은 '파일이 든 폴더'다. 사람이 파일을 다룰 때 이미 아는 몸짓(더블클릭으로 열기,
//  ⌘/⇧ 클릭으로 골라 담기, 빈 자리를 끌어 사각형 선택, 폴더에 끌어다 넣기, 우클릭 메뉴, 보기·정렬 바꾸기)을
//  그대로 쓰면 배울 것이 없다. 없던 시절엔 자료가 스무 개만 넘어도 한 장짜리 격자에서 길을 잃었다(원준 신고).
//
//  #3870(원준 2026-09-30 «맥이랑 윈도우의 Finder나 파일탐색기 수준으로»): 키보드도 그 문법이다 — 키 판정은 lib/finder-keys.ts
//   한 자리(맥 ↩ = 이름 바꾸기 · 윈도 Enter = 열기 같은 두 표). 여기엔 그 판정이 부르는 **일**만 있다: 방향키 고르기 ·
//   타이핑으로 고르기 · 위 폴더/뒤로/앞으로 · 복사·잘라내기·붙여넣기·복제 · 되돌리기 · 빠른 보기 · 선택한 이름 한 번 더 누르기.
//
//  계약(panes-parts.ts 의 Part 와 같다): root 를 칸 본문에 붙이고, tick() 은 8초마다, destroy() 는 정리.
//  ⚠ tick 은 **서명이 같으면 아무것도 하지 않는다** — 선택·스크롤·미리보기를 8초마다 날리면 쓸 수 없는 칸이 된다.
import { api, apiUrl, el, relTime, toast } from '../core.js';
import { fmtSize } from '../projects/files.js';
import { confirmDialog } from '../ui-primitives.js';
import { authDownload, upDirSupported, upDropZone, upFromInput, upSend, upToast, type UpItem } from '../projects/files-upload.js';
import { openInViewerPart, FV_NOTE, FV_SIZE, FV_SORT, FV_VIEW, ICON_STEPS, MACHINE_FILES, NOISE_RE, SORT_LABEL, TRASH_DIR, attachName, authHeaders, ctxMenu, folderIcon, freeName, kindOf, lsGet, lsSet, pnIcon, stamp, type FileItem, type SortKey } from './panes-kit.js';
import { findMatcher } from '../lib/find.js';
import { copyName, finderKey, isMacPlatform, keyHint, navIndex, typeChar, typeSelect, type FinderAction } from '../lib/finder-keys.js';
import { createPreviewKit } from './file-preview.js';
import { placeChildren, reuseKeyed, type KeyedCard } from './keyed-cards.js';   // #4135 — 제자리 되그리기(바뀐 카드만 새로)
import { showCtxMenu, type CtxRow } from './ctx-menu.js';
import type { Part, PartCtx } from './panes-parts.js';

/** 곁칸 밖에서 이 부품을 쓰는 자리(프로젝트 화면의 공유 폴더 모달, #4135)가 거는 고리 — 전부 선택 사항이라 곁칸(PartCtx)은 그대로 들어온다.
 *  같은 폴더를 보여 주는 화면이 둘이면 그림도 몸짓도 같아야 한다(원준 2026-09-27: «곁칸이랑 같은 디자인으로») — 그래서 베끼지 않고 이 부품을 그대로 세운다. */
export interface FilesHooks {
  /** 처음 열 폴더(프로젝트 루트 기준 상대경로). */
  startDir?: string;
  /** 파일 열기를 가로챈다 — 없으면 곁칸 뷰어로 보낸다(openInViewerPart). */
  openFile?: (f: FileItem) => void;
  /** 폴더 · 목록 · 고른 것이 바뀔 때마다(그린 뒤). 옆에 «고른 파일» 칸을 세우는 자리가 쓴다. */
  onState?: (s: { cwd: string; items: FileItem[]; selected: FileItem[] }) => void;
  /** 목록이 실제로 달라졌다(올리기 · 삭제 · 이동 · 이름) — 밖의 캐시를 버릴 때. */
  onFiles?: () => void;
  /** 항목 우클릭 메뉴에 더할 행(「열기」 묶음 바로 아래). */
  extraRows?: (f: FileItem, many: FileItem[]) => CtxRow[];
  /** 맨 위 안내 줄을 세우지 않는다(이미 같은 말을 하는 자리). */
  noNote?: boolean;
  /** 경로 줄 첫 조각의 이름(기본 «자료»). */
  rootLabel?: string;
}
export type FilesCtx = Pick<PartCtx, 'id' | 'dead'> & { paneRoot?: PartCtx['paneRoot'] } & FilesHooks;
/** 곁칸 안에 선 것인가 — 그때만 곁칸 뷰어로 보낸다(밖에 선 자리는 openFile 고리를 준다). */
const hasPane = (c: FilesCtx): c is FilesCtx & { paneRoot: PartCtx['paneRoot'] } => typeof c.paneRoot === 'function';

// ── 페이지에 하나인 것 — 칸을 닫았다 열어도 남아야 하는 것들 ─────────────────────────────
//  마지막으로 받은 폴더 목록(프로젝트·폴더별) — 다시 열면 **먼저 그린 뒤** 새로 받아 맞춘다. 파인더도 폴더를 다시 열 때
//   기다리게 하지 않는다(실측: 목록 한 번에 0.3~0.5초 — 칸을 열 때마다 빈 칸으로 그만큼 서 있었다).
const LIST_CACHE = new Map<string, FileItem[]>();
//  파일 클립보드 — 운영체제 클립보드는 웹에서 «파일»을 못 담으므로 이 페이지가 쥔다. 곁칸이 여럿이어도 하나(한 사람의 ⌘C 는 하나다).
//  marker = 복사할 때 운영체제 클립보드에 함께 적은 글(이름 목록). ⌘V 때 운영체제 클립보드가 **아직 그 글이면** 이 파일들을,
//   그새 딴 것(그림·글)을 복사했으면 그것을 붙인다 — «마지막에 복사한 것이 붙는다» 는 운영체제 약속을 지킨다.
type ClipItem = { path: string; name: string; type: 'dir' | 'file'; size: number };
let FILE_CLIP: { mode: 'copy' | 'cut'; pid: number; items: ClipItem[]; marker: string; osOk: boolean } | null = null;
const MAC = isMacPlatform();
const COPY_MAX_FILES = 500, COPY_MAX_BYTES = 300 * 1024 * 1024;
const SIZE_LABEL = ['가장 작게', '작게', '보통', '크게', '가장 크게'];

export function filesPart(ctx: FilesCtx): Part {
  const root = el('div', { class: 'pn-part pn-files', tabindex: '0', 'aria-label': '자료 — 방향키로 고르고 ' + (MAC ? '⌘O' : 'Enter') + '로 엽니다' }) as HTMLElement;
  const body = el('div', { class: 'pn-fbody' });          // 격자 또는 목록이 사는 자리(스크롤 주체)
  const crumbs = el('div', { class: 'pn-fcrumbs' });
  const count = el('span', { class: 'pn-fine', text: '' });
  let sig = '';

  // ── 상태 ──
  let cwd = String(ctx.startDir || '').replace(/^\/+|\/+$/g, '');   // 지금 보는 폴더(프로젝트 루트 기준 상대경로)
  let items: FileItem[] = [];                   // 지금 폴더의 것들(받은 그대로)
  //  찾기용 **평평한 전체 목록**(매니페스트) — 폴더를 열어 보지 않고도 이름으로 닿을 수 있어야 찾기다.
  //  ⚠ 목록 화면의 정본은 items 다. 이건 찾는 중에만 쓴다(전체를 늘 그리면 폴더 구조가 뜻을 잃는다).
  let allFiles: FileItem[] = [];
  let allAt = 0;                                //  매니페스트를 받은 시각 — 찾는 중이 아니면 틱마다 부르지 않는다(아래 load)
  //  화면에 실제로 그려진 순서. ⇧클릭 범위·⌘A 는 **눈에 보이는 순서**를 따라야 하므로 items 가 아니라 이걸 본다.
  //  ⚠ 정렬은 render 가 한다(load 가 아니라) — load 에서만 정렬하면 정렬을 바꿔도 다음 폴링(8초)까지 그대로다(실측).
  let ordered: FileItem[] = [];
  const sel = new Set<string>();                // 선택된 상대경로
  let anchorPath: string | null = null;         // ⇧클릭·⇧방향키 범위의 기준
  let leadPath: string | null = null;           // 방향키가 움직이는 «지금 칸»(범위의 반대 끝)
  let renameAt: string | null = null;           // 지금 이름을 고치는 중인 항목(제자리 편집, 파인더 문법)
  let selectAfter: string[] | null = null;      // 다음 그리기에서 고를 경로(새로 만든 것·방금 나온 폴더)
  let revealNext = false;                       // 그걸 골랐으면 한 번 보이는 자리로 굴린다
  let view = lsGet(FV_VIEW, 'icon') === 'list' ? 'list' : 'icon';
  let iconSz = Math.max(ICON_STEPS[0], Math.min(ICON_STEPS[ICON_STEPS.length - 1], Number(lsGet(FV_SIZE, '110')) || 110));
  let sortKey = (lsGet(FV_SORT, 'date:desc').split(':')[0] as SortKey) || 'date';
  let sortAsc = lsGet(FV_SORT, 'date:desc').split(':')[1] === 'asc';
  if (!SORT_LABEL[sortKey]) sortKey = 'date';
  //  뒤로·앞으로(⌘[ ⌘] · Alt+← Alt+→ · 마우스 옆 단추) — 이 칸 안에서 다닌 폴더.
  const backStack: string[] = [], fwdStack: string[] = [];
  //  되돌리기(⌘Z) — 이 칸에서 한 일. run 이 없는 줄은 «되돌리지 않는 일»의 표시다(삭제·올리기): 그걸 건너뛰고
  //   그 전의 일을 되돌리면 사람이 기대한 것(방금 한 일)과 다른 것이 바뀐다.
  const undos: Array<{ label: string; run?: () => Promise<void>; why?: string }> = [];
  const pushUndo = (label: string, run?: () => Promise<void>, why?: string): void => { undos.push({ label, run, why }); if (undos.length > 40) undos.shift(); };

  // ── 찾기 (#762, 원준 2026-09-04 "자료 위젯에서 검색 기능도 필요할 거 같음") ─────────────────
  //  잣대는 사이드바·타임라인과 **같은 것**(lib/find.ts) — 띄어쓰기 무시 · 낱말 순서 무관 · 초성.
  //  ⚠ 찾는 중에는 **지금 폴더 안**이 아니라 이 프로젝트 자료 **전체**를 본다: 파일이 어느 폴더에 있는지
  //   기억나지 않아 찾는 것이므로, 폴더를 하나씩 열어 보게 하면 찾기가 아니다. 그래서 결과 행에 경로를 함께 보인다.
  //  ⚠ 한글 조합 중에는 다시 그리지 않는다(사이드바와 같은 규율 #1958) — 매 글자 재렌더가 조합을 끊는다.
  let query = '';
  const findIn = el('input', { class: 'pn-ffind', type: 'search', placeholder: '자료 찾기', 'aria-label': '자료에서 찾기 (' + keyHint('find', MAC) + ')' }) as HTMLInputElement;
  let composing = false;
  const onFind = (): void => {
    query = findIn.value;
    if (query.trim() && Date.now() - allAt > 8000) void loadAll().then(() => { if (!ctx.dead() && query.trim()) render(); });
    render();
  };
  findIn.addEventListener('compositionstart', () => { composing = true; });
  findIn.addEventListener('compositionend', () => { composing = false; onFind(); });
  findIn.addEventListener('input', () => { if (!composing) onFind(); });
  findIn.addEventListener('focus', () => { if (Date.now() - allAt > 8000) void loadAll(); });   // 치기 전에 재료를 미리
  findIn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (composing || e.isComposing) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); findIn.value = ''; onFind(); root.focus({ preventScroll: true }); return; }
    //  ↓ — 결과로 내려간다(첫 칸을 골라 둔다). 찾은 뒤 손을 마우스로 옮기지 않아도 연다.
    if (e.key === 'ArrowDown' && ordered.length) { e.preventDefault(); e.stopPropagation(); selectOnly(ordered[0].path); root.focus({ preventScroll: true }); }
  });

  const rel = (name: string): string => (cwd ? cwd + '/' + name : name);
  //  손가락 기기(hover 없음 · coarse) — 판정은 **포인터**로, 폭으로 하지 않는다(iPad+트랙패드·미리보기 프레임은 마우스다).
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)');
  const selItems = (): FileItem[] => ordered.filter((f) => sel.has(f.path));
  const dirOf = (p2: string): string => (p2.includes('/') ? p2.slice(0, p2.lastIndexOf('/')) : '');
  const baseOf = (p2: string): string => p2.slice(p2.lastIndexOf('/') + 1);
  const errMsg = (e: any): string => String(e?.message || e || '');

  // ── 맨 위 안내 — 이 칸이 무엇인지 한 줄로. 접어 둘 수 있고, 그 선택은 기억한다. ──
  //  왜 두나: 자료를 '이 세션에 첨부하는 것'으로 오해하면 딱 필요한 파일 하나만 올린다. 실제 계약은 그 반대라
  //  (프로젝트의 모든 세션이 여기를 읽는다) 많이 올릴수록 이득이라는 걸 올리기 전에 알려야 한다.
  const noteEl = el('div', { class: 'pn-fnote' },
    pnIcon('spark', 'pn-i sm'),
    el('p', { text: '여기 있는 자료는 이 프로젝트의 모든 세션이 자동으로 참고합니다. 관련 자료를 넉넉히 올려 둘수록 답이 좋아져요.' }),
    el('button', { class: 'pn-fnote-x', type: 'button', title: '안내 접기', 'aria-label': '안내 접기', text: '✕', onclick: () => { lsSet(FV_NOTE, '0'); noteEl.hidden = true; } }));
  noteEl.hidden = !!ctx.noNote || lsGet(FV_NOTE, '1') === '0';

  // ── 올리기 — 파일 **또는 폴더** (#1819 원준) ─────────────────────────────────
  //  끌어다 놓는 길은 처음부터 폴더를 받았는데(upDropZone → 하위 구조 그대로), 버튼 길만 파일 전용이었다.
  //  폴더 입력은 webkitRelativePath 로 하위 경로를 들고 오므로(upFromInput) 구조가 그대로 올라간다.
  const upIn = el('input', { type: 'file', multiple: 'true', hidden: true }) as HTMLInputElement;
  const upDirIn = el('input', { type: 'file', multiple: 'true', webkitdirectory: '', hidden: true }) as HTMLInputElement;
  upIn.addEventListener('change', () => { const list = upFromInput(upIn); upIn.value = ''; void upload(list.map((u) => ({ file: u.file, rel: rel(u.rel) }))); });
  upDirIn.addEventListener('change', () => { const list = upFromInput(upDirIn); upDirIn.value = ''; void upload(list.map((u) => ({ file: u.file, rel: rel(u.rel) }))); });
  // ── 올리기 단추는 **한 덩이, 두 입구**(분할 단추) (#3870, 원준 2026-09-30 «폴더 올리기 버튼은 따로있는데 이게 최선이야?») ──
  //  브라우저는 한 창에서 파일과 폴더를 같이 고르게 해주지 않는다(`<input type=file>` 은 파일만, `webkitdirectory` 는 폴더만,
  //   File System Access API 도 showOpenFilePicker/showDirectoryPicker 로 갈려 있다). 그래서 입구는 둘일 수밖에 없다.
  //  지나온 두 판: #781 메뉴 하나(파일 올리기에 클릭이 하나 더 붙었다 — 원준 2026-08-20 "드롭다운으로 나누지 말고") →
  //   단추 옆 폴더 아이콘(«따로 있는» 낯선 아이콘 하나가 옆 [새 폴더]와 헷갈렸다 — 이번 신고).
  //  이번 판: [＋ 올리기 ⌄] 한 덩이. 큰 쪽을 누르면 곧바로 파일 창(가장 흔한 일은 여전히 한 번), 작은 ⌄ 를 누르면
  //   «파일 / 폴더» 가 뜬다(구글 드라이브·원드라이브·깃허브의 같은 자리). 폴더 입력을 못 받치는 브라우저면 ⌄ 를 숨긴다.

  // ── 머리 — 경로 / 개수 / 도구 ──
  const upBtn = el('button', { class: 'btn-text pn-up-main', type: 'button', text: '＋ 올리기', title: '컴퓨터에서 파일을 고릅니다 — 폴더째 올리려면 옆 ⌄ 를 누르세요', onclick: () => upIn.click() });
  const upCar = el('button', { class: 'btn-text pn-up-car', type: 'button', title: '파일 또는 폴더 올리기', 'aria-label': '올리기 방법 고르기', 'aria-haspopup': 'menu' },
    pnIcon('chevD', 'pn-i xs')) as HTMLButtonElement;
  upCar.hidden = !upDirSupported();
  const upGrp = el('span', { class: 'pn-upgrp' }, upBtn, upCar) as HTMLElement;
  const mkBtn = el('button', { class: 'btn-text pn-fmk', type: 'button', text: '새 폴더', title: '이 폴더 안에 폴더를 만듭니다 (' + keyHint('newFolder', MAC) + ')', onclick: () => void newFolder() }) as HTMLElement;
  const viewBtn = el('button', { class: 'pn-fbtn', type: 'button' }) as HTMLButtonElement;
  const sizeIn = el('input', { type: 'range', class: 'pn-fsize', min: '0', max: String(ICON_STEPS.length - 1), step: '1', title: '아이콘 크기', 'aria-label': '아이콘 크기' }) as HTMLInputElement;
  const sortBtn = el('button', { class: 'pn-fbtn wide', type: 'button', title: '정렬 순서', 'aria-haspopup': 'menu' }) as HTMLButtonElement;
  //  칸이 좁아 접힌 도구를 모아 여는 자리 — 접힌 것이 있을 때만 선다(파인더 도구막대의 » 와 같다).
  const moreBtn = el('button', { class: 'pn-fbtn pn-fmore-tools', type: 'button', title: '도구 더 보기', 'aria-label': '도구 더 보기', 'aria-haspopup': 'menu', hidden: true },
    pnIcon('more', 'pn-i sm')) as HTMLButtonElement;
  const tools = el('div', { class: 'pn-ftools' }, upGrp, mkBtn, el('span', { class: 'pn-fsp' }), findIn, viewBtn, sizeIn, sortBtn, moreBtn) as HTMLElement;
  const head = el('div', { class: 'pn-fhead' }, el('div', { class: 'pn-frow1' }, crumbs, count), tools);
  root.append(upIn, upDirIn, noteEl, head, body);

  // ── 메뉴 단추 — 다시 누르면 닫힌다(열린 메뉴는 밖을 누르는 순간 닫히므로, 방금 이 단추로 닫힌 것이면 다시 열지 않는다) ──
  let menuBy: HTMLElement | null = null, menuClosedAt = 0;
  function menuFrom(btn: HTMLElement, rows: CtxRow[]): void {
    if (menuBy === btn && performance.now() - menuClosedAt < 350) { menuBy = null; return; }
    const r = btn.getBoundingClientRect();
    btn.setAttribute('aria-expanded', 'true');
    menuBy = btn;
    showCtxMenu(r.left, r.bottom + 4, rows, { onClose: () => { btn.setAttribute('aria-expanded', 'false'); menuClosedAt = performance.now(); } });
  }
  const upRows = (): CtxRow[] => [
    { label: '파일 올리기…', icon: 'upload', run: () => upIn.click() },
    ...(upDirSupported() ? [{ label: '폴더 올리기…', icon: 'folderup', run: () => upDirIn.click() }] : []),
    { sep: true, label: '' },
    { head: true, label: '파일·폴더를 이 칸에 끌어다 놓아도 올라갑니다.' },
  ];
  upCar.onclick = () => menuFrom(upGrp, upRows());

  const setView = (v: 'icon' | 'list'): void => { if (view === v) return; view = v; lsSet(FV_VIEW, view); paintTools(); render(); };
  const setSize = (px: number): void => { iconSz = px; lsSet(FV_SIZE, String(iconSz)); sizeIn.value = String(Math.max(0, ICON_STEPS.indexOf(iconSz))); body.style.setProperty('--pn-fsz', iconSz + 'px'); };
  const setSort = (k: SortKey, asc: boolean): void => { sortKey = k; sortAsc = asc; lsSet(FV_SORT, sortKey + ':' + (sortAsc ? 'asc' : 'desc')); paintTools(); render(); };
  viewBtn.onclick = () => setView(view === 'icon' ? 'list' : 'icon');
  sizeIn.addEventListener('input', () => {
    // 다시 그리지 않는다 — 격자 폭만 바뀐다(미리보기 재요청 방지)
    setSize(ICON_STEPS[Number(sizeIn.value)] || 110);
  });
  //  정렬 — 우클릭 메뉴와 같은 엔진(키보드 ↑↓·Enter·Esc, 체크 표시). 종전엔 앵커 팝오버에 바탕을 안 줘서 뒤가 비쳤다(#3870 신고 그림).
  const sortRows = (): CtxRow[] => [
    ...(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({
      label: SORT_LABEL[k], checked: k === sortKey,
      run: () => setSort(k, k === sortKey ? sortAsc : (k === 'name' || k === 'kind')),
    })),
    { sep: true, label: '' },
    { label: '오름차순', checked: sortAsc, run: () => setSort(sortKey, true) },
    { label: '내림차순', checked: !sortAsc, run: () => setSort(sortKey, false) },
  ];
  const viewRows = (): CtxRow[] => [
    { label: '아이콘', checked: view === 'icon', run: () => setView('icon') },
    { label: '목록', checked: view === 'list', run: () => setView('list') },
  ];
  const sizeRows = (): CtxRow[] => ICON_STEPS.map((px, i) => ({ label: SIZE_LABEL[i] || String(px), checked: px === iconSz, keep: true, run: () => setSize(px) }));
  sortBtn.onclick = () => menuFrom(sortBtn, sortRows());
  moreBtn.onclick = () => {
    const rows: CtxRow[] = [];
    if (mkBtn.classList.contains('pn-fold')) rows.push({ label: '새 폴더', hint: keyHint('newFolder', MAC), run: () => void newFolder() });
    if (sortBtn.classList.contains('pn-fold')) rows.push({ label: '정렬 기준', sub: sortRows() });
    if (viewBtn.classList.contains('pn-fold')) rows.push({ label: '보기', sub: viewRows() });
    if (sizeIn.classList.contains('pn-fold') && view === 'icon') rows.push({ label: '아이콘 크기', sub: sizeRows() });
    menuFrom(moreBtn, rows);
  };
  function paintTools(): void {
    viewBtn.replaceChildren(pnIcon(view === 'icon' ? 'rows' : 'grid', 'pn-i sm'));
    viewBtn.title = view === 'icon' ? '목록으로 보기' : '아이콘으로 보기';
    viewBtn.setAttribute('aria-label', viewBtn.title);
    sizeIn.hidden = view !== 'icon';
    sizeIn.value = String(Math.max(0, ICON_STEPS.indexOf(iconSz)));
    sortBtn.replaceChildren(el('span', { text: SORT_LABEL[sortKey] }), pnIcon('chevD', 'pn-i xs'));
    sortBtn.title = '정렬 순서 — ' + SORT_LABEL[sortKey] + (sortAsc ? ' 오름차순' : ' 내림차순');
    fitTools();
  }
  // ── 도구줄은 **한 줄** — 좁아지면 덜 중요한 것부터 접는다(#3870, 원준 2026-09-30 «두 줄로 될게 아니라 덜중요한거부터 안보이게») ──
  //  접는 순서 = 덜 중요한 순서: 아이콘 크기 → 보기 → 정렬 → 새 폴더. [＋ 올리기]·찾기는 늘 남는다(찾기는 줄어들 뿐).
  //  접힌 것은 [⋯] 안에 그대로 있다(우클릭 메뉴에도 있다) — 칸이 좁다고 할 수 없는 일이 생기면 안 된다.
  //  판정은 **실제로 넘치나**(scrollWidth) — 글자 폭(정렬 이름이 «날짜»↔«종류»)·폰트가 바뀌어도 표를 고칠 일이 없다.
  const FOLD = [sizeIn, viewBtn, sortBtn, mkBtn];
  function fitTools(): void {
    if (!tools.isConnected) return;
    for (const n of FOLD) n.classList.remove('pn-fold');
    moreBtn.hidden = true;
    const over = (): boolean => tools.scrollWidth > tools.clientWidth + 1;
    if (!over()) return;
    moreBtn.hidden = false;
    for (const n of FOLD) { if (!over()) break; n.classList.add('pn-fold'); }
  }
  const toolsRO = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitTools()) : null;
  toolsRO?.observe(tools);
  paintTools();
  body.style.setProperty('--pn-fsz', iconSz + 'px');

  // ── 서버 왕복 ────────────────────────────────────────────────────────────
  const pUrl = (suffix: string, pid: number = ctx.id): string => '/api/ui/v6/projects/' + pid + suffix;
  const fileQ = (p2: string, pid: number = ctx.id): string => pUrl('/file?path=' + encodeURIComponent(p2), pid);

  async function upload(list: UpItem[], emptyDirs: string[] = []): Promise<void> {
    if (!list.length && !emptyDirs.length) return;
    if (!(ctx.id > 0)) { toast('이 화면은 프로젝트 폴더가 없어 파일을 둘 곳이 없어요.', true); return; }
    const ac = new AbortController();
    toast(`${list.length}개를 올리는 중이에요…`);
    const r = await upSend({
      items: list, emptyDirs, signal: ac.signal,
      fileUrl: (p) => fileQ(p),
      dirUrl: (d) => pUrl('/folder?path=' + encodeURIComponent(d)),
    });
    if (ctx.dead()) return;
    upToast(r);
    //  올린 것은 되돌리기로 지우지 않는다 — 지우는 것은 사람이 삭제로 한다(확인창이 무엇이 사라지는지 말한다).
    pushUndo('올리기', undefined, '올린 파일은 되돌리기로 지우지 않아요 — 지우려면 골라서 ' + keyHint('delete', MAC) + ' 를 누르세요.');
    //  올린 것 중 이 폴더에 바로 든 것들을 골라 둔다(파인더가 붙여넣은 것을 골라 두는 것과 같다).
    selectAfter = [...new Set(list.map((u) => (dirOf(u.rel) === cwd ? u.rel : (cwd ? cwd + '/' : '') + u.rel.slice(cwd ? cwd.length + 1 : 0).split('/')[0])))];
    sig = ''; void load();
  }

  //  파인더처럼 **만들고 나서 그 자리에서 이름을 고친다** — 이름부터 물으면 흐름이 한 번 끊기고,
  //  이름을 안 정한 채로는 폴더를 못 만든다(정작 급한 건 '지금 이것들을 담을 자리'다).
  async function newFolder(): Promise<void> {
    if (!(ctx.id > 0)) { toast('이 화면은 프로젝트 폴더가 없어요.', true); return; }
    const nm = freeName(new Set(items.map((f) => f.name)), '새 폴더');
    const at = rel(nm);
    try { await api(pUrl('/folder?path=' + encodeURIComponent(at)), { method: 'POST' }); }
    catch (e: any) { toast('폴더를 만들지 못했어요 — ' + errMsg(e), true); return; }
    pushUndo('새 폴더', async () => {
      //  비어 있을 때만 걷는다 — 그새 무엇이 들었으면(올리기·세션) 되돌리기가 그걸 같이 지우면 안 된다.
      const d: any = await api(pUrl('/files?path=' + encodeURIComponent(currentPath(at))));
      if (Array.isArray(d?.items) && d.items.length) throw new Error('폴더가 비어 있지 않아 그대로 두었어요');
      await api(fileQ(currentPath(at)), { method: 'DELETE' });
    });
    sig = ''; await load();
    selectOnly(at);
    renameAt = at;                    // 다시 그린 뒤 그 칸의 이름을 편집 상태로 연다
    render();
  }
  //  되돌리기가 잡은 경로는 그 뒤의 이름 바꾸기로 달라질 수 있다 — 이 칸에서 바꾼 이름을 따라간다.
  const renamed = new Map<string, string>();
  const currentPath = (p2: string): string => { let cur = p2; for (let i = 0; i < 20 && renamed.has(cur); i++) cur = renamed.get(cur)!; return cur; };

  async function removeMany(list: FileItem[]): Promise<void> {
    if (!list.length) return;
    const label = list.length === 1 ? `「${list[0].name}」` : `자료 ${list.length}개`;
    const hasDir = list.some((f) => f.type === 'dir');
    if (!await confirmDialog({
      title: label + '를 삭제할까요?',
      message: hasDir ? '폴더는 안에 든 것까지 함께 지워집니다.' : '이 프로젝트의 세션들이 더는 이 자료를 참고하지 못하게 됩니다.',
      //  #3778 파일 휴지통 — 자료로 등록된 파일은 서버가 지우지 않고 보관한다. 그 밖의 것(빈 폴더·코드 폴더)은 종전대로 바로 지워진다.
      lines: ['자료로 등록된 파일은 [휴지통] ▸ [자료] 탭에서 되살릴 수 있어요. 그 밖의 파일(압축·영상 등 자료가 아닌 것)과 빈 폴더는 되살릴 수 없어요.'],
      confirmText: '삭제', danger: true,
    })) { root.focus({ preventScroll: true }); return; }
    let fail = 0, kept = 0;
    for (const f of list) {
      try { const r: any = await api(fileQ(f.path), { method: 'DELETE' }); kept += Number(r?.trashed) || 0; sel.delete(f.path); }
      catch { fail++; }
    }
    const done = list.length - fail;
    toast((kept ? `${done}개를 지웠어요 — 자료 ${kept}건은 휴지통에서 되살릴 수 있어요` : `${done}개를 삭제했어요`) + (fail ? ` · ${fail}개 실패` : ''), fail > 0);
    pushUndo('삭제', undefined, '지운 자료는 [휴지통] ▸ [자료] 탭에서 되살릴 수 있어요.');
    //  지운 자리 다음 칸을 골라 둔다(탐색기와 같다) — 키보드로 연달아 정리할 수 있게.
    const idx = ordered.findIndex((x) => x.path === list[0].path);
    const gone = new Set(list.map((x) => x.path));
    const next = ordered.slice(idx + 1).find((x) => !gone.has(x.path)) || ordered.slice(0, Math.max(0, idx)).reverse().find((x) => !gone.has(x.path));
    selectAfter = next ? [next.path] : null;
    sig = ''; await load();
    root.focus({ preventScroll: true });
  }

  /** 옮긴다 — 옮겨진 새 경로를 돌려준다. 되돌리기는 각자 원래 폴더로 되옮긴다. */
  async function moveMany(paths: string[], to: string, opts: { undo?: boolean } = {}): Promise<string[]> {
    const mine = paths.filter((p) => p !== to && !to.startsWith(p + '/') && dirOf(p) !== to);
    if (!mine.length) return [];
    let r: any;
    try { r = await api(pUrl('/move'), { method: 'POST', body: JSON.stringify({ paths: mine, to }) }); }
    catch (e: any) { toast('옮기지 못했어요 — ' + errMsg(e), true); return []; }
    const moved: string[] = (r && r.moved) || [];
    const bad = (r && r.failed) || [];
    toast(bad.length ? `${moved.length}개 이동 · ${bad.length}개 실패 (${bad[0].error})` : `${moved.length}개를 옮겼어요`, bad.length > 0);
    if (opts.undo !== false && moved.length) {
      const back = new Map<string, string[]>();   // 원래 폴더 → 지금 경로들
      for (const np of moved) {
        const orig = mine.find((p) => baseOf(p) === baseOf(np));
        if (!orig) continue;
        const d = dirOf(orig);
        back.set(d, [...(back.get(d) || []), np]);
      }
      pushUndo('옮기기', async () => {
        for (const [d, list] of back) {
          const rr: any = await api(pUrl('/move'), { method: 'POST', body: JSON.stringify({ paths: list.map(currentPath), to: d }) });
          if (rr?.failed?.length) throw new Error(rr.failed[0].error);
        }
      });
    }
    sel.clear();
    for (const np of moved) if (dirOf(np) === cwd) sel.add(np);
    sig = ''; await load();
    return moved;
  }

  // ── 복사 · 잘라내기 · 붙여넣기 · 복제 (#3870) ──────────────────────────────────────────
  //  서버엔 «복사» 길이 없다 — 받아서(내려받기 주소) 다시 올린다. 같은 프로젝트든 다른 프로젝트든 같은 길이라
  //   곁칸 두 개(프로젝트 A·B)에서 ⌘C → ⌘V 도 된다. 폴더는 매니페스트로 안의 파일을 펴서 같은 구조로 올린다
  //   (⚠ 빈 하위 폴더는 매니페스트에 없어 따라가지 않는다 — 파일이 든 구조만 옮겨진다).
  //  너무 큰 묶음(파일 500개·300MB 초과)은 받지 않는다 — 브라우저가 전부 쥐었다 올리는 길이라 멈춘다.
  async function copyInto(src: ClipItem[], srcPid: number, dest: string, sameDirNames: boolean): Promise<string[]> {
    if (!src.length) return [];
    //  폴더 안 파일 목록 — 같은 프로젝트면 찾기 재료(매니페스트)를 새로 받아 쓰고, 다른 프로젝트면 그 프로젝트의 것을 받는다.
    let flat: Array<{ path: string; size: number }> = [];
    if (src.some((x) => x.type === 'dir')) {
      const m: any = await api(pUrl('/shared/manifest', srcPid)).catch(() => null);
      flat = ((m?.files || []) as any[]).map((f) => ({ path: String(f.path), size: Number(f.size || 0) }))
        .filter((f) => !f.path.startsWith(TRASH_DIR + '/') && !NOISE_RE.test('/' + f.path) && !MACHINE_FILES.has(baseOf(f.path)));
    }
    //  목적지에 이미 있는 이름 — 지금 폴더면 손에 있는 목록, 하위 폴더(⌥ 끌어 놓기)면 그 폴더를 읽는다. 겹치면 덮지 않고 «복사본» 이름.
    let taken = new Set(items.map((f) => f.name));
    if (dest !== cwd) {
      const d: any = await api(pUrl('/files?path=' + encodeURIComponent(dest))).catch(() => null);
      if (!d || !Array.isArray(d.items)) { toast('복사할 폴더를 읽지 못했어요.', true); return []; }
      taken = new Set((d.items as any[]).map((x) => String(x.name)));
    }
    type Job = { from: string; to: string };
    const jobs: Job[] = [], dirs: string[] = [], tops: string[] = [];
    let bytes = 0;
    for (const it of src) {
      const nm = sameDirNames && dirOf(it.path) === dest && srcPid === ctx.id ? copyName(it.name, taken, MAC, it.type === 'dir')
        : taken.has(it.name) ? copyName(it.name, taken, MAC, it.type === 'dir') : it.name;
      taken.add(nm);
      const top = (dest ? dest + '/' : '') + nm;
      tops.push(top);
      if (it.type === 'file') { jobs.push({ from: it.path, to: top }); bytes += it.size || 0; continue; }
      dirs.push(top);
      for (const f of flat) if (f.path.startsWith(it.path + '/')) { jobs.push({ from: f.path, to: top + f.path.slice(it.path.length) }); bytes += f.size; }
    }
    if (jobs.length > COPY_MAX_FILES || bytes > COPY_MAX_BYTES) {
      toast(`한 번에 복사하기엔 너무 커요 — 파일 ${jobs.length}개 · ${fmtSize(bytes)} (상한 ${COPY_MAX_FILES}개 · ${fmtSize(COPY_MAX_BYTES)}).`, true);
      return [];
    }
    toast(`${src.length}개를 복사하는 중이에요…`);
    for (const d of dirs) await api(pUrl('/folder?path=' + encodeURIComponent(d)), { method: 'POST' }).catch(() => null);
    const up: UpItem[] = [];
    let fail = 0;
    for (const j of jobs) {
      const r = await fetch(apiUrl(fileQ(j.from, srcPid) + '&download=1'), { headers: authHeaders() }).catch(() => null);
      if (!r || !r.ok) { fail++; continue; }
      up.push({ file: new File([await r.blob()], baseOf(j.to)), rel: j.to });
    }
    const res = await upSend({ items: up, signal: new AbortController().signal, fileUrl: (p) => fileQ(p) });
    fail += res.fail;
    toast(fail ? `${src.length}개 복사 · ${fail}개 파일 실패` : `${src.length}개를 복사했어요`, fail > 0);
    return tops;
  }
  async function pasteClip(move: boolean): Promise<void> {
    const clip = FILE_CLIP;
    if (!clip || !clip.items.length) { toast('붙여넣을 자료가 없어요 — 먼저 ' + keyHint('copy', MAC) + ' 로 복사하세요.', true); return; }
    if (!(ctx.id > 0)) return;
    if ((move || clip.mode === 'cut') && clip.pid === ctx.id) {
      //  잘라내기 → 붙여넣기 = 옮기기(탐색기). 같은 폴더에 붙이면 아무 일도 없다.
      const moved = await moveMany(clip.items.map((x) => x.path), cwd);
      if (moved.length && clip.mode === 'cut') FILE_CLIP = null;
      paintSel();
      return;
    }
    const tops = await copyInto(clip.items, clip.pid, cwd, true);
    if (!tops.length) return;
    pushUndo('복사', async () => { for (const t of tops) await api(fileQ(currentPath(t)), { method: 'DELETE' }); });
    selectAfter = tops;
    sig = ''; await load();
  }
  function setClip(mode: 'copy' | 'cut'): void {
    const list = selItems();
    if (!list.length) return;
    const marker = list.map((f) => f.name).join('\n');
    FILE_CLIP = { mode, pid: ctx.id, items: list.map((f) => ({ path: f.path, name: f.name, type: f.type, size: f.size || 0 })), marker, osOk: false };
    const clip = FILE_CLIP;
    //  운영체제 클립보드에도 이름을 적는다 — ⌘V 가 «아직 이것» 인지 가르는 표식이고, 세션 입력칸에 붙이면 이름이 들어간다.
    try { void navigator.clipboard?.writeText(marker).then(() => { clip.osOk = true; }, () => { /* 권한 없음 — 이 페이지 것만 쓴다 */ }); } catch (_) { /* noop */ }
    toast(mode === 'cut' ? `${list.length}개를 잘라냈어요 — 옮길 폴더에서 ${keyHint('paste', MAC)}` : `${list.length}개를 복사했어요 — 붙일 폴더에서 ${keyHint('paste', MAC)}`);
    paintSel();
  }
  async function duplicate(): Promise<void> {
    const list = selItems();
    if (!list.length) return;
    const tops = await copyInto(list.map((f) => ({ path: f.path, name: f.name, type: f.type, size: f.size || 0 })), ctx.id, cwd, true);
    if (!tops.length) return;
    pushUndo('복제', async () => { for (const t of tops) await api(fileQ(currentPath(t)), { method: 'DELETE' }); });
    selectAfter = tops;
    sig = ''; await load();
  }
  /** 운영체제 클립보드가 아직 우리가 적은 표식인가 — 아니면 그새 딴 것을 복사했다(그것을 붙인다). */
  const clipIsOurs = (text: string, hasFiles: boolean): boolean =>
    !!FILE_CLIP && !hasFiles && (FILE_CLIP.osOk ? text === FILE_CLIP.marker : true);

  async function undo(): Promise<void> {
    const u = undos.pop();
    if (!u) { toast('되돌릴 것이 없어요.'); return; }
    if (!u.run) { toast(u.why || '이 일은 되돌리지 않아요.'); return; }
    try { await u.run(); toast(`되돌렸어요 — ${u.label}`); }
    catch (e: any) { toast(`되돌리지 못했어요 — ${u.label}: ${errMsg(e)}`, true); }
    sig = ''; await load();
  }

  // ── 붙여넣기 — ⌘V 와 우클릭 ▸ 붙여넣기가 같은 곳으로 모인다 ────────────────────
  //  ⌘V 는 paste 이벤트의 clipboardData 를 쓰고(권한 프롬프트 없음), 메뉴에서 부른 붙여넣기는 그 이벤트가 없어
  //  비동기 클립보드 API 로 직접 읽는다(보안 컨텍스트 필요 · 권한을 물을 수 있다). 둘 다 결국 upload() 로 간다.
  //  #3870 — 이 칸에서 ⌘C 한 자료가 운영체제 클립보드의 **마지막 것**이면 그 자료를 복사해 붙인다(위 FILE_CLIP).
  function pasteItems(files: File[], text: string): void {
    const taken = items.map((f) => f.name);
    const list: UpItem[] = [];
    for (const f of files) {
      const nm = attachName(f, taken);       // 이름 규칙은 새 세션 창의 첨부와 **한 곳**(panes-kit)에서 온다
      taken.push(nm);
      list.push({ file: new File([f], nm, { type: f.type }), rel: rel(nm) });
    }
    if (!list.length && text.trim()) {
      const nm = freeName(new Set(taken), `붙여넣은 글 ${stamp()}.txt`);
      list.push({ file: new File([text], nm, { type: 'text/plain' }), rel: rel(nm) });
    }
    if (!list.length) { toast('클립보드에 올릴 것이 없어요.', true); return; }
    void upload(list);
  }
  async function pasteFromApi(): Promise<void> {
    const cb: any = navigator.clipboard;
    if (!cb || !cb.read) {
      if (FILE_CLIP) { void pasteClip(false); return; }
      toast('이 브라우저에선 메뉴로 붙여넣을 수 없어요 — ⌘V(Ctrl+V)를 눌러 주세요.', true); return;
    }
    try {
      const files: File[] = [];
      let text = '';
      for (const it of await cb.read()) {
        const t = (it.types || []).find((x: string) => x.startsWith('image/'));
        if (t) { const b = await it.getType(t); files.push(new File([b], 'image.' + (t.split('/')[1] || 'png'), { type: t })); }
        else if (!text && (it.types || []).includes('text/plain')) text = await (await it.getType('text/plain')).text();
      }
      if (clipIsOurs(text, files.length > 0)) { void pasteClip(false); return; }
      pasteItems(files, text);
    } catch (e: any) {
      if (FILE_CLIP) { void pasteClip(false); return; }
      toast('클립보드를 읽지 못했어요 — 브라우저가 막았거나 권한이 없어요. ⌘V(Ctrl+V)로 붙여넣어 보세요.', true);
    }
  }
  // 이 칸이 '붙여넣을 자리'일 때만 가로챈다 — 안에 포커스가 있거나 포인터가 올라와 있을 때.
  //  (곁칸이 여럿이라 무조건 가로채면 옆 칸에 치던 글이 이리로 온다.)
  let hot = false;
  root.addEventListener('pointerenter', () => { hot = true; });
  root.addEventListener('pointerleave', () => { hot = false; });
  const onPaste = (e: ClipboardEvent): void => {
    if (!root.isConnected) { document.removeEventListener('paste', onPaste, true); return; }
    if (!hot && !root.contains(document.activeElement)) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(input|textarea)$/i.test(t.tagName))) return;   // 글 치던 중은 방해하지 않는다
    const dt = e.clipboardData;
    if (!dt) return;
    const files = Array.from(dt.items || []).filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean) as File[];
    const text = dt.getData('text/plain') || '';
    if (clipIsOurs(text, files.length > 0)) { e.preventDefault(); e.stopPropagation(); void pasteClip(false); return; }
    if (!files.length && !text.trim()) return;
    e.preventDefault(); e.stopPropagation();
    pasteItems(files, text);
  };
  document.addEventListener('paste', onPaste, true);

  // ── 목록 읽기·정렬 ───────────────────────────────────────────────────────
  //  ⚠ 돌려주는 null 은 «이번 답은 쓰지 않는다» 이다(#4135):
  //   · 못 받았다(망·서버) — 종전엔 빈 목록으로 그려 «아직 자료가 없어요» 가 떴다. 자료가 사라진 게 아니라 못 읽은 것이므로 앞의 목록을 둔다.
  //   · 받는 사이 다른 폴더로 옮겼다 — 늦게 온 답을 지금 폴더의 것으로 그리면 경로가 어긋난다(미리보기가 없는 주소를 찾아 404).
  async function fetchDir(): Promise<FileItem[] | null> {
    const dir = cwd;
    const at = (name: string): string => (dir ? dir + '/' + name : name);
    const d: any = await api(pUrl('/files?path=' + encodeURIComponent(dir))).catch(() => null);
    if (dir !== cwd) return null;
    if (!d || !Array.isArray(d.items)) return loadedOnce || items.length ? null : [];   // 보관본을 그려 둔 채 못 받았으면 그대로 둔다
    const raw: any[] = d.items;
    return raw
      .filter((it) => {
        const nm = String(it.name);
        if (it.repo) return false;      // provision 된 레포/워크트리 — 코드는 git 이 소유한다(매니페스트도 같은 규칙으로 뺀다)
        if (nm === TRASH_DIR && !dir) return false;
        if (MACHINE_FILES.has(nm)) return false;
        return !NOISE_RE.test('/' + nm + '/');
      })
      .map((it) => ({ name: String(it.name), path: at(String(it.name)), type: it.type === 'dir' ? 'dir' : 'file', size: Number(it.size || 0), mtime: Number(it.mtime || 0), empty: !!it.empty } as FileItem));
  }
  function sortItems(list: FileItem[]): FileItem[] {
    const dir = sortAsc ? 1 : -1;
    return list.slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;   // 폴더 먼저 — 파인더 기본과 같다
      if (sortKey === 'size') return (a.size - b.size) * dir || a.name.localeCompare(b.name, 'ko');
      if (sortKey === 'date') return (a.mtime - b.mtime) * dir || a.name.localeCompare(b.name, 'ko');
      if (sortKey === 'kind') { const ka = a.type === 'dir' ? '폴더' : kindOf(a.path).type; const kb = b.type === 'dir' ? '폴더' : kindOf(b.path).type; return (ka.localeCompare(kb, 'ko') || a.name.localeCompare(b.name, 'ko')) * dir; }
      return a.name.localeCompare(b.name, 'ko') * dir;
    });
  }
  /** 찾기용 전체 목록 — 매니페스트 한 번(평평하고, 화면과 같은 규칙으로 잡동사니를 뺀다). */
  async function loadAll(): Promise<void> {
    allAt = Date.now();
    const m: any = await api(pUrl('/shared/manifest')).catch(() => null);
    if (ctx.dead() || !m) { allAt = 0; return; }
    allFiles = (((m.files || []) as any[]))
      .map((f) => ({ name: String(f.path).split('/').pop() || String(f.path), path: String(f.path), type: 'file' as const, size: Number(f.size || 0), mtime: Number(f.mtime || 0) }))
      .filter((f) => !f.path.startsWith(TRASH_DIR + '/') && !NOISE_RE.test('/' + f.path) && !MACHINE_FILES.has(f.name));
  }

  let loadedOnce = false, lastDir = '';
  const cacheKey = (): string => ctx.id + '|' + cwd;
  /** 받은 목록을 화면에 앉힌다 — 서버 답이든 페이지 보관본이든 같은 길. */
  function take(got: FileItem[], fromServer: boolean): void {
    const s2 = cwd + '|' + got.map((f) => f.path + f.mtime + f.size).join('|');
    const changed = fromServer && loadedOnce && lastDir === cwd && s2 !== sig;   // 같은 폴더의 목록이 달라졌다 — 폴더를 옮긴 것은 변화가 아니다
    if (fromServer) { loadedOnce = true; lastDir = cwd; LIST_CACHE.set(cacheKey(), got); }
    if (s2 === sig && !selectAfter) return;
    sig = s2;
    items = got;
    if (changed && ctx.onFiles) { try { ctx.onFiles(); } catch (_) { /* 밖의 고리가 던져도 목록은 선다 */ } }
    for (const p of [...sel]) if (!got.some((f) => f.path === p)) sel.delete(p);   // 사라진 것은 선택도 놓는다
    render();
    if (fromServer) selectAfter = null;   // 서버 목록에도 없으면 고를 것이 없다 — 기다리던 것을 놓는다(안 그러면 틱마다 다시 그린다)
  }
  async function load(): Promise<void> {
    if (!(ctx.id > 0)) { body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:18px', text: '이 화면은 프로젝트 폴더가 없어 자료를 둘 수 없어요.' })); return; }
    //  찾기 재료(매니페스트)는 **찾는 중일 때만** 틱마다 새로 받는다 — 종전엔 8초마다 늘 받았고, 그 요청은 서버에서
    //   AGENTS.md 를 다시 쓰느라 한 번에 1.2초가 들었다(2026-09-30 매니지드 실측). 찾기칸에 들어가는 순간 받는다(위 findIn).
    if (query.trim()) void loadAll().then(() => { if (!ctx.dead() && query.trim()) render(); });
    if (!loadedOnce || lastDir !== cwd) { const cached = LIST_CACHE.get(cacheKey()); if (cached && !sig) take(cached, false); }
    const got = await fetchDir();
    if (ctx.dead() || !root.isConnected || !got) return;
    take(got, true);
  }
  function goto(dir: string, how: 'push' | 'none' = 'push', pick: string | null = null): void {
    if (how === 'push' && dir !== cwd) { backStack.push(cwd); if (backStack.length > 60) backStack.shift(); fwdStack.length = 0; }
    cwd = dir; sel.clear(); anchorPath = null; leadPath = null; renameAt = null; sig = ''; body.scrollTop = 0;
    selectAfter = pick ? [pick] : null;
    void load();
  }
  //  뒤로 — 돌아간 폴더가 방금 폴더의 부모면 방금 폴더를 골라 둔다(위 폴더로 갈 때와 같다).
  const goBack = (): void => { if (!backStack.length) return; const from = cwd; fwdStack.push(cwd); const to = backStack.pop()!; goto(to, 'none', dirOf(from) === to && from ? from : null); };
  const goFwd = (): void => { if (!fwdStack.length) return; backStack.push(cwd); goto(fwdStack.pop()!, 'none'); };
  //  위 폴더로 — 방금 나온 폴더를 골라 둔다(파인더와 같다: ⌘↑ 뒤 ⌘↓ 로 곧바로 다시 들어간다).
  const goParent = (): void => { if (!cwd) return; const from = cwd; goto(dirOf(cwd), 'push', from); };

  // ── 선택 ────────────────────────────────────────────────────────────────
  function paintSel(): void {
    const cut = FILE_CLIP && FILE_CLIP.mode === 'cut' && FILE_CLIP.pid === ctx.id ? new Set(FILE_CLIP.items.map((x) => x.path)) : null;
    for (const n of Array.from(body.querySelectorAll('[data-fp]'))) {
      const p2 = (n as HTMLElement).dataset.fp || '';
      (n as HTMLElement).classList.toggle('on', sel.has(p2));
      (n as HTMLElement).classList.toggle('cut', !!cut && cut.has(p2));   // 잘라낸 것은 흐리게(탐색기와 같다) — 붙이면 옮겨진다
      (n as HTMLElement).setAttribute('aria-selected', sel.has(p2) ? 'true' : 'false');
    }
    count.textContent = sel.size ? `${sel.size}개 선택` : (ordered.length ? `${ordered.length}개` : '');
    count.classList.toggle('sel', sel.size > 0);
    if (ctx.onState) { try { ctx.onState({ cwd, items, selected: selItems() }); } catch (_) { /* 밖의 고리가 던져도 고르기는 된다 */ } }
  }
  function selectOnly(p2: string): void { sel.clear(); sel.add(p2); anchorPath = p2; leadPath = p2; paintSel(); }
  const nodeOf = (p2: string): HTMLElement | null => body.querySelector('[data-fp="' + CSS.escape(p2) + '"]');
  function reveal(p2: string | null): void { const n = p2 ? nodeOf(p2) : null; n?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  function clickSelect(f: FileItem, e: MouseEvent): void {
    const multi = e.metaKey || e.ctrlKey;
    if (e.shiftKey && anchorPath) {
      const ai = ordered.findIndex((x) => x.path === anchorPath), ci = ordered.findIndex((x) => x.path === f.path);
      if (ai >= 0 && ci >= 0) { if (!multi) sel.clear(); for (let i = Math.min(ai, ci); i <= Math.max(ai, ci); i++) sel.add(ordered[i].path); }
      leadPath = f.path;
    } else if (multi) {
      if (sel.has(f.path)) sel.delete(f.path); else sel.add(f.path);
      anchorPath = f.path; leadPath = f.path;
    } else {
      sel.clear(); sel.add(f.path); anchorPath = f.path; leadPath = f.path;
    }
    paintSel();
  }
  /** 방향키 — 격자면 줄 단위로, 목록이면 한 칸씩. ⇧ 는 기준(anchor)에서 지금 칸까지를 고른다. */
  function arrow(act: 'up' | 'down' | 'left' | 'right' | 'first' | 'last', extend: boolean): void {
    if (!ordered.length) return;
    let cols = 1;
    if (view === 'icon' && grid) {
      const kids = Array.from(grid.children) as HTMLElement[];
      const top0 = kids[0]?.offsetTop ?? 0;
      cols = Math.max(1, kids.filter((k) => k.offsetTop === top0).length);
    }
    const cur = ordered.findIndex((x) => x.path === (leadPath && sel.has(leadPath) ? leadPath : [...sel].pop()));
    const ni = navIndex(ordered.length, cols, cur, act);
    if (ni < 0) return;
    const target = ordered[ni].path;
    if (extend && anchorPath && ordered.some((x) => x.path === anchorPath)) {
      const ai = ordered.findIndex((x) => x.path === anchorPath);
      sel.clear();
      for (let i = Math.min(ai, ni); i <= Math.max(ai, ni); i++) sel.add(ordered[i].path);
      leadPath = target;
      paintSel();
    } else selectOnly(target);
    reveal(target);
  }
  /** 파일을 편다 — **파일마다 뷰어 하나**(#4135, 원준 2026-09-25: "다른 거 한 번 클릭하면 이전 꺼 뷰어에서 보이던 거
   *  없애고 새로 선택한 게 뜨는데 그러지 말고 새 창으로 뜨도록"). 이미 떠 있는 파일이면 그 뷰어로, 아니면 새 뷰어 —
   *  그 판정은 셸이 한다(panes.ts openViewerAt). 뷰어 칸이 없으면 셸이 이 신호를 듣고 만든다. */
  function open(f: FileItem): void {
    if (f.type === 'dir') { goto(f.path); return; }
    if (ctx.openFile) { ctx.openFile(f); return; }
    if (hasPane(ctx)) openInViewerPart(ctx, f.path);
  }
  /** 고른 것 여럿을 편다 — 각자 제 뷰어에. 상한 8은 부르는 쪽이 이미 건다. */
  function openMany(list: FileItem[]): void {
    const files = list.filter((x) => x.type !== 'dir');
    if (!files.length) { for (const d of list.slice(0, 1)) open(d); return; }   // 폴더만 골랐으면 첫 폴더로 들어간다
    files.forEach((f) => open(f));
  }
  function download(f: FileItem): void {
    //  인증 fetch → blob(files-upload authDownload). 종전의 새 탭은 토큰을 못 실어 쿠키 세션이 없는 폰에서 로그인 화면이 떴고,
    //   iOS 는 그 팝업 자체를 막는다(#4088 후속).
    void authDownload(apiUrl(fileQ(f.path) + '&download=1'), f.name);
  }
  function startRename(f: FileItem | undefined): void {
    if (!f || renameAt) return;
    selectOnly(f.path);
    renameAt = f.path;
    render();
  }

  // ── 키보드 — 파인더·탐색기 문법(lib/finder-keys.ts 가 키를 동작으로 읽는다) ─────────────────
  //  타이핑으로 고르기: 이름 첫머리를 치면 그 항목으로 간다. 1초 안에 이어 치면 이어 붙인다(«세션»을 ㅅ·세·세ㅅ…).
  let typed = '', typedCho = '', typedAt = 0;
  function doAct(act: FinderAction): boolean {
    const one = selItems();
    switch (act) {
      case 'open': if (one.length) openMany(one.slice(0, 8)); return true;
      case 'quicklook': { const files = one.filter((x) => x.type !== 'dir'); if (files.length) openMany(files.slice(0, 8)); return true; }
      case 'rename': if (one.length === 1) startRename(one[0]); return true;
      case 'parent': goParent(); return true;
      case 'back': goBack(); return true;
      case 'forward': goFwd(); return true;
      case 'delete': if (one.length) void removeMany(one); return true;
      case 'selectAll': sel.clear(); for (const f of ordered) sel.add(f.path); paintSel(); return true;
      case 'clear': if (!sel.size) return false; sel.clear(); anchorPath = null; leadPath = null; paintSel(); return true;
      case 'newFolder': void newFolder(); return true;
      case 'copy': if (!one.length) return false; setClip('copy'); return true;
      case 'cut': if (!one.length) return false; setClip('cut'); return true;
      case 'paste': return false;   // ⌘V 는 paste 이벤트가 받는다(운영체제 클립보드를 읽을 수 있는 곳이 거기뿐이다 — 위 onPaste)
      case 'pasteMove': void pasteClip(true); return true;
      case 'duplicate': if (one.length) void duplicate(); return true;
      case 'find': findIn.focus(); findIn.select(); return true;
      case 'undo': void undo(); return true;
      default: return false;
    }
  }
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    //  칸 자체(격자)에 포커스가 있을 때만 — 찾기칸·이름칸에서 치는 글자와 도구 단추 위의 Enter·Space 는 그 자리의 것이다.
    if (t !== root && !(t && body.contains(t) && !/^(input|textarea|select)$/i.test(t.tagName))) return;
    cancelSlowRename();
    //  타이핑으로 고르기 — 인쇄되는 글자(수식키 없이). Space 는 이어 치는 중(1초 안)일 때만 이름의 일부고, 아니면 빠른 보기다.
    const now = performance.now();
    const tc = typeChar(e);
    const typing = !!typed && now - typedAt < 1000;
    if (tc && (tc.ch !== ' ' || typing)) {
      if (!typing) { typed = ''; typedCho = ''; }
      typed += tc.ch; typedCho += tc.cho; typedAt = now;
      const i = typeSelect(ordered.map((f) => f.name), typed, typedCho);
      if (i >= 0) { selectOnly(ordered[i].path); reveal(ordered[i].path); }
      e.preventDefault();
      return;
    }
    const fk = finderKey(e, MAC);
    if (!fk) return;
    if (fk.act === 'up' || fk.act === 'down' || fk.act === 'left' || fk.act === 'right' || fk.act === 'first' || fk.act === 'last') {
      e.preventDefault(); arrow(fk.act, !!fk.extend); return;
    }
    if (doAct(fk.act)) e.preventDefault();
  });
  //  도구 단추를 눌러도 포커스는 격자에 둔다 — 보기·정렬을 바꾼 뒤 곧바로 방향키·단축키가 먹게(파인더 도구막대 단추도 포커스를 안 가져간다).
  head.addEventListener('mousedown', (e: MouseEvent) => {
    const b = (e.target as HTMLElement)?.closest('button');
    if (b && head.contains(b)) { e.preventDefault(); root.focus({ preventScroll: true }); }
  });
  //  마우스 옆 단추(뒤로 3 · 앞으로 4) — 이 칸 위에서 누르면 브라우저 뒤로가기 대신 폴더를 오간다(다닌 곳이 있을 때만).
  root.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.button === 3 && backStack.length) || (e.button === 4 && fwdStack.length)) e.preventDefault();
  });
  root.addEventListener('mouseup', (e: MouseEvent) => {
    if (e.button === 3 && backStack.length) { e.preventDefault(); goBack(); }
    else if (e.button === 4 && fwdStack.length) { e.preventDefault(); goFwd(); }
  });

  // ── 우클릭 메뉴 ─────────────────────────────────────────────────────────
  //  단축키는 오른쪽에 흐리게 적는다 — 메뉴에서 배우고 다음부터는 키로 한다(파인더·탐색기 메뉴와 같다).
  function menuFor(f: FileItem | null, e: MouseEvent): void {
    e.preventDefault(); e.stopPropagation();
    if (f && !sel.has(f.path)) selectOnly(f.path);
    const many = selItems();
    const rows: CtxRow[] = [];
    const H = (a: FinderAction): string => keyHint(a, MAC);
    if (f) {
      //  「열기」 = 두 번 누르기와 같은 일 — 파일은 제 뷰어로(이미 떠 있으면 그 뷰어), 폴더는 들어간다.
      rows.push({ label: many.length > 1 ? `${many.length}개 나란히 열기` : (f.type === 'dir' ? '폴더 열기' : '열기'), hint: H('open'), run: () => openMany(many.slice(0, 8)) });
      if (f.type !== 'dir') rows.push({ label: '내려받기', run: () => { for (const x of many) if (x.type !== 'dir') download(x); } });
      if (ctx.extraRows) { try { rows.push(...ctx.extraRows(f, many)); } catch (_) { /* 덧붙는 행이 없어도 메뉴는 선다 */ } }
      rows.push({ sep: true, label: '' });
      rows.push({ label: '이름 바꾸기', hint: H('rename'), off: many.length !== 1, run: () => startRename(f) });
      rows.push({ label: '복사', hint: H('copy'), run: () => setClip('copy') });
      rows.push({ label: '잘라내기', hint: H('cut'), run: () => setClip('cut') });
      rows.push({ label: '복제', hint: H('duplicate'), run: () => void duplicate() });
      if (cwd) rows.push({ label: '상위 폴더로 옮기기', run: () => void moveMany(many.map((x) => x.path), dirOf(cwd)) });
      rows.push({ sep: true, label: '' });
      rows.push({ label: many.length > 1 ? `${many.length}개 삭제` : '삭제', hint: H('delete'), danger: true, run: () => void removeMany(many) });
      rows.push({ sep: true, label: '' });
    }
    rows.push({ label: FILE_CLIP ? `붙여넣기 (${FILE_CLIP.items.length}개)` : '붙여넣기', hint: H('paste'), run: () => void pasteFromApi() });
    rows.push({ label: '새 폴더', hint: H('newFolder'), run: () => void newFolder() });
    rows.push({ label: '파일 올리기…', run: () => upIn.click() });
    if (upDirSupported()) rows.push({ label: '폴더 올리기…', run: () => upDirIn.click() });
    rows.push({ sep: true, label: '' });
    rows.push({ label: '정렬 기준', sub: sortRows() });
    rows.push({ label: '보기', sub: viewRows() });
    if (view === 'icon') rows.push({ label: '아이콘 크기', sub: sizeRows() });
    if (undos.length) rows.push({ sep: true, label: '' }, { label: '되돌리기 — ' + undos[undos.length - 1].label, hint: H('undo'), run: () => void undo() });
    ctxMenu(e.clientX, e.clientY, rows);
  }
  root.addEventListener('contextmenu', (e: MouseEvent) => {
    if ((e.target as HTMLElement)?.closest('[data-fp]')) return;   // 항목 위는 항목 쪽 핸들러가 맡는다
    if ((e.target as HTMLElement)?.closest('.pn-fhead, .pn-fnote')) return;
    sel.clear(); paintSel();
    menuFor(null, e);
  });

  // ── 사각형 끌어 여럿 고르기(marquee) ─────────────────────────────────────
  //  빈 자리에서 왼쪽 버튼으로 끌면 사각형이 생기고, 그 사각형에 닿는 것이 선택된다.
  //  ⌘/⇧ 를 누른 채 끌면 기존 선택에 **더한다**(파인더와 같다). 항목 위에서 시작한 드래그는 '옮기기'라 여기서 안 잡는다.
  const marquee = el('div', { class: 'pn-fmarq', hidden: true });
  body.append(marquee);
  root.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;   // 손가락은 굴리는 것이다 — 사각형 선택이 스크롤과 싸운다
    const t = e.target as HTMLElement;
    if (t.closest('[data-fp], .pn-fhead, .pn-fnote, button, input, a')) return;
    cancelSlowRename();
    const add = e.metaKey || e.ctrlKey || e.shiftKey;
    const base = new Set(sel);
    const x0 = e.clientX, y0 = e.clientY;
    let live = false;
    const move = (ev: PointerEvent): void => {
      if (!live && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return;   // 살짝 흔들린 클릭은 드래그가 아니다
      live = true;
      const br = body.getBoundingClientRect();
      const l = Math.min(x0, ev.clientX), r2 = Math.max(x0, ev.clientX);
      const tp = Math.min(y0, ev.clientY), bt = Math.max(y0, ev.clientY);
      marquee.hidden = false;
      marquee.style.left = (l - br.left + body.scrollLeft) + 'px';
      marquee.style.top = (tp - br.top + body.scrollTop) + 'px';
      marquee.style.width = (r2 - l) + 'px';
      marquee.style.height = (bt - tp) + 'px';
      sel.clear();
      if (add) for (const p of base) sel.add(p);
      for (const n of Array.from(body.querySelectorAll('[data-fp]'))) {
        const q = (n as HTMLElement).getBoundingClientRect();
        if (q.right >= l && q.left <= r2 && q.bottom >= tp && q.top <= bt) sel.add((n as HTMLElement).dataset.fp || '');
      }
      paintSel();
    };
    const up = (): void => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      marquee.hidden = true;
      if (!live) { sel.clear(); anchorPath = null; leadPath = null; paintSel(); }   // 빈 자리 클릭 = 선택 해제
      document.body.classList.remove('lv-dragselect');
    };
    document.body.classList.add('lv-dragselect');
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
  });

  // ── 폴더로 끌어 옮기기 — ⌥(맥)·Ctrl(윈도)을 누른 채 놓으면 복사(파인더·탐색기와 같다) ──
  const DND = 'application/x-lively-assets';
  const copyKey = (e: DragEvent): boolean => (MAC ? e.altKey : e.ctrlKey);
  async function dropInto(e: DragEvent, dir: string): Promise<void> {
    let paths: string[] = [];
    try { paths = JSON.parse(e.dataTransfer!.getData(DND) || '[]'); } catch { /* 빈 손이면 아무 일도 없다 */ }
    if (!paths.length) return;
    if (!copyKey(e)) { await moveMany(paths, dir); return; }
    const src = paths.map((p2) => ordered.find((x) => x.path === p2)).filter(Boolean) as FileItem[];
    const tops = await copyInto(src.map((f) => ({ path: f.path, name: f.name, type: f.type, size: f.size || 0 })), ctx.id, dir, false);
    if (tops.length) { pushUndo('복사', async () => { for (const t2 of tops) await api(fileQ(currentPath(t2)), { method: 'DELETE' }); }); sig = ''; await load(); }
  }
  const hasDnd = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(DND);
  function wireDrop(node: HTMLElement, dir: string, stop: boolean): void {
    node.addEventListener('dragover', (e: DragEvent) => { if (!hasDnd(e)) return; e.preventDefault(); if (stop) e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = copyKey(e) ? 'copy' : 'move'; node.classList.add('drop-in'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-in'));
    node.addEventListener('drop', (e: DragEvent) => {
      if (!hasDnd(e)) return;
      e.preventDefault(); if (stop) e.stopPropagation(); node.classList.remove('drop-in');
      void dropInto(e, dir);
    });
  }
  function wireDrag(node: HTMLElement, f: FileItem): void {
    node.draggable = true;
    node.addEventListener('dragstart', (e: DragEvent) => {
      cancelSlowRename();
      if (!sel.has(f.path)) selectOnly(f.path);
      e.dataTransfer?.setData(DND, JSON.stringify(selItems().map((x) => x.path)));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
    });
    if (f.type === 'dir') wireDrop(node, f.path, true);
  }
  /** 경로 조각(빵부스러기)에도 떨굴 수 있다 — 위로 꺼내는 가장 짧은 길이다. */
  const wireCrumbDrop = (node: HTMLElement, dir: string): void => wireDrop(node, dir, false);

  // 미리보기 기계는 **공용 한 벌**(v2/file-preview.ts) — 뷰어 목록도 같은 것을 쓴다(#762).
  const pv = createPreviewKit({ fileUrl: (p2) => apiUrl(fileQ(p2)), dead: () => ctx.dead() });

  function thumb(f: FileItem, small: boolean): HTMLElement {
    // 목록 보기(20px)에선 서류를 그리지 않는다 — 그 크기에선 뭉개져 얼룩으로만 보인다.
    if (f.type === 'dir') return el('span', { class: 'pn-fic dir' + (small ? ' sm' : '') },
      folderIcon('pn-folder' + (small ? ' sm' : ''), { empty: f.empty, plain: small })) as HTMLElement;
    const k = kindOf(f.path);
    const box = el('span', { class: 'pn-fic ' + k.kind + (small ? ' sm' : ''), 'data-pv': f.path, 'data-pvk': k.kind, 'data-pvs': String(f.size || 0) },
      pnIcon(k.kind === 'page' ? 'note' : k.kind === 'video' ? 'img' : 'doc', 'pn-i')) as HTMLElement;
    if (k.kind !== 'file' && !small) pv.watch(box, f.path, k.kind, f.size || 0, f.mtime);
    return box;
  }

  // ── 그리기 ───────────────────────────────────────────────────────────────
  function crumbBar(): void {
    const segs = cwd ? cwd.split('/') : [];
    const kids: HTMLElement[] = [];
    const rootBtn = el('button', { class: 'pn-fcrumb' + (segs.length ? '' : ' on'), type: 'button', text: ctx.rootLabel || '자료', title: '맨 위 폴더', onclick: () => goto('') }) as HTMLElement;
    wireCrumbDrop(rootBtn, '');
    kids.push(rootBtn);
    let acc = '';
    segs.forEach((s, i) => {
      acc = acc ? acc + '/' + s : s;
      const here = acc;
      kids.push(el('span', { class: 'pn-fcsep', text: '›', 'aria-hidden': 'true' }));
      const b = el('button', { class: 'pn-fcrumb' + (i === segs.length - 1 ? ' on' : ''), type: 'button', text: s, title: here, onclick: () => goto(here) }) as HTMLElement;
      wireCrumbDrop(b, here);
      kids.push(b);
    });
    crumbs.replaceChildren(...kids);
  }

  /** 이름 자리에 입력칸을 세운다 — Enter 로 확정, Esc 로 되돌림, 밖을 누르면 확정(파인더와 같다). */
  function nameEditor(f: FileItem): HTMLElement {
    const inp = el('input', { class: 'pn-frename', type: 'text', value: f.name, 'aria-label': '새 이름' }) as HTMLInputElement;
    let done = false;
    //  Enter·Esc 로 끝냈으면 칸으로 포커스를 돌린다(이어서 방향키·단축키를 쓴다). 밖을 눌러 끝냈으면 그 자리를 뺏지 않는다.
    const finish = async (ok: boolean, byKey: boolean): Promise<void> => {
      if (done) return;
      done = true;
      renameAt = null;
      const nm = inp.value.trim();
      const refocus = (): void => { if (byKey) root.focus({ preventScroll: true }); };
      if (!ok || !nm || nm === f.name) { render(); refocus(); return; }
      if (/[/\\]/.test(nm) || nm.startsWith('.')) { toast('이름에 / \\ 는 쓸 수 없고 . 로 시작할 수 없어요.', true); render(); refocus(); return; }
      //  ⚠ 주소가 '/file/rename' 이다(#4114) — '/rename' 은 **프로젝트 이름짓기**의 자리라, 그리로 보내면
      //   파일이 아니라 프로젝트 이름을 고치려 든다(서버 project-routes.ts 의 같은 번호 주석).
      try { await api(pUrl('/file/rename'), { method: 'POST', body: JSON.stringify({ path: f.path, name: nm }) }); }
      catch (e: any) { toast('이름을 바꾸지 못했어요 — ' + errMsg(e), true); render(); refocus(); return; }
      const to = (dirOf(f.path) ? dirOf(f.path) + '/' : '') + nm;
      renamed.set(f.path, to);
      const oldName = f.name;
      pushUndo('이름 바꾸기', async () => {
        await api(pUrl('/file/rename'), { method: 'POST', body: JSON.stringify({ path: currentPath(to), name: oldName }) });
        //  되돌렸으면 추적표에서 **지운다** — 거꾸로 된 줄(to → 원래)을 더하면 두 줄이 서로를 가리켜 돌고 돈다.
        renamed.delete(f.path);
      });
      //  바꾼 뒤에도 그 항목을 골라 둔다(파인더와 같다 — 바꾸고 곧바로 ⌘O·⌘C 를 누른다).
      sel.clear(); selectAfter = [to];
      sig = ''; await load();
      refocus();
    };
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();          // ⌘A·Delete 같은 칸 단축키가 글자 편집을 가로채지 않게
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void finish(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); void finish(false, true); }
    });
    inp.addEventListener('blur', () => void finish(true, false));
    inp.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
    inp.addEventListener('dblclick', (e: MouseEvent) => e.stopPropagation());
    inp.addEventListener('pointerdown', (e: PointerEvent) => e.stopPropagation());   // 글자 안에서 끌어 고르기가 칸 끌기(옮기기)가 되지 않게
    // 확장자 앞까지만 고르게 — 파인더와 같다(대개 바꾸고 싶은 건 이름이지 확장자가 아니다).
    window.setTimeout(() => {
      inp.focus();
      const dot = f.type === 'dir' ? -1 : f.name.lastIndexOf('.');
      try { inp.setSelectionRange(0, dot > 0 ? dot : f.name.length); } catch { /* 일부 브라우저 */ }
    }, 0);
    return inp;
  }

  // ── 고른 항목의 이름을 한 번 더 누르면 이름 바꾸기(파인더·탐색기) ─────────────────────
  //  두 번 누르기(열기)와 섞이지 않게 잠깐 기다린다 — 그 사이 두 번째 누름이 오면(dblclick) 취소한다.
  let slowT = 0;
  function cancelSlowRename(): void { if (slowT) { window.clearTimeout(slowT); slowT = 0; } }

  /** 찾는 중 행에 붙는 경로 — '어느 폴더에 있나'가 곧 찾기의 답 절반이다. */
  function itemNode(f: FileItem): HTMLElement {
    const k = f.type === 'dir' ? { kind: 'dir', type: '폴더' } : kindOf(f.path);
    const meta = f.type === 'dir' ? '폴더' : `${k.type} · ${fmtSize(f.size || 0)}`;
    const editing = renameAt === f.path;
    const node = view === 'list'
      ? el('div', { class: 'pn-frow2', 'data-fp': f.path, title: f.name, role: 'option' },
        thumb(f, true),
        editing ? nameEditor(f) : el('b', { class: 'pn-fname1', text: f.name }),
        el('span', { class: 'pn-fcol k', text: query.trim() && dirOf(f.path) ? dirOf(f.path) : (f.type === 'dir' ? '폴더' : k.type) }),
        el('span', { class: 'pn-fcol s', text: f.type === 'dir' ? '—' : fmtSize(f.size || 0) }),
        el('span', { class: 'pn-fcol d', text: f.mtime ? relTime(new Date(f.mtime).toISOString()) : '' }))
      : el('div', { class: 'pn-fcard', 'data-fp': f.path, title: `${f.name}\n${meta}`, role: 'option' },
        thumb(f, false),
        editing ? nameEditor(f) : el('b', { class: 'pn-fname ell2', text: f.name }),
        el('span', { class: 'pn-fmeta' }, el('span', { text: query.trim() && dirOf(f.path) ? dirOf(f.path) : (f.type === 'dir' ? '폴더' : k.type) }),
          ...(f.type === 'dir' ? [] : [el('span', { class: 'sep', text: '·' }), el('span', { text: fmtSize(f.size || 0) })])));
    const n = node as HTMLElement;
    if (editing) { n.classList.add('editing'); return n; }   // 이름을 고치는 중엔 고르기·열기·끌기가 다 쉰다
    //  손가락(hover 없음·coarse)에는 **한 번 눌러 연다**(#4088 후속, 원준 2026-09-23) — 두 번 누르기는 폰에서 아무도 모르는
    //   손짓이고, 고르기·범위 고르기는 마우스의 것이다. 보조키를 누른 채면(외장 키보드) 종전대로 고른다.
    n.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      if (coarse.matches && !e.metaKey && !e.ctrlKey && !e.shiftKey) { open(f); return; }
      //  이미 혼자 골라져 있던 것의 **이름**을 한 번 더 눌렀다 — 잠깐 뒤 이름 바꾸기(그 사이 두 번째 누름이 오면 열기).
      const onName = !!(e.target as HTMLElement)?.closest('.pn-fname, .pn-fname1');
      const wasSole = sel.size === 1 && sel.has(f.path) && e.detail === 1;
      cancelSlowRename();
      if (onName && wasSole && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        slowT = window.setTimeout(() => { slowT = 0; if (sel.size === 1 && sel.has(f.path)) startRename(f); }, 600);
        return;
      }
      clickSelect(f, e);
    });
    //  두 번 누르기 = 열기. 파일마다 뷰어가 하나라(#4135) 보조키로 «새 탭»을 고를 일이 없다.
    n.addEventListener('dblclick', (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); cancelSlowRename(); open(f); });
    n.addEventListener('contextmenu', (e: MouseEvent) => { cancelSlowRename(); menuFor(f, e); });
    wireDrag(n, f);
    //  [⋯] — 우클릭 메뉴의 손가락 입구(iOS 는 길게 눌러도 contextmenu 를 안 낸다). hover 가 있는 기기에선 CSS 가 숨긴다(50-mobile.css).
    n.append(el('button', { class: 'pn-fmore', type: 'button', title: '더 보기', 'aria-label': f.name + ' 더 보기',
      onclick: (e: MouseEvent) => { e.stopPropagation(); menuFor(f, e); } }, el('span', { 'aria-hidden': 'true', text: '⋯' })));
    return n;
  }

  //  ── 제자리 되그리기(#4135, 원준 2026-09-25: "미리보기가 몇 초마다 다시 불러와지는 게 보여서 계속 깜빡거린다") ──
  //  종전엔 서명이 바뀌면 격자를 **통째로** 새로 만들었다 — 카드가 전부 새 노드라 미리보기(blob 받기)도 전부 다시 받았고,
  //  그 사이 아이콘이 잠깐 섰다. 파일 하나가 바뀌면 **그 카드만** 바뀌어야 한다 —
  //  카드를 «경로 · 종류 · 도장(mtime·size) · 빈 폴더 · 보기 · 이름 고치는 중 · 찾는 중이면 폴더 열(행이 폴더 이름을 보인다)» 열쇠로 붙잡아 두고, 열쇠가 같으면
  //  노드째 다시 쓴다(자리만 옮긴다 — 옮겨도 그림은 남고, 관찰자(file-preview seenPv)도 이미 채운 상자를 다시 받지 않는다).
  //  ⚠ 손잡이(click·dblclick·drag)는 만들 때의 FileItem 을 닫아 둔다 — 열쇠가 같으면 그 값들(path·type·mtime·size·empty)이
  //   전부 같으므로 옛 객체를 써도 결과가 같다. 열쇠에 없는 값을 손잡이가 읽게 되면 열쇠에도 넣어야 한다.
  const cards = new Map<string, KeyedCard<HTMLElement>>();
  let grid: HTMLElement | null = null;
  const cardKey = (f: FileItem, q: string): string =>
    [f.path, f.type, f.mtime, f.size, f.empty ? 1 : 0, view, renameAt === f.path ? 'e' : '', q ? dirOf(f.path) : ''].join('\u0000');
  function render(): void {
    crumbBar();
    const q = query.trim();
    if (q) {
      //  찾을 땐 이 프로젝트 자료 **전체**에서(폴더는 뺀다 — 찾는 것은 파일이다). 매니페스트가 이미 평평한 목록이다.
      const m = findMatcher(q);
      ordered = sortItems(allFiles.filter((f) => f.type !== 'dir' && m(f.name, f.path)));
    } else ordered = sortItems(items);
    //  새로 만든 것·방금 나온 폴더를 고른다 — 목록에 실제로 선 것만(아직 안 왔으면 다음 그리기까지 기다린다).
    if (selectAfter) {
      const here = selectAfter.filter((p2) => ordered.some((x) => x.path === p2));
      if (here.length) { sel.clear(); for (const p2 of here) sel.add(p2); anchorPath = here[0]; leadPath = here[here.length - 1]; selectAfter = null; revealNext = true; }
    }
    if (!ordered.length) {
      cards.clear(); grid = null;
      body.replaceChildren(marquee, el('div', { class: 'pn-empty' },
        pnIcon(q ? 'search' : 'drop', 'pn-i big'),
        el('b', { text: q ? '찾는 자료가 없어요.' : cwd ? '이 폴더는 비어 있어요.' : '아직 자료가 없어요.' }),
        el('p', { class: 'pn-fine', text: q ? '이름 일부로 다시 찾아보세요 — 초성(ㅍㅌ)이나 띄어쓰기 없이도 찾습니다.' : '파일이나 폴더를 이 칸에 끌어다 놓거나, 그림을 복사해 ⌘V 로 붙여넣거나, [＋ 올리기]를 누르세요. 세션이 만든 결과물도 여기 쌓입니다.' })));
      pv.prune();
      paintSel();
      return;
    }
    //  격자 자체는 보기(icon·list)마다 다른 요소다 — 무슨 보기로 만들었는지는 data-view 로 기억한다(클래스 비교가 아니다:
    //  누가 격자에 클래스를 덧붙여도 격자째 새로 만들지 않게).
    const host = grid && grid.isConnected && grid.dataset.view === view ? grid : el('div', { class: view === 'list' ? 'pn-flist' : 'pn-fgrid', 'data-view': view, role: 'listbox', 'aria-multiselectable': 'true' }) as HTMLElement;
    if (host !== grid) { grid = host; cards.clear(); }   // 보기가 바뀌었거나 빈 화면을 거쳤다 — 격자째 새로
    placeChildren(host, reuseKeyed(cards, ordered, (f) => f.path, (f) => cardKey(f, q), itemNode));
    if (host.parentNode !== body) body.replaceChildren(marquee, host);   // 격자를 떼었다 붙이면 그 안의 프레임이 전부 다시 실린다
    pv.prune();     // 붙인 **뒤에** — 떨어져 나간 상자만 잊는다(살아남은 카드의 종이는 그대로 다시 잰다)
    paintSel();
    //  골라 둔 것이 새로 생겼으면 보이는 자리로 — 틱마다(8초) 되그릴 때는 굴리지 않는다(사람이 굴려 둔 자리를 뺏지 않는다).
    if (revealNext) { revealNext = false; reveal(leadPath); }
  }
  // 컴퓨터에서 끌어다 놓기 — 지금 보고 있는 폴더로 들어간다(내부 드래그는 types 에 Files 가 없어 안 걸린다).
  upDropZone(root, root, (list, emptyDirs) => {
    void upload(list.map((u) => ({ file: u.file, rel: rel(u.rel) })), emptyDirs.map((d) => rel(d)));
  });

  void load();
  return {
    root,
    // ⚠ 이름을 고치는 중이면 틱을 쉰다 — 8초마다 다시 그리면 치던 글자가 사라진다.
    tick: () => { if (!renameAt) void load(); },
    destroy: () => {
      pv.destroy();
      toolsRO?.disconnect();
      cancelSlowRename();
      document.removeEventListener('paste', onPaste, true);
      document.querySelector('.pn-ctx')?.remove();
    },
  };
}
