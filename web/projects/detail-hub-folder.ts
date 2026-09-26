// projects/detail-hub-folder.ts — 허브 «공유 폴더» 위젯(#4135, 5판 시안 2026-09-25 원준: «파일 수만 보여주는 건 목적에 안 맞음.
//  최근 파일이랑 끌어다 놓기가 있어야지»).
//   1×1  최근 파일 셋(줄) + 끌어다 놓기               1×N  «폴더» 줄들 · «최근» 줄들 + 끌어다 놓기 · [업로드]
//   2×1  낱장 넷 + 끌어다 놓기 카드                    3×1  폴더 나무(150) + 낱장 여섯 + 끌어다 놓기
//   2×2+ 폴더 나무(170) + 경로 줄([＋ 폴더][업로드]) + 낱장 격자   3×2+ + 오른쪽 고른 파일(미리보기 · 크기·수정 · [열기][내려받기][공유 링크])
//  줄·낱장을 누르면 파일 뷰어(detail.ts 공장 openFile — files-cards.openFileViewer), 폴더면 그 폴더로. 업로드·끌어다 놓기는 섹션(detail-folder)과
//  같은 부품(files-upload: upDropZone · upSend · upPrecheckOverwrite · upControl). 올리고 나면 이 위젯만 다시 그린다.
import { api, el, relTime, toast } from '../core.js';
import { copyFileLink, joinRel } from '../lib/sharelink.js';
import { fileThumb } from './files-icons.js';
import { fmtSize } from './files-format.js';
import { UP_CONFIRM, authDownload, upControl, upDropZone, upPrecheckOverwrite, upProgress, upSend, upToast, type UpItem } from './files-upload.js';
import { pjvPopover } from './popover.js';
import { type Fill, btn, emptyNote, footText, hubIcon } from './detail-hub-kit.js';
import { recentFiles, splitDirs } from './detail-hub-model.js';

// 프로젝트별 «보고 있는 폴더»·«고른 파일» — 다시 그려도 남는다.
const NAV: Map<number, { path: string; picked: string }> = new Map();
const navOf = (pid: number) => { let n = NAV.get(pid); if (!n) { n = { path: '', picked: '' }; NAV.set(pid, n); } return n; };
// 하위 폴더 목록 캐시 — 같은 화면에서 필터·설정으로 다시 그릴 때 재요청을 막는다. 30초 뒤엔 다시 묻고, 실패는 캐시하지 않는다(리뷰 지적).
const DIR_CACHE: Map<string, { at: number; p: Promise<any[]> }> = new Map();
const DIR_TTL_MS = 30_000;

export const fillFolder: Fill = (ctx, f, body, foot, sub) => {
  const { o, P, pid } = ctx;
  const w = f.w, h = f.h;
  const nav = navOf(pid);
  const B = o.base;
  const open = () => ctx.openTool('folder');
  const listDir = (rel: string): Promise<any[]> => {
    if (!rel) return ctx.D.files();
    const key = pid + ':' + rel;
    const hit = DIR_CACHE.get(key);
    if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.p;
    const p = api(B + pid + '/files?path=' + encodeURIComponent(rel)).then((d: any) => (d && d.items) || [])
      .catch(() => { DIR_CACHE.delete(key); return [] as any[]; });
    DIR_CACHE.set(key, { at: Date.now(), p });
    return p;
  };
  const refresh = () => { DIR_CACHE.clear(); ctx.D.invalidate('files'); ctx.refreshGrid(); };
  const relOf = (name: string): string => (nav.path ? nav.path + '/' : '') + name;
  const openItem = (it: any, rel: string) => {
    if (it.type === 'dir') { nav.path = rel; nav.picked = ''; ctx.refreshGrid(); return; }
    if (w >= 3 && h >= 2) { nav.picked = rel; ctx.refreshGrid(); return; }   // 옆 칸이 있으면 먼저 고른다 — 열기는 옆 칸 단추
    if (o.openFile) o.openFile(rel, it.name); else open();
  };

  // ── 업로드(끌어다 놓기 · 단추) — 섹션과 같은 부품, 대상 폴더는 지금 보고 있는 곳 ──
  const progBox: HTMLElement = el('div', { class: 'pjh-prog' });
  async function uploadFiles(items: UpItem[], emptyDirs: string[], current: any[]) {
    const arr = items || [], dirs = emptyDirs || [];
    if (!arr.length && !dirs.length) return;
    const pc = upPrecheckOverwrite(arr, current);
    if (!pc.go) return;
    if (arr.length > UP_CONFIRM && !confirm(arr.length + '개 파일을 업로드합니다. 계속할까요?')) return;
    const dest = nav.path;
    const ac = new AbortController();
    const bar = upProgress(arr.length, () => ac.abort());
    progBox.append(bar.row);
    const r = await upSend({
      items: arr, emptyDirs: dirs, signal: ac.signal, overwriteNames: pc.over,
      fileUrl: (rel) => B + pid + '/file?path=' + encodeURIComponent((dest ? dest + '/' : '') + rel),
      dirUrl: (d) => B + pid + '/folder?path=' + encodeURIComponent((dest ? dest + '/' : '') + d),
      onProgress: (i, rel, pct) => bar.set(i, rel, pct),
    });
    bar.row.remove();
    upToast(r);
    refresh();
  }
  const dropBox = (wide = false): HTMLElement => el('div', { class: 'pjh-drop' + (wide ? ' wide' : '') }, hubIcon('up', 14), el('span', { text: wide ? '파일을 여기에 끌어다 놓기' : '끌어다 놓기' }));
  const mkdirBtn = (): HTMLElement => {
    const b = btn('＋ 폴더', 'btn-ghost');
    b.onclick = (e) => {
      e.stopPropagation();
      const inp = el('input', { type: 'text', class: 'pjh-search-in', placeholder: '새 폴더 이름 (Enter)', maxlength: '80' }) as HTMLInputElement;
      const menu = el('div', { class: 'pjv-menu pjh-pop' }, el('div', { class: 'pjh-pop-h', text: '새 폴더' }), inp);
      const close = pjvPopover(b, menu);
      setTimeout(() => inp.focus(), 0);
      inp.addEventListener('keydown', async (ev) => {
        if (ev.key === 'Escape') { close(); return; }
        if (ev.key !== 'Enter' || ev.isComposing) return;
        const name = inp.value.trim().replace(/[/\\]+/g, ''); if (!name) return;
        close();
        try { await api(B + pid + '/folder?path=' + encodeURIComponent(relOf(name)), { method: 'POST' }); toast('폴더를 만들었습니다'); refresh(); }
        catch (err: any) { toast('폴더 만들기 실패 — ' + (err && err.message || err), true); }
      });
    };
    return b;
  };

  body.append(el('div', { class: 'pjh-stat', text: '파일을 불러오는 중' }));
  Promise.all([ctx.D.files(), nav.path ? listDir(nav.path) : ctx.D.files()]).then(([rootItems, items]: any[][]) => {
    body.replaceChildren();
    progBox.replaceChildren();
    const root = splitDirs(rootItems);
    const cur = splitDirs(items);
    sub.textContent = rootItems.length ? '파일 ' + root.files.length + (root.dirs.length ? ' · 폴더 ' + root.dirs.length : '') : '';
    const up = upControl((picked) => { uploadFiles(picked, [], items); }, { label: '업로드' });
    const rootLabel = '루트 · 파일 ' + root.files.length + ' · 폴더 ' + root.dirs.length;
    const here = nav.path ? nav.path.split('/').pop() : '루트';
    upDropZone(body, body.closest('.pjh-w') || body, (dropped, emptyDirs) => uploadFiles(dropped, emptyDirs, items));

    const frow = (it: any): HTMLElement => {
      const rel = relOf(it.name);
      const isDir = it.type === 'dir';
      const right = el('span', { class: 'pjh-fr-r', text: isDir ? '' : fmtSize(it.size || 0) });
      if (isDir) listDir(rel).then((its: any[]) => { right.textContent = String(its.filter((x) => x.type !== 'dir').length); });   // 시안: 폴더 줄 오른쪽은 파일 수
      return el('div', { class: 'pjh-fr' + (nav.picked === rel ? ' on' : ''), title: it.name, onclick: () => openItem(it, rel) },
        el('span', { class: 'pjh-fr-th' }, tile(it, rel)),
        el('span', { class: 'pjh-fr-b' }, el('span', { class: 'pjh-fr-n', text: it.name }),
          isDir ? null : el('span', { class: 'pjh-fr-m', text: it.mtime ? relTime(new Date(it.mtime).toISOString()) : '' })),
        right);
    };
    // 낱장 아이콘 — 프로젝트 탭 공유 폴더 섹션과 같은 그림(files-icons.fileThumb: 폴더 두 톤 · 문서 색 띠 · 사진 썸네일). 크기는 CSS(.pjh-fc-ic · .pjh-fr-th · .pjh-prev-ic).
    const tile = (it: any, rel: string): HTMLElement => el('div', { class: 'pjh-fc-ic' }, fileThumb(pid, it, rel, B));
    const fcard = (it: any): HTMLElement => {
      const rel = relOf(it.name);
      return el('div', { class: 'pjh-fc' + (nav.picked === rel ? ' on' : ''), title: it.name, onclick: () => openItem(it, rel) },
        tile(it, rel),
        el('div', { class: 'pjh-fc-n', text: it.name }),
        el('div', { class: 'pjh-fc-m', text: [it.type === 'dir' ? '폴더' : fmtSize(it.size || 0), it.mtime ? relTime(new Date(it.mtime).toISOString()) : ''].filter(Boolean).join(' · ') }));
    };
    const tree = (): HTMLElement => {
      const t = el('div', { class: 'pjh-tree' });
      t.append(el('div', { class: 'pjh-tree-r' + (!nav.path ? ' on' : ''), onclick: () => { nav.path = ''; nav.picked = ''; ctx.refreshGrid(); } }, hubIcon('folder', 14), el('span', { class: 'pjh-tree-n', text: P.name || '루트' }), el('span', { class: 'pjh-tree-c', text: String(root.files.length) })));
      for (const d of root.dirs) {
        const on = nav.path === d.name || nav.path.startsWith(d.name + '/');
        const cnt = el('span', { class: 'pjh-tree-c' });
        listDir(d.name).then((its: any[]) => { cnt.textContent = String(its.filter((x) => x.type !== 'dir').length); });   // 파일 수 — 목록은 캐시(30초)
        t.append(el('div', { class: 'pjh-tree-r sub' + (on ? ' on' : ''), onclick: () => { nav.path = d.name; nav.picked = ''; ctx.refreshGrid(); } }, hubIcon('folder', 14), el('span', { class: 'pjh-tree-n', text: d.name }), cnt));
      }
      return t;
    };
    const crumb = (): HTMLElement => el('div', { class: 'pjh-crumb' },
      el('b', { text: P.name || '프로젝트' }), hubIcon('chevr', 11), el('span', { text: here }),
      el('span', { class: 'pjh-crumb-sp' }, mkdirBtn(), up.btn, up.fileIn, up.dirIn));

    if (!rootItems.length && !nav.path) {
      body.append(emptyNote('아직 올린 파일이 없습니다 — 여기에 끌어다 놓거나 업로드하세요.'), dropBox(true), progBox);
      foot.append(footText('루트'), up.btn, up.fileIn, up.dirIn, btn('폴더 열기', 'btn-ghost', open));
      return;
    }

    // 끌어다 놓기 낱장(격자의 마지막 자리) — 누르면 업로드 고르기(바닥의 [업로드] 와 같은 문). 한 줄 높이의 바닥은 [폴더 열기] 만(시안).
    const dropCard = (): HTMLElement => el('div', { class: 'pjh-fc drop', title: '파일을 끌어다 놓거나 눌러서 고르기', onclick: () => up.btn.click() }, hubIcon('up', 14), el('span', { text: '끌어다 놓기' }));
    if (w <= 1 && h <= 1) {
      const list = el('div', { class: 'pjh-frl short' });   // 1×1: 한 줄짜리 줄 셋(32px) + 끌어다 놓기 34px = 138px 안
      for (const it of recentFiles(items, 3)) list.append(frow(it));
      body.append(list, dropBox(true), progBox);
      foot.append(footText(rootLabel), up.fileIn, up.dirIn, btn('폴더 열기', 'btn-ghost', open));
      return;
    }
    if (w <= 1) {
      const list = el('div', { class: 'pjh-frl' });
      if (nav.path) list.append(el('div', { class: 'pjh-fr back', onclick: () => { nav.path = nav.path.split('/').slice(0, -1).join('/'); ctx.refreshGrid(); } }, hubIcon('left', 13), el('span', { class: 'pjh-fr-n', text: '위로' })));
      if (cur.dirs.length) { list.append(el('div', { class: 'pjh-grp' }, el('b', { text: '폴더' }), el('span', { class: 'pjh-grp-n', text: String(cur.dirs.length) }))); for (const d of cur.dirs.slice(0, 4)) list.append(frow(d)); }
      list.append(el('div', { class: 'pjh-grp' }, el('b', { text: '최근' }), el('span', { class: 'pjh-grp-n', text: String(cur.files.length) })));
      for (const it of recentFiles(items, h >= 3 ? 9 : 5)) list.append(frow(it));
      body.append(list, dropBox(true), progBox);   // 끌어다 놓기는 목록 바로 아래(바닥에 홀로 띄우지 않는다)
      foot.append(footText(rootLabel), up.btn, up.fileIn, up.dirIn, btn('폴더 열기', 'btn-ghost', open));
      return;
    }
    if (h <= 1) {
      const n = w >= 3 ? 6 : 4;
      const grid = el('div', { class: 'pjh-fgrid', style: 'grid-template-columns:repeat(' + (n + 1) + ',1fr)' });
      for (const it of recentFiles(items, n)) grid.append(fcard(it));   // 낱장은 파일만 — 폴더는 나무(3칸)·[폴더 열기]
      grid.append(dropCard());
      if (w >= 3) body.append(el('div', { class: 'pjh-two-f', style: 'grid-template-columns:150px minmax(0,1fr)' }, tree(), grid));
      else body.append(grid);
      body.append(progBox);
      foot.append(footText('최근 순 · ' + here), up.fileIn, up.dirIn, btn('폴더 열기', 'btn-ghost', open));
      return;
    }
    // 2×2 이상 — 나무 + 경로 줄 + 낱장 격자 (+ 3×2 옆 칸)
    const cols = w >= 3 ? 3 : 4;
    const grid = el('div', { class: 'pjh-fgrid tall', style: 'grid-template-columns:repeat(' + cols + ',1fr)' });
    // 낱장 한 줄 높이 = 아이콘 56 + 이름·메타 38 + 안쪽 여백 18 + 격자 간격 8 = 120px. 몸통(칸 높이 − 크롬 122)에서 경로 줄 38px 을 뺀다. 마지막 자리는 «끌어다 놓기».
    const cardPx = 120;
    const capCards = cols * Math.max(1, Math.floor((h * 276 - 16 - 122 - 38) / cardPx)) - 1;
    const shownCards = recentFiles(items, capCards);
    // 옆 칸(3×2)이 있으면 아직 고른 게 없어도 첫 낱장을 골라 둔다 — 빈 «고른 파일» 칸 대신 미리보기가 선다(시안).
    if (w >= 3 && !nav.picked && shownCards.length) nav.picked = relOf(shownCards[0].name);
    for (const it of shownCards) grid.append(fcard(it));   // 낱장은 파일만 — 폴더는 왼쪽 나무
    grid.append(dropCard());
    const main = el('div', { class: 'pjh-fmain' }, crumb(), grid, progBox);
    const parts: HTMLElement[] = [tree(), main];
    let picked: any = null;
    if (w >= 3) {
      const pr = nav.picked ? items.find((it: any) => relOf(it.name) === nav.picked) : null;
      picked = pr || null;
      const side = el('div', { class: 'pjh-side' });
      if (!picked) side.append(el('div', { class: 'pjh-side-l', text: '고른 파일' }), el('div', { class: 'pjh-stat', text: '낱장을 누르면 여기에 보입니다.' }));
      else {
        const rel = relOf(picked.name);
        side.append(el('div', { class: 'pjh-side-l', text: '고른 파일' }),
          el('div', { class: 'pjh-prev-ic' }, tile(picked, rel)),
          el('div', { class: 'pjh-side-t' }, el('span', { class: 'pjh-sr-n', text: picked.name })),
          el('div', { class: 'pjh-kv' },
            el('b', { text: '크기' }), el('span', { text: fmtSize(picked.size || 0) }),
            el('b', { text: '수정' }), el('span', { text: picked.mtime ? relTime(new Date(picked.mtime).toISOString()) : '' }),
            el('b', { text: '위치' }), el('span', { text: here })),
          el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
            el('button', { class: 'pjh-sbtn', type: 'button', onclick: () => { if (o.openFile) o.openFile(rel, picked.name); else open(); } }, hubIcon('doc', 12), '열기'),
            el('button', { class: 'pjh-sbtn ghost', type: 'button', onclick: () => authDownload(B + pid + '/file?path=' + encodeURIComponent(rel), picked.name) }, hubIcon('dl', 12), '내려받기'),
            o.shareBase ? el('button', { class: 'pjh-sbtn ghost', type: 'button', onclick: () => copyFileLink('shared', joinRel(o.shareBase!, rel), 'file') }, hubIcon('link', 12), '공유 링크') : null));
      }
      parts.push(side);
    }
    body.append(el('div', { class: 'pjh-two-f', style: 'grid-template-columns:170px minmax(0,1fr)' + (w >= 3 ? ' 300px' : '') }, ...parts));
    foot.append(footText(rootLabel + (picked ? ' · 고른 것: ' + picked.name : '')), btn('폴더 열기', 'btn-ghost', open));
  });
};
