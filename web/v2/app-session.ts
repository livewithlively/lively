// web/v2/app-session.ts — 설치된 '세션 앱'(org_app)을 연다 (#1780 PR4b).
//  전역 런치패드(side-rail 의 ⊞ 앱)·세션 화면 곁칸 [앱] 부품(panes-parts appsPart)이 **공유**하는 진입점이다.
//  세션 앱 = 매니페스트로 스킬·persona·MCP·UI 를 묶은 앱. 열면 그 앱의 하네스 자산이 물질화된 tmux 세션이 뜨고
//  (서버 createSession 이 appId 를 받아 grant 재검·앱 토큰 발급·세션폴더 앱홈/자산 물질화를 한다 — sessions.ts D3·D4),
//  사용자는 그 세션과 대화한다. 일반 세션(quick-session)과 다른 점은 **appId 를 실어 보낸다**는 것 하나 —
//  그 한 필드가 앱 세션 배관 전체를 켠다.
//
//  스폰 전제 = **동의(grant)**. 서버는 grant 가 없으면 mintAppToken 에서 403 을 준다. 이 모듈이 그 403 을 받아
//   동의 창을 띄우고, 동의하면 POST /apps/:id/grant(선언 상한 그대로 — 서버가 매니페스트 부분집합으로 고정)한 뒤
//   **한 번** 재시도한다. 거절하면 조용히 멈춘다(세션 안 뜸).
import { api, el, toast } from '../core.js';
import { runPrefs } from './run-picker.js';
import { chooseAppExecution, ensureSessionAppInstance, type AppExecution } from './app-instance.js';

export interface SessionApp {
  id: string;
  title: string;
  version: string;
  scopes: string[];   // 매니페스트 선언 상한(동의 창 표시용)
  tools: string[];    // 〃 (permissions.tools ∪ ext_tools)
  pages: Array<{ key: string; title: string }>;  // #1780 PR5 — ui.pages(있으면 UI 앱). 없으면 [](세션 앱).
  sites: string[];   // csp.frame_domains — 이 앱이 **화면에 싣는** 사이트(동의 창에 보여 준다)
  net: string[];     // csp.connect_domains ∪ permissions.hosts — 이 앱이 **직접 연결하는** 곳
  instances: { project: 'global' | 'optional' | 'required'; multiplicity: 'single' | 'multiple' };
  runtime: { kind: 'worker'; placement: 'any' | 'central' | 'remote'; idle_timeout_sec: number; memory_mb: number } | null;
  system: { renderer: 'session' | 'browser' | 'classic'; home?: string; route?: string } | null;
  source: { kind?: string };
}

/** 설치된 세션 앱 = status 'active' + enabled. 런치패드·앱서랍이 격자에 싣는다. */
export async function listSessionApps(): Promise<SessionApp[]> {
  try {
    const out: any = await api('/api/ui/apps');
    const rows: any[] = Array.isArray(out?.apps) ? out.apps : [];
    return rows
      .filter((a) => a && a.status === 'active' && a.enabled !== false)
      .map((a) => {
        const perm = (a.manifest && a.manifest.permissions) || {};
        const tools = [...(perm.tools || []), ...(perm.ext_tools || [])].map(String);
        const pages = (((a.manifest && a.manifest.ui) || {}).pages || []).map((p: any) => ({ key: String(p.key), title: String(p.title || p.key) }));
        const csp = (a.manifest && a.manifest.csp) || {};
        const sites = (csp.frame_domains || []).map(String);
        const net = [...(csp.connect_domains || []), ...(perm.hosts || [])].map(String);
        const instances = (a.manifest && a.manifest.instances) || { project: 'optional', multiplicity: 'multiple' };
        const runtime = a.manifest?.runtime?.kind === 'worker' ? {
          kind: 'worker' as const,
          placement: a.manifest.runtime.placement as 'any' | 'central' | 'remote',
          idle_timeout_sec: Number(a.manifest.runtime.idle_timeout_sec || 300),
          memory_mb: Number(a.manifest.runtime.memory_mb || 256),
        } : null;
        const source = (a.source && typeof a.source === 'object') ? a.source : {};
        // system renderer는 builtin에서만 신뢰한다(서버 AppInstance 응답과 같은 경계). 외부 앱은 generic iframe.
        const system = source.kind === 'builtin' && a.manifest ? (a.manifest.system || null) : null;
        return { id: String(a.id), title: String(a.title || a.id), version: String(a.version || '0.0.0'),
          scopes: (perm.scopes || []).map(String), tools, pages, sites, net, instances, runtime, system, source };
      });
  } catch (e: any) {
    // 앱 레지스트리가 아직 없는 배포(구버전)·권한 없음 등 — 조용히 빈 목록(런치패드는 화면앱만 보인다).
    return [];
  }
}

let spawning = false;
export function isSpawningApp(): boolean { return spawning; }

/**
 * 앱 세션을 만든다. 성공하면 { id }, 사용자가 동의를 취소했거나 실패하면 null(이유는 toast).
 *  UI 중립 — **행선지는 호출자가 정한다**: 런치패드는 openAppSession 으로 #/s/<id> 로 간다.
 *  opts.projectId 를 주면 만든 뒤 그 프로젝트에 붙인다.
 */
/**
 * 이 앱에 대한 내 동의(grant)를 확보한다 — 없으면 **동의 창을 띄우고** 승인 시 grant 를 만든다.
 *  세션 스폰(403)·앱 UI 의 첫 도구 호출(403) 양쪽이 같은 창을 쓴다(동의는 한 번, 이후 계속 유효).
 *  반환 false = 사람이 취소함(호출부는 조용히 멈춘다).
 *  ⚠ **single-flight**: 앱이 시작하자마자 도구를 여러 개 부르면 403 도 여러 개 온다(실측: 브라우저 앱이
 *   북마크·최근주소를 동시에 읽어 동의 창이 두 겹으로 떴다). 앱당 진행 중인 동의는 하나로 합친다.
 */
const grantInFlight = new Map<string, Promise<boolean>>();
export function ensureAppGrant(appId: string, title?: string): Promise<boolean> {
  const cur = grantInFlight.get(appId);
  if (cur) return cur;
  const run = (async (): Promise<boolean> => {
    const app = (await listSessionApps()).find((a) => a.id === appId)
      || { id: appId, title: title || appId, version: '', scopes: [], tools: [], pages: [], sites: [], net: [],
        instances: { project: 'optional' as const, multiplicity: 'multiple' as const }, runtime: null, system: null, source: {} };
    if (!(await appConsent(app))) return false;
    await api('/api/ui/apps/' + encodeURIComponent(appId) + '/grant', { method: 'POST', body: JSON.stringify({}) });
    return true;
  })().finally(() => { grantInFlight.delete(appId); });
  grantInFlight.set(appId, run);
  return run;
}

export async function spawnAppSession(
  appId: string,
  opts?: { title?: string; projectId?: number | null; initialPrompt?: string },
): Promise<{ id: string } | null> {
  if (spawning) return null;
  spawning = true;
  try {
    const app = (await listSessionApps()).find((item) => item.id === appId);
    let execution: AppExecution | undefined;
    if (app?.runtime) {
      // worker는 화면을 보기만 하는 것과 달리 실제 코드를 실행하므로 세션을 만들기 전에 grant와 위치를 확정한다.
      if (!(await ensureAppGrant(appId, opts?.title || app.title))) return null;
      const selected = await chooseAppExecution(opts?.title || app.title, app.runtime);
      if (!selected) return null;
      execution = selected;
    }
    let id = '';
    try { id = await postAppSession(appId, opts); }
    catch (e: any) {
      if (e && e.status === 403) {
        if (!(await ensureAppGrant(appId, opts?.title))) return null;   // 취소 = 조용히 멈춤
        id = await postAppSession(appId, opts);
      } else throw e;
    }
    if (opts?.projectId && Number(opts.projectId) > 0) {
      // 세션은 이미 유효 — 붙이기 실패는 치명 아님(사용자는 우측 '이 세션'에서 나중에 붙일 수 있다).
      try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(id) + '/project', { method: 'POST', body: JSON.stringify({ projectId: Number(opts.projectId) }) }); }
      catch (_) { /* noop */ }
    }
    try {
      await ensureSessionAppInstance(appId, id, {
        projectId: opts?.projectId ?? null,
        title: opts?.title || app?.title || appId,
        execution,
      });
    } catch (error: any) {
      // 세션은 이미 만들어졌다. AppInstance/worker 메타 실패가 대화 자체를 회수하지 않게 하되 원인은 숨기지 않는다.
      console.warn('[app-instance] 앱 세션 인스턴스 확보 실패', error);
      if (app?.runtime) toast('세션은 열렸지만 앱 worker를 시작하지 못했어요 — ' + (error?.message || error), true);
    }
    return { id };
  } catch (e: any) {
    toast('앱을 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
    return null;
  } finally { spawning = false; }
}

/** 앱 세션을 열고 그 대화 화면(#/s/<id>)으로 간다 — 전역 런치패드용. */
export async function openAppSession(appId: string, opts?: { title?: string; projectId?: number | null; initialPrompt?: string }): Promise<boolean> {
  const s = await spawnAppSession(appId, opts);
  if (!s) return false;
  location.hash = '#/s/' + encodeURIComponent(s.id);
  return true;
}

async function postAppSession(appId: string, opts?: { title?: string; initialPrompt?: string }): Promise<string> {
  const p = runPrefs();
  const out: any = await api('/api/ui/terminal/sessions', {
    method: 'POST',
    body: JSON.stringify({
      label: (opts?.title || appId).slice(0, 28),
      harness: p.harness && p.harness !== 'shell' ? p.harness : 'claude',
      flags: p.flags && typeof p.flags === 'object' ? p.flags : {},
      autoApprove: !!p.autoApprove, sessionDir: true, appId,
      ...(opts?.initialPrompt ? { initialPrompt: opts.initialPrompt } : {}),
    }),
  });
  const id = out && out.session && out.session.id ? String(out.session.id) : '';
  if (!id) throw new Error('세션 id 를 받지 못했습니다');
  return id;
}

// ── 동의(grant) 창 — 이 앱을 내 자격으로 쓰겠다는 확인. 선언 상한(scope·도구)을 그대로 보여 준다. ──
//  네이티브 confirm() 은 안 쓴다(브라우저 모달은 이벤트를 막는다) — DOM 오버레이 + Esc/밖클릭 취소.
function appConsent(app: SessionApp): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') finish(false); };
    const finish = (v: boolean): void => { if (done) return; done = true; ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const chips = (xs: string[], empty: string) => (xs.length
      ? xs.map((s) => el('span', { class: 'v2-consent-chip', text: s }))
      : [el('span', { class: 'v2-consent-chip none', text: empty })]);
    const ov = el('div', { class: 'v2-consent-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': app.title + ' 사용 동의',
      onclick: (e: Event) => { if (e.target === ov) finish(false); } },
      el('div', { class: 'v2-consent' },
        el('h3', { class: 'v2-consent-t', text: '「' + app.title + '」을(를) 내 자격으로 실행할까요?' }),
        el('p', { class: 'v2-consent-sub', text: '이 앱의 화면·worker·AI 세션은 아래 권한만 내 이름으로 씁니다. 언제든 설정에서 철회할 수 있어요.' }),
        el('div', { class: 'v2-consent-grp' }, el('b', { text: '권한' }), el('div', { class: 'v2-consent-chips' }, ...chips(app.scopes, '추가 권한 없음'))),
        el('div', { class: 'v2-consent-grp' }, el('b', { text: '도구' }), el('div', { class: 'v2-consent-chips' }, ...chips(app.tools, '도구 없음'))),
        // 선언된 사이트 — 앱이 화면에 싣거나 직접 연결하는 곳. 없으면 줄 자체를 안 그린다(없는 걸 설명하지 않는다).
        app.sites.length ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '사이트' }),
          el('div', { class: 'v2-consent-chips' }, ...chips(app.sites.map((d) => d === '*' ? '모든 사이트(화면에 싣기)' : d), ''))) : null,
        app.net.length ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '연결' }),
          el('div', { class: 'v2-consent-chips' }, ...chips(app.net, ''))) : null,
        el('div', { class: 'v2-consent-acts' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => finish(false) }),
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '동의하고 열기', onclick: () => finish(true) }))));
    document.body.append(ov as HTMLElement);
    document.addEventListener('keydown', onKey);
    (ov.querySelector('.btn-primary') as HTMLElement | null)?.focus();
  });
}
