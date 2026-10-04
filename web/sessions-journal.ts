// sessions-journal.ts — 세션 이력 앱 「작업 일지」 탭(#4553 안 B, 원준 2026-10-04).
//  앱의 일: 언제 무슨 일을 했고 무엇이 남았는지 본다. 줄마다 «한 일»(그 세션이 적은 작업 기록)과 «남긴 것»(산출 지식 · 맡은 태스크 ·
//  커밋 · 고친 파일)이 붙고, 기간 합계를 주간 보고에 붙여 넣을 글로 복사한다.
//  ⚠ «한 일» 은 지어낸 요약이 아니다 — 세션이 스스로 적은 작업 기록의 제목이다. 기록이 없는 세션은 그렇다고 말하고 첫 지시를 보인다.
import { api, el, toast } from './core.js';
import { resumeSessionRecord } from './sessions.js';
import { activityLine, fmtBytes, leftChips, routeLink, segOf, sessionHref, transcriptHref } from './sessions-kit.js';
import {
  JOURNAL_PRESETS, journalCopyText, journalGroups, journalHeadline, journalRange, journalStats,
  type JRow, type JournalMode, type JournalPreset,
} from './session-history.js';
import { whenLabel } from './lib/omni-order.js';

const MODES: ReadonlyArray<{ key: JournalMode; label: string }> = [{ key: 'day', label: '날짜별' }, { key: 'project', label: '프로젝트별' }];
const st = { preset: 'week' as JournalPreset, mode: 'day' as JournalMode, open: new Set<string>() };
const cache = new Map<JournalPreset, { at: number; rows: JRow[]; truncated: boolean }>();
const TTL_MS = 30_000;
let seq = 0;
const rowKey = (r: JRow): string => r.node_id + '|' + r.session_id;

export function mountJournal(host: HTMLElement): void {
  const range = el('span', { class: 'shx-range' });
  const stats = el('div', { class: 'shx-stats' });
  const list = el('div', { class: 'shx-journal' });
  const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '요약 복사', title: '이 기간에 한 일을 프로젝트별로 정리한 글을 복사합니다' }) as HTMLButtonElement;
  let rows: JRow[] = [];
  let label = '';

  host.replaceChildren(el('div', { class: 'shx-one' },
    el('div', { class: 'shx-bar' },
      segOf(JOURNAL_PRESETS, st.preset, (v) => { st.preset = v; void load(false); }, '기간'),
      segOf(MODES, st.mode, (v) => { st.mode = v; draw(); }, '묶는 기준'),
      range,
      el('span', { class: 'shx-grow' }),
      copyBtn),
    stats, list));

  copyBtn.addEventListener('click', async () => {
    if (!rows.length) { toast('이 기간에 복사할 세션이 없습니다.'); return; }
    const text = journalCopyText(rows, label, Date.now());
    try { await navigator.clipboard.writeText(text); toast('요약을 복사했습니다.'); }
    catch { toast('복사하지 못했습니다 — 브라우저가 클립보드 접근을 막았습니다.'); }
  });

  function tile(n: number, name: string): HTMLElement {
    return el('div', { class: 'shx-stat' }, el('b', { text: String(n) }), el('span', { text: name }));
  }
  function rowEl(r: JRow, now: number): HTMLElement {
    const key = rowKey(r);
    const head = journalHeadline(r);
    const name = String(r.name || r.title || '이름 없는 세션');
    const more = el('div', { class: 'shx-jmore', hidden: !st.open.has(key) });
    const fillMore = (): void => {
      if (more.childElementCount) return;
      const acts = r.activities.length ? r.activities.map(activityLine) : [el('p', { class: 'admin-hint', text: '이 세션이 적어 둔 작업 기록이 없습니다.' })];
      const resume = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '이어 질문하기' }) as HTMLButtonElement;
      resume.addEventListener('click', () => { void resumeSessionRecord(r.session_id, r.node_id, resume); });
      const transcript = el('a', { class: 'btn btn-ghost btn-sm', href: transcriptHref(r.session_id, r.node_id), text: '대화록 열기' });
      transcript.addEventListener('click', () => { try { sessionStorage.setItem('sessReturn', location.hash || '#/sessions'); } catch { /* */ } });
      //  ⚠ 노드의 append 는 null 을 글자 «null» 로 넣는다 — el() 의 자식 규칙이 아니다. 없는 칸은 미리 걷는다.
      const first = r.title ? el('div', { class: 'shx-first' }, el('span', { class: 'shx-first-k', text: '첫 지시' }), el('span', { text: r.title })) : null;
      const btns = el('div', { class: 'shx-jacts' },
        r.box_id ? routeLink(sessionHref(r.box_id), { class: 'btn btn-primary btn-sm' }, '세션 열기') : null,
        transcript, resume,
        el('span', { class: 'shx-row-m', text: [r.harness, fmtBytes(r.bytes)].filter(Boolean).join(' · ') }));
      more.append(...acts, ...(first ? [first] : []), btns);
    };
    if (st.open.has(key)) fillMore();
    const headBtn = el('button', { class: 'shx-jhead', type: 'button', 'aria-expanded': st.open.has(key) ? 'true' : 'false' },
      el('div', { class: 'shx-row-t' }, name,
        el('span', { class: 'shx-row-m', text: ' · ' + [st.mode === 'day' ? (r.project_name || '프로젝트 없음') : '', whenLabel(Date.parse(r.last_seen), now), r.asks ? `질문 ${r.asks}개` : ''].filter(Boolean).join(' · ') })),
      head.source === 'activity'
        ? el('div', { class: 'shx-jsum', text: head.text + (head.more ? ` 외 ${head.more}건` : '') })
        : el('div', { class: 'shx-jsum none', text: head.source === 'prompt' ? '기록된 작업 없음 · 첫 지시: ' + head.text : '기록된 작업 없음' }));
    headBtn.addEventListener('click', () => {
      const on = !st.open.has(key);
      if (on) { st.open.add(key); fillMore(); } else st.open.delete(key);
      more.hidden = !on;
      headBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    return el('div', { class: 'shx-jrow' }, headBtn, leftChips(r), more);
  }
  function draw(): void {
    const now = Date.now();
    const s = journalStats(rows);
    stats.replaceChildren(tile(s.sessions, '세션'), tile(s.projects, '프로젝트'), tile(s.activities, '한 일(기록)'), tile(s.knowledge, '만든 지식'), tile(s.tasks, '태스크'));
    if (!rows.length) { list.replaceChildren(el('p', { class: 'admin-hint', text: '이 기간에 한 세션이 없습니다.' })); return; }
    const kids: HTMLElement[] = [];
    for (const g of journalGroups(rows, st.mode, now)) {
      kids.push(el('div', { class: 'shx-grp', text: `${g.label} · ${g.rows.length}` }));
      for (const r of g.rows) kids.push(rowEl(r, now));
    }
    const c = cache.get(st.preset);
    if (c && c.truncated) kids.push(el('p', { class: 'admin-hint', text: '세션이 많아 최근 500개까지만 보여 줍니다.' }));
    list.replaceChildren(...kids);
  }
  async function load(force: boolean): Promise<void> {
    const mySeq = ++seq;
    const preset = st.preset;
    const r = journalRange(preset, Date.now());
    label = r.label;
    range.textContent = r.label;
    const hit = cache.get(preset);
    if (!force && hit && Date.now() - hit.at < TTL_MS) { rows = hit.rows; draw(); return; }
    list.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    const qs = new URLSearchParams({ since: new Date(r.since).toISOString(), limit: '500' });
    if (r.until != null) qs.set('until', new Date(r.until).toISOString());
    try {
      const d: any = await api('/api/ui/v6/session-journal?' + qs.toString());
      const got: JRow[] = Array.isArray(d?.rows) ? d.rows : [];
      cache.set(preset, { at: Date.now(), rows: got, truncated: !!d?.truncated });
      if (mySeq !== seq) return;
      rows = got;
      draw();
    } catch (e: any) {
      if (mySeq !== seq) return;
      rows = [];
      stats.replaceChildren();
      list.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '작업 일지를 불러오지 못했습니다.' }));
    }
  }
  void load(false);
}
