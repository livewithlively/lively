// sessions-find.ts — 세션 이력 앱 「대화 찾기」 탭(#4553 안 A, 원준 2026-10-04).
//  앱의 일: 지난 대화에서 **그 말**을 찾아 그 자리로 간다. 결과는 세션이 아니라 맞은 말 하나가 한 줄이고(앞뒤 말과 함께),
//  누르면 오른쪽 칸에 대화록이 그 말의 자리로 열린다. 검색어가 없으면 최근 대화를 날짜 묶음으로 보여 준다.
//  ⚠ 대화 본문은 신뢰할 수 없다 — 글은 전부 textContent 로만 넣는다(innerHTML 금지).
//  모양(원준 2026-10-05): 왼쪽 카드 = 찾기 칸 · 알약 고르개 · 결과(그 안에서 스크롤), 오른쪽 카드 = 대화록. 맞은 말 한 줄은
//   «말한 쪽 · 세션 · 언제» 머리 아래 앞 말 – 맞은 말 – 뒤 말이 한 가닥으로 서고, 맞은 말만 가닥 위에 파랗게 선다.
import { api, el, toast } from './core.js';
import { mountTranscript, setTranscriptDoor } from './sessions.js';
import { btnOf, dropMySessions, emptyBox, errBox, ico, leftPanel, loadMySessions, pickOf, searchBox, selectOf, shellHref, skelRows, transcriptHref } from './sessions-kit.js';
import { markRanges, type HitRef } from './session-history.js';
import { PERIODS, periodSince, dayBucket, whenLabel, inPeriod, type OmniPeriod } from './lib/omni-order.js';

interface Hit {
  node_id: string; session_id: string; name: string | null; project: string | null;
  role: 'user' | 'assistant'; ts: string | null; text: string; terms: number;
  before: { role: string; text: string } | null; after: { role: string; text: string } | null;
}
interface Picked { sid: string; node: string; name: string; hit: HitRef | null; words: string[]; /** 줄을 가르는 열쇠의 꼬리 — 시각이 같은 두 말(한 줄의 글 블록들)을 가른다. */ mark?: string; /** 대화록 머리의 부제(프로젝트 · 언제). */ sub?: string }

const HIT_STEP = 30, HIT_MAX = 100, RECENT_STEP = 50;
type RoleKey = '' | 'user' | 'assistant';
const ROLES: ReadonlyArray<{ key: RoleKey; label: string }> = [
  { key: '', label: '누구 말이든' }, { key: 'user', label: '내 지시' }, { key: 'assistant', label: 'AI 답' },
];
//  탭을 떠났다 와도, 대화록 페이지에 다녀와도 찾던 자리가 그대로다(화면이 다시 그려질 때 이 값에서 되살린다).
const st = { q: '', period: 'all' as OmniPeriod, project: '', role: '' as RoleKey, limit: HIT_STEP, shown: RECENT_STEP, picked: null as Picked | null };
let seq = 0;
let aborter: AbortController | null = null;

/** 글에 낱말을 칠해 넣는다 — 글 노드와 <mark> 만 만든다. */
function markInto(parent: HTMLElement, text: string, words: string[]): void {
  let at = 0;
  for (const [s, e] of markRanges(text, words)) {
    if (s > at) parent.append(text.slice(at, s));
    parent.append(el('mark', { class: 'sess-hl', text: text.slice(s, e) }));
    at = e;
  }
  if (at < text.length) parent.append(text.slice(at));
}
const who = (role: string): string => (role === 'assistant' ? 'AI' : '나');

export function mountFind(host: HTMLElement, opts: { q?: string; onQuery?: (q: string) => void } = {}): void {
  if (typeof opts.q === 'string' && opts.q !== st.q) { st.q = opts.q; st.limit = HIT_STEP; }
  const input = el('input', { type: 'text', class: 'shx-input', placeholder: '대화 내용으로 찾기', value: st.q, 'aria-label': '대화 내용으로 찾기', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const projSel = el('select', { class: 'shx-select', 'aria-label': '프로젝트' }, el('option', { value: '', text: '모든 프로젝트' })) as HTMLSelectElement;
  const count = el('div', { class: 'shx-count', role: 'status' });
  const list = el('div', { class: 'shx-results' });
  const pane = el('section', { class: 'shx-card shx-pane', 'aria-label': '대화록' }) as HTMLElement;
  const rerun = (): void => { st.limit = HIT_STEP; st.shown = RECENT_STEP; void run(); };
  const projPick = pickOf(projSel, 'projMini') as HTMLElement & { repaint?: () => void };
  const filters = el('div', { class: 'shx-filters' },
    pickOf(selectOf(PERIODS, st.period, (v) => { st.period = v; rerun(); }, '기간'), 'clock'),
    projPick,
    pickOf(selectOf(ROLES, st.role, (v) => { st.role = v; rerun(); }, '말한 쪽'), 'person'));
  projSel.addEventListener('change', () => { st.project = projSel.value; rerun(); });
  host.replaceChildren(el('div', { class: 'shx-split' },
    el('section', { class: 'shx-card shx-master', 'aria-label': '대화 찾기' },
      el('div', { class: 'shx-mhead' }, searchBox(input, () => { st.q = ''; fire(true); }), filters, count),
      list),
    pane));

  // 프로젝트 고르개 — 내 세션이 붙어 있는 프로젝트들(최근에 쓴 것부터) + 「프로젝트 없음」.
  void loadMySessions().then((d) => {
    const seen = new Map<string, string>();
    for (const s of d.sessions) if (s.project_id != null && !seen.has(String(s.project_id))) seen.set(String(s.project_id), String(s.project_name || '#' + s.project_id));
    for (const [id, name] of seen) projSel.append(el('option', { value: id, text: name }));
    projSel.append(el('option', { value: '0', text: '프로젝트 없음' }));
    projSel.value = st.project;
    if (projSel.value !== st.project) { st.project = ''; projSel.value = ''; }   // 고른 프로젝트가 더는 없다
    if (projPick.repaint) projPick.repaint();
  }).catch(() => { /* 목록을 못 받아도 찾기는 된다 */ });

  const openPicked = (p: Picked | null, scroll = false): void => {
    st.picked = p;
    for (const a of Array.from(list.querySelectorAll('.shx-row')) as HTMLElement[]) a.classList.toggle('sel', !!p && a.dataset.pick === pickKey(p));
    if (!p) { pane.replaceChildren(emptyBox({ icon: 'chat', big: true, title: '대화록이 여기 열립니다', text: '왼쪽에서 줄을 누르면 그 말의 자리로 대화록이 열립니다.' })); return; }
    void mountTranscript(pane, { sid: p.sid, node: p.node, q: '', ln: '' }, {
      embedded: true, words: p.words, hit: p.hit, name: p.name, sub: p.sub,
      //  그 대화를 돌리는 박스를 알게 되면 머리의 「이어 질문하기」를 「세션 열기」로 바꾼다 — 세션으로 가는 문은 하나다.
      rail: () => leftPanel(p.sid, p.node, (r) => { if (r.box_id && st.picked === p) setTranscriptDoor(pane, r.box_id); }),
      onTrashed: () => { dropMySessions(); openPicked(null); void run(); },
    });
    if (scroll && pane.getBoundingClientRect().top > window.innerHeight * 0.6) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });   // 좁은 화면(한 칸)에서는 대화록이 아래에 있다
  };
  const pickKey = (p: Picked): string => p.sid + '|' + p.node + '|' + (p.hit ? p.hit.role + '|' + (p.hit.ts || '') : '') + '|' + (p.mark || '');
  const rowLink = (p: Picked, ...kids: unknown[]): HTMLElement => {
    const a = el('a', { class: 'shx-row' + (st.picked && pickKey(st.picked) === pickKey(p) ? ' sel' : ''), href: shellHref(transcriptHref(p.sid, p.node)), 'data-pick': pickKey(p) }, ...kids) as HTMLAnchorElement;
    a.addEventListener('click', (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) { try { sessionStorage.setItem('sessReturn', location.hash || '#/sessions'); } catch { /* */ } return; }
      e.preventDefault();
      openPicked(p, true);
    });
    return a;
  };
  const moreBtn = (text: string, onClick: () => void): HTMLElement => { const b = btnOf(text, { kind: 'ghost', cls: 'shx-more' }); b.addEventListener('click', onClick); return b; };
  const grpEl = (label: string, n: number): HTMLElement => el('div', { class: 'shx-grp' }, el('span', { class: 'shx-grp-l', text: label }), el('span', { class: 'shx-grp-n', text: String(n) })) as HTMLElement;
  const projEl = (name: string | null | undefined): HTMLElement => el('span', { class: 'shx-proj' + (name ? '' : ' none') }, ico(name ? 'projMini' : 'projNone'), el('span', { text: name || '프로젝트 없음' })) as HTMLElement;

  // ── 검색어 없음: 최근 대화 ──
  async function drawRecent(mySeq: number): Promise<void> {
    count.textContent = '불러오는 중…';
    if (!list.childElementCount) list.replaceChildren(skelRows(6));
    let d;
    try { d = await loadMySessions(); }
    catch (e: any) { if (mySeq === seq) { count.textContent = ''; list.replaceChildren(errBox(e?.message || '세션 목록을 불러오지 못했습니다.')); } return; }
    if (mySeq !== seq) return;
    const now = Date.now(), since = periodSince(st.period, now);
    const rows = d.sessions.filter((s: any) => inPeriod(Date.parse(s.last_seen), since)
      && (st.project === '' || (st.project === '0' ? s.project_id == null : String(s.project_id) === st.project)));
    count.replaceChildren(el('span', { class: 'shx-count-m' }, '최근 대화 ', el('b', { text: `${rows.length}개` })),
      ...(d.truncated ? [el('span', { class: 'shx-count-note' }, ico('info'), el('span', { text: '더 오래된 세션은 여기 다 서지 않습니다(2,000개까지)' }))] : []));
    const kids: HTMLElement[] = [];
    //  묶음 머리의 수는 그 묶음 전체의 수다(지금 보이는 줄 수가 아니다).
    const perBucket = new Map<string, number>();
    for (const s of rows) { const b = dayBucket(Date.parse(s.last_seen), now); perBucket.set(b, (perBucket.get(b) || 0) + 1); }
    let bucket = '';
    for (const s of rows.slice(0, st.shown)) {
      const at = Date.parse(s.last_seen);
      const b = dayBucket(at, now);
      if (b !== bucket) { bucket = b; kids.push(grpEl(b, perBucket.get(b) || 0)); }
      const name = String(s.name || s.title || s.session_id);
      const when = whenLabel(at, now);
      kids.push(rowLink({ sid: String(s.session_id), node: String(s.node_id || ''), name, hit: null, words: [], sub: [s.project_name || '프로젝트 없음', when].filter(Boolean).join(' · ') },
        el('div', { class: 'shx-row-h' }, el('div', { class: 'shx-row-t', text: name, title: name }), el('span', { class: 'shx-row-when', text: when })),
        el('div', { class: 'shx-row-f' }, projEl(s.project_name))));
    }
    if (!rows.length) kids.push(emptyBox(d.sessions.length
      ? { icon: 'search', title: '이 기간·프로젝트에 맞는 대화가 없습니다.', text: '기간이나 프로젝트를 넓혀 보세요.' }
      : { icon: 'sess', title: '중앙에 기록된 세션이 없습니다.', text: '관리 ▸ 세션 공유를 켜고 `lively backfill` 로 기존 기록을 올리세요.' }));
    if (rows.length > st.shown) kids.push(moreBtn(`더 보기 (${rows.length - st.shown}개 남음)`, () => { st.shown += RECENT_STEP; void run(); }));
    list.replaceChildren(...kids);
  }

  // ── 검색어 있음: 맞은 말 ──
  async function drawHits(mySeq: number, q: string): Promise<void> {
    count.textContent = '찾는 중…';
    list.classList.add('busy');
    const qs = new URLSearchParams({ q, limit: String(st.limit) });
    const since = periodSince(st.period, Date.now());
    if (since) qs.set('since', new Date(since).toISOString());
    if (st.role) qs.set('role', st.role);
    if (st.project !== '') qs.set('project', st.project);
    aborter = new AbortController();
    let d: any;
    try { d = await api('/api/ui/v6/session-search/messages?' + qs.toString(), { signal: aborter.signal }); }
    catch (e: any) {
      if (mySeq !== seq || (e && e.name === 'AbortError')) return;
      count.textContent = '';
      list.classList.remove('busy');
      list.replaceChildren(errBox(e?.message || '대화를 찾지 못했습니다.'));
      return;
    }
    if (mySeq !== seq) return;
    list.classList.remove('busy');
    const hits: Hit[] = Array.isArray(d?.hits) ? d.hits : [];
    const words: string[] = Array.isArray(d?.words) ? d.words.map(String) : [];
    const now = Date.now();
    //  수 한 줄 + (색인이 아직 따라오는 중이면) 안내 한 줄 — 안내가 수를 밀어내지 않게 줄을 가른다.
    count.replaceChildren(
      ...(hits.length ? [el('span', { class: 'shx-count-m' }, '맞은 말 ', el('b', { text: `${d.total}곳${d.capped ? ' 이상' : ''}` }), ' · 세션 ', el('b', { text: `${d.sessions}개` }))] : []),
      ...(typeof d?.pending === 'number' && d.pending > 0 ? [el('span', { class: 'shx-count-note' }, ico('info'), el('span', { text: `대화 색인을 만드는 중입니다 — 세션 ${d.pending}개의 대화는 아직 못 찾을 수 있습니다` }))] : []));
    const kids: HTMLElement[] = hits.map((h) => {
      const name = String(h.name || '이름 없는 세션');
      const text = el('div', { class: 'shx-hit' });
      markInto(text, h.text, words);
      const ctx = (l: { role: string; text: string } | null): HTMLElement | null => l ? el('div', { class: 'shx-ctx' }, el('b', { text: who(l.role) }), el('span', { text: l.text })) : null;
      const when = whenLabel(h.ts ? Date.parse(h.ts) : undefined, now);
      return rowLink({ sid: h.session_id, node: h.node_id, name, hit: { role: h.role, ts: h.ts }, words, mark: h.text.slice(0, 48), sub: [h.project || '프로젝트 없음', when].filter(Boolean).join(' · ') },
        el('div', { class: 'shx-row-h' },
          el('span', { class: 'shx-role ' + (h.role === 'user' ? 'me' : 'ai'), text: h.role === 'user' ? '내 지시' : 'AI 답' }),
          el('b', { class: 'shx-row-n', text: name, title: name }),
          el('span', { class: 'shx-row-when', text: when })),
        el('div', { class: 'shx-thread' }, ctx(h.before), text, ctx(h.after)),
        el('div', { class: 'shx-row-f' }, projEl(h.project)));
    });
    if (!hits.length) kids.push(emptyBox({ icon: 'search', title: '맞은 말이 없습니다.', text: '기간이나 프로젝트를 넓히거나 다른 낱말로 찾아 보세요.' }));
    else if (hits.length < Number(d.total || 0)) {
      if (st.limit < HIT_MAX) kids.push(moreBtn('더 보기', () => { st.limit = Math.min(HIT_MAX, st.limit + HIT_STEP); void run(); }));
      else kids.push(el('p', { class: 'shx-note', text: `앞의 ${HIT_MAX}곳만 보여 줍니다. 기간·프로젝트·말한 쪽으로 좁혀 보세요.` }));
    }
    list.replaceChildren(...kids);
  }

  async function run(): Promise<void> {
    const mySeq = ++seq;
    if (aborter) { aborter.abort(); aborter = null; }   // 글자를 더 치면 앞 요청을 끊는다
    const q = st.q.trim();
    list.classList.remove('busy');
    if (!q) return drawRecent(mySeq);
    if (q.length > 200) { count.textContent = ''; list.replaceChildren(errBox('검색어가 너무 깁니다(200자 이하).')); return; }
    return drawHits(mySeq, q);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (now: boolean): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    const go = (): void => {
      //  이 탭이 화면에서 떨어진 뒤(다른 화면으로 갔다)에 도는 늦은 타이머 — 남의 화면 주소를 덮거나 새로 선 탭의 순번을 흔들지 않는다.
      if (!host.isConnected) return;
      st.limit = HIT_STEP; st.shown = RECENT_STEP; if (opts.onQuery) opts.onQuery(st.q.trim()); void run();
    };
    if (now) go(); else timer = setTimeout(go, 250);
  };
  input.addEventListener('input', () => { st.q = input.value; fire(false); });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing) return;   // 한글 조합 중의 Enter 는 글자를 맺는 키다
    if (e.key === 'Enter') { st.q = input.value; fire(true); }
    else if (e.key === 'Escape' && input.value) { input.value = ''; st.q = ''; fire(true); }
  });

  openPicked(st.picked);
  void run().catch((e) => toast(e?.message || '대화 찾기를 열지 못했습니다.'));
}
