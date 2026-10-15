// v2/app-try-session.ts — 앱빌더 ③ 「세션 위젯으로 보기」 의 **시험 세션**(#4632, 원준 2026-10-15
//  «칠 수 있어야지 실제로 어떻게 동작하는지 쳐볼 수 있어야 해 · 수정을 위한 AI 세션이 아니어야 · 회의록 위젯을 가지고 세션과 상호작용 ·
//  세션에서 회의록 위젯을 검색해 보고 싶을 거고 · 다른 사이드바나 이런 곳에 노출하지는 말고»).
//
//  앱을 만드는 세션과 다른 **진짜 AI 세션** 하나를 따로 띄운다 — 이름 «"이름" 앱 시험»(사람이 지은 이름으로 박혀 표식이 되고, 셸의 세션 목록
//   어디에도 서지 않는다: lib/builder-flow isTrySession). 그 세션에 앱을 붙이고 **진짜 세션 화면**(panes.ts mountPanes — 문패 · 세션 · 우측 사이드바 ·
//   탭 줄의 [+] 앱 찾기 전부 그대로)을 앱빌더 자리에 세운다. 우측 사이드바는 붙은 앱 탭으로 연다.
//  코멘트 막대(app-review.ts)는 맨 위 **문패 줄 위에 얹힌다**(dock) — 세션과 사이드바의 자리 · 크기는 진짜와 같다(«윗부분을 차지하면 사실과 다르다»).
//  숨긴 세션이라 사람은 목록에서 못 찾는다 — 그래서 띄운 순간 기록하고(onSpawned), 기록을 잃었으면 이름으로 다시 찾는다(findTrySession).
//  셸이 제 탭에 해 주는 일(20초 상태 갱신 · 되살린 뒤 새 id 로 옮기기)은 여기서 한다 — 셸 목록엔 이 세션이 없다.
import { api, el } from '../core.js';
import { spawnSession } from './quick-session.js';
import { attachAppToSession, preferSessAppTab, refreshSessionApps, SHOW_SESSAPP_EVT } from './session-app-pane.js';
import { takeCreated } from './created-cache.js';
import { findTrySession, trySessionLabel } from '../lib/builder-flow.js';
import { tryBrief } from '../lib/studio-flow.js';
import type { SessionChatHandle } from '../session-chat.js';

export interface TrySession {
  root: HTMLElement;
  /** 코멘트 막대가 얹히는 자리 — 문패 줄 위(app-review 의 dock). */
  dock: HTMLElement;
  destroy(): void;
}

const liveRows = (): Promise<any[]> => api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (Array.isArray(d && d.sessions) ? d.sessions : []));
const logRows = (): Promise<any[]> => api('/api/ui/v6/sessions?limit=60').then((d: any) => (Array.isArray(d && d.sessions) ? d.sessions : []));

/** 시험 세션을 마련한다 — 기록의 세션이 아직 있으면 그것, 없으면 이름으로 찾은 것, 그것도 없으면 새로(앱빌더 프로젝트 · 첫 지시 = 써 보는 세션이라는 말).
 *  세션 id 는 **정해지는 즉시** onSpawned 로 알린다(붙이기가 실패하거나 사람이 떠나도 다음에 같은 세션을 쓴다). 앱을 붙이면 id, 못 붙이면 null. */
export async function ensureTrySession(o: { appId: string; title: string; projectId: number; prevSid?: string; onSpawned: (sid: string) => void }): Promise<string | null> {
  const label = trySessionLabel(o.title);
  //  기록의 세션이 아직 있나 — 박스 목록(멈춘 박스도 서 있다)의 id 로 본다(기록 줄 v6 은 대화 uuid 라 박스 id 와 맞지 않는다). 목록을 못 읽으면 기록을 믿는다.
  const live = await liveRows().catch(() => null);
  let sid = '';
  if (o.prevSid && (!live || live.some((x: any) => x && x.id === o.prevSid))) sid = o.prevSid;
  if (!sid && live) sid = findTrySession(live, label, o.projectId);
  if (!sid) {
    const s = await spawnSession(tryBrief(o.title, o.appId), { projectId: o.projectId, label });
    if (!s) return null;   // 실패면 spawnSession 이 까닭을 말했다(다른 세션을 막 띄우는 중이면 조용히 — 다시 누르면 된다)
    sid = s.id;
  }
  o.onSpawned(sid);
  return (await attachAppToSession(sid, o.appId, o.title)) ? sid : null;
}

/** 시험 세션 화면을 host 에 세운다 — 진짜 세션 화면(mountPanes) 한 벌. 우측 사이드바는 앱 탭으로 연다.
 *  onResumed — 멈춘 세션을 되살려 **새 박스 id** 가 됐다(부르는 쪽이 기록을 옮긴다). 화면은 여기서 그 id 로 다시 세운다(앱빌더를 떠나지 않게). */
export function mountTrySession(host: HTMLElement, o: { appId: string; sid: string; projectId: number; onResumed: (sid: string) => void }): TrySession {
  let dead = false, handle: { destroy(): void } | null = null, chat: SessionChatHandle | null = null, pollT = 0, tickT = 0, seq = 0;
  let sid = o.sid, detail: any = null;
  const dock = el('div', { class: 'v2-try-dock' });
  const shell = el('div', { class: 'v2-try-shell' }, el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '시안을 여는 중…' })));
  const root = el('div', { class: 'v2-try' + (host === document.body ? ' v2-try--fixed' : ''), role: 'region', 'aria-label': '시험 세션' }, shell, dock);
  host.append(root);
  //  막대가 문패 줄을 꼭 덮게 — 문패 높이를 재어 넘긴다(폭 · 글꼴이 바뀌면 다시).
  const doorObs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    const d = shell.querySelector('.pn-door') as HTMLElement | null; if (d && d.offsetHeight) root.style.setProperty('--v2-try-door-h', d.offsetHeight + 'px');
  }) : null;
  //  이 화면의 목록은 **시험 세션 한 장**과 그 프로젝트뿐 — 서랍 · 문패가 다른 세션을 끌어오지 않는다. 살아 있는 줄이 이긴다(created-cache 는 얇다).
  const data: any = { projects: [], sessions: [], loadedAt: Date.now(), lists: [], folders: [] };
  const fill = async (): Promise<void> => {
    const [live, logs] = await Promise.all([liveRows().catch(() => null), logRows().catch(() => [] as any[])]);
    if (!live) return;   // 못 읽은 틱은 직전 것을 그대로 둔다(셸과 같다 — 빈 목록이면 «세션을 찾을 수 없어요» 가 선다)
    const { mergeSessions } = await import('./views.js');
    //  생성 · 복원 응답(created-cache)은 목록이 아직 모르거나 «중단됨»(restorable) 으로 들고 있을 때만 이긴다 — 같은 id 로 되살린 세션(main.ts seedCreated 와 같은 규칙).
    const made: any = takeCreated(sid);
    const row = live.find((x: any) => x && x.id === sid);
    const rows = made && (!row || row.restorable) ? [made, ...live.filter((x: any) => !(x && x.id === sid))] : live;
    data.sessions = mergeSessions(rows, logs).filter((s: any) => s.id === sid || (Array.isArray(s.altIds) && s.altIds.includes(sid)));
    data.loadedAt = Date.now();
  };
  const projectName = (): string => (data.projects[0] && data.projects[0].name) || '';
  const mountShell = async (): Promise<void> => {
    const mine = ++seq;
    preferSessAppTab(sid);   // 우측 사이드바가 늘 서던 「자료」 대신 붙은 앱 탭으로 열린다
    //  정적으로 들여오면 views/panes → apps → app-studio → 이 모듈로 순환한다(check-imports) — 화면을 세울 때 늦게.
    const [{ renderSession }, { mountPanes }] = await Promise.all([import('./views.js'), import('./panes.js'), fill()]);
    if (dead || mine !== seq) return;
    handle?.destroy(); handle = null; chat = null;
    shell.replaceChildren();
    handle = mountPanes(shell, {
      data: () => data, id: o.projectId, detail, sessionId: sid,
      mountSession: (h, s, oo) => {
        chat = renderSession(h, data, s, { trail: (oo && oo.trail) || null, onOpenFiles: oo && oo.openFiles ? oo.openFiles : undefined,
          filesLabel: oo && oo.filesLabel ? oo.filesLabel : undefined, appDoor: oo && oo.appDoor ? oo.appDoor : undefined,
          isVisible: () => !dead && root.isConnected,
          //  되살렸다 — 셸 주소(#/s/…)로 가지 않고 이 자리에서 다시 세운다(셸 목록엔 이 세션이 없어 그 주소는 길을 잃는다). 같은 id 로 되살린 것(#4694 뒤
          //   대개 그렇다)도 셸처럼 다시 그린다 — 복원 응답이 «중단됨» 줄을 이겨 살아 있는 화면으로 선다. 새 id 면 기록도 옮긴다.
          onResumed: (nid: string) => { if (dead || !nid) return; if (nid !== sid) { sid = nid; o.onResumed(nid); } remount(); } });
        return chat;
      },
    });
    const door = shell.querySelector('.pn-door'); if (door && doorObs) { doorObs.disconnect(); doorObs.observe(door); }
    //  앱 탭이 아직 안 섰으면(붙이기가 막 끝나 목록이 늦다) 몇 번 다시 부른다 — 이 화면 안의 사이드바에만.
    let tries = 0;
    const nudge = (): void => {
      if (dead || mine !== seq || tries++ > 10) return;
      if (root.querySelector('iframe.v2-appui-frame[data-app-id="' + CSS.escape(o.appId) + '"]')) return;
      refreshSessionApps(sid);
      const w = root.querySelector('.pn-wrap'); if (w) w.dispatchEvent(new CustomEvent(SHOW_SESSAPP_EVT, { detail: { app_id: o.appId } }));
      pollT = window.setTimeout(nudge, 1200);
    };
    window.clearTimeout(pollT); pollT = window.setTimeout(nudge, 900);
  };
  const failNote = (e: any): void => { if (!dead) shell.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '시안을 열지 못했어요 — ' + (e && e.message ? e.message : e) }))); };
  const remount = (): void => { void mountShell().catch(failNote); };
  //  20초마다 세션 줄을 다시 읽어 세션 화면에 흘린다(도는 중 · 멈춤 · 이름) — 셸이 제 탭에 하는 일과 같다(main.ts tab.chat.update).
  const tick = async (): Promise<void> => {
    if (dead) return;
    if (!document.hidden && chat) {
      try { await fill(); const s = data.sessions[0]; if (!dead && s && chat && chat.id === s.id) chat.update({ ...s, projectName: projectName() }); } catch (_) { /* 다음 틱 */ }
    }
    if (!dead) tickT = window.setTimeout(() => { void tick(); }, 20_000);
  };

  void (async () => {
    try {
      detail = await api('/api/ui/v6/projects/' + o.projectId).catch(() => null);
      if (detail && detail.id) data.projects = [{ id: Number(detail.id), name: String(detail.name || ''), status: detail.status ?? null }];
      if (dead) return;
      await mountShell();
      tickT = window.setTimeout(() => { void tick(); }, 20_000);
    } catch (e: any) { failNote(e); }
  })();

  return {
    root, dock,
    destroy() {
      if (dead) return; dead = true; window.clearTimeout(pollT); window.clearTimeout(tickT); doorObs?.disconnect();
      try { handle?.destroy(); } catch (_) { /* 이미 떨어졌다 */ }
      root.remove();
    },
  };
}
