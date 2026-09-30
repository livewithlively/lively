// projects/detail-hub-folder.ts — 허브 «공유 폴더» 위젯(#4135, 5판 시안 2026-09-25 원준: «파일 수만 보여주는 건 목적에 안 맞음.
//  최근 파일이랑 끌어다 놓기가 있어야지»).
//   1×1  최근 파일 셋(줄) + 끌어다 놓기               1×N  «폴더» 줄들 · «최근» 줄들 + 끌어다 놓기 · [업로드]
//   2×1  낱장 넷 + 끌어다 놓기 카드                    3×1  폴더 나무(150) + 낱장 여섯 + 끌어다 놓기
//   2×2+ 폴더 나무(170) + 경로 줄([＋ 폴더][업로드]) + 낱장 격자   3×2+ + 오른쪽 고른 파일(미리보기 · 크기·수정 · [열기][내려받기][공유 링크])
//   모달 **곁칸 «자료» 부품 그대로**(v2/panes-files filesPart) + 오른쪽 «고른 파일»(내용 미리보기 · 종류·크기·수정·경로 · 단추)
//
//  ★ 그림은 곁칸 «자료» 와 한 벌이다(원준 2026-09-27: «미리보기가 하나도 안 뜬다 · 곁칸이랑 같은 디자인으로») —
//    파일은 내용이 보이는 미리보기(v2/file-preview 의 같은 기계), 폴더는 곁칸의 폴더 그림(panes-kit folderIcon),
//    보이는 것도 같은 규칙(레포 워크트리 · 휴지통 · 기계 파일은 가린다). 확장자 알약만 선 타일은 걷었다.
//  ★ 줄·낱장·빈 자리 전부 우클릭 메뉴(detail-hub-kit hubCtx). 모달은 부품이 제 메뉴를 가진다.
//  줄·낱장을 누르면 파일 뷰어(detail.ts 공장 openFile — files-cards.openFileViewer), 폴더면 그 폴더로. 업로드·끌어다 놓기는 섹션(detail-folder)과
//  같은 부품(files-upload: upDropZone · upSend · upPrecheckOverwrite · upControl). 올리고 나면 이 위젯만 다시 그린다.
import { api, apiUrl, el, relTime, toast } from '../core.js';
import { copyFileLink, joinRel } from '../lib/sharelink.js';
import { createPreviewKit, type PreviewKit } from '../v2/file-preview.js';
import { MACHINE_FILES, NOISE_RE, PV_PAGE_W, TRASH_DIR, authHeaders, folderIcon, freeName, kindOf, pnIcon } from '../v2/panes-kit.js';
import { deleteEntry, renameEntry } from './files-cards.js';
import { fmtSize } from './files-format.js';
import { UP_CONFIRM, authDownload, upControl, upDirSupported, upDropZone, upPrecheckOverwrite, upProgress, upSend, upToast, type UpItem } from './files-upload.js';
import { pjvPopover } from './popover.js';
import { type CtxRow, type Fill, SEP, btn, copyRow, emptyNote, footText, hubCtx, hubCtxSurface, hubIcon } from './detail-hub-kit.js';
import { recentFiles, splitDirs } from './detail-hub-model.js';

// 프로젝트별 «보고 있는 폴더»·«고른 파일» — 다시 그려도 남는다.
type Nav = { path: string; picked: string; sort: 'recent' | 'name' | 'size' };
const NAV: Map<number, Nav> = new Map();
const navOf = (pid: number): Nav => { let n = NAV.get(pid); if (!n) { n = { path: '', picked: '', sort: 'recent' }; NAV.set(pid, n); } return n; };
// 하위 폴더 목록 캐시 — 같은 화면에서 필터·설정으로 다시 그릴 때 재요청을 막는다. 30초 뒤엔 다시 묻고, 실패는 캐시하지 않는다(리뷰 지적).
const DIR_CACHE: Map<string, { at: number; p: Promise<any[]> }> = new Map();
const DIR_TTL_MS = 30_000;
// 미리보기 기계 — 위젯·모달마다 한 벌. 다시 그릴 때 앞의 것을 거둔다(받아 둔 그림 주소를 놓아 준다).
const KITS: Map<string, PreviewKit> = new Map();

type Entry = { name: string; type: string; size?: number; mtime?: number; empty?: boolean; repo?: boolean };
type Picked = { name: string; path: string; type: string; size: number; mtime: number; empty?: boolean };

/** 곁칸 «자료» 와 같은 것만 보인다 — 레포 워크트리(코드는 git 의 것) · 맨 위의 휴지통 · 기계가 만드는 파일 · 빌드 잡음. */
const visible = (items: any[], dir: string): Entry[] => (items || []).filter((it) => {
  const nm = String(it.name);
  if (it.repo) return false;
  if (nm === TRASH_DIR && !dir) return false;
  if (MACHINE_FILES.has(nm)) return false;
  return !NOISE_RE.test('/' + nm + '/');
});
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const whenFull = (ms: number): string => {
  if (!ms) return '';
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ' · ' + relTime(d.toISOString());
};

// ── 내용 미리보기(옆 칸) — 곁칸 뷰어·프로젝트 파일 뷰어와 같은 렌더러(lib/file-preview). 시안(html)만은 데스크톱 폭으로 펴서 줄여 보인다 ──
//  (옆 칸 폭 그대로 그리면 데스크톱용 시안이 휴대폰 배치로 접혀 «그 파일» 로 안 읽힌다 — 낱장 미리보기와 같은 이유, panes-kit PV_PAGE_W).
const PV_AUTO_MAX: Record<string, number> = { page: 12e6, text: 2e6, pdf: 20e6, img: 24e6, video: 80e6, audio: 80e6, office: 12e6, file: 4e6 };
function previewStage(pid: number, B: string, f: Picked): { node: HTMLElement; start: () => void } {
  const node = el('div', { class: 'pjh-fprev' }) as HTMLElement;
  const k = kindOf(f.path);
  const url = B + pid + '/file?path=' + encodeURIComponent(f.path);
  const get = (u: string, extra: Record<string, string> = {}): Promise<Response> => fetch(apiUrl(u), { headers: { ...authHeaders(), ...extra } });
  const msg = (t: string, ...kids: any[]): HTMLElement => el('div', { class: 'pjh-fprev-msg' }, el('span', { text: t }), ...kids) as HTMLElement;
  const load = async (): Promise<void> => {
    node.className = 'pjh-fprev';
    node.replaceChildren(msg('미리보기를 불러오는 중…'));
    try {
      if (k.kind === 'page') {
        let r = await get(url, { Range: 'bytes=0-1500000' });
        if (r.status === 416) r = await get(url);
        if (!r.ok) throw new Error(String(r.status));
        const raw = await r.text();
        if (!node.isConnected) return;
        //  srcdoc + 빈 sandbox — 스크립트·폼·상위 접근을 모두 막는다(곁칸 낱장과 같은 규율).
        const frame = el('iframe', { class: 'pjh-fprev-page', sandbox: '', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLIFrameElement;
        frame.srcdoc = raw.slice(0, 1_500_000);
        const fit = (): void => {
          const w = node.clientWidth || 300, h = node.clientHeight || 240, s = w / PV_PAGE_W;
          frame.style.width = PV_PAGE_W + 'px';
          frame.style.height = Math.ceil(h / s) + 'px';
          frame.style.transform = 'scale(' + s.toFixed(4) + ')';
        };
        node.classList.add('page');
        node.replaceChildren(frame);
        fit();
        if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(() => { if (!node.isConnected) { ro.disconnect(); return; } fit(); }); ro.observe(node); }
        return;
      }
      const { buildFilePreview } = await import('../lib/file-preview.js');
      const out = await buildFilePreview({
        name: f.name, size: f.size || undefined,
        fetchView: () => get(url), fetchDownload: () => get(url + '&download=1'),
        mkBtn: (label: string, onClick: () => void) => el('button', { class: 'pjh-sbtn ghost', type: 'button', text: label, onclick: onClick }),
      });
      if (!node.isConnected) return;
      node.classList.add('k-' + k.kind);
      node.replaceChildren(...(out.tools.length ? [el('div', { class: 'pjh-fprev-tools' }, ...out.tools)] : []), el('div', { class: 'pjh-fprev-body' }, out.body));
    } catch (_) {
      if (node.isConnected) node.replaceChildren(msg('미리보기를 불러오지 못했습니다 — 「열기」 로 확인하세요.'));
    }
  };
  const start = (): void => {
    if ((f.size || 0) > (PV_AUTO_MAX[k.kind] ?? 4e6)) {
      node.replaceChildren(msg('큰 파일(' + fmtSize(f.size) + ')이라 바로 불러오지 않았습니다.',
        el('button', { class: 'pjh-sbtn ghost', type: 'button', text: '미리보기 불러오기', onclick: () => void load() })));
    } else void load();
  };
  return { node, start };
}

export const fillFolder: Fill = (ctx, f, body, foot, sub) => {
  const { o, P, pid } = ctx;
  const w = f.w, h = f.h;
  const modal = !!f.modal;
  const nav = navOf(pid);
  const B = o.base;
  const open = () => ctx.openTool('folder');
  const enc = encodeURIComponent;
  const fileUrl = (rel: string): string => B + pid + '/file?path=' + enc(rel);
  const listDir = (rel: string): Promise<any[]> => {
    if (!rel) return ctx.D.files();
    const key = pid + ':' + rel;
    const hit = DIR_CACHE.get(key);
    if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.p;
    const p = api(B + pid + '/files?path=' + enc(rel)).then((d: any) => (d && d.items) || [])
      .catch(() => { DIR_CACHE.delete(key); return [] as any[]; });
    DIR_CACHE.set(key, { at: Date.now(), p });
    return p;
  };
  const drop = (): void => { DIR_CACHE.clear(); ctx.D.invalidate('files'); };
  const refresh = () => { drop(); ctx.refreshGrid(); };
  const relOf = (name: string): string => (nav.path ? nav.path + '/' : '') + name;
  const openFile = (rel: string, name: string): void => { if (o.openFile) o.openFile(rel, name); else open(); };
  const download = (rel: string, name: string): void => { void authDownload(apiUrl(fileUrl(rel) + '&download=1'), name); };
  const shareLink = (rel: string, isDir: boolean): void => { if (o.shareBase) copyFileLink('shared', joinRel(o.shareBase, rel), isDir ? 'dir' : 'file'); };

  // ── 항목 하나의 우클릭 행 — 위젯 줄·낱장과 옆 칸이 같이 쓴다 ──
  const itemRows = (it: { name: string; type: string; size?: number }, rel: string, goDir: (rel: string) => void, after: () => void): Array<CtxRow | null> => {
    const isDir = it.type === 'dir';
    return [
      { label: isDir ? '폴더 열기' : '열기', icon: isDir ? 'folder' : 'open', run: () => { if (isDir) goDir(rel); else openFile(rel, it.name); } },
      isDir ? null : { label: '내려받기', icon: 'download', run: () => download(rel, it.name) },
      SEP,
      o.shareBase ? { label: '공유 링크 복사', icon: 'link', run: () => shareLink(rel, isDir) } : null,
      copyRow('이름 복사', it.name),
      copyRow('경로 복사', rel),
      SEP,
      { label: '이름 바꾸기', icon: 'pen', run: () => renameEntry(pid, rel, it.name, isDir, after, B) },
      { label: '삭제', icon: 'trash', danger: true, run: () => { void deleteEntry(pid, rel, it.name, isDir, after, B); } },
    ];
  };

  // ── 옆 칸 «고른 것» — 모달과 3×2 위젯이 같이 쓴다. 같은 상태로 다시 부르면 아무것도 하지 않는다(미리보기를 다시 받지 않게) ──
  let sideKey = '';
  const paintDetail = (side: HTMLElement, st: { cwd: string; items: Picked[]; selected: Picked[] }, goDir: (rel: string) => void, after: () => void): void => {
    const key = st.cwd + '|' + st.selected.map((x) => x.path + ':' + x.mtime + ':' + x.size).join(',') + '|' + st.items.length;
    if (key === sideKey && side.childElementCount) return;
    sideKey = key;
    const kids: any[] = [];
    const acts = (...bs: any[]): HTMLElement => el('div', { class: 'pjh-side-acts pjh-fside-acts' }, ...bs) as HTMLElement;
    const sbtn = (label: string, icon: string, fn: () => void, ghost = true): HTMLElement =>
      el('button', { class: 'pjh-sbtn' + (ghost ? ' ghost' : ''), type: 'button', onclick: fn }, hubIcon(icon, 12), label) as HTMLElement;
    let starter: (() => void) | null = null;
    if (st.selected.length === 1) {
      const x = st.selected[0];
      const isDir = x.type === 'dir';
      const k = isDir ? { kind: 'dir', type: '폴더' } : kindOf(x.path);
      kids.push(el('div', { class: 'pjh-side-l', text: isDir ? '고른 폴더' : '고른 파일' }));
      if (isDir) {
        kids.push(el('div', { class: 'pjh-fprev dir' }, folderIcon('pn-folder', { empty: !!x.empty })));
        const inside = el('span', { text: '세는 중…' });
        listDir(x.path).then((its) => { const v = splitDirs(visible(its, x.path)); inside.textContent = '파일 ' + v.files.length + ' · 폴더 ' + v.dirs.length; });
        kids.push(el('div', { class: 'pjh-fside-n', text: x.name }),
          el('div', { class: 'pjh-kv' },
            el('b', { text: '종류' }), el('span', { text: '폴더' }),
            el('b', { text: '안에 든 것' }), inside,
            el('b', { text: '수정' }), el('span', { text: whenFull(x.mtime) }),
            el('b', { text: '경로' }), el('span', { class: 'pjh-mono', text: x.path })),
          acts(sbtn('폴더 열기', 'folder', () => goDir(x.path), false), o.shareBase ? sbtn('공유 링크', 'link', () => shareLink(x.path, true)) : null));
      } else {
        const pvw = previewStage(pid, B, x);
        starter = pvw.start;
        const ext = (x.name.match(/\.([A-Za-z0-9]{1,8})$/) || [])[1];
        kids.push(pvw.node, el('div', { class: 'pjh-fside-n', text: x.name }),
          el('div', { class: 'pjh-kv' },
            el('b', { text: '종류' }), el('span', { text: k.type + (ext ? ' · ' + ext.toUpperCase() : '') }),
            el('b', { text: '크기' }), el('span', { text: fmtSize(x.size || 0) }),
            el('b', { text: '수정' }), el('span', { text: whenFull(x.mtime) }),
            el('b', { text: '위치' }), el('span', { text: dirOf(x.path) || '맨 위' }),
            el('b', { text: '경로' }), el('span', { class: 'pjh-mono', text: x.path })),
          acts(sbtn('열기', 'doc', () => openFile(x.path, x.name), false), sbtn('내려받기', 'dl', () => download(x.path, x.name)),
            o.shareBase ? sbtn('공유 링크', 'link', () => shareLink(x.path, false)) : null));
      }
      hubCtx(side, x.name, isDir ? '폴더' : k.type, () => itemRows(x, x.path, goDir, after));
    } else if (st.selected.length > 1) {
      const files = st.selected.filter((x) => x.type !== 'dir');
      const total = files.reduce((a, x) => a + (x.size || 0), 0);
      kids.push(el('div', { class: 'pjh-side-l', text: '고른 것 ' + st.selected.length + '개' }),
        el('div', { class: 'pjh-fside-list' }, ...st.selected.slice(0, 40).map((x) => el('div', { class: 'pjh-fside-li' },
          x.type === 'dir' ? el('span', { class: 'pn-fic dir sm' }, folderIcon('pn-folder sm', { plain: true })) : el('span', { class: 'pn-fic sm' }, pnIcon('doc', 'pn-i')),
          el('span', { class: 'pjh-fside-lin', text: x.name }), el('span', { class: 'pjh-fside-lis', text: x.type === 'dir' ? '폴더' : fmtSize(x.size || 0) })))),
        el('div', { class: 'pjh-kv' },
          el('b', { text: '파일' }), el('span', { text: files.length + '개 · ' + fmtSize(total) }),
          el('b', { text: '폴더' }), el('span', { text: (st.selected.length - files.length) + '개' })),
        acts(files.length ? sbtn('내려받기 ' + files.length, 'dl', () => { for (const x of files) download(x.path, x.name); }, false) : null));
      hubCtx(side, '고른 것 ' + st.selected.length + '개', '파일 ' + files.length + ' · 폴더 ' + (st.selected.length - files.length), () => [files.length ? { label: files.length + '개 내려받기', icon: 'download', run: () => { for (const x of files) download(x.path, x.name); } } : null]);
    } else {
      const v = splitDirs(st.items as any[]);
      const total = (v.files as any[]).reduce((a, x) => a + (Number(x.size) || 0), 0);
      const name = st.cwd ? st.cwd.split('/').pop() || '' : (P.name || '프로젝트');
      kids.push(el('div', { class: 'pjh-side-l', text: '지금 폴더' }),
        el('div', { class: 'pjh-fprev dir' }, folderIcon('pn-folder', { empty: !st.items.length })),
        el('div', { class: 'pjh-fside-n', text: name }),
        el('div', { class: 'pjh-kv' },
          el('b', { text: '안에 든 것' }), el('span', { text: '파일 ' + v.files.length + ' · 폴더 ' + v.dirs.length }),
          el('b', { text: '크기' }), el('span', { text: fmtSize(total) }),
          el('b', { text: '경로' }), el('span', { class: 'pjh-mono', text: st.cwd || '/' })),
        el('div', { class: 'pjh-fside-tip' },
          el('div', {}, el('b', { text: '한 번' }), ' 누르면 고르고 여기에 미리보기가 섭니다'),
          el('div', {}, el('b', { text: '두 번' }), ' 누르면 파일이 열리고 폴더로 들어갑니다'),
          el('div', {}, el('b', { text: '오른쪽 단추' }), ' 로 이름 바꾸기 · 옮기기 · 삭제 · 공유 링크')),
        acts(o.shareBase && st.cwd ? sbtn('이 폴더 공유 링크', 'link', () => shareLink(st.cwd, true)) : null));
      hubCtx(side, name, '지금 폴더', () => [copyRow('경로 복사', st.cwd || '/'), o.shareBase && st.cwd ? { label: '공유 링크 복사', icon: 'link', run: () => shareLink(st.cwd, true) } : null]);
    }
    side.replaceChildren(...kids.filter(Boolean));
    if (starter) starter();
  };

  // ══ 모달 — 곁칸 «자료» 부품을 그대로 세우고, 오른쪽에 «고른 것» 칸 ══════════════════════════════════
  if (modal) {
    body.append(el('div', { class: 'pjh-stat', text: '파일을 불러오는 중' }));
    const paintSub = (): void => { ctx.D.files().then((its) => { const r = splitDirs(visible(its, '')); sub.textContent = '파일 ' + r.files.length + (r.dirs.length ? ' · 폴더 ' + r.dirs.length : ''); }); };
    paintSub();
    const footTxt = footText('');
    foot.append(footTxt);
    void import('../v2/panes-files.js').then(({ filesPart }) => {
      if (!body.isConnected) return;
      const side = el('div', { class: 'pjh-side pjh-fside', 'data-mscroll': 'fside' }) as HTMLElement;
      let goDir: (rel: string) => void = () => { /* 부품이 선 뒤에 채운다 */ };
      const after = (): void => { drop(); paintSub(); part.tick?.(); };
      const part = filesPart({
        id: pid,
        dead: () => !body.isConnected,
        startDir: nav.path,
        rootLabel: P.name || '자료',
        openFile: (x) => openFile(x.path, x.name),
        onFiles: () => { drop(); paintSub(); },
        onState: (st) => {
          nav.path = st.cwd;
          nav.picked = st.selected.length === 1 && st.selected[0].type !== 'dir' ? st.selected[0].path : '';
          paintDetail(side, st as any, goDir, after);
          const v = splitDirs(st.items as any[]);
          const total = (v.files as any[]).reduce((a, x) => a + (Number(x.size) || 0), 0);
          const here = st.cwd ? '«' + (st.cwd.split('/').pop() || '') + '»' : '맨 위';
          footTxt.textContent = ctx.narrow ? here + ' · 파일 ' + v.files.length + ' · 폴더 ' + v.dirs.length
            : here + ' · 파일 ' + v.files.length + ' · 폴더 ' + v.dirs.length + ' · ' + fmtSize(total) + (st.selected.length ? ' — ' + st.selected.length + '개 고름' : ' — 한 번 누르면 고르고, 두 번 누르면 엽니다');
        },
        extraRows: (x, many) => [
          o.shareBase && many.length === 1 ? { label: '공유 링크 복사', run: () => shareLink(x.path, x.type === 'dir') } : null,
          many.length === 1 ? { label: '경로 복사', run: copyRow('경로 복사', x.path).run } : null,
        ].filter(Boolean) as CtxRow[],
      });
      //  폴더로 들어가기 — 부품의 경로 줄·두 번 누르기와 같은 길을 밖에서 부른다: 그 폴더의 낱장을 두 번 누른 것과 같다.
      goDir = (rel: string): void => {
        const card = part.root.querySelector('[data-fp="' + (window.CSS && CSS.escape ? CSS.escape(rel) : rel) + '"]') as HTMLElement | null;
        if (card) card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      };
      body.replaceChildren(el('div', { class: 'pjh-fm' }, el('div', { class: 'pjh-fm-main' }, part.root), side));
      //  곁칸은 셸이 8초마다 tick 을 준다 — 여기선 모달이 떠 있는 동안 우리가 준다. 닫히면(떨어져 나가면) 거둔다.
      const timer = window.setInterval(() => {
        if (!body.isConnected) { window.clearInterval(timer); part.destroy?.(); return; }
        part.tick?.();
      }, 8000);
    });
    return;
  }

  // ══ 위젯 ══════════════════════════════════════════════════════════════════════════════════
  const kitKey = pid + ':w';
  KITS.get(kitKey)?.destroy();
  const pv = createPreviewKit({ fileUrl: (p2) => apiUrl(fileUrl(p2)), dead: () => !body.isConnected });
  KITS.set(kitKey, pv);
  /** 곁칸 «자료» 의 그림 그대로 — card: 낱장(내용 미리보기) · row: 줄(44×36 미리보기) · icon: 20px 아이콘(한 줄 높이가 낮은 자리). */
  const thumb = (it: Entry, rel: string, size: 'card' | 'row' | 'icon'): HTMLElement => {
    const extra = size === 'row' ? ' pv' : size === 'icon' ? ' sm' : '';
    if (it.type === 'dir') return el('span', { class: 'pn-fic dir' + extra }, folderIcon('pn-folder' + (size === 'icon' ? ' sm' : ''), { empty: !!it.empty, plain: size === 'icon' })) as HTMLElement;
    const k = kindOf(rel);
    const box = el('span', { class: 'pn-fic ' + k.kind + extra, 'data-pv': rel, 'data-pvk': k.kind, 'data-pvs': String(it.size || 0) },
      pnIcon(k.kind === 'page' ? 'note' : k.kind === 'video' ? 'img' : 'doc', 'pn-i')) as HTMLElement;
    if (k.kind !== 'file' && size !== 'icon') pv.watch(box, rel, k.kind, Number(it.size) || 0, Number(it.mtime) || 0);   // 판을 주면 같은 판은 다시 받지 않는다(#3870)
    return box;
  };
  const goDir = (rel: string): void => { nav.path = rel; nav.picked = ''; ctx.refreshGrid(); };
  const openItem = (it: Entry, rel: string) => {
    if (it.type === 'dir') { goDir(rel); return; }
    if (w >= 3 && h >= 2) { nav.picked = rel; ctx.refreshGrid(); return; }   // 옆 칸이 있으면 먼저 고른다 — 열기는 옆 칸 단추
    openFile(rel, it.name);
  };
  const withMenu = <T extends HTMLElement>(node: T, it: Entry, rel: string): T =>
    hubCtx(node, it.name, it.type === 'dir' ? '폴더' : kindOf(rel).type + ' · ' + fmtSize(it.size || 0), () => itemRows(it, rel, goDir, refresh));

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
      fileUrl: (rel) => B + pid + '/file?path=' + enc((dest ? dest + '/' : '') + rel),
      dirUrl: (d) => B + pid + '/folder?path=' + enc((dest ? dest + '/' : '') + d),
      onProgress: (i, rel, pct) => bar.set(i, rel, pct),
    });
    bar.row.remove();
    upToast(r);
    refresh();
  }
  const dropBox = (wide = false): HTMLElement => el('div', { class: 'pjh-drop' + (wide ? ' wide' : '') }, hubIcon('up', 14), el('span', { text: wide ? '파일을 여기에 끌어다 놓기' : '끌어다 놓기' }));
  const makeFolder = async (name: string): Promise<boolean> => {
    try { await api(B + pid + '/folder?path=' + enc(relOf(name)), { method: 'POST' }); toast('폴더를 만들었습니다'); return true; }
    catch (err: any) { toast('폴더 만들기 실패 — ' + (err && err.message || err), true); return false; }
  };
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
        if (await makeFolder(name)) refresh();
      });
    };
    return b;
  };

  body.append(el('div', { class: 'pjh-stat', text: '파일을 불러오는 중' }));
  Promise.all([ctx.D.files(), nav.path ? listDir(nav.path) : ctx.D.files()]).then(([rootRaw, raw]: any[][]) => {
    body.replaceChildren();
    progBox.replaceChildren();
    const rootItems = visible(rootRaw, '');
    const items = visible(raw, nav.path);
    const root = splitDirs(rootItems as any[]);
    const cur = splitDirs(items as any[]);
    sub.textContent = rootItems.length ? '파일 ' + root.files.length + (root.dirs.length ? ' · 폴더 ' + root.dirs.length : '') : '';
    const up = upControl((picked) => { uploadFiles(picked, [], items); }, { label: '업로드' });
    const rootLabel = '맨 위 · 파일 ' + root.files.length + ' · 폴더 ' + root.dirs.length;
    const here = nav.path ? nav.path.split('/').pop() : '맨 위';
    const card = (body.closest('.pjh-w') || body) as HTMLElement;
    upDropZone(body, card, (dropped, emptyDirs) => uploadFiles(dropped, emptyDirs, items));
    //  빈 자리 우클릭 — 새 폴더 · 올리기 · 크게 열기. 새 폴더는 곁칸처럼 먼저 만들고 그 자리에서 이름을 묻는다.
    hubCtxSurface(card, () => [
      { label: '새 폴더', icon: 'folder', run: () => { const nm = freeName(new Set(items.map((x) => String(x.name))), '새 폴더'); void makeFolder(nm).then((ok) => { if (!ok) return; refresh(); renameEntry(pid, relOf(nm), nm, true, refresh, B); }); } },
      { label: '파일 올리기…', icon: 'upload', run: () => (up.fileIn as HTMLInputElement).click() },
      upDirSupported() ? { label: '폴더째 올리기…', icon: 'upload', run: () => (up.dirIn as HTMLInputElement).click() } : null,
      nav.path ? { label: '위 폴더로', icon: 'chevL', run: () => goDir(dirOf(nav.path)) } : null,
      SEP,
      { label: '크게 열기', icon: 'window', run: open },
      nav.path && o.shareBase ? { label: '이 폴더 공유 링크 복사', icon: 'link', run: () => shareLink(nav.path, true) } : null,
    ], '공유 폴더 · ' + here);

    const frow = (it: Entry, short = false): HTMLElement => {
      const rel = relOf(it.name);
      const isDir = it.type === 'dir';
      const right = el('span', { class: 'pjh-fr-r', text: isDir ? '' : fmtSize(it.size || 0) });
      if (isDir) listDir(rel).then((its: any[]) => { right.textContent = String(visible(its, rel).filter((x) => x.type !== 'dir').length); });   // 시안: 폴더 줄 오른쪽은 파일 수
      return withMenu(el('div', { class: 'pjh-fr' + (nav.picked === rel ? ' on' : ''), title: it.name, onclick: () => openItem(it, rel) },
        el('span', { class: 'pjh-fr-th' }, thumb(it, rel, short ? 'icon' : 'row')),
        el('span', { class: 'pjh-fr-b' }, el('span', { class: 'pjh-fr-n', text: it.name }),
          isDir ? null : el('span', { class: 'pjh-fr-m', text: [kindOf(rel).type, it.mtime ? relTime(new Date(it.mtime).toISOString()) : ''].filter(Boolean).join(' · ') })),
        right) as HTMLElement, it, rel);
    };
    //  낱장 — 곁칸 «자료» 의 카드(.pn-fcard) 그대로: 미리보기 · 이름 두 줄 · 종류 · 크기. 위젯에선 한 번 눌러 연다(고르기는 3×2 옆 칸).
    const fcard = (it: Entry): HTMLElement => {
      const rel = relOf(it.name);
      const isDir = it.type === 'dir';
      const meta = el('span', { class: 'pn-fmeta' }, el('span', { text: isDir ? '폴더' : kindOf(rel).type }),
        ...(isDir ? [] : [el('span', { class: 'sep', text: '·' }), el('span', { text: fmtSize(it.size || 0) })]));
      return withMenu(el('div', { class: 'pn-fcard pjh-fcard' + (nav.picked === rel ? ' on' : ''), title: it.name + '\n' + (isDir ? '폴더' : kindOf(rel).type + ' · ' + fmtSize(it.size || 0)), onclick: () => openItem(it, rel) },
        thumb(it, rel, 'card'), el('b', { class: 'pn-fname ell2', text: it.name }), meta) as HTMLElement, it, rel);
    };
    const tree = (): HTMLElement => {
      const t = el('div', { class: 'pjh-tree' });
      t.append(el('div', { class: 'pjh-tree-r' + (!nav.path ? ' on' : ''), onclick: () => goDir('') }, el('span', { class: 'pn-fic dir sm' }, folderIcon('pn-folder sm', { plain: true })), el('span', { class: 'pjh-tree-n', text: P.name || '맨 위' }), el('span', { class: 'pjh-tree-c', text: String(root.files.length) })));
      for (const d of root.dirs as Entry[]) {
        const on = nav.path === d.name || nav.path.startsWith(d.name + '/');
        const cnt = el('span', { class: 'pjh-tree-c' });
        listDir(d.name).then((its: any[]) => { cnt.textContent = String(visible(its, d.name).filter((x) => x.type !== 'dir').length); });   // 파일 수 — 목록은 캐시(30초)
        t.append(withMenu(el('div', { class: 'pjh-tree-r sub' + (on ? ' on' : ''), onclick: () => goDir(d.name) }, el('span', { class: 'pn-fic dir sm' }, folderIcon('pn-folder sm', { plain: true })), el('span', { class: 'pjh-tree-n', text: d.name }), cnt) as HTMLElement, d, d.name));
      }
      return t;
    };
    //  경로 줄 — 조각을 눌러 올라간다(여러 단계 들어가도 줄이 넘치지 않게 조각은 줄어든다).
    const crumb = (): HTMLElement => {
      const segs = nav.path ? nav.path.split('/') : [];
      const c = el('div', { class: 'pjh-crumb' }, el('button', { class: 'pjh-crumb-b' + (segs.length ? '' : ' on'), type: 'button', text: P.name || '프로젝트', title: '맨 위 폴더', onclick: () => goDir('') }));
      segs.forEach((sg, i) => c.append(hubIcon('chevr', 11), el('button', { class: 'pjh-crumb-b' + (i === segs.length - 1 ? ' on' : ''), type: 'button', text: sg, title: segs.slice(0, i + 1).join('/'), onclick: () => goDir(segs.slice(0, i + 1).join('/')) })));
      c.append(el('span', { class: 'pjh-crumb-sp' }, mkdirBtn(), up.btn, up.fileIn, up.dirIn));
      return c;
    };

    if (!rootItems.length && !nav.path) {
      body.append(emptyNote('아직 올린 파일이 없습니다 — 여기에 끌어다 놓거나 업로드하세요.'), dropBox(true), progBox);
      foot.append(footText('맨 위'), up.btn, up.fileIn, up.dirIn, btn('폴더 열기', 'btn-ghost', open));
      return;
    }

    // 끌어다 놓기 낱장(격자의 마지막 자리) — 누르면 업로드 고르기(바닥의 [업로드] 와 같은 문). 한 줄 높이의 바닥은 [폴더 열기] 만(시안).
    const dropCard = (): HTMLElement => el('div', { class: 'pjh-fc drop', title: '파일을 끌어다 놓거나 눌러서 고르기', onclick: () => up.btn.click() }, hubIcon('up', 14), el('span', { text: '끌어다 놓기' }));
    if (w <= 1 && h <= 1) {
      const list = el('div', { class: 'pjh-frl short' });   // 1×1: 한 줄짜리 줄 셋(32px) + 끌어다 놓기 34px = 138px 안
      for (const it of recentFiles(items as any[], 3) as Entry[]) list.append(frow(it, true));
      body.append(list, dropBox(true), progBox);
      foot.append(footText(rootLabel), up.fileIn, up.dirIn, btn('폴더 열기', 'btn-ghost', open));
      return;
    }
    if (w <= 1) {
      const list = el('div', { class: 'pjh-frl' });
      if (nav.path) list.append(el('div', { class: 'pjh-fr back', onclick: () => goDir(dirOf(nav.path)) }, hubIcon('left', 13), el('span', { class: 'pjh-fr-n', text: '위로' })));
      const dirsShown = cur.dirs as Entry[];   // 자르지 않는다 — 넘치면 목록 안에서 스크롤(2026-09-27)
      if (dirsShown.length) { list.append(el('div', { class: 'pjh-grp' }, el('b', { text: '폴더' }), el('span', { class: 'pjh-grp-n', text: String(cur.dirs.length) }))); for (const d of dirsShown) list.append(frow(d)); }
      list.append(el('div', { class: 'pjh-grp' }, el('b', { text: '최근' }), el('span', { class: 'pjh-grp-n', text: String(cur.files.length) })));
      for (const it of recentFiles(items as any[], 9999) as Entry[]) list.append(frow(it));
      list.setAttribute('data-mscroll', 'frl');
      body.append(list, dropBox(true), progBox);   // 끌어다 놓기는 목록 바로 아래(바닥에 홀로 띄우지 않는다)
      foot.append(footText(rootLabel), up.btn, up.fileIn, up.dirIn, btn('폴더 열기', 'btn-ghost', open));
      return;
    }
    if (h <= 1) {
      const n = w >= 3 ? 6 : 4;
      const grid = el('div', { class: 'pjh-fgrid', style: 'grid-template-columns:repeat(' + (n + 1) + ',minmax(0,1fr))' });
      for (const it of recentFiles(items as any[], n) as Entry[]) grid.append(fcard(it));   // 낱장은 파일만 — 폴더는 나무(3칸)·[폴더 열기]
      grid.append(dropCard());
      if (w >= 3) body.append(el('div', { class: 'pjh-two-f', style: 'grid-template-columns:150px minmax(0,1fr)' }, tree(), grid));
      else body.append(grid);
      body.append(progBox);
      foot.append(footText('최근 순 · ' + here), up.fileIn, up.dirIn, btn('폴더 열기', 'btn-ghost', open));
      return;
    }
    // 2×2 이상 — 나무 + 경로 줄 + 낱장 격자 (+ 3×2 옆 칸). 전부 세우고 격자 안에서 스크롤한다.
    const grid = el('div', { class: 'pjh-fgrid tall auto', 'data-mscroll': 'files' });
    const shown = [...(nav.path ? (cur.dirs as Entry[]) : []), ...(recentFiles(items as any[], 9999) as Entry[])];   // 맨 위의 폴더는 왼쪽 나무에 있다 — 들어간 폴더 안의 하위 폴더는 낱장으로
    // 옆 칸(3×2)이 있으면 아직 고른 게 없어도 첫 낱장을 골라 둔다 — 빈 «고른 파일» 칸 대신 미리보기가 선다(시안).
    const firstFile = shown.find((it) => it.type !== 'dir');
    if (w >= 3 && (!nav.picked || !items.some((it) => relOf(it.name) === nav.picked)) && firstFile) nav.picked = relOf(firstFile.name);
    for (const it of shown) grid.append(fcard(it));
    grid.append(dropCard());
    const main = el('div', { class: 'pjh-fmain' }, crumb(), grid, progBox);
    const parts: HTMLElement[] = [tree(), main];
    let picked: Entry | null = null;
    if (w >= 3) {
      picked = (nav.picked ? items.find((it) => relOf(it.name) === nav.picked) : null) || null;
      const side = el('div', { class: 'pjh-side pjh-fside', 'data-mscroll': 'fside' }) as HTMLElement;
      const asPicked = (it: Entry): Picked => ({ name: it.name, path: relOf(it.name), type: it.type, size: Number(it.size) || 0, mtime: Number(it.mtime) || 0, empty: it.empty });
      parts.push(side);
      //  붙은 뒤에 채운다 — 미리보기는 상자가 화면에 있어야 폭을 재고 받는다.
      queueMicrotask(() => paintDetail(side, { cwd: nav.path, items: items.map(asPicked), selected: picked ? [asPicked(picked)] : [] }, goDir, refresh));
    }
    body.append(el('div', { class: 'pjh-two-f', style: 'grid-template-columns:170px minmax(0,1fr)' + (w >= 3 ? ' 300px' : '') }, ...parts));
    foot.append(footText(rootLabel + (picked ? ' · 고른 것: ' + picked.name : '')));
    foot.append(btn('폴더 열기', 'btn-ghost', open));
  });
};
