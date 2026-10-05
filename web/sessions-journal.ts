// sessions-journal.ts — 세션 이력 앱 「작업 일지」 탭(#4553 안 B, 원준 2026-10-04).
//  앱의 일: 언제 무슨 일을 했고 무엇이 남았는지 본다. 줄마다 «한 일»(그 세션이 적은 작업 기록)과 «남긴 것»(산출 지식 · 맡은 태스크 ·
//  커밋 · 고친 파일)이 붙고, 기간 합계를 주간 보고에 붙여 넣을 글로 복사한다.
//  ⚠ «한 일» 은 지어낸 요약이 아니다 — 세션이 스스로 적은 작업 기록의 제목이다. 기록이 없는 세션은 그렇다고 말하고 첫 지시를 보인다.
//  모양(원준 2026-10-05 «프로젝트 본문 창 참고해서 그 디자인 언어로»): 가운데 카드 = 도구 줄 · 합계 띠 · 시간 가닥(때 – 점 – 세션 카드),
//   오른쪽 카드 = 기간 요약(하루하루 막대 · 프로젝트 · 만든 지식 · 태스크). [대화록 열기]는 화면을 옮기지 않고 창으로 연다(본문 창의 결).
import { api, el, toast } from './core.js';
import { openTranscriptWindow, resumeSessionRecord } from './sessions.js';
import { actTypePill, activityLine, btnOf, emptyBox, errBox, fmtBytes, ico, leftChips, routeLink, segOf, sessionLink, shellHref, skelRows, tileOf, transcriptHref } from './sessions-kit.js';
import {
  JOURNAL_PRESETS, journalCopyText, journalDayBars, journalGroups, journalHeadline, journalKnowledgeList, journalProjects, journalRange, journalStats, journalTaskList,
  type JRow, type JournalMode, type JournalPreset,
} from './session-history.js';
import { whenLabel } from './lib/omni-order.js';

const MODES: ReadonlyArray<{ key: JournalMode; label: string }> = [{ key: 'day', label: '날짜별' }, { key: 'project', label: '프로젝트별' }];
const st = { preset: 'week' as JournalPreset, mode: 'day' as JournalMode, open: new Set<string>() };
const cache = new Map<JournalPreset, { at: number; rows: JRow[]; truncated: boolean }>();
const TTL_MS = 30_000;
const RAIL_TOP = 6;   // 옆 칸의 목록마다 먼저 보이는 줄 수 — 나머지는 [n개 더]
let seq = 0;
let aborter: AbortController | null = null;
const rowKey = (r: JRow): string => r.node_id + '|' + r.session_id;
const p2 = (n: number): string => (n < 10 ? '0' : '') + n;
/** 줄의 때 — 날짜별 묶음에서는 시각(14:10), 프로젝트별 묶음에서는 날짜(10/5). */
function rowTime(iso: string, mode: JournalMode): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return mode === 'day' ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

export function mountJournal(host: HTMLElement): void {
  const range = el('span', { class: 'shx-range' });
  const stats = el('div', { class: 'shx-stats' });
  const list = el('div', { class: 'shx-journal' });
  const rail = el('aside', { class: 'shx-card shx-jrail', 'aria-label': '기간 요약', hidden: true }) as HTMLElement;   // 줄이 설 때 세운다
  const copyBtn = btnOf('요약 복사', { icon: 'copy', kind: 'ghost', title: '이 기간에 한 일을 프로젝트별로 정리한 글을 복사합니다' });
  //  화면에 선 줄과 그 줄의 기간은 한 몸이다 — 새 기간을 받는 동안에는 앞 기간의 줄과 앞 기간의 범위가 그대로 남는다
  //   (범위만 먼저 바꾸면, 받는 중에 묶는 기준을 눌렀을 때 앞 줄이 새 범위의 막대 아래 그려진다 — 격리 리뷰).
  let rows: JRow[] = [];
  let label = '';
  let span: { since: number; until: number | null } = { since: 0, until: null };
  let loading = false;
  const makeModeSeg = (): HTMLElement => segOf(MODES, st.mode, (v) => { st.mode = v; if (!loading) draw(); }, '묶는 기준');
  let modeSeg = makeModeSeg();
  const wrapEl = el('div', { class: 'shx-jwrap norail' }) as HTMLElement;

  host.replaceChildren(wrapEl);
  wrapEl.append(
    el('section', { class: 'shx-card shx-jmain', 'aria-label': '작업 일지' },
      el('div', { class: 'shx-bar' },
        segOf(JOURNAL_PRESETS, st.preset, (v) => { st.preset = v; void load(false); }, '기간'),
        modeSeg,
        range,
        el('span', { class: 'shx-grow' }),
        copyBtn),
      stats, list),
    rail);

  copyBtn.addEventListener('click', async () => {
    if (!rows.length) { toast('이 기간에 복사할 세션이 없습니다.'); return; }
    const text = journalCopyText(rows, label, Date.now());
    try { await navigator.clipboard.writeText(text); toast('요약을 복사했습니다.'); }
    catch { toast('복사하지 못했습니다 — 브라우저가 클립보드 접근을 막았습니다.'); }
  });

  function tile(n: number, name: string, iconName: string, tone: string): HTMLElement {
    return el('div', { class: 'shx-stat' }, tileOf(iconName, tone), el('div', { class: 'shx-stat-b' }, el('b', { class: 'shx-stat-n', text: String(n) }), el('span', { class: 'shx-stat-k', text: name }))) as HTMLElement;
  }
  function rowEl(r: JRow, now: number): HTMLElement {
    const key = rowKey(r);
    const head = journalHeadline(r);
    const name = String(r.name || r.title || '이름 없는 세션');
    const isOpen = st.open.has(key);
    const more = el('div', { class: 'shx-jmore', hidden: !isOpen });
    const fillMore = (): void => {
      if (more.childElementCount) return;
      const acts = r.activities.length ? r.activities.map(activityLine)
        : [el('p', { class: 'shx-note', text: (r.activities_before || 0) > 0 ? `이 기간에 적은 작업 기록이 없습니다. 그 전에 적은 기록이 ${r.activities_before}건 있습니다.` : '이 세션이 적어 둔 작업 기록이 없습니다.' })];
      //  세션으로 가는 문은 하나 — 그 대화를 돌리는 박스가 있으면 [세션 열기], 기록만 남았으면 [이어 질문하기].
      //   박스가 있는 대화를 기록으로 하나 더 열면 같은 대화가 둘이 된다.
      const resume = btnOf('이어 질문하기', { icon: 'chat' });
      resume.addEventListener('click', () => { void resumeSessionRecord(r.session_id, r.node_id, resume); });
      const door = r.box_id ? sessionLink(r.box_id, { class: 'shx-btn' }, ico('open'), el('span', { class: 'shx-btn-l', text: '세션 열기' })) : resume;
      //  대화록은 창으로 연다 — 일지에서 보던 자리가 그대로 남는다. 새 탭·가운데 클릭만 단독 화면(#/sessions/<sid>)의 셸 주소로 간다.
      const transcript = el('a', { class: 'shx-btn ghost', href: shellHref(transcriptHref(r.session_id, r.node_id)) }, ico('doc'), el('span', { class: 'shx-btn-l', text: '대화록 열기' })) as HTMLAnchorElement;
      transcript.addEventListener('click', (e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) { try { sessionStorage.setItem('sessReturn', location.hash || '#/sessions'); } catch { /* */ } return; }
        e.preventDefault();
        openTranscriptWindow({ sid: r.session_id, node: r.node_id }, {
          name, boxId: r.box_id, sub: [r.project_name || '프로젝트 없음', whenLabel(Date.parse(r.last_seen), Date.now())].filter(Boolean).join(' · '),
          onTrashed: () => { cache.delete(st.preset); void load(true); },
        });
      });
      //  ⚠ 노드의 append 는 null 을 글자 «null» 로 넣는다 — el() 의 자식 규칙이 아니다. 없는 칸은 미리 걷는다.
      const first = r.title ? el('div', { class: 'shx-first' }, el('span', { class: 'shx-first-k', text: '첫 지시' }), el('span', { class: 'shx-first-t', text: r.title })) : null;
      const btns = el('div', { class: 'shx-jacts' },
        door, transcript,
        el('span', { class: 'shx-jmeta', text: [r.harness, fmtBytes(r.bytes)].filter(Boolean).join(' · ') }));
      more.append(...acts, ...(first ? [first] : []), btns);
    };
    if (isOpen) fillMore();
    //  단추 안에는 흐름 요소(div)를 둘 수 없다 — span 을 블록으로 그린다(53-session-history.css).
    const lastAct = r.activities.length ? r.activities[r.activities.length - 1]! : null;
    const headBtn = el('button', { class: 'shx-jhead', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false' },
      el('span', { class: 'shx-row-t' },
        el('span', { class: 'shx-jname', text: name, title: name }),
        st.mode === 'day' ? el('span', { class: 'shx-proj' + (r.project_name ? '' : ' none') }, ico(r.project_name ? 'projMini' : 'projNone'), el('span', { text: r.project_name || '프로젝트 없음' })) : null,
        r.asks ? el('span', { class: 'shx-jasks', text: `질문 ${r.asks}개` }) : null),
      el('span', { class: 'shx-jline' },
        head.source === 'activity' && lastAct ? actTypePill(lastAct.type) : null,
        head.source === 'activity'
          ? el('span', { class: 'shx-jsum', text: head.text + (head.more ? ` 외 ${head.more}건` : '') })
          : el('span', { class: 'shx-jsum none', text: head.source === 'earlier' ? `이 기간에 적은 기록 없음 · 이전 기록 ${head.more}건`
            : head.source === 'prompt' ? '기록된 작업 없음 · 첫 지시: ' + head.text : '기록된 작업 없음' })),
      el('span', { class: 'shx-jchev' }, ico('chevD')));
    const rowBox = el('div', { class: 'shx-jrow' + (isOpen ? ' open' : '') + (head.source === 'activity' ? '' : ' quiet') },
      el('div', { class: 'shx-jtime', text: rowTime(r.last_seen, st.mode), title: whenLabel(Date.parse(r.last_seen), now) }),
      el('div', { class: 'shx-jcard' }, headBtn, leftChips(r), more)) as HTMLElement;
    headBtn.addEventListener('click', () => {
      const on = !st.open.has(key);
      if (on) { st.open.add(key); fillMore(); } else st.open.delete(key);
      more.hidden = !on;
      rowBox.classList.toggle('open', on);
      headBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    return rowBox;
  }

  // ── 옆 칸 — 기간 요약 ──
  /** 묶음으로 간다 — 그 묶음이 지금 화면에 없으면(다른 기준으로 묶여 있다) 기준을 바꿔 다시 그린 뒤 간다.
   *  다시 그리면 옆 칸도 새로 선다 — 누른 단추(같은 열쇠)에 초점을 돌려준다(키보드로 누른 사람이 자리를 잃지 않게). */
  function goGroup(mode: JournalMode, key: string): void {
    if (st.mode !== mode) {
      st.mode = mode; const next = makeModeSeg(); modeSeg.replaceWith(next); modeSeg = next; draw();
      const again = (Array.from(rail.querySelectorAll(mode === 'day' ? '.shx-day' : '.shx-rail-r.proj')) as HTMLElement[]).find((x) => x.dataset.key === key);
      if (again) again.focus();
    }
    const g = (Array.from(list.querySelectorAll('.shx-jgroup')) as HTMLElement[]).find((x) => x.dataset.key === key);
    if (!g) return;
    //  문서(셸 액자)까지 굴리지 않게 일지 칸 안에서만 굴린다.
    list.scrollTop += g.getBoundingClientRect().top - list.getBoundingClientRect().top - 4;
    g.classList.add('flash');
    setTimeout(() => g.classList.remove('flash'), 1600);
  }
  function railList<T>(title: string, items: T[], one: (x: T) => HTMLElement, empty: string): HTMLElement {
    const box = el('div', { class: 'shx-rail-sec' }, el('div', { class: 'shx-rail-h' }, title + ' ', el('b', { text: String(items.length) })));
    if (!items.length) { box.append(el('p', { class: 'shx-note', text: empty })); return box as HTMLElement; }
    const body = el('div', { class: 'shx-rail-list' });
    const paint = (all: boolean): void => {
      body.replaceChildren(...items.slice(0, all ? items.length : RAIL_TOP).map(one));
      if (!all && items.length > RAIL_TOP) { const b = el('button', { class: 'shx-rail-more', type: 'button', text: `${items.length - RAIL_TOP}개 더` }); b.addEventListener('click', () => paint(true)); body.append(b); }
    };
    paint(false);
    box.append(body);
    return box as HTMLElement;
  }
  function drawRail(now: number): void {
    wrapEl.classList.toggle('norail', !rows.length);
    if (!rows.length) { rail.replaceChildren(); rail.hidden = true; return; }
    rail.hidden = false;
    // 하루하루 — 그날이 마지막 활동인 세션 수(날짜 묶음과 같은 셈). 막대를 누르면 그날로 간다.
    const days = journalDayBars(rows, span.since, span.until, now);
    const max = Math.max(1, ...days.map((d) => d.n));
    const bars = el('div', { class: 'shx-days' + (days.length > 10 ? ' many' : ''), role: 'group', 'aria-label': '하루하루 세션 수' },
      ...days.map((d) => {
        const b = el('button', { class: 'shx-day' + (d.today ? ' today' : '') + (d.n ? '' : ' zero'), type: 'button', 'data-key': d.key, title: `${d.label} · 세션 ${d.n}개`, 'aria-label': `${d.label} 세션 ${d.n}개`, disabled: !d.n },
          el('span', { class: 'shx-day-n', text: d.n ? String(d.n) : '' }),
          el('span', { class: 'shx-day-bar', style: '--v:' + (d.n ? Math.max(8, Math.round((d.n / max) * 100)) : 0) + '%' }),
          el('span', { class: 'shx-day-l', text: d.weekday }));
        b.addEventListener('click', () => goGroup('day', d.key));
        return b;
      }));
    const projs = journalProjects(rows);
    const pmax = Math.max(1, ...projs.map((p) => p.sessions));
    const projBox = railList('프로젝트', projs, (p) => {
      const b = el('button', { class: 'shx-rail-r proj', type: 'button', 'data-key': p.key, title: `${p.name} — 세션 ${p.sessions}개 · 기록 ${p.activities}건` },
        el('span', { class: 'shx-rail-k' }, ico(p.id == null ? 'projNone' : 'projMini'), el('span', { class: 'shx-rail-tn', text: p.name })),
        el('b', { text: String(p.sessions) }),
        el('span', { class: 'shx-rail-bar', style: '--v:' + Math.round((p.sessions / pmax) * 100) + '%' }));
      b.addEventListener('click', () => goGroup('project', p.key));
      return b as HTMLElement;
    }, '');
    const kn = journalKnowledgeList(rows);
    const knBox = railList('만든 지식', kn, (k) => routeLink('#/k/' + encodeURIComponent(k.name), { class: 'shx-rail-r link', title: '지식 열기 — ' + (k.title || k.name) },
      el('span', { class: 'shx-rail-k' }, ico('wiki'), el('span', { class: 'shx-rail-tn', text: k.title || k.name }))), '이 기간에 만든 지식이 없습니다.');
    const tk = journalTaskList(rows);
    const tkBox = railList('태스크', tk, (t) => routeLink('#/projects2/t/' + t.id, { class: 'shx-rail-r link' + (t.status === 'done' ? ' done' : ''), title: '태스크 열기 — ' + (t.status === 'done' ? '완료' : '진행 중') },
      el('span', { class: 'shx-rail-k' }, ico(t.status === 'done' ? 'check' : 'task'), el('span', { class: 'shx-rail-tn', text: `#${t.id} ${t.name}` }))), '이 기간에 맡은 태스크가 없습니다.');
    rail.replaceChildren(
      el('div', { class: 'shx-rail-sec' }, el('div', { class: 'shx-rail-h', text: '하루하루' }), bars),
      projBox, knBox, tkBox);
  }

  function draw(): void {
    const now = Date.now();
    const s = journalStats(rows);
    stats.replaceChildren(tile(s.sessions, '세션', 'chat', 'blue'), tile(s.projects, '프로젝트', 'projMini', ''), tile(s.activities, '한 일(기록)', 'check', 'mint'), tile(s.knowledge, '만든 지식', 'wiki', 'mint'), tile(s.tasks, '태스크', 'task', 'amber'));
    drawRail(now);
    if (!rows.length) {
      //  주가 막 바뀐 때(월요일 아침)의 「이번 주」는 비어 있는 게 맞다 — 고장으로 읽히지 않게 지난 주로 가는 문을 함께 둔다.
      let action: HTMLElement | null = null;
      if (st.preset === 'week') { action = btnOf('지난 주 보기', { kind: 'ghost' }); action.addEventListener('click', () => { st.preset = 'last-week'; mountJournal(host); }); }
      list.replaceChildren(emptyBox({ icon: 'timeline', big: true, title: st.preset === 'week' ? '이번 주에 한 세션이 아직 없습니다.' : '이 기간에 한 세션이 없습니다.', action }));
      return;
    }
    const kids: HTMLElement[] = [];
    for (const g of journalGroups(rows, st.mode, now)) {
      kids.push(el('section', { class: 'shx-jgroup', 'data-key': g.key },
        el('div', { class: 'shx-grp' }, st.mode === 'project' ? ico(g.key === 'p:0' ? 'projNone' : 'projMini') : null, el('span', { class: 'shx-grp-l', text: g.label }), el('span', { class: 'shx-grp-n', text: String(g.rows.length) })),
        el('div', { class: 'shx-jlist' }, ...g.rows.map((r) => rowEl(r, now)))) as HTMLElement);
    }
    const c = cache.get(st.preset);
    if (c && c.truncated) kids.push(el('p', { class: 'shx-note', text: '세션이 많아 최근 500개까지만 보여 줍니다.' }));
    list.replaceChildren(...kids);
  }
  async function load(force: boolean): Promise<void> {
    const mySeq = ++seq;
    const preset = st.preset;
    const r = journalRange(preset, Date.now());
    range.textContent = r.label;
    const show = (got: JRow[]): void => { rows = got; label = r.label; span = { since: r.since, until: r.until }; loading = false; draw(); };
    const hit = cache.get(preset);
    if (!force && hit && Date.now() - hit.at < TTL_MS) { show(hit.rows); return; }
    loading = true;
    list.replaceChildren(skelRows(5, 'cards'));
    const qs = new URLSearchParams({ since: new Date(r.since).toISOString(), limit: '500' });
    if (r.until != null) qs.set('until', new Date(r.until).toISOString());
    if (aborter) aborter.abort();   // 기간을 연달아 바꾸면 앞 요청을 끊는다(일곱 문장짜리 조회가 서버에 쌓이지 않게)
    const mine = aborter = new AbortController();
    try {
      const d: any = await api('/api/ui/v6/session-journal?' + qs.toString(), { signal: mine.signal });
      const got: JRow[] = Array.isArray(d?.rows) ? d.rows : [];
      cache.set(preset, { at: Date.now(), rows: got, truncated: !!d?.truncated });
      if (mySeq !== seq) return;
      show(got);
    } catch (e: any) {
      if (mySeq !== seq || (e && e.name === 'AbortError')) return;
      rows = [];
      loading = false;
      stats.replaceChildren();
      rail.replaceChildren(); rail.hidden = true;
      wrapEl.classList.add('norail');
      list.replaceChildren(errBox(e?.message || '작업 일지를 불러오지 못했습니다.'));
    }
  }
  void load(false);
}
