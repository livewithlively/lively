// v2/panes-knowledge.ts — 곁칸 «지식»: 이 프로젝트에 연결된 문서 목록 + **그 칸 안의 읽기 화면** (#4443)
//
//  원준(2026-10-05): «곁칸에 있는 지식은 지식 골라서 누르면 이게 우리 앱 위에서 오른쪽에서 칸 튀어나오듯이 나오는데
//   이렇게 하지말고 그냥 곁칸에서 마크다운 이쁘게 보이도록 하는 방식이면 좋을 것 같음.»
//  종전(원준 2026-08-20 «위키로 튀지 말고 여기서 먼저»)엔 문서 전체 위에 오른쪽 시트(pn-modal)를 띄웠다 — 세션 화면을
//   덮개로 가리고, 본문은 6000자에서 잘랐다. 이제 목록과 읽기는 **한 칸 안의 두 화면**이다.
//   · 줄을 누르면 목록 자리에 읽기 화면이 선다 — 제목 · 메타 · 요약 · 본문(위키와 같은 렌더러 · 같은 모양을 사이드바 폭으로).
//   · 본문 속 지식 링크(#/k/… · [[이름]])는 그 자리에서 이어 읽는다(lib/kn-links). 뒤로는 한 칸씩, 마지막이면 목록.
//   · 목록으로: [‹ 지식] · 마우스 뒤로 단추 · 켜진 탭 다시 누르기(reselect — 목록이면 맨 위로). 보던 목록 자리는 그대로.
//   · 정독 · 고치기는 [위키에서 열기] — 그때만 화면을 떠난다.
import { api, el, relTime, renderMarkdown, replaceKids, toast } from '../core.js';
import { dropTitleH1, knHref, knNameOfHref, plainMd, wikiLinksToMd } from '../lib/kn-links.js';
import { knTitle, pnIcon, pnNote } from './panes-kit.js';
import { bindCtx, requestOpenRoute } from './ctx-registry.js';
import { copyText } from './ctx-menu.js';
import type { Part, PartCtx } from './panes-parts.js';

/** 목록의 한 줄 — rel(필요 · 산출)은 이 프로젝트와의 관계라, 본문 링크로 따라간 문서엔 없다. */
type KnRow = { name: string; title: string; rel?: string | null; type?: string | null };
/** 읽기 화면에 연 문서 하나 — top 은 그 문서를 떠날 때의 스크롤(뒤로 오면 그 자리). */
type Read = { row: KnRow; top: number };
/** GET /api/ui/knowledge/:name 의 knowledge — 읽기 화면이 쓰는 칸만. */
type KnDoc = {
  name: string; title?: string | null; type?: string | null; summary?: string | null; body_md?: string | null;
  updated_at?: string | null; categories?: Array<{ name?: string | null; key?: string | null }> | null;
};
/** 열어 둔 문서를 다시 받아 보는 간격 — 세션이 쓰고 고치는 글이라 곁에 띄워 둔 동안 낡지 않게(틱은 8초, 받기는 이 간격으로 거른다). */
const RECHECK_MS = 30_000;

export function knowledgePart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-kn' });
  const note = pnNote('lively_pn_kn_note',
    '지식은 세션들이 일하면서 계속 쓰고 고치는 글이고, 이 워크스페이스의 모든 세션이 함께 봅니다. 쌓일수록 맥락이 촘촘해져요.');
  const list = el('div', { class: 'pn-knlist' });
  const reader = el('div', { class: 'pn-knr', role: 'region', 'aria-label': '지식 읽기' });
  root.append(note, list, reader);
  let sig: string | null = null;                 // null — 첫 그림은 빈 목록이어도 그린다(빈 서명 '' 와 겹치면 안내가 안 섰다)
  //  읽기 — 연 차례(맨 끝이 지금 보는 문서). 비면 목록이다.
  let trail: Read[] = [];
  let listTop = 0;
  let openedName = '';                           // 목록에서 연 문서 — 돌아올 때 초점이 앉을 줄
  //  문서를 그릴 때마다 하나씩. 늦게 온 응답은 이미 떼어진 노드에 쓰니 화면을 덮지는 못한다 — seq 는 버려진 문서를
  //   굳이 그리지(마크다운 · 그림 · 모음 조회) 않게 거른다.
  let seq = 0;
  const docs = new Map<string, KnDoc>();         // 이번에 읽는 동안 받아 둔 문서(뒤로 올 때 다시 안 받는다) — 목록에 돌아가면 비운다
  let curScroll: HTMLElement | null = null;
  let checkedAt = 0;                             // 지금 문서를 마지막으로 받은 때(RECHECK_MS)

  function paint(): void {
    const kn = (ctx.detail()?.project || {}).knowledge || {};
    const pick = (arr: any[], rel: string): KnRow[] => (arr || []).map((k: any) => ({
      name: String(k.name), title: String(k.title || ''), rel, type: k.type ?? null,
    }));
    const all: KnRow[] = [...pick(kn.required, '필요'), ...pick(kn.produced, '산출')];
    const s2 = all.map((k) => k.rel + k.name + k.title).join('|');
    if (s2 === sig) return;
    sig = s2;
    if (!all.length) {
      replaceKids(list, el('div', { class: 'pn-empty' },
        pnIcon('doc', 'pn-i big'),
        el('b', { text: '연결된 지식이 아직 없어요.' }),
        el('p', { class: 'pn-fine', text: '세션이 만든 결론을 지식으로 남기면 여기 모입니다.' })));
      return;
    }
    replaceKids(list, all.map((k) => {
      // 제목은 **한 줄**만 — 전문은 title 속성과 읽기 화면이 갖는다(knTitle 머리말 참조).
      const row = el('button', {
        class: 'pn-knrow', type: 'button', 'data-kn': k.name, title: (k.title || k.name) + '\n눌러서 여기서 읽습니다',
        onclick: () => openFromList(k),
      }, pnIcon('doc', 'pn-i sm'),
        el('span', { class: 'n ell1', text: knTitle(k.title, k.name) }),
        el('span', { class: 'pn-knrel' + (k.rel === '산출' ? ' prod' : ''), text: k.rel || '' }));
      // #3784 우클릭 — 여기서 읽기 · 위키에서 열기 · 새 탭 · 제목/이름/링크 복사
      const href = knHref(k.name);
      bindCtx(row, () => ({
        title: knTitle(k.title, k.name), sub: `${k.rel} 지식` + (k.type ? ' · ' + k.type : ''),
        rows: [
          { label: '여기서 읽기', icon: 'eye', hint: '이 칸에서', run: () => openFromList(k) },
          { label: '위키에서 열기', icon: 'wiki', run: () => requestOpenRoute(href) },
          { label: '새 탭에서 열기', icon: 'columns', run: () => requestOpenRoute(href, true) },
          { sep: true, label: '' },
          { label: '제목 복사', icon: 'copy', run: () => void copyText(k.title || k.name).then((ok) => { if (ok) toast('복사했어요'); }) },
          { label: '지식 이름 복사', icon: 'copy', hint: k.name.length > 18 ? k.name.slice(0, 18) + '…' : k.name, run: () => void copyText(k.name).then((ok) => { if (ok) toast('복사했어요'); }) },
          { label: '링크 복사', icon: 'link', run: () => void copyText(new URL(href, location.href).toString()).then((ok) => { if (ok) toast('링크를 복사했어요'); }) },
        ],
      }));
      return row;
    }));
  }

  // ── 목록 ↔ 읽기 ─────────────────────────────────────────────────────────────
  const reading = (): boolean => trail.length > 0;
  function setMode(on: boolean): void {
    //  목록의 스크롤 자리 — 크롬은 display:none 을 지나도 지켜 주지만 거기에 기대지 않는다. 떠날 때 재 두고 돌아와서 되돌린다.
    if (on && !root.classList.contains('reading')) listTop = list.scrollTop;
    //  초점 — 읽기 화면 안(‹ · 본문 링크)에 있었으면 목록의 그 문서 줄로 돌려준다(숨는 칸에 초점이 남으면 키보드가 길을 잃는다).
    const back2row = !on && reader.contains(document.activeElement) ? openedName : '';
    root.classList.toggle('reading', on);
    if (!on) {
      seq++;                                     // 오던 응답은 그리지 않는다
      list.scrollTop = listTop; replaceKids(reader); curScroll = null; docs.clear();
      if (back2row) (list.querySelector(`[data-kn="${CSS.escape(back2row)}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
    }
  }
  function openFromList(k: KnRow): void {
    trail = [{ row: k, top: 0 }];
    openedName = k.name;
    setMode(true);
    void show({ focusBack: true });
  }
  /** 본문 속 링크로 다른 문서를 연다 — 지금 문서의 자리를 적어 두고 한 칸 쌓는다. 같은 문서면 맨 위로만. */
  function follow(name: string): void {
    const cur = trail[trail.length - 1];
    if (cur && cur.row.name === name) { if (curScroll) curScroll.scrollTop = 0; return; }
    if (cur && curScroll) cur.top = curScroll.scrollTop;
    trail.push({ row: { name, title: '' }, top: 0 });
    void show();
  }
  /** 한 칸 뒤로 — 마지막 문서였으면 목록. 돌아갈 곳이 있었으면 true. */
  function back(): boolean {
    if (!reading()) return false;
    trail.pop();
    if (trail.length) void show(); else setMode(false);
    return true;
  }
  async function fetchDoc(name: string): Promise<KnDoc | null> {
    const d: any = await api('/api/ui/knowledge/' + encodeURIComponent(name)).catch(() => null);
    const kd = (d && (d.knowledge || d)) || null;
    return kd && kd.name ? (kd as KnDoc) : null;
  }

  /** 지금 문서(trail 맨 끝)를 그린다.
   *  focusBack — 목록에서 막 열었다: 숨은 줄 대신 [‹] 에 초점. keepFocus — 열어 둔 문서를 새로 받아 다시 그린다: 초점은 건드리지 않는다. */
  async function show(o: { focusBack?: boolean; keepFocus?: boolean } = {}): Promise<void> {
    const cur = trail[trail.length - 1];
    if (!cur) return;
    const k = cur.row;
    const my = ++seq;
    const depth = trail.length;
    const backBtn = el('button', {
      class: 'pn-knr-back', type: 'button', onclick: () => back(),
      title: depth > 1 ? '앞 문서로 돌아갑니다' : '지식 목록으로 돌아갑니다',
    }, pnIcon('chevL', 'pn-i sm'), el('span', { text: depth > 1 ? '뒤로' : '지식' }));
    const wiki = el('a', { class: 'pn-knr-open', href: knHref(k.name), title: '위키에서 열기 — 처음부터 정독하거나 고칠 때' },
      pnIcon('wiki', 'pn-i sm'), el('span', { text: '위키에서 열기' }));
    //  본문 링크로 따라온 문서는 줄의 제목이 없다 — 받기 전까지 머리를 비워 둔다(슬러그를 제목처럼 세우지 않는다).
    const titleEl = el('h2', { class: 'pn-knr-t', text: k.title ? knTitle(k.title, k.name) : '' });
    const head = el('header', { class: 'pn-knr-head' }, titleEl);
    const body = el('div', { class: 'pn-knr-body' }, el('p', { class: 'pn-fine pn-knr-wait', role: 'status', text: '불러오는 중…' }));
    const scroll = el('div', { class: 'pn-knr-scroll' }, head, body);
    replaceKids(reader, el('div', { class: 'pn-knr-bar' }, backBtn, wiki), scroll);
    curScroll = scroll;
    //  초점 — 목록에서 열었으면 [‹] 로(누른 줄은 숨었다), 본문 링크 · 뒤로로 넘어왔으면 새 머리줄의 [‹] 로(누른 것은 사라졌다).
    if (!o.keepFocus && (o.focusBack || reader.contains(document.activeElement) || document.activeElement === document.body)) backBtn.focus({ preventScroll: true });

    let kd = docs.get(k.name) || null;
    if (!kd) {
      kd = await fetchDoc(k.name);
      if (my !== seq) return;                    // 그 사이 다른 문서를 열었다 — 이 응답은 그리지 않는다
      if (kd) { docs.set(k.name, kd); checkedAt = Date.now(); }
    }
    if (!kd) {
      replaceKids(body, el('div', { class: 'pn-knr-err', role: 'status' },
        el('p', { text: '내용을 불러오지 못했어요.' }),
        el('a', { class: 'btn btn-sm', href: knHref(k.name) }, el('span', { text: '위키에서 열기' }))));
      return;
    }
    const full = String(kd.title || '').trim();
    const short = knTitle(full || k.title, k.name);
    titleEl.textContent = short;
    const fullText = plainMd(full);
    //  원 제목은 세 줄까지만(긴 설명이 본문을 밀어내지 않게) — 누르거나 Enter · Space 로 펼친다. 전문은 title 에도.
    const fullEl = full && fullText !== short ? el('p', {
      class: 'pn-knr-full', role: 'button', tabindex: '0', 'aria-expanded': 'false', title: full, text: fullText,
    }) as HTMLElement : null;
    if (fullEl) {
      const toggle = (): void => { fullEl.setAttribute('aria-expanded', String(fullEl.classList.toggle('open'))); };
      fullEl.addEventListener('click', toggle);
      fullEl.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    replaceKids(head, titleEl, fullEl,
      el('div', { class: 'pn-knr-meta' },
        k.rel ? el('span', { class: 'pn-knrel' + (k.rel === '산출' ? ' prod' : ''), text: k.rel }) : null,
        kd.type ? el('span', { class: 'pn-knr-tag', text: String(kd.type) }) : null,
        (kd.categories || []).slice(0, 2).map((c) => el('span', { class: 'pn-knr-tag', text: String(c.name || c.key || '') })),
        kd.updated_at ? el('span', { class: 'pn-fine', text: relTime(String(kd.updated_at)) + ' 갱신' }) : null));
    //  본문 첫 줄의 H1 이 제목을 되풀이하면 턴다(머리에 이미 있다) — 다른 말이면 둔다(lib/kn-links dropTitleH1).
    const md = wikiLinksToMd(dropTitleH1(String(kd.body_md || ''), [full, short]));
    const mdEl = md.trim() ? el('div', { class: 'pn-knr-md md-rendered' }, renderMarkdown(md)) as HTMLElement : null;
    //  바깥 주소(http · https)는 새 탭으로 — 세션 옆에서 읽다가 누르면 세션 화면째 떠나 버린다.
    mdEl?.querySelectorAll<HTMLAnchorElement>('a[href^="http://"], a[href^="https://"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; });
    replaceKids(body,
      kd.summary ? el('p', { class: 'pn-knr-sum', text: String(kd.summary) }) : null,
      mdEl || el('p', { class: 'pn-fine', text: '본문이 비어 있어요.' }),
      el('footer', { class: 'pn-knr-foot' },
        el('span', { class: 'pn-knr-name', title: '지식 이름', text: k.name }),
        el('button', { class: 'btn-text', type: 'button', title: '이 문서의 링크를 복사합니다',
          onclick: () => void copyText(new URL(knHref(k.name), location.href).toString()).then((ok) => { if (ok) toast('링크를 복사했어요'); }) },
        pnIcon('link', 'pn-i sm'), el('span', { text: '링크 복사' }))));
    scroll.scrollTop = cur.top || 0;
  }
  /** 열어 둔 문서를 다시 받아 본다(RECHECK_MS 마다) — 바뀌었으면 보던 자리를 지키며 다시 그린다. */
  async function recheck(): Promise<void> {
    const cur = trail[trail.length - 1];
    if (!cur || Date.now() - checkedAt < RECHECK_MS) return;
    checkedAt = Date.now();
    const my = seq;
    const kd = await fetchDoc(cur.row.name);
    if (my !== seq || !kd || trail[trail.length - 1] !== cur) return;      // 그 사이 다른 문서로 갔다
    const old = docs.get(cur.row.name);
    if (old && old.updated_at === kd.updated_at && old.body_md === kd.body_md && old.title === kd.title) return;
    docs.set(cur.row.name, kd);
    if (curScroll) cur.top = curScroll.scrollTop;
    void show({ keepFocus: true });
  }

  //  본문 속 지식 링크 — 주소를 바꾸지 않고 이 칸에서 이어 읽는다(새 탭 · 보조키는 브라우저에 맡긴다). 본문(.pn-knr-md) 안의 것만 —
  //   머리줄 · 실패 안내의 [위키에서 열기] 는 일부러 화면을 떠나는 단추다.
  reader.addEventListener('click', (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || !a.closest('.pn-knr-md') || !reader.contains(a)) return;
    const name = knNameOfHref(a.getAttribute('href'));
    if (!name) return;
    e.preventDefault();
    follow(name);
  });
  //  마우스 옆 단추(뒤로) — 읽는 중이면 브라우저 뒤로가기 대신 한 칸 뒤로(자료 칸과 같은 손).
  root.addEventListener('mousedown', (e: MouseEvent) => { if (e.button === 3 && reading()) e.preventDefault(); });
  root.addEventListener('mouseup', (e: MouseEvent) => { if (e.button === 3 && reading()) { e.preventDefault(); back(); } });

  paint();
  return {
    root,
    tick: () => { paint(); if (reading()) void recheck(); },
    //  켜진 탭을 또 눌렀다 — 읽던 중이면 목록으로, 목록이면 맨 위로(iOS 탭 막대 · 자료 칸의 «처음으로»).
    reselect: () => { if (reading()) { trail = []; setMode(false); } else list.scrollTop = 0; },
    destroy: () => { seq++; },
  };
}
