// v2/views.ts — 새 셸의 중앙 화면 셋(#1719): 홈(미선택) · 프로젝트 · 세션. 데이터는 main.ts 가 모아 넘긴다(V2Data).
//  홈은 **입력창 하나**(claude.ai 홈처럼 — Enter 로 프로젝트 없는 세션이 열린다, v2/quick-session.ts)이고,
//  프로젝트는 개요+세션, 세션은 그 세션 자체(대화창 — 라이브 또는 중앙 기록)를 실는다. 리브 대화는 #/liv 에 있다.
//  클래식 모듈을 **복제하지 않는다** — 대화·세션 목록·프로젝트 상세는 이미 있는 것을 가져다 붙인다.
import { api, el, errorNote, relTime, state, toast } from '../core.js';
import { isCreatingQuickSession, openQuickSession, takeFirstPrompt } from './quick-session.js';
import { createRunPicker } from './run-picker.js';
import { mountSessionChat, type SessionChatHandle } from '../session-chat.js';
import type { TrailWidget } from '../session-trail.js';
import { sessIsDead, sessLabel, sessStateKey, shouldRestoreOnOpen } from '../session-status.js';
import { soloSessionUrl, terminalUrl } from './apps.js';

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

// ── 홈 = 런처 (#1719 재설계 · #1798 행선지 제거) — 입력창이 주인공이다 ──────────
//  · 입력은 **항상 프로젝트 없는 세션**으로 열린다(세션 전용 폴더). 종전의 행선지 자동매칭·프로젝트 드롭다운은
//    #1798 에서 제거 — 이름 토큰 매칭의 오연결이 잦았고(무관한 프로젝트에 세션이 붙는 실측), 소속은 세션이
//    맥락을 갖춘 뒤에 정하는 게 맞다(미연결 첫 쓰기 훅이 새 프로젝트 생성을 기본으로 유도 · 상단바 수동 연결 #1749).
//  · Enter → 세션 생성 → 세션 대화 화면. 리브 대화는 홈에 두지 않는다(#/liv 가 그 자리).
//  · '지금 도는 세션'은 **답 기다리는 것 먼저**, 세션 이름과 프로젝트가 같으면 한 번만 쓴다(같은 말 두 줄 금지).

export function renderHome(host: HTMLElement, data: V2Data): void {
  const me = state.me || {};
  const name = String(me.display_name || me.email || me.userId || '');
  const live = data.sessions.filter((s) => s.live && s.alive);
  const busy = live.filter((s) => s.stateKey === 'busy').length;
  const waiting = live.filter((s) => s.stateKey === 'waiting').length;
  const h = new Date().getHours(); const tod = h < 12 ? '좋은 아침이에요' : h < 18 ? '좋은 오후예요' : '좋은 저녁이에요';
  const d = new Date(); const KO_DAY = ['일', '월', '화', '수', '목', '금', '토'];

  const ta = el('textarea', { class: 'v2-launch-in', rows: '2', placeholder: '무엇이든 시키세요 — 프로젝트 없이 열리고, 소속은 나중에 세션에서 정해요', 'aria-label': '무엇이든 시키기' }) as HTMLTextAreaElement;
  const send = el('button', { class: 'btn btn-primary v2-launch-send', type: 'button' }, el('span', { text: '시키기' }), el('kbd', { text: '⏎' })) as HTMLButtonElement;
  // [시키기] 왼쪽 세 칸 — 제공자(어느 회사 모델)·모델·추론강도(#1758). 기본은 내가 지난번에 고른 값이고,
  //  여기서 바꾸면 그게 다음 기본이 된다(v2/run-picker.ts — '새 AI 세션' 폼과 같은 기억을 쓴다).
  const runPicker = createRunPicker();
  const card = el('div', { class: 'v2-launch' }, ta,
    el('div', { class: 'v2-launch-row' }, el('div', { class: 'v2-launch-ctl' }, runPicker.el), send));

  const grow = (): void => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight) + 'px'; };
  const submit = async (): Promise<void> => {
    const text = ta.value.trim();
    if (!text || isCreatingQuickSession()) return;
    send.disabled = true; ta.disabled = true; runPicker.disable(true);
    send.replaceChildren(el('span', { text: '여는 중…' }));
    const ok = await openQuickSession(text, { run: runPicker.value() });
    if (!ok) { send.disabled = false; ta.disabled = false; runPicker.disable(false); send.replaceChildren(el('span', { text: '시키기' }), el('kbd', { text: '⏎' })); ta.focus(); }
  };
  send.onclick = () => { void submit(); };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
  });

  host.replaceChildren(
    el('section', { class: 'v2-home v2-home-launch' },
      el('div', { class: 'v2-home-eyebrow' },
        el('span', { text: `${d.getMonth() + 1}월 ${d.getDate()}일 ${KO_DAY[d.getDay()]}요일` }),
        // 세션이 하나도 안 돌면 그 말 자체를 안 한다 — '도는 세션 없음'은 정보가 아니라 빈자리 채우기다.
        busy ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'st busy' }, dot('busy'), `작업 중 ${busy}`)] : null,
        waiting ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'st wait' }, dot('waiting'), `답 기다림 ${waiting}`)] : null),
      el('h1', { class: 'v2-h1', text: `${tod}${name ? ', ' + name + '님' : ''}.` }),
      el('p', { class: 'v2-home-sub', text: '무엇을 할까요?' }),
      card,
      nowList(data)));
  window.setTimeout(() => { grow(); ta.focus(); }, 30);
}

function nowList(data: V2Data): HTMLElement {
  // 홈의 두 번째 존재 — 상태별 두 결(#1756): **답을 기다리는 것**은 내가 움직여야 풀리는 일이라 앰버 카드로
  //  도드라지고, 나머지는 조용한 목록이다. 종전엔 일곱 행이 같은 무게로 나열돼 급한 것이 안 보였다.
  const rank = (s: Sess): number => (s.stateKey === 'waiting' ? 0 : s.stateKey === 'busy' ? 1 : 2);
  const live = data.sessions.filter((s) => s.live && s.alive).sort((a, b) => rank(a) - rank(b) || b.lastSeen - a.lastSeen);
  if (!live.length) return el('div', {});
  const waits = live.filter((s) => s.stateKey === 'waiting');
  const rest = live.filter((s) => s.stateKey !== 'waiting').slice(0, 7 - Math.min(waits.length, 4));
  const rowOf = (s: Sess): HTMLElement => {
    const pn = projName(data, s.projectId);
    const raw = (s.raw || {}) as any;
    const title = s.label === pn && raw.title && String(raw.title) !== s.label ? String(raw.title) : s.label;
    const showProj = !!s.projectId && title !== pn;
    return el('a', { class: 'v2-now-row' + (s.stateKey === 'waiting' ? ' wait' : ''), href: '#/s/' + encodeURIComponent(s.id) },
      dot(s.stateKey),
      el('span', { class: 'tw' }, el('span', { class: 't', text: title }), showProj ? el('span', { class: 'p', text: pn }) : null),
      el('span', { class: 'st', text: s.stateKey === 'waiting' ? when(s.lastSeen) : `${s.stateLabel} · ${when(s.lastSeen)}` }),
      s.stateKey === 'waiting' ? el('span', { class: 'go btn btn-sm', text: '답하기' }) : null);
  };
  return el('div', { class: 'v2-now' },
    waits.length ? el('section', { class: 'v2-now-wait' },
      el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k wait', text: `답을 기다려요 · ${waits.length}` })),
      ...waits.slice(0, 4).map(rowOf)) : null,
    rest.length ? el('section', {},
      el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `돌고 있어요 · ${rest.length}` }),
        el('a', { class: 'btn-text', href: '#/app/terminal', text: '전체 →' })),
      ...rest.map(rowOf)) : null);
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

// ── 세션 — 그 세션 자체를 가운데에: 터미널 기본 + 대화(베타)(web/session-chat.ts) ─────────
//  라이브면 박스의 대화 파일을 창으로 읽어 라이브로 따라가고 입력칸으로 보낸다(프롬프트 주입). 끝난 세션이면 기록 + [이어서 대화하기].
//  핸들은 **호출자(탭)가 쥔다**(#1719 탭 — 세션 화면이 탭마다 하나씩 동시에 산다). 파괴·갱신도 탭이 한다.
export interface SessionViewOpts {
  /** 우패널 '발자취' 위젯(main.ts 가 그 탭의 aside 에 만들어 넘긴다). */
  trail?: TrailWidget | null;
  /** 상단바 [프로젝트 연결] 드롭다운(#1749) — main.ts 가 목록·실행·갱신을 쥔다. */
  onPickProject?: (anchor: HTMLElement) => void;
  /** 제목을 눌러 고친 세션 이름을 서버에 반영(#1719) — 사이드바·우패널·탭 제목 갱신까지 main.ts 가 쥔다. */
  onRename?: (label: string) => Promise<void>;
  /** 상단바 [파일] — 그 탭의 우패널을 '타임라인 ↔ 파일 탐색기'로 갈아 끼운다(#1744). 켜진 뒤 상태를 돌려준다. */
  onToggleFiles?: () => boolean;
  /** 팝아웃 창(?solo=1) — 왼쪽 사이드바 없이 이 화면만 띄운 창(#1744). */
  solo?: boolean;
}
export function renderSession(host: HTMLElement, data: V2Data, id: string, vopts: SessionViewOpts = {}): SessionChatHandle | null {
  // 기록(uuid) 링크로 들어왔는데 그 대화를 도는 박스가 있으면 그 박스가 정본이다(mergeSessions 가 기록을 박스에 접었다) — 옛 링크가 산다.
  const s = data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
  if (!s) { host.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '세션을 찾을 수 없어요. 목록을 새로고침해 주세요.' }))); return null; }
  // 프레임에 실을 터미널은 embed=1 — 그 안의 상단바·파일 탐색기는 이 화면의 상단바·우패널로 이미 합쳐졌다(#1744).
  const termSrc = s.live ? terminalUrl(s.id, s.label, s.node, { embed: true }) : null;
  return mountSessionChat(host, { ...s, projectName: projName(data, s.projectId) }, {
    terminalSrc: termSrc,
    // 나가는 문: 본 화면이면 이 세션만 담은 **팝아웃 창**(같은 컴포넌트, 사이드바만 없다), 팝아웃 창이면 반대로 전체 화면.
    openHref: vopts.solo ? location.pathname + '#/s/' + encodeURIComponent(s.id) : soloSessionUrl(s.id),
    // 홈 입력창이 방금 연 세션이면 그 첫 지시를 낙관적으로 먼저 그린다(서버가 하네스 입력창이 뜬 뒤 실제로 넣는다).
    firstPrompt: takeFirstPrompt(s.id),
    trail: vopts.trail || null,
    onPickProject: vopts.onPickProject,   // 상단바 [프로젝트 연결] 드롭다운(#1749)
    onRename: vopts.onRename,             // 제목 = 세션 이름(#1719) — 고치면 사이드바·목록이 그 이름으로 바뀐다
    onToggleFiles: vopts.onToggleFiles,   // 상단바 [파일] → 우패널 파일 탐색기(#1744)
    solo: vopts.solo,
    // ★ #1820 — 멈춘 내 세션은 **열면 바로 되살린다**. 위 주석의 '읽기전용 기록 + 버튼 한 번'은 화면이 어긋나던
    //  사고(#1808)의 처방이었는데, 그 처방이 "열어도 아무 일도 안 난다"를 기본 경험으로 만들었다(dev 실측:
    //  내 세션 219건 중 복원 가능 198건). 어긋남의 원인은 '자동'이 아니라 **프레임이 몰래 갈아탄 것**이었으므로,
    //  셸이 라우팅까지 쥐고 되살리면 둘 다 만족한다. 실패하면 그 기록 화면과 버튼이 그대로 남는다.
    autoResume: shouldRestoreOnOpen({ restorable: !!s.raw?.restorable, owned: s.owned }),
  });
}

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
