// v2/views.ts — 새 셸의 중앙 화면 셋(#1719): 홈(미선택) · 프로젝트 · 세션. 데이터는 main.ts 가 모아 넘긴다(V2Data).
//  홈은 **입력창 하나**(claude.ai 홈처럼 — Enter 로 프로젝트 없는 세션이 열린다, v2/quick-session.ts)이고,
//  프로젝트는 개요+세션, 세션은 그 세션 자체(대화창 — 라이브 또는 중앙 기록)를 실는다. 리브 대화는 #/liv 에 있다.
//  클래식 모듈을 **복제하지 않는다** — 대화·세션 목록·프로젝트 상세는 이미 있는 것을 가져다 붙인다.
import { api, el, errorNote, relTime, state, toast } from '../core.js';
import { isCreatingQuickSession, openQuickSession, takeFirstPrompt } from './quick-session.js';
import { mountSessionChat, type SessionChatHandle } from '../session-chat.js';
import { sessIsDead, sessLabel, sessStateKey } from '../session-status.js';
import { terminalUrl } from './apps.js';

export interface Proj {
  id: number; name: string; status?: string | null; status_category?: string | null; description?: string | null; list_id?: number | null; updated_at?: string | null;
  // 사이드바 '내 프로젝트만'(side.ts) — 만든 사람 + 팀원 id. 서버 mine=1 과 같은 술어(생성자이거나 팀원)를 프론트에서 그대로 판정한다.
  created_by?: string | null; member_ids?: string[];
}
export interface Sess {
  id: string; label: string; projectId: number | null; node: string | null;
  live: boolean; alive: boolean; owned: boolean; stateKey: string; stateLabel: string; lastSeen: number; raw: any;
  // 중앙 기록 좌표(대화 uuid) — 라이브 행에 접힌 기록(mergeSessions). 기록만 있는 행은 id 자체가 uuid 라 비어 있다.
  logId?: string | null; logNode?: string | null;
}
export interface V2Data { projects: Proj[]; sessions: Sess[]; loadedAt: number; }

const dot = (k: string) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
// 상태 key(web/session-status.ts) → 점 색 클래스. 눈에 띄어야 할 셋만 색이다 — 작업 중(파랑·깜빡)·확인 필요(앰버)·작업 완료(민트 링).
//  나머지 살아 있는 것(대기·오프라인·셸)은 회색 계열로 조용히, 끝난 것(중단됨·종료됨·기록)은 빈 점.
export function dotCls(stateKey: string): string {
  if (stateKey === 'busy') return 'busy';
  if (stateKey === 'waiting') return 'wait';
  if (stateKey === 'done') return 'done';
  if (stateKey === 'idle') return 'idle';
  if (stateKey === 'offline') return 'off';
  if (stateKey === 'shell') return 'shell';
  return '';
}
const when = (ms: number) => (ms ? relTime(new Date(ms).toISOString()) : '');

// ── 홈(미선택) — 인사 + **입력창 하나**(claude.ai 홈처럼) + '지금 도는 세션' ──────────────
//  리브 대화는 홈에 두지 않는다(사이드바 [리브] → #/liv 가 그 자리). 홈은 "무엇이든 시키는 창" 하나가 주인이고,
//  Enter 는 프로젝트를 **묻지 않고** 세션을 연다(v2/quick-session.ts — 세션 전용 폴더, 프로젝트는 나중에 언제든).
export function renderHome(host: HTMLElement, data: V2Data): void {
  const me = state.me || {};
  const name = String(me.display_name || me.email || me.userId || '');
  const live = data.sessions.filter((s) => s.live && s.alive);
  const busy = live.filter((s) => s.stateKey === 'busy').length;
  const waiting = live.filter((s) => s.stateKey === 'waiting').length;
  // 오전이에요 · 오후예요 · 저녁이에요 — 받침 유무로 '이에요/예요'가 갈린다(오후는 받침이 없다).
  const h = new Date().getHours(); const tod = h < 12 ? '오전이에요' : h < 18 ? '오후예요' : '저녁이에요';
  const lead = busy || waiting
    ? `${name ? name + '님, ' : ''}${tod}. ${busy ? `세션 ${busy}개가 돌고 있고` : '도는 세션은 없고'}${waiting ? ` ${waiting}개는 답을 기다려요.` : ' 기다리는 건 없어요.'}`
    : `${name ? name + '님, ' : ''}${tod}. 무엇을 할까요?`;
  const ta = el('textarea', { class: 'v2-compose-in', rows: '2', placeholder: '무엇이든 시키세요 — Enter 로 새 세션이 열립니다', 'aria-label': '무엇이든 시키기' }) as HTMLTextAreaElement;
  const send = el('button', { class: 'btn btn-primary btn-sm v2-compose-send', type: 'button', text: '시키기' }) as HTMLButtonElement;
  const hint = el('span', { class: 'v2-compose-hint', text: 'Enter 보내기 · Shift+Enter 줄바꿈 · 프로젝트는 나중에 언제든 붙일 수 있어요' });
  const grow = (): void => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight) + 'px'; };
  const submit = async (): Promise<void> => {
    const text = ta.value.trim();
    if (!text || isCreatingQuickSession()) return;
    send.disabled = true; ta.disabled = true; send.textContent = '여는 중…';
    const ok = await openQuickSession(text);
    if (!ok) { send.disabled = false; ta.disabled = false; send.textContent = '시키기'; ta.focus(); }
    // 성공이면 라우터가 세션 화면으로 갈아 끼운다 — 이 요소들은 사라진다.
  };
  send.onclick = () => { void submit(); };
  ta.addEventListener('input', grow);
  // IME 조합 중 Enter(한글 마지막 글자 확정)는 보내지 않는다 — isComposing 이 그 신호다.
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
  });
  host.replaceChildren(
    el('section', { class: 'v2-home v2-home-compose' },
      el('div', { class: 'v2-home-lead' }, el('h1', { class: 'v2-h1', text: lead })),
      el('div', { class: 'v2-compose' },
        ta,
        el('div', { class: 'v2-compose-row' }, hint, send)),
      nowList(data)));
  window.setTimeout(() => { grow(); ta.focus(); }, 30);
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

// ── 세션 — 그 세션 자체를 가운데에: **대화창**(web/session-chat.ts, 리브와 같은 컴포넌트)으로. 터미널은 헤더에서 토글 ─────────
//  라이브면 박스의 대화 파일을 창으로 읽어 라이브로 따라가고 입력칸으로 보낸다(프롬프트 주입). 끝난 세션이면 기록 + [이어서 대화하기].
let sessChat: SessionChatHandle | null = null;
export function renderSession(host: HTMLElement, data: V2Data, id: string): void {
  // 기록(uuid) 링크로 들어왔는데 그 대화를 도는 박스가 있으면 그 박스가 정본이다(mergeSessions 가 기록을 박스에 접었다) — 옛 링크가 산다.
  const s = data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
  if (sessChat) { sessChat.destroy(); sessChat = null; }
  if (!s) { host.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '세션을 찾을 수 없어요. 목록을 새로고침해 주세요.' }))); return; }
  const termSrc = s.live ? terminalUrl(s.id, s.label, s.node) : null;
  sessChat = mountSessionChat(host, { ...s, projectName: projName(data, s.projectId) }, {
    terminalSrc: termSrc,
    openHref: s.live ? termSrc : (location.pathname + '?ui=classic#/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node) : '')),
    // 홈 입력창이 방금 연 세션이면 그 첫 지시를 낙관적으로 먼저 그린다(서버가 하네스 입력창이 뜬 뒤 실제로 넣는다).
    firstPrompt: takeFirstPrompt(s.id),
  });
}
/** 목록이 새로 왔을 때(20초 폴링) 열려 있는 세션 화면의 상태 표시를 갱신한다. 본문은 화면 자신이 대화 파일을 폴링한다. */
export function refreshSession(data: V2Data, id: string): void {
  if (!sessChat) return;
  const s = data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
  if (s) sessChat.update({ ...s, projectName: projName(data, s.projectId) });
}
export function unmountSession(): void { if (sessChat) { sessChat.destroy(); sessChat = null; } }

// ── 데이터 정규화 — 라이브(terminal/sessions) + 기록(v6/sessions) 를 한 목록으로 ─────────
//  같은 세션이 두 목록에 있으면 한 장으로: 라이브 행의 claudeSessionId(박스가 도는 대화 uuid) == 기록 행의 session_id 면
//  기록 행을 라이브 행에 접는다(logId·logNode). 종전엔 '박스 1장 + 그 대화의 기록 1장'이 나란히 떠 같은 세션이 둘로 보였다.
export function mergeSessions(liveRows: any[], logRows: any[]): Sess[] {
  const now = Date.now();
  const out = new Map<string, Sess>();
  const byUuid = new Map<string, Sess>();
  for (const r of liveRows || []) {
    const k = sessStateKey(r, now);
    const s: Sess = {
      id: String(r.id), label: String(r.label || r.title || r.id), projectId: r.projectId ? Number(r.projectId) : null,
      // 노드 세션의 node 는 {id,name,online} 객체다 — id 만 든다(터미널 URL·중앙 기록 좌표에 문자열로 쓴다).
      node: r.node && typeof r.node === 'object' ? (String(r.node.id || '') || null) : (r.node ? String(r.node) : null),
      live: true, alive: !sessIsDead(r, now), owned: !!r.owned, stateKey: k, stateLabel: sessLabel(r, now),
      lastSeen: Number(r.lastActive || r.created || 0) * (String(r.lastActive || r.created || 0).length > 11 ? 1 : 1000) || 0, raw: r,
    };
    out.set(s.id, s);
    if (r.claudeSessionId && !byUuid.has(String(r.claudeSessionId))) byUuid.set(String(r.claudeSessionId), s);
  }
  for (const r of logRows || []) {
    const id = String(r.session_id);
    if (out.has(id)) continue;
    const owner = byUuid.get(id);
    if (owner) {                                   // 라이브(또는 복원 가능) 박스가 이 대화를 돌린다 — 그 카드에 접는다
      owner.logId = id; owner.logNode = r.node_id || '';
      if (!owner.projectId && r.project_id != null) owner.projectId = Number(r.project_id);
      continue;
    }
    out.set(id, {
      id, label: String(r.title || id), projectId: r.project_id != null ? Number(r.project_id) : null, node: r.node_id || null,
      live: false, alive: false, owned: true, stateKey: 'log', stateLabel: '기록', lastSeen: r.last_seen ? new Date(r.last_seen).getTime() : 0, raw: r,
    });
  }
  return [...out.values()];
}

export function toastOnce(msg: string): void { toast(msg); }
