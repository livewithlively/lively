// v2/panes-files.ts — 곁칸의 **자료** 부품(#1819). 프로젝트 공유 폴더를 맥 파인더 문법으로 다룬다.
//
//  왜 파인더를 베끼나 — 이 칸은 '파일이 든 폴더'다. 사람이 파일을 다룰 때 이미 아는 몸짓(더블클릭으로 열기,
//  ⌘/⇧ 클릭으로 골라 담기, 빈 자리를 끌어 사각형 선택, 폴더에 끌어다 넣기, 우클릭 메뉴, 보기·정렬 바꾸기)을
//  그대로 쓰면 배울 것이 없다. 없던 시절엔 자료가 스무 개만 넘어도 한 장짜리 격자에서 길을 잃었다(원준 신고).
//
//  계약(panes-parts.ts 의 Part 와 같다): root 를 칸 본문에 붙이고, tick() 은 8초마다, destroy() 는 정리.
//  ⚠ tick 은 **서명이 같으면 아무것도 하지 않는다** — 선택·스크롤·미리보기를 8초마다 날리면 쓸 수 없는 칸이 된다.
import { anchoredPopover, api, apiUrl, el, relTime, toast } from '../core.js';
import { fmtSize } from '../projects/files.js';
import { confirmDialog } from '../ui-primitives.js';
import { upDirSupported, upDropZone, upFromInput, upSend, upToast, type UpItem } from '../projects/files-upload.js';
import { openInViewerPart, FV_NOTE, FV_SIZE, FV_SORT, FV_VIEW, ICON_STEPS, MACHINE_FILES, NOISE_RE, SORT_LABEL, TRASH_DIR, attachName, ctxMenu, folderIcon, freeName, kindOf, lsGet, lsSet, pnIcon, stamp, type FileItem, type SortKey } from './panes-kit.js';
import { findMatcher } from '../lib/find.js';
import { createPreviewKit } from './file-preview.js';
import type { Part, PartCtx } from './panes-parts.js';

export function filesPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-files', tabindex: '0' }) as HTMLElement;
  const body = el('div', { class: 'pn-fbody' });          // 격자 또는 목록이 사는 자리(스크롤 주체)
  const crumbs = el('div', { class: 'pn-fcrumbs' });
  const count = el('span', { class: 'pn-fine', text: '' });
  let sig = '';

  // ── 상태 ──
  let cwd = '';                                 // 지금 보는 폴더(프로젝트 루트 기준 상대경로)
  let items: FileItem[] = [];                   // 지금 폴더의 것들(받은 그대로)
  //  찾기용 **평평한 전체 목록**(매니페스트) — 폴더를 열어 보지 않고도 이름으로 닿을 수 있어야 찾기다.
  //  ⚠ 목록 화면의 정본은 items 다. 이건 찾는 중에만 쓴다(전체를 늘 그리면 폴더 구조가 뜻을 잃는다).
  let allFiles: FileItem[] = [];
  //  화면에 실제로 그려진 순서. ⇧클릭 범위·⌘A 는 **눈에 보이는 순서**를 따라야 하므로 items 가 아니라 이걸 본다.
  //  ⚠ 정렬은 render 가 한다(load 가 아니라) — load 에서만 정렬하면 정렬을 바꿔도 다음 폴링(8초)까지 그대로다(실측).
  let ordered: FileItem[] = [];
  const sel = new Set<string>();                // 선택된 상대경로
  let anchorPath: string | null = null;         // ⇧클릭 범위의 기준
  let renameAt: string | null = null;           // 지금 이름을 고치는 중인 항목(제자리 편집, 파인더 문법)
  let view = lsGet(FV_VIEW, 'icon') === 'list' ? 'list' : 'icon';
  let iconSz = Math.max(ICON_STEPS[0], Math.min(ICON_STEPS[ICON_STEPS.length - 1], Number(lsGet(FV_SIZE, '110')) || 110));
  let sortKey = (lsGet(FV_SORT, 'date:desc').split(':')[0] as SortKey) || 'date';
  let sortAsc = lsGet(FV_SORT, 'date:desc').split(':')[1] === 'asc';
  if (!SORT_LABEL[sortKey]) sortKey = 'date';

  // ── 찾기 (#762, 원준 2026-09-04 "자료 위젯에서 검색 기능도 필요할 거 같음") ─────────────────
  //  잣대는 사이드바·타임라인과 **같은 것**(lib/find.ts) — 띄어쓰기 무시 · 낱말 순서 무관 · 초성.
  //  ⚠ 찾는 중에는 **지금 폴더 안**이 아니라 이 프로젝트 자료 **전체**를 본다: 파일이 어느 폴더에 있는지
  //   기억나지 않아 찾는 것이므로, 폴더를 하나씩 열어 보게 하면 찾기가 아니다. 그래서 결과 행에 경로를 함께 보인다.
  //  ⚠ 한글 조합 중에는 다시 그리지 않는다(사이드바와 같은 규율 #1958) — 매 글자 재렌더가 조합을 끊는다.
  let query = '';
  const findIn = el('input', { class: 'pn-ffind', type: 'search', placeholder: '자료 찾기', 'aria-label': '자료에서 찾기' }) as HTMLInputElement;
  let composing = false;
  const onFind = (): void => { query = findIn.value; render(); };
  findIn.addEventListener('compositionstart', () => { composing = true; });
  findIn.addEventListener('compositionend', () => { composing = false; onFind(); });
  findIn.addEventListener('input', () => { if (!composing) onFind(); });
  findIn.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && !composing) { e.stopPropagation(); findIn.value = ''; onFind(); } });

  const rel = (name: string): string => (cwd ? cwd + '/' + name : name);
  const selItems = (): FileItem[] => ordered.filter((f) => sel.has(f.path));

  // ── 맨 위 안내 — 이 칸이 무엇인지 한 줄로. 접어 둘 수 있고, 그 선택은 기억한다. ──
  //  왜 두나: 자료를 '이 세션에 첨부하는 것'으로 오해하면 딱 필요한 파일 하나만 올린다. 실제 계약은 그 반대라
  //  (프로젝트의 모든 세션이 여기를 읽는다) 많이 올릴수록 이득이라는 걸 올리기 전에 알려야 한다.
  const noteEl = el('div', { class: 'pn-fnote' },
    pnIcon('spark', 'pn-i sm'),
    el('p', { text: '여기 있는 자료는 이 프로젝트의 모든 세션이 자동으로 참고합니다. 관련 자료를 넉넉히 올려 둘수록 답이 좋아져요.' }),
    el('button', { class: 'pn-fnote-x', type: 'button', title: '안내 접기', 'aria-label': '안내 접기', text: '✕', onclick: () => { lsSet(FV_NOTE, '0'); noteEl.hidden = true; } }));
  noteEl.hidden = lsGet(FV_NOTE, '1') === '0';

  // ── 올리기 — 파일 **또는 폴더** (#1819 원준) ─────────────────────────────────
  //  끌어다 놓는 길은 처음부터 폴더를 받았는데(upDropZone → 하위 구조 그대로), 버튼 길만 파일 전용이었다.
  //  같은 자리에서 할 수 있는 일이 입력 방식에 따라 갈리면 사람은 '안 되는 것'으로 배운다 — 둘을 맞춘다.
  //  폴더 입력은 webkitRelativePath 로 하위 경로를 들고 오므로(upFromInput) 구조가 그대로 올라간다.
  const upIn = el('input', { type: 'file', multiple: 'true', hidden: true }) as HTMLInputElement;
  const upDirIn = el('input', { type: 'file', multiple: 'true', webkitdirectory: '', hidden: true }) as HTMLInputElement;
  upIn.addEventListener('change', () => { const items = upFromInput(upIn); upIn.value = ''; void upload(items.map((u) => ({ file: u.file, rel: rel(u.rel) }))); });
  upDirIn.addEventListener('change', () => { const items = upFromInput(upDirIn); upDirIn.value = ''; void upload(items.map((u) => ({ file: u.file, rel: rel(u.rel) }))); });
  // ⚠ 왜 버튼이 둘인가 — 브라우저가 **한 창에서 파일과 폴더를 같이 고르게 해주지 않는다.**
  //  `<input type=file>` 은 파일만, `webkitdirectory` 는 폴더만 받는다(File System Access API 도
  //  showOpenFilePicker/showDirectoryPicker 로 갈려 있다). 맥 네이티브 창은 둘 다 되지만 웹엔 안 열려 있다.
  //  그래서 팀은 #781 에서 팝오버 메뉴로 풀었는데, 그러면 **가장 흔한 일(파일 올리기)에 클릭이 하나 더 붙는다**
  //  (원준 2026-08-20: "드롭다운으로 나누지 말고"). 메뉴를 걷고 입구를 둘로 벌린다 — 각각 누르면 창이 바로 뜬다.
  //  본 버튼은 파일(자료 칸에서 압도적으로 흔하다), 옆 아이콘은 폴더째. 폴더 입력을 못 받치는 브라우저면 옆 버튼을 숨긴다.

  // ── 머리 — 경로 / 개수 / 도구 ──
  const upBtn = el('button', { class: 'btn-text', type: 'button', text: '＋ 올리기', title: '컴퓨터에서 파일을 고릅니다 — 여러 개 고르거나 더블클릭으로 하나만', onclick: () => upIn.click() });
  const upDirBtn = el('button', {
    class: 'pn-fbtn', type: 'button', title: '폴더째 올리기 — 하위 구조 그대로 올라갑니다', 'aria-label': '폴더째 올리기',
    onclick: () => upDirIn.click(),
  }, pnIcon('folderup', 'pn-i sm')) as HTMLElement;
  upDirBtn.hidden = !upDirSupported();
  const mkBtn = el('button', { class: 'btn-text', type: 'button', text: '새 폴더', title: '이 폴더 안에 폴더를 만듭니다', onclick: () => void newFolder() });
  const viewBtn = el('button', { class: 'pn-fbtn', type: 'button' }) as HTMLButtonElement;
  const sizeIn = el('input', { type: 'range', class: 'pn-fsize', min: '0', max: String(ICON_STEPS.length - 1), step: '1', title: '아이콘 크기', 'aria-label': '아이콘 크기' }) as HTMLInputElement;
  const sortBtn = el('button', { class: 'pn-fbtn wide', type: 'button', title: '정렬 순서' }) as HTMLButtonElement;
  const head = el('div', { class: 'pn-fhead' },
    el('div', { class: 'pn-frow1' }, crumbs, count),
    el('div', { class: 'pn-ftools' }, el('span', { class: 'pn-upgrp' }, upBtn, upDirBtn), mkBtn, el('span', { class: 'pn-fsp' }), findIn, viewBtn, sizeIn, sortBtn));
  root.append(upIn, upDirIn, noteEl, head, body);

  viewBtn.onclick = () => { view = view === 'icon' ? 'list' : 'icon'; lsSet(FV_VIEW, view); paintTools(); render(); };
  sizeIn.addEventListener('input', () => {
    iconSz = ICON_STEPS[Number(sizeIn.value)] || 110;
    lsSet(FV_SIZE, String(iconSz));
    body.style.setProperty('--pn-fsz', iconSz + 'px');   // 다시 그리지 않는다 — 격자 폭만 바뀐다(미리보기 재요청 방지)
  });
  sortBtn.onclick = () => {
    const close = anchoredPopover(sortBtn, el('div', { class: 'pn-fsort-pop' },
      ...(Object.keys(SORT_LABEL) as SortKey[]).map((k) => el('button', {
        class: 'pn-fsort-i' + (k === sortKey ? ' on' : ''), type: 'button', text: SORT_LABEL[k],
        onclick: () => { if (k === sortKey) sortAsc = !sortAsc; else { sortKey = k; sortAsc = k === 'name' || k === 'kind'; } lsSet(FV_SORT, sortKey + ':' + (sortAsc ? 'asc' : 'desc')); close(); paintTools(); render(); },
      })),
      el('div', { class: 'pn-ctx-sep' }),
      el('button', { class: 'pn-fsort-i', type: 'button', text: sortAsc ? '내림차순으로' : '오름차순으로', onclick: () => { sortAsc = !sortAsc; lsSet(FV_SORT, sortKey + ':' + (sortAsc ? 'asc' : 'desc')); close(); paintTools(); render(); } })));
  };
  function paintTools(): void {
    viewBtn.replaceChildren(pnIcon(view === 'icon' ? 'rows' : 'grid', 'pn-i sm'));
    viewBtn.title = view === 'icon' ? '목록으로 보기' : '아이콘으로 보기';
    viewBtn.setAttribute('aria-label', viewBtn.title);
    sizeIn.hidden = view !== 'icon';
    sizeIn.value = String(Math.max(0, ICON_STEPS.indexOf(iconSz)));
    sortBtn.replaceChildren(el('span', { text: SORT_LABEL[sortKey] }), el('span', { class: 'pn-fcar', text: sortAsc ? '▲' : '▼' }));
  }
  paintTools();
  body.style.setProperty('--pn-fsz', iconSz + 'px');

  // ── 서버 왕복 ────────────────────────────────────────────────────────────
  const pUrl = (suffix: string): string => '/api/ui/v6/projects/' + ctx.id + suffix;

  async function upload(list: UpItem[], emptyDirs: string[] = []): Promise<void> {
    if (!list.length && !emptyDirs.length) return;
    if (!(ctx.id > 0)) { toast('이 화면은 프로젝트 폴더가 없어 파일을 둘 곳이 없어요.', true); return; }
    const ac = new AbortController();
    toast(`${list.length}개를 올리는 중이에요…`);
    const r = await upSend({
      items: list, emptyDirs, signal: ac.signal,
      fileUrl: (p) => pUrl('/file?path=' + encodeURIComponent(p)),
      dirUrl: (d) => pUrl('/folder?path=' + encodeURIComponent(d)),
    });
    if (ctx.dead()) return;
    upToast(r);
    sig = ''; void load();
  }

  //  파인더처럼 **만들고 나서 그 자리에서 이름을 고친다** — 이름부터 물으면 흐름이 한 번 끊기고,
  //  이름을 안 정한 채로는 폴더를 못 만든다(정작 급한 건 '지금 이것들을 담을 자리'다).
  async function newFolder(): Promise<void> {
    if (!(ctx.id > 0)) { toast('이 화면은 프로젝트 폴더가 없어요.', true); return; }
    const nm = freeName(new Set(items.map((f) => f.name)), '새 폴더');
    try { await api(pUrl('/folder?path=' + encodeURIComponent(rel(nm))), { method: 'POST' }); }
    catch (e: any) { toast('폴더를 만들지 못했어요 — ' + (e?.message || e), true); return; }
    sig = ''; await load();
    renameAt = rel(nm);                    // 다시 그린 뒤 그 칸의 이름을 편집 상태로 연다
    render();
  }

  async function removeMany(list: FileItem[]): Promise<void> {
    if (!list.length) return;
    const label = list.length === 1 ? `「${list[0].name}」` : `자료 ${list.length}개`;
    const hasDir = list.some((f) => f.type === 'dir');
    if (!await confirmDialog({
      title: label + '를 삭제할까요?',
      message: hasDir ? '폴더는 안에 든 것까지 함께 지워집니다.' : '이 프로젝트의 세션들이 더는 이 자료를 참고하지 못하게 됩니다.',
      confirmText: '삭제', danger: true,
    })) return;
    let fail = 0;
    for (const f of list) {
      try { await api(pUrl('/file?path=' + encodeURIComponent(f.path)), { method: 'DELETE' }); sel.delete(f.path); }
      catch { fail++; }
    }
    toast(fail ? `${list.length - fail}개 삭제 · ${fail}개 실패` : `${list.length}개를 삭제했어요`);
    sig = ''; await load();
  }

  async function moveMany(paths: string[], to: string): Promise<void> {
    const mine = paths.filter((p) => p !== to && !to.startsWith(p + '/'));
    if (!mine.length) return;
    let r: any;
    try { r = await api(pUrl('/move'), { method: 'POST', body: JSON.stringify({ paths: mine, to }) }); }
    catch (e: any) { toast('옮기지 못했어요 — ' + (e?.message || e), true); return; }
    const bad = (r && r.failed) || [];
    toast(bad.length ? `${(r.moved || []).length}개 이동 · ${bad.length}개 실패 (${bad[0].error})` : `${(r.moved || []).length}개를 옮겼어요`);
    sel.clear(); sig = ''; await load();
  }

  // ── 붙여넣기 — ⌘V 와 우클릭 ▸ 붙여넣기가 같은 곳으로 모인다 ────────────────────
  //  ⌘V 는 paste 이벤트의 clipboardData 를 쓰고(권한 프롬프트 없음), 메뉴에서 부른 붙여넣기는 그 이벤트가 없어
  //  비동기 클립보드 API 로 직접 읽는다(보안 컨텍스트 필요 · 권한을 물을 수 있다). 둘 다 결국 upload() 로 간다.
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
    if (!cb || !cb.read) { toast('이 브라우저에선 메뉴로 붙여넣을 수 없어요 — ⌘V(Ctrl+V)를 눌러 주세요.', true); return; }
    try {
      const files: File[] = [];
      let text = '';
      for (const it of await cb.read()) {
        const t = (it.types || []).find((x: string) => x.startsWith('image/'));
        if (t) { const b = await it.getType(t); files.push(new File([b], 'image.' + (t.split('/')[1] || 'png'), { type: t })); }
        else if (!text && (it.types || []).includes('text/plain')) text = await (await it.getType('text/plain')).text();
      }
      pasteItems(files, text);
    } catch (e: any) {
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
    if (!files.length && !text.trim()) return;
    e.preventDefault(); e.stopPropagation();
    pasteItems(files, text);
  };
  document.addEventListener('paste', onPaste, true);

  // ── 목록 읽기·정렬 ───────────────────────────────────────────────────────
  async function fetchDir(): Promise<FileItem[]> {
    const d: any = await api(pUrl('/files?path=' + encodeURIComponent(cwd))).catch(() => null);
    const raw: any[] = (d && d.items) || [];
    return raw
      .filter((it) => {
        const nm = String(it.name);
        if (it.repo) return false;      // provision 된 레포/워크트리 — 코드는 git 이 소유한다(매니페스트도 같은 규칙으로 뺀다)
        if (nm === TRASH_DIR && !cwd) return false;
        if (MACHINE_FILES.has(nm)) return false;
        return !NOISE_RE.test('/' + nm + '/');
      })
      .map((it) => ({ name: String(it.name), path: rel(String(it.name)), type: it.type === 'dir' ? 'dir' : 'file', size: Number(it.size || 0), mtime: Number(it.mtime || 0), empty: !!it.empty } as FileItem));
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
    const m: any = await api(pUrl('/shared/manifest')).catch(() => null);
    if (ctx.dead() || !m) return;
    allFiles = (((m.files || []) as any[]))
      .map((f) => ({ name: String(f.path).split('/').pop() || String(f.path), path: String(f.path), type: 'file' as const, size: Number(f.size || 0), mtime: Number(f.mtime || 0) }))
      .filter((f) => !f.path.startsWith(TRASH_DIR + '/') && !NOISE_RE.test('/' + f.path) && !MACHINE_FILES.has(f.name));
  }

  async function load(): Promise<void> {
    if (!(ctx.id > 0)) { body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:18px', text: '이 화면은 프로젝트 폴더가 없어 자료를 둘 수 없어요.' })); return; }
    void loadAll();                              // 찾기 재료는 곁길로 — 목록 그리기를 기다리게 하지 않는다
    const got = await fetchDir();
    if (ctx.dead() || !root.isConnected) return;
    const s2 = cwd + '|' + got.map((f) => f.path + f.mtime + f.size).join('|');
    if (s2 === sig) return;
    sig = s2;
    items = got;
    for (const p of [...sel]) if (!got.some((f) => f.path === p)) sel.delete(p);   // 사라진 것은 선택도 놓는다
    render();
  }
  function goto(dir: string): void { cwd = dir; sel.clear(); anchorPath = null; renameAt = null; sig = ''; body.scrollTop = 0; void load(); }

  // ── 선택 ────────────────────────────────────────────────────────────────
  function paintSel(): void {
    for (const n of Array.from(body.querySelectorAll('[data-fp]'))) {
      (n as HTMLElement).classList.toggle('on', sel.has((n as HTMLElement).dataset.fp || ''));
    }
    count.textContent = sel.size ? `${sel.size}개 선택` : (ordered.length ? `${ordered.length}개` : '');
    count.classList.toggle('sel', sel.size > 0);
  }
  function clickSelect(f: FileItem, e: MouseEvent): void {
    const multi = e.metaKey || e.ctrlKey;
    if (e.shiftKey && anchorPath) {
      const ai = ordered.findIndex((x) => x.path === anchorPath), ci = ordered.findIndex((x) => x.path === f.path);
      if (ai >= 0 && ci >= 0) { if (!multi) sel.clear(); for (let i = Math.min(ai, ci); i <= Math.max(ai, ci); i++) sel.add(ordered[i].path); }
    } else if (multi) {
      if (sel.has(f.path)) sel.delete(f.path); else sel.add(f.path);
      anchorPath = f.path;
    } else {
      sel.clear(); sel.add(f.path); anchorPath = f.path;
    }
    paintSel();
  }
  /** 파일을 편다. `newTab` 이면 **새 뷰어 탭**에 — 여러 개를 나란히 보려면 이 길이다(#762, 원준 2026-09-05:
   *  "자료에 있는 파일 중에서 한 번에 하나만 열 수 있는게 이상해서"). */
  function open(f: FileItem, newTab = false): void {
    if (f.type === 'dir') { goto(f.path); return; }
    // 파일을 누르면 **곁칸의 뷰어 탭**으로 편다 (#762, 원준 2026-09-04: "따로 뷰어 위젯을 띄우지 않더라도
    //  곁칸에서 탭으로 뜨면 좋겠다"). 종전엔 화면 한가운데 모달이라 ① 그 파일을 보면서 세션을 볼 수 없었고
    //  ② 뷰어 칸을 미리 넣어 둔 사람만 칸에서 볼 수 있었다. 칸이 없으면 셸이 이 신호를 듣고 만든다.
    openInViewerPart(ctx, f.path, { newTab });
  }
  /** 고른 것 여럿을 편다 — **첫 장은 보던 뷰어에, 나머지는 각자 새 탭에**. 종전엔 전부 같은 칸에 밀어 넣어
   *  마지막 하나만 남았다(「N개 열기」가 사실상 「마지막 것 열기」였다). 상한 8은 부르는 쪽이 이미 건다. */
  function openMany(list: FileItem[]): void {
    const files = list.filter((x) => x.type !== 'dir');
    if (!files.length) { for (const d of list.slice(0, 1)) open(d); return; }   // 폴더만 골랐으면 첫 폴더로 들어간다
    files.forEach((f, i) => open(f, i > 0));
  }
  function download(f: FileItem): void {
    window.open(apiUrl(pUrl('/file?path=' + encodeURIComponent(f.path) + '&download=1')), '_blank');
  }

  // 키보드 — 파인더처럼 ⌘A 전체선택 · Delete 삭제 · Esc 선택해제 · Enter 열기.
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(input|textarea)$/i.test(t.tagName))) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); sel.clear(); for (const f of ordered) sel.add(f.path); paintSel(); return; }
    if (e.key === 'Escape' && sel.size) { e.preventDefault(); sel.clear(); paintSel(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && sel.size) { e.preventDefault(); void removeMany(selItems()); return; }
    //  Enter — 하나면 그대로, 여럿이면 나란히 편다(우클릭 메뉴의 「N개 나란히 열기」와 같은 일).
    if (e.key === 'Enter' && sel.size) { e.preventDefault(); openMany(selItems().slice(0, 8)); }
  });

  // ── 우클릭 메뉴 ─────────────────────────────────────────────────────────
  function menuFor(f: FileItem | null, e: MouseEvent): void {
    e.preventDefault(); e.stopPropagation();
    if (f && !sel.has(f.path)) { sel.clear(); sel.add(f.path); anchorPath = f.path; paintSel(); }
    const many = selItems();
    const rows: Array<{ label: string; run?: () => void; danger?: boolean; sep?: boolean; off?: boolean }> = [];
    if (f) {
      rows.push({ label: many.length > 1 ? `${many.length}개 나란히 열기` : (f.type === 'dir' ? '폴더 열기' : '열기'), run: () => openMany(many.slice(0, 8)) });
      // 왼쪽 클릭과 같은 일 — 뷰어 칸이 없으면 셸이 곁칸에 만든다(종전엔 "먼저 [뷰어]를 넣어 주세요"로 돌려보냈다).
      if (f.type !== 'dir') rows.push({ label: '뷰어에서 보기', run: () => open(f) });
      //  새 탭 — 지금 보던 것을 **두고** 하나 더 편다(#762). ⌘/Ctrl+두 번 누르기와 같은 일.
      if (f.type !== 'dir') rows.push({ label: '새 뷰어 탭에서 보기', run: () => open(f, true) });
      if (f.type !== 'dir') rows.push({ label: '내려받기', run: () => { for (const x of many) if (x.type !== 'dir') download(x); } });
      rows.push({ label: '이름 바꾸기', off: many.length !== 1, run: () => { renameAt = f.path; render(); } });
      if (cwd) rows.push({ label: '상위 폴더로 옮기기', run: () => void moveMany(many.map((x) => x.path), cwd.includes('/') ? cwd.slice(0, cwd.lastIndexOf('/')) : '') });
      rows.push({ sep: true, label: '' });
      rows.push({ label: many.length > 1 ? `${many.length}개 삭제` : '삭제', danger: true, run: () => void removeMany(many) });
      rows.push({ sep: true, label: '' });
    }
    rows.push({ label: '붙여넣기', run: () => void pasteFromApi() });
    rows.push({ label: '새 폴더', run: () => void newFolder() });
    rows.push({ label: '파일 올리기…', run: () => upIn.click() });
    if (upDirSupported()) rows.push({ label: '폴더째 올리기…', run: () => upDirIn.click() });
    rows.push({ sep: true, label: '' });
    rows.push({ label: view === 'icon' ? '목록으로 보기' : '아이콘으로 보기', run: () => { view = view === 'icon' ? 'list' : 'icon'; lsSet(FV_VIEW, view); paintTools(); render(); } });
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
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('[data-fp], .pn-fhead, .pn-fnote, button, input, a')) return;
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
      if (!live) { sel.clear(); anchorPath = null; paintSel(); }   // 빈 자리 클릭 = 선택 해제
      document.body.classList.remove('lv-dragselect');
    };
    document.body.classList.add('lv-dragselect');
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
  });

  // ── 폴더로 끌어 옮기기 ──────────────────────────────────────────────────
  const DND = 'application/x-lively-assets';
  function wireDrag(node: HTMLElement, f: FileItem): void {
    node.draggable = true;
    node.addEventListener('dragstart', (e: DragEvent) => {
      if (!sel.has(f.path)) { sel.clear(); sel.add(f.path); anchorPath = f.path; paintSel(); }
      e.dataTransfer?.setData(DND, JSON.stringify(selItems().map((x) => x.path)));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    if (f.type !== 'dir') return;
    const has = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(DND);
    node.addEventListener('dragover', (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; node.classList.add('drop-in'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-in'));
    node.addEventListener('drop', (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault(); e.stopPropagation(); node.classList.remove('drop-in');
      let paths: string[] = [];
      try { paths = JSON.parse(e.dataTransfer!.getData(DND) || '[]'); } catch { /* 빈 손이면 아무 일도 없다 */ }
      if (paths.length) void moveMany(paths, f.path);
    });
  }
  /** 경로 조각(빵부스러기)에도 떨굴 수 있다 — 위로 꺼내는 가장 짧은 길이다. */
  function wireCrumbDrop(node: HTMLElement, dir: string): void {
    const has = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(DND);
    node.addEventListener('dragover', (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; node.classList.add('drop-in'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-in'));
    node.addEventListener('drop', (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault(); node.classList.remove('drop-in');
      let paths: string[] = [];
      try { paths = JSON.parse(e.dataTransfer!.getData(DND) || '[]'); } catch { /* noop */ }
      if (paths.length) void moveMany(paths, dir);
    });
  }

  // 미리보기 기계는 **공용 한 벌**(v2/file-preview.ts) — 뷰어 목록도 같은 것을 쓴다(#762).
  const pv = createPreviewKit({ fileUrl: (p2) => apiUrl(pUrl('/file?path=' + encodeURIComponent(p2))), dead: () => ctx.dead() });

  function thumb(f: FileItem, small: boolean): HTMLElement {
    // 목록 보기(20px)에선 서류를 그리지 않는다 — 그 크기에선 뭉개져 얼룩으로만 보인다.
    if (f.type === 'dir') return el('span', { class: 'pn-fic dir' + (small ? ' sm' : '') },
      folderIcon('pn-folder' + (small ? ' sm' : ''), { empty: f.empty, plain: small })) as HTMLElement;
    const k = kindOf(f.path);
    const box = el('span', { class: 'pn-fic ' + k.kind + (small ? ' sm' : ''), 'data-pv': f.path, 'data-pvk': k.kind, 'data-pvs': String(f.size || 0) },
      pnIcon(k.kind === 'page' ? 'note' : k.kind === 'video' ? 'img' : 'doc', 'pn-i')) as HTMLElement;
    if (k.kind !== 'file' && !small) pv.watch(box, f.path, k.kind, f.size || 0);
    return box;
  }

  // ── 그리기 ───────────────────────────────────────────────────────────────
  function crumbBar(): void {
    const segs = cwd ? cwd.split('/') : [];
    const kids: HTMLElement[] = [];
    const rootBtn = el('button', { class: 'pn-fcrumb' + (segs.length ? '' : ' on'), type: 'button', text: '자료', title: '맨 위 폴더', onclick: () => goto('') }) as HTMLElement;
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
    const finish = async (ok: boolean): Promise<void> => {
      if (done) return;
      done = true;
      renameAt = null;
      const nm = inp.value.trim();
      if (!ok || !nm || nm === f.name) { render(); return; }
      if (/[/\\]/.test(nm) || nm.startsWith('.')) { toast('이름에 / \\ 는 쓸 수 없고 . 로 시작할 수 없어요.', true); render(); return; }
      try { await api(pUrl('/rename'), { method: 'POST', body: JSON.stringify({ path: f.path, name: nm }) }); }
      catch (e: any) { toast('이름을 바꾸지 못했어요 — ' + (e?.message || e), true); render(); return; }
      sel.delete(f.path); sig = ''; await load();
    };
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();          // ⌘A·Delete 같은 칸 단축키가 글자 편집을 가로채지 않게
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
    });
    inp.addEventListener('blur', () => void finish(true));
    inp.addEventListener('click', (e: MouseEvent) => e.stopPropagation());
    inp.addEventListener('dblclick', (e: MouseEvent) => e.stopPropagation());
    // 확장자 앞까지만 고르게 — 파인더와 같다(대개 바꾸고 싶은 건 이름이지 확장자가 아니다).
    window.setTimeout(() => {
      inp.focus();
      const dot = f.type === 'dir' ? -1 : f.name.lastIndexOf('.');
      try { inp.setSelectionRange(0, dot > 0 ? dot : f.name.length); } catch { /* 일부 브라우저 */ }
    }, 0);
    return inp;
  }

  /** 찾는 중 행에 붙는 경로 — '어느 폴더에 있나'가 곧 찾기의 답 절반이다. */
  const dirOf = (p2: string): string => (p2.includes('/') ? p2.slice(0, p2.lastIndexOf('/')) : '');
  function itemNode(f: FileItem): HTMLElement {
    const k = f.type === 'dir' ? { kind: 'dir', type: '폴더' } : kindOf(f.path);
    const meta = f.type === 'dir' ? '폴더' : `${k.type} · ${fmtSize(f.size || 0)}`;
    const editing = renameAt === f.path;
    const node = view === 'list'
      ? el('div', { class: 'pn-frow2', 'data-fp': f.path, title: f.name },
        thumb(f, true),
        editing ? nameEditor(f) : el('b', { class: 'pn-fname1', text: f.name }),
        el('span', { class: 'pn-fcol k', text: query.trim() && dirOf(f.path) ? dirOf(f.path) : (f.type === 'dir' ? '폴더' : k.type) }),
        el('span', { class: 'pn-fcol s', text: f.type === 'dir' ? '—' : fmtSize(f.size || 0) }),
        el('span', { class: 'pn-fcol d', text: f.mtime ? relTime(new Date(f.mtime).toISOString()) : '' }))
      : el('div', { class: 'pn-fcard', 'data-fp': f.path, title: `${f.name}\n${meta}` },
        thumb(f, false),
        editing ? nameEditor(f) : el('b', { class: 'pn-fname ell2', text: f.name }),
        el('span', { class: 'pn-fmeta' }, el('span', { text: query.trim() && dirOf(f.path) ? dirOf(f.path) : (f.type === 'dir' ? '폴더' : k.type) }),
          ...(f.type === 'dir' ? [] : [el('span', { class: 'sep', text: '·' }), el('span', { text: fmtSize(f.size || 0) })])));
    const n = node as HTMLElement;
    if (editing) { n.classList.add('editing'); return n; }   // 이름을 고치는 중엔 고르기·열기·끌기가 다 쉰다
    n.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); clickSelect(f, e); });
    //  ⌘/Ctrl 을 누른 채면 **새 뷰어 탭**으로 — 브라우저에서 링크를 새 탭으로 여는 그 손짓 그대로(#762).
    n.addEventListener('dblclick', (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); open(f, e.metaKey || e.ctrlKey); });
    n.addEventListener('contextmenu', (e: MouseEvent) => menuFor(f, e));
    wireDrag(n, f);
    return n;
  }

  function render(): void {
    crumbBar();
    pv.reset();
    const q = query.trim();
    if (q) {
      //  찾을 땐 이 프로젝트 자료 **전체**에서(폴더는 뺀다 — 찾는 것은 파일이다). 매니페스트가 이미 평평한 목록이다.
      const m = findMatcher(q);
      ordered = sortItems(allFiles.filter((f) => f.type !== 'dir' && m(f.name, f.path)));
    } else ordered = sortItems(items);
    if (!ordered.length) {
      body.replaceChildren(marquee, el('div', { class: 'pn-empty' },
        pnIcon(q ? 'search' : 'drop', 'pn-i big'),
        el('b', { text: q ? '찾는 자료가 없어요.' : cwd ? '이 폴더는 비어 있어요.' : '아직 자료가 없어요.' }),
        el('p', { class: 'pn-fine', text: q ? '이름 일부로 다시 찾아보세요 — 초성(ㅍㅌ)이나 띄어쓰기 없이도 찾습니다.' : '파일이나 폴더를 이 칸에 끌어다 놓거나, 그림을 복사해 ⌘V 로 붙여넣거나, [＋ 올리기]를 누르세요. 세션이 만든 결과물도 여기 쌓입니다.' })));
      paintSel();
      return;
    }
    const wrap = el('div', { class: view === 'list' ? 'pn-flist' : 'pn-fgrid' }, ...ordered.map(itemNode));
    body.replaceChildren(marquee, wrap);
    paintSel();
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
      document.removeEventListener('paste', onPaste, true);
      document.querySelector('.pn-ctx')?.remove();
    },
  };
}
