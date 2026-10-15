// v2/app-try-session.ts — 앱빌더 ③ 「세션 위젯으로 보기」 의 **시험 세션**(#4632, 원준 2026-10-15).
//  처음엔 앱을 만드는 세션 화면으로 갔고(«시연 중이잖아 · 앱을 수정하는 세션이 들어가면 안 되지»), 다음엔 AI 없는 가짜 세션을 그렸다 —
//  그 판에 원준이 다시 짚었다: «칠 수 있어야지 실제로 어떻게 동작하는지 쳐볼 수 있어야 해 · 수정을 위한 AI 세션이 아니어야 한다는 거 ·
//  회의록 위젯을 가지고 세션과 상호작용해 보고 싶을 거고, 세션에서 회의록 위젯을 검색해 보고 싶을 거고 · 다른 사이드바나 이런 곳에 노출하지는 말고».
//
//  그래서 **진짜 AI 세션** 하나를 따로 띄운다(앱을 만드는 세션과 다른 세션 · 이름 «"이름" 앱 시험» — 사람이 지은 이름으로 박혀 표식이 되고,
//   셸의 세션 목록 어디에도 서지 않는다: lib/builder-flow isTrySession). 그 세션에 앱을 붙이고, **진짜 세션 화면**(panes.ts mountPanes —
//   문패 · 세션 · 우측 사이드바 · 탭 줄의 [+] 앱 찾기 전부 그대로)을 앱빌더 자리에 세운다. 우측 사이드바는 붙은 앱 탭으로 연다.
//  코멘트 막대(app-review.ts)는 맨 위 **문패 줄 위에 얹힌다**(dock) — 세션과 사이드바의 자리 · 크기는 진짜와 같다
//   (원준 «이거 실제 화면에 윗부분을 차지하잖아? 그러면 결과적으로 사실과 다르다는 건데»). 문패(프로젝트 이름 줄)만 막대가 가린다.
import { api, el } from '../core.js';
import { spawnSession } from './quick-session.js';
import { attachAppToSession, preferSessAppTab, refreshSessionApps, SHOW_SESSAPP_EVT } from './session-app-pane.js';
import { takeCreated } from './created-cache.js';
import { trySessionLabel } from '../lib/builder-flow.js';
import { tryBrief } from '../lib/studio-flow.js';

export interface TrySession {
  root: HTMLElement;
  /** 코멘트 막대가 얹히는 자리 — 문패 줄 위(app-review 의 dock). */
  dock: HTMLElement;
  destroy(): void;
}

/** 시험 세션을 마련한다 — 전에 띄운 것이 아직 있으면(목록 · 기록 어디든) 그것, 없으면 새로(앱빌더 프로젝트 · 첫 지시 = 써 보는 세션이라는 말).
 *  어느 쪽이든 앱을 붙인다(동의가 필요하면 그 자리에서 묻는다 — 거절하면 null). */
export async function ensureTrySession(o: { appId: string; title: string; projectId: number; prevSid?: string }): Promise<string | null> {
  let sid = o.prevSid || '';
  if (sid && !(await sessionKnown(sid))) sid = '';
  if (!sid) {
    const s = await spawnSession(tryBrief(o.title, o.appId), { projectId: o.projectId, label: trySessionLabel(o.title) });
    if (!s) return null;   // 까닭은 spawnSession 이 이미 말했다
    sid = s.id;
  }
  return (await attachAppToSession(sid, o.appId, o.title)) ? sid : null;
}
/** 그 세션이 아직 있나 — 도는 목록이나 지난 기록 어디든. 못 읽으면 있다고 본다(괜히 새 세션을 띄우지 않게). */
async function sessionKnown(sid: string): Promise<boolean> {
  try {
    const [live, logs] = await Promise.all([
      api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (d && d.sessions) || []),
      api('/api/ui/v6/sessions?limit=60').then((d: any) => (d && d.sessions) || []),
    ]);
    return [...live, ...logs].some((x: any) => x && (x.id === sid || x.box_id === sid || x.boxId === sid));
  } catch (_) { return true; }
}

/** 시험 세션 화면을 host 에 세운다 — 진짜 세션 화면(mountPanes) 한 벌. 그 세션의 우측 사이드바는 앱 탭으로 연다. */
export function mountTrySession(host: HTMLElement, o: { appId: string; sid: string; projectId: number }): TrySession {
  let dead = false, handle: { destroy(): void } | null = null, pollT = 0;
  const dock = el('div', { class: 'v2-try-dock' });
  const shell = el('div', { class: 'v2-try-shell' }, el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '시험 세션을 여는 중…' })));
  const root = el('div', { class: 'v2-try' + (host === document.body ? ' v2-try--fixed' : ''), role: 'region', 'aria-label': '시험 세션' }, shell, dock);
  host.append(root);
  preferSessAppTab(o.sid);   // 우측 사이드바가 늘 서던 「자료」 대신 붙은 앱 탭으로 열린다

  void (async () => {
    try {
      const [detail, live, logs] = await Promise.all([
        api('/api/ui/v6/projects/' + o.projectId).catch(() => null),
        api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
        api('/api/ui/v6/sessions?limit=60').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
      ]);
      if (dead) return;
      //  정적으로 들여오면 views/panes → apps → app-studio → 이 모듈로 순환한다(check-imports) — 화면을 세울 때 늦게.
      const [{ mergeSessions, renderSession }, { mountPanes }] = await Promise.all([import('./views.js'), import('./panes.js')]);
      if (dead) return;
      const made = takeCreated(o.sid);
      const rows = made ? [made, ...(live as any[]).filter((x: any) => x && x.id !== o.sid)] : (live as any[]);
      //  이 화면의 목록은 **시험 세션 한 장**과 그 프로젝트뿐 — 서랍 · 문패가 다른 세션을 끌어오지 않는다.
      const data: any = {
        projects: detail && detail.id ? [{ id: Number(detail.id), name: String(detail.name || ''), status: detail.status ?? null }] : [],
        sessions: mergeSessions(rows, logs as any[]).filter((s: any) => s.id === o.sid || (Array.isArray(s.altIds) && s.altIds.includes(o.sid))),
        loadedAt: Date.now(), lists: [], folders: [],
      };
      shell.replaceChildren();
      handle = mountPanes(shell, {
        data: () => data, id: o.projectId, detail, sessionId: o.sid,
        mountSession: (h, sid, oo) => renderSession(h, data, sid, { trail: (oo && oo.trail) || null, onOpenFiles: oo && oo.openFiles ? oo.openFiles : undefined,
          filesLabel: oo && oo.filesLabel ? oo.filesLabel : undefined, appDoor: oo && oo.appDoor ? oo.appDoor : undefined, isVisible: () => !dead && root.isConnected }),
      });
      //  앱 탭이 아직 안 섰으면(붙이기가 막 끝나 목록이 늦다) 몇 번 다시 부른다 — 이 화면 안의 사이드바에만.
      let tries = 0;
      const nudge = (): void => {
        if (dead || tries++ > 10) return;
        if (root.querySelector('iframe.v2-appui-frame[data-app-id="' + CSS.escape(o.appId) + '"]')) return;
        refreshSessionApps(o.sid);
        const w = root.querySelector('.pn-wrap'); if (w) w.dispatchEvent(new CustomEvent(SHOW_SESSAPP_EVT, { detail: { app_id: o.appId } }));
        pollT = window.setTimeout(nudge, 1200);
      };
      pollT = window.setTimeout(nudge, 900);
    } catch (e: any) {
      if (!dead) shell.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '시험 세션을 열지 못했어요 — ' + (e && e.message ? e.message : e) })));
    }
  })();

  return {
    root, dock,
    destroy() {
      if (dead) return; dead = true; window.clearTimeout(pollT);
      try { handle?.destroy(); } catch (_) { /* 이미 떨어졌다 */ }
      root.remove();
    },
  };
}
