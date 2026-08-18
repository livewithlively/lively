// v2/views.ts — 새 셸의 중앙 화면 셋(#1719): 홈(미선택) · 프로젝트 · 세션. 데이터는 main.ts 가 모아 넘긴다(V2Data).
//  중앙은 '리브와 대화하는 창'이 주인이다 — 홈은 리브 대화(web/liv-chat.ts mountLivChat 을 그대로 마운트)로 시작하고,
//  프로젝트는 개요+세션, 세션은 그 세션 자체(라이브 터미널 또는 중앙 기록 대화)를 실는다.
//  클래식 모듈을 **복제하지 않는다** — 대화·세션 목록·프로젝트 상세는 이미 있는 것을 가져다 붙인다.
import { api, el, errorNote, relTime, state, toast } from '../core.js';
import { mountLivChat, livChatAsk } from '../liv-chat.js';
import { sessIsDead, sessLabel, sessStateKey } from '../session-status.js';
import { appFrame, terminalUrl } from './apps.js';

export interface Proj { id: number; name: string; status?: string | null; status_category?: string | null; my_session_count?: number; description?: string | null; list_id?: number | null; updated_at?: string | null; }
export interface Sess {
  id: string; label: string; projectId: number | null; node: string | null;
  live: boolean; alive: boolean; owned: boolean; stateKey: string; stateLabel: string; lastSeen: number; raw: any;
}
export interface V2Data { projects: Proj[]; sessions: Sess[]; loadedAt: number; }

const dot = (k: string) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
export function dotCls(stateKey: string): string {
  if (stateKey === 'busy') return 'busy';
  if (stateKey === 'waiting') return 'wait';
  if (stateKey === 'done' || stateKey === 'idle') return 'done';
  return '';
}
const when = (ms: number) => (ms ? relTime(new Date(ms).toISOString()) : '');

// ── 홈(미선택) — 인사 + 리브 대화 + '지금' ──────────────────────────────────
export function renderHome(host: HTMLElement, data: V2Data): void {
  const me = state.me || {};
  const name = String(me.display_name || me.email || me.userId || '');
  const live = data.sessions.filter((s) => s.live && s.alive);
  const busy = live.filter((s) => s.stateKey === 'busy').length;
  const waiting = live.filter((s) => s.stateKey === 'waiting').length;
  const h = new Date().getHours(); const tod = h < 12 ? '오전' : h < 18 ? '오후' : '저녁';
  const lead = busy || waiting
    ? `${name ? name + '님, ' : ''}${tod}이에요. ${busy ? `세션 ${busy}개가 돌고 있고` : '도는 세션은 없고'}${waiting ? ` ${waiting}개는 답을 기다려요.` : ' 기다리는 건 없어요.'}`
    : `${name ? name + '님, ' : ''}${tod}이에요. 무엇이든 시키세요 — 리브가 받아 정리하고, 필요하면 세션을 엽니다.`;
  const chatBody = el('div', { class: 'v2-chat-body' });
  const askHost = el('div', { class: 'liv-askdock v2-askdock' });
  host.replaceChildren(
    el('section', { class: 'v2-home' },
      el('div', { class: 'v2-home-lead' },
        el('span', { class: 'v2-liv-tag' }, el('span', { class: 'liv-dot' }), '리브'),
        el('h1', { class: 'v2-h1', text: lead })),
      el('div', { class: 'v2-sugs' },
        ...['지난주 회의 결정 모아 줘', '연결한 서비스 상태 봐 줘', '내 세션 지금 뭐 하고 있어?', '오늘 새로 들어온 자료 정리해 줘']
          .map((t) => el('button', { class: 'chip', type: 'button', text: t, onclick: () => livChatAsk(t) }))),
      el('div', { class: 'v2-chat liv-chat' }, chatBody),
      askHost,
      nowList(data)));
  // 리브 대화 — 클래식 #/liv 와 같은 마운트 함수. 기억은 서버에 산다(리브 v1 불변식)라 어느 셸에서 열어도 같은 대화다.
  mountLivChat(chatBody, askHost);
}

function nowList(data: V2Data): HTMLElement {
  const rows = data.sessions.filter((s) => s.live && s.alive).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 6);
  if (!rows.length) return el('div', {});
  return el('div', { class: 'v2-now' },
    el('span', { class: 'v2-k', text: '지금 도는 세션' }),
    ...rows.map((s) => el('a', { class: 'v2-now-row', href: '#/s/' + encodeURIComponent(s.id) },
      dot(s.stateKey), el('span', { class: 't', text: s.label }),
      el('span', { class: 'p', text: projName(data, s.projectId) }),
      el('span', { class: 'st', text: `${s.stateLabel} · ${when(s.lastSeen)}` }))));
}
export function projName(data: V2Data, id: number | null): string {
  if (!id) return '프로젝트 없음';
  const p = data.projects.find((x) => Number(x.id) === Number(id));
  return p ? p.name : `프로젝트 #${id}`;
}

// ── 프로젝트 — 개요 + 세션 + 여는 길 ────────────────────────────────────────
export async function renderProject(host: HTMLElement, data: V2Data, id: number, detailIn?: any): Promise<void> {
  const p = data.projects.find((x) => Number(x.id) === id);
  let detail: any = detailIn ?? null;
  if (!detail) {
    host.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '불러오는 중…' })));
    try { detail = await api('/api/ui/v6/projects/' + id); } catch (e) { host.replaceChildren(el('div', { class: 'v2-center' }, errorNote(e, '프로젝트를 불러오지 못했습니다'))); return; }
  }
  const pj = (detail && detail.project) || p || { id, name: `프로젝트 #${id}` };
  const tasks: any[] = Array.isArray(detail?.project?.tasks) ? detail.project.tasks : (Array.isArray(detail?.tasks) ? detail.tasks : []);
  const done = tasks.filter((t) => t.status_category === 'done' || t.status === 'done').length;
  const sess = data.sessions.filter((s) => Number(s.projectId) === id).sort((a, b) => Number(b.live) - Number(a.live) || b.lastSeen - a.lastSeen);
  const st = pj.status_category === 'done' ? '끝남' : pj.status_category === 'unstarted' ? '시작 전' : '진행 중';
  host.replaceChildren(el('div', { class: 'v2-center' },
    el('div', { class: 'v2-eyebrow' }, el('span', { class: 'mono', text: '#' + pj.id }), el('span', { text: '·' }), el('span', { class: 'state ' + (pj.status_category === 'done' ? 'done' : 'busy'), text: st }),
      pj.list && pj.list.name ? [el('span', { text: '·' }), el('span', { text: pj.list.name })] : null),
    el('h1', { class: 'v2-title', text: pj.name }),
    pj.description ? el('p', { class: 'v2-desc', text: String(pj.description).slice(0, 600) }) : null,
    el('div', { class: 'v2-actrow' },
      el('a', { class: 'btn btn-primary btn-sm', href: '#/app/terminal', text: '새 AI 세션' }),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2/p/' + pj.id, text: '프로젝트 앱에서 열기(보드·태스크)' }),
      el('span', { class: 'v2-muted', text: tasks.length ? `태스크 ${tasks.length} · 끝남 ${done}` : '태스크 없음' })),
    el('section', { class: 'v2-sec' },
      el('div', { class: 'v2-sec-h' }, el('span', { class: 'v2-k', text: `세션 · ${sess.length}` })),
      sess.length ? el('div', { class: 'v2-list' }, ...sess.map((s) => el('a', { class: 'v2-row', href: '#/s/' + encodeURIComponent(s.id) },
        dot(s.stateKey), el('div', { class: 'v2-row-main' }, el('div', { class: 't', text: s.label }), el('div', { class: 'm', text: `${s.stateLabel}${s.live ? '' : ' · 기록만'} · ${when(s.lastSeen)}` })),
        el('span', { class: 'v2-row-r', text: '›' }))))
        : el('p', { class: 'v2-empty', text: '이 프로젝트에 붙은 세션이 아직 없어요. [새 AI 세션] 으로 시작하면 여기에 쌓입니다.' })),
    tasks.length ? el('section', { class: 'v2-sec' },
      el('div', { class: 'v2-sec-h' }, el('span', { class: 'v2-k', text: `태스크 · ${tasks.length}` })),
      el('div', { class: 'v2-list' }, ...tasks.slice(0, 8).map((t) => el('a', { class: 'v2-row', href: '#/projects2/t/' + t.id },
        el('span', { class: 'v2-dot ' + (t.status_category === 'done' ? 'done' : t.status_category === 'started' ? 'busy' : '') }),
        el('div', { class: 'v2-row-main' }, el('div', { class: 't', text: t.name }), el('div', { class: 'm', text: t.status || t.status_category || '' })),
        el('span', { class: 'v2-row-r', text: '›' }))),
        tasks.length > 8 ? el('a', { class: 'v2-more', href: '#/projects2/p/' + pj.id, text: `외 ${tasks.length - 8}개 — 프로젝트 앱에서` }) : null)) : null,
  ));
}

// ── 세션 — 그 세션 자체를 가운데에. 라이브면 터미널, 아니면 중앙 기록 대화(클래식 #/sessions/<id>) ─────────
export function renderSession(host: HTMLElement, data: V2Data, id: string): void {
  const s = data.sessions.find((x) => x.id === id);
  if (!s) { host.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '세션을 찾을 수 없어요. 목록을 새로고침해 주세요.' }))); return; }
  const title = s.label;
  const frame = s.live
    ? appFrame('', title, { live: true, src: terminalUrl(s.id, s.label, s.node) })
    : appFrame('sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node) : ''), title);
  const meta = el('div', { class: 'v2-sess-meta' },
    dot(s.stateKey), el('span', { text: s.stateLabel }), el('span', { text: '·' }),
    el('a', { href: s.projectId ? '#/p/' + s.projectId : '#/', text: projName(data, s.projectId) }),
    el('span', { text: '·' }), el('span', { text: when(s.lastSeen) }));
  frame.insertBefore(meta, frame.firstChild!.nextSibling);
  host.replaceChildren(frame);
}

// ── 데이터 정규화 — 라이브(terminal/sessions) + 기록(v6/sessions) 를 한 목록으로 ─────────
export function mergeSessions(liveRows: any[], logRows: any[]): Sess[] {
  const now = Date.now();
  const out = new Map<string, Sess>();
  for (const r of liveRows || []) {
    const k = sessStateKey(r, now);
    out.set(String(r.id), {
      id: String(r.id), label: String(r.label || r.title || r.id), projectId: r.projectId ? Number(r.projectId) : null,
      node: r.node || null, live: true, alive: !sessIsDead(r, now), owned: !!r.owned, stateKey: k, stateLabel: sessLabel(r, now),
      lastSeen: Number(r.lastActive || r.created || 0) * (String(r.lastActive || r.created || 0).length > 11 ? 1 : 1000) || 0, raw: r,
    });
  }
  for (const r of logRows || []) {
    const id = String(r.session_id);
    if (out.has(id)) continue;
    out.set(id, {
      id, label: String(r.title || id), projectId: r.project_id != null ? Number(r.project_id) : null, node: r.node_id || null,
      live: false, alive: false, owned: true, stateKey: 'log', stateLabel: '기록', lastSeen: r.last_seen ? new Date(r.last_seen).getTime() : 0, raw: r,
    });
  }
  return [...out.values()];
}

export function toastOnce(msg: string): void { toast(msg); }
