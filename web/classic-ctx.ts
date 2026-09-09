// classic-ctx.ts — 클래식 화면(위키 · 프로젝트 보드 · 그 밖의 액자 안 페이지)의 우클릭 메뉴(#3784).
//  새 셸은 이 화면들을 iframe(액자)에 싣는다. 액자 안은 다른 문서라 셸의 배선(v2/main.ts)이 닿지 않으므로
//  **같은 엔진·같은 배선을 이 문서에서 한 번 더** 건다. 셸 탭이 필요한 일(새 탭에서 열기)은 부모 창에 한 줄 보낸다
//  (ctx-registry.requestOpenRoute → 'lively:open-route').
//  행의 실체는 화면마다 이미 있는 ⋯ 메뉴를 그대로 누른다(pjv-trow-more · wk-more) — 같은 일을 두 벌로 만들지 않는다.
import { api, toast } from './core.js';
import { copyText, type CtxRow } from './v2/ctx-menu.js';
import { mountCtxMenus, registerCtx, registerCtxCommon, registerCtxSurface, requestOpenRoute } from './v2/ctx-registry.js';
import { commonRows } from './v2/ctx-shell.js';
import { openKnHistory } from './wiki-history.js';
import { openWikiPeek } from './wiki-doc.js';

const absUrl = (href: string): string => { try { return new URL(href, location.href).toString(); } catch (_) { return href; } };
const copyRow = (label: string, text: string | (() => Promise<string>), done = '복사했어요', icon = 'copy'): CtxRow => ({
  label, icon, run: () => {
    const p = typeof text === 'function' ? text() : Promise.resolve(text);
    void p.then((t) => copyText(t)).then((ok) => { if (ok) toast(done); }).catch((e: any) => toast((e && e.message) || '복사하지 못했어요', true));
  },
});
const openRows = (href: string, label = '열기'): CtxRow[] => [
  { label, icon: 'open', run: () => requestOpenRoute(href) },
  { label: '새 탭에서 열기', icon: 'columns', hint: '셸 탭', run: () => requestOpenRoute(href, true) },
];
/** 행 끝 ⋯ 를 대신 눌러 그 화면의 정식 메뉴를 연다 — 우클릭에서 「더 보기…」 한 줄로. */
const moreRow = (host: HTMLElement, sel: string, label = '더 보기…'): CtxRow[] => {
  const b = host.querySelector(sel) as HTMLElement | null;
  return b ? [{ label, icon: 'sliders', run: () => b.click() }] : [];
};
const bodyMd = async (name: string): Promise<string> => {
  const d: any = await api('/api/ui/knowledge/' + encodeURIComponent(name));
  const k = (d && (d.knowledge || d)) || {};
  return String(k.body_md || '');
};

let mounted = false;
export function mountClassicCtx(): void {
  if (mounted) return;
  mounted = true;
  document.body.dataset.ctxSurface = 'classic';
  mountCtxMenus(document.body, { longPress: true, menuKey: true });

  // ── 위키 ──────────────────────────────────────────────────────────────
  const wikiDocRows = (name: string, title: string, host: HTMLElement, o: { page?: boolean } = {}): { rows: CtxRow[]; title: string; sub: string } => {
    const href = '#/k/' + encodeURIComponent(name);
    const rows: CtxRow[] = [];
    if (!o.page) rows.push(...openRows(href), { label: '살짝 보기', icon: 'eye', hint: '이 화면 위에', run: () => openWikiPeek(name, { originEl: host }) });
    else rows.push({ label: '새 탭에서 열기', icon: 'columns', hint: '셸 탭', run: () => requestOpenRoute(href, true) });
    rows.push({ label: '변경 이력', icon: 'clock', run: () => openKnHistory(name, {}) });
    rows.push({ sep: true, label: '' });
    rows.push(copyRow('제목 복사', title));
    rows.push(copyRow('지식 이름 복사', name));
    rows.push(copyRow('마크다운 원문 복사', () => bodyMd(name), '원문을 복사했어요'));
    rows.push(copyRow('링크 복사', absUrl(href), '링크를 복사했어요', 'link'));
    rows.push(...moreRow(host, '.pjv-trow-more, .wk-more'));
    return { rows, title, sub: o.page ? '지식 문서' : '지식' };
  };
  registerCtx('wikidoc', (hit) => {
    const name = String(hit.data.name || ''); if (!name) return null;
    return wikiDocRows(name, String(hit.data.title || name), hit.el);
  });
  registerCtx('wikipage', (hit) => {
    const name = String(hit.data.name || ''); if (!name) return null;
    const title = (hit.el.querySelector('.wk-doc-title') as HTMLElement | null)?.textContent?.trim() || name;
    return wikiDocRows(name, title, hit.el, { page: true });
  });
  registerCtx('wikifolder', (hit) => {
    const name = String(hit.data.name || ''); if (!name) return null;
    return { rows: [{ label: '열기', icon: 'folder', run: () => (hit.el.querySelector('.wk-ttitle') as HTMLElement | null)?.click() }, copyRow('폴더 이름 복사', String(hit.data.title || name))], title: String(hit.data.title || name), sub: '폴더' };
  });

  // ── 프로젝트 보드 ────────────────────────────────────────────────────
  registerCtx('pboard', (hit) => {
    const id = String(hit.data.projId || ''); if (!id) return null;
    const name = String(hit.data.projName || '프로젝트');
    const href = '#/projects2/p/' + id;
    return {
      title: name, sub: '프로젝트',
      rows: [
        ...openRows(href),
        { label: '세션 화면으로', icon: 'chat', hint: '셸 탭', run: () => requestOpenRoute('#/p/' + id, true) },
        { sep: true, label: '' },
        copyRow('이름 복사', name),
        copyRow('링크 복사', absUrl(href), '링크를 복사했어요', 'link'),
        ...moreRow(hit.el, ':scope > .pjv-trow .pjv-trow-more'),
      ],
    };
  });
  registerCtx('ptask', (hit) => {
    const id = String(hit.data.taskId || ''); if (!id) return null;
    const name = String(hit.data.taskName || '할 일');
    const href = '#/projects2/t/' + id;
    return {
      title: name, sub: hit.data.taskLevel === 'subtask' ? '하위 작업' : '작업',
      rows: [
        { label: '상세 열기', icon: 'open', run: () => (hit.el.querySelector(':scope > .pjv-trow .pjv-trow-title') as HTMLElement | null)?.click() },
        { sep: true, label: '' },
        copyRow('이름 복사', name),
        copyRow('링크 복사', absUrl(href), '링크를 복사했어요', 'link'),
        ...moreRow(hit.el, ':scope > .pjv-trow .pjv-trow-more'),
      ],
    };
  });

  // ── 빈 자리 · 공통 ───────────────────────────────────────────────────
  registerCtxSurface('classic', () => {
    const h = location.hash || '';
    const rows: CtxRow[] = [];
    if (/^#\/(knowledge|k)\b/.test(h)) rows.push({ label: '새 문서', icon: 'plus', run: () => requestOpenRoute('#/knowledge/new') }, { label: 'WIKI 첫 화면', icon: 'wiki', run: () => requestOpenRoute('#/knowledge') });
    rows.push({ label: '새로고침', icon: 'refresh', run: () => location.reload() });
    return rows;
  });
  registerCtxCommon((ev) => commonRows(ev, { openRoute: requestOpenRoute }));
}
