// web/v2/app-session.ts — 설치된 '세션 앱'(org_app)을 연다 (#1780 PR4b).
//  전역 런치패드(side-rail 의 ⊞ 앱)·세션 화면 곁칸 [앱] 부품(panes-parts appsPart)이 **공유**하는 진입점이다.
//  세션 앱 = 매니페스트로 스킬·persona·MCP·UI 를 묶은 앱. 열면 그 앱의 하네스 자산이 물질화된 tmux 세션이 뜨고
//  (서버 createSession 이 appId 를 받아 grant 재검·앱 토큰 발급·private session_home에 자산을 물질화한다),
//  사용자는 그 세션과 대화한다. 일반 세션(quick-session)과 다른 점은 **appId 를 실어 보낸다**는 것 하나 —
//  그 한 필드가 앱 세션 배관 전체를 켠다.
//
//  스폰 전제 = **동의(grant)**. 서버는 grant 가 없으면 mintAppToken 에서 403 을 준다. 이 모듈이 그 403 을 받아
//   동의 창을 띄우고, 동의하면 POST /apps/:id/grant(선언 상한 그대로 — 서버가 매니페스트 부분집합으로 고정)한 뒤
//   **한 번** 재시도한다. 거절하면 조용히 멈춘다(세션 안 뜸).
import { appIconSpecOf, type AppIconSpec } from './glass-icon.js';   // #4769 앱 아이콘 선언
import { api, el, toast } from '../core.js';
import { runPrefs } from './run-picker.js';
import { toolExplain } from '../lib/tool-explain.js';   // #4632 동의 창 도구 칩의 쉬운 설명

export interface SessionApp {
  id: string;
  title: string;
  version: string;
  scopes: string[];   // 매니페스트 선언 상한(동의 창 표시용)
  tools: string[];    // 〃 (permissions.tools ∪ ext_tools)
  pages: Array<{ key: string; title: string }>;  // #1780 PR5 — ui.pages(있으면 UI 앱). 없으면 [](세션 앱).
  tables: string[];   // #4225 — data.tables 이름. 있으면 세션에 붙여 AI 가 쓸 데이터가 있는 앱
  editMode: 'all' | 'members';   // #4225 누가 고칠 수 있나(app_save) — 기본 전원
  editMembers: string[];
  canEdit: boolean;              // 이 사람이 고칠 수 있나(서버 판정)
  installedBy: string;           // #4592 누가 처음 설치했나 — 「만든 사람」 은 madeBy(서버 기록)를 쓴다
  installedAt: number;           // 〃 처음 저장된 때(ms · 모르면 0)
  studio: { place?: string; card?: unknown; put?: boolean } | null;   // 매니페스트의 앱 만들기 표시(passthrough 칸) — 자리·기획 카드뿐. 누가·어느 세션·원본은 아래 서버 칸
  //  #4667 서버가 찍은 기록 · 공개 상태 — 매니페스트 studio.made_by 같은 앱 코드 칸은 믿지 않는다(아무나 고쳐 저장할 수 있다).
  visibility: 'all' | 'me';   // #4632 공개 범위 — 'me' = 나만 보는 앱(공개 전 · 서버가 책임자에게만 준다) · 'all' = 모두
  madeBy: string;                      // 만든 사람(서버 기록 · 옛 앱은 처음 설치한 사람)
  ownerMember: string | null;          // 지금 책임자(null = 관리자)
  origin: { id: string; title: string; madeBy: string } | null;   // 사본이면 원본(못 보는 원본이면 title 이 비어 있다)
  view: 'installed' | 'published';     // 이 사람이 보는 판 — 남의 초안이 있으면 공개 판
  draft: { by: string; versionNo: number } | null;   // 공개 앱에 걸린 초안(그 초안을 만든 사람 · 책임자에게만 온다)
  buildSession: string;                // 이 앱을 만드는 세션(책임자에게만 온다 — 다른 기기에서 이어 만들기)
  isOwner: boolean;
  canPublish: boolean;
  canUnpublish: boolean;
  sites: string[];   // csp.frame_domains — 이 앱이 **화면에 싣는** 사이트(동의 창에 보여 준다)
  net: string[];     // csp.connect_domains ∪ permissions.hosts — 이 앱이 **직접 연결하는** 곳
  instances: { project: 'global' | 'optional' | 'required'; multiplicity: 'single' | 'multiple' };
  system: { renderer: 'session' | 'browser' | 'classic'; home?: string; route?: string } | null;
  source: { kind?: string };
  notifications: boolean;   // #1891 — 이 앱이 알림을 보낼 수 있나(동의 창이 제 줄로 보여 준다)
  chatSend: boolean;        // #4594 — 이 앱 화면이 붙은 세션에 글을 바로 보낼 수 있나(동의 창이 제 줄로 보여 준다)
  workspaceFiles: string[];   // #4629 — 볼 수 있는 모든 프로젝트의 자료에서 읽을 수 있는 확장자(프로젝트 자료와 다른 동의 줄)
  projectFiles: string[];   // #4592 — 이 앱 화면이 붙은 세션의 프로젝트 자료에서 읽을 수 있는 확장자(동의 창이 제 줄로 보여 준다)
  appFolder: boolean;       // #4673 — 이 앱이 제 앱 폴더(apps/<앱>/)에 파일을 올리고 받나(동의 창이 제 줄로 보여 준다)
  icon: AppIconSpec | null;   // #4769 — 매니페스트가 선언한 앱 아이콘(없으면 기본 그림)
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
        const tables = (((a.manifest && a.manifest.data) || {}).tables || []).map((t: any) => String((t && t.name) || '')).filter(Boolean);
        const csp = (a.manifest && a.manifest.csp) || {};
        const sites = (csp.frame_domains || []).map(String);
        const net = [...(csp.connect_domains || []), ...(perm.hosts || [])].map(String);
        const instances = (a.manifest && a.manifest.instances) || { project: 'optional', multiplicity: 'multiple' };
        const source = (a.source && typeof a.source === 'object') ? a.source : {};
        // system renderer는 builtin에서만 신뢰한다(서버 AppInstance 응답과 같은 경계). 외부 앱은 generic iframe.
        const system = source.kind === 'builtin' && a.manifest ? (a.manifest.system || null) : null;
        return { id: String(a.id), title: String(a.title || a.id), version: String(a.version || '0.0.0'),
          scopes: (perm.scopes || []).map(String), tools, pages, tables, sites, net, instances, system, source,
          editMode: a.edit_mode === 'members' ? 'members' as const : 'all' as const,
          editMembers: Array.isArray(a.edit_members) ? a.edit_members.map(String) : [], canEdit: a.can_edit === true,
          installedBy: String(a.installed_by || ''), installedAt: (() => { const t = Date.parse(String(a.installed_at || '')); return Number.isFinite(t) ? t : 0; })(),
          studio: a.manifest && a.manifest.studio && typeof a.manifest.studio === 'object' ? a.manifest.studio : null,
          ...appStateOf(a),
          notifications: perm.notifications === true,     // #1891 — 동의 창이 제 줄로 보여 준다
          chatSend: perm.chat_send === true,               // #4594 — 같은 자리에 제 줄로
          workspaceFiles: Array.isArray(perm.workspace_files) ? perm.workspace_files.map(String) : [],   // #4629
          projectFiles: Array.isArray(perm.project_files) ? perm.project_files.map(String) : [],   // #4592
          appFolder: perm.app_folder === true,   // #4673
          icon: appIconSpecOf(a.manifest) };   // #4769
      });
  } catch (e: any) {
    // 앱 레지스트리가 아직 없는 배포(구버전)·권한 없음 등 — 조용히 빈 목록(런치패드는 화면앱만 보인다).
    return [];
  }
}

/** #4667 서버가 실어 준 공개 상태 · 기록 칸(org_apps · org_app_get 의 한 줄) — 앱 찾기 · 앱빌더 · 앱 만들기가 같은 자로 읽는다. */
export function appStateOf(a: any): Pick<SessionApp, 'visibility' | 'madeBy' | 'ownerMember' | 'origin' | 'view' | 'draft' | 'buildSession' | 'isOwner' | 'canPublish' | 'canUnpublish'> {
  const o = a && a.origin && typeof a.origin === 'object' ? a.origin : null;
  const d = a && a.draft && typeof a.draft === 'object' ? a.draft : null;
  return {
    visibility: a && a.visibility === 'me' ? 'me' : 'all',
    madeBy: String((a && (a.made_by || a.installed_by)) || ''),
    ownerMember: a && a.owner_member ? String(a.owner_member) : null,
    origin: o && o.id ? { id: String(o.id), title: String(o.title || ''), madeBy: String(o.made_by || '') } : null,
    view: a && a.view === 'published' ? 'published' : 'installed',
    draft: d && d.by ? { by: String(d.by), versionNo: Number(d.version_no) || 0 } : null,
    buildSession: String((a && a.build_session) || ''),
    isOwner: !!(a && a.is_owner), canPublish: !!(a && a.can_publish), canUnpublish: !!(a && a.can_unpublish),
  };
}

let spawning = false;
export function isSpawningApp(): boolean { return spawning; }

/**
 * 앱 세션을 만든다. 성공하면 { id }, 사용자가 동의를 취소했거나 실패하면 null(이유는 toast).
 *  UI 중립 — **행선지는 호출자가 정한다**: 런치패드는 openAppSession 으로 #/s/<id> 로 간다.
 *  opts.projectId 를 주면 생성 요청 자체가 그 프로젝트 workspace와 DB 소속을 확정한다.
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
      || { id: appId, title: title || appId, version: '', scopes: [], tools: [], pages: [], tables: [], sites: [], net: [], notifications: false, chatSend: false, projectFiles: [], workspaceFiles: [], appFolder: false,
        editMode: 'all' as const, editMembers: [], canEdit: false, installedBy: '', installedAt: 0, studio: null, ...appStateOf(null),
        instances: { project: 'optional' as const, multiplicity: 'multiple' as const }, system: null, source: {}, icon: null };
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
    let id = '';
    try { id = await postAppSession(appId, opts); }
    catch (e: any) {
      if (e && e.status === 403) {
        if (!(await ensureAppGrant(appId, opts?.title))) return null;   // 취소 = 조용히 멈춤
        id = await postAppSession(appId, opts);
      } else throw e;
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

async function postAppSession(appId: string, opts?: { title?: string; projectId?: number | null; initialPrompt?: string }): Promise<string> {
  const p = runPrefs();
  const projectId = Number(opts?.projectId || 0);
  const endpoint = projectId > 0 ? `/api/ui/v6/projects/${projectId}/sessions` : '/api/ui/terminal/sessions';
  const out: any = await api(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      label: (opts?.title || appId).slice(0, 28),
      harness: p.harness && p.harness !== 'shell' ? p.harness : 'claude',
      flags: p.flags && typeof p.flags === 'object' ? p.flags : {},
      autoApprove: !!p.autoApprove, appId,
      ...(projectId > 0 ? {} : { rootKey: 'personal' }),
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
    //  도구 칩 — 이름은 그대로 두고(무엇에 동의하는지 정확해야 한다) 쉬운 설명을 붙인다(lib/tool-explain · #4632 원준 2026-10-19 «호버하면 고등학생도 이해할 수 있는 수준으로»).
    //   마우스는 올려 두면, 키보드는 초점이 가면, 손가락은 누르면 뜬다(폰엔 호버가 없다). 창 가장자리 칩도 잘리지 않게 창 위에 떠서 자리를 잡는다.
    const tip = el('div', { class: 'v2-consent-tip', role: 'tooltip', id: 'v2-consent-tip', hidden: true }) as HTMLElement;
    let tipFor: HTMLElement | null = null;
    const showTip = (chip: HTMLElement): void => {
      if (tipFor && tipFor !== chip) tipFor.removeAttribute('aria-describedby');   // 다른 칩으로 옮겼다 — 앞 칩의 연결을 끊는다(남으면 읽어 주는 프로그램이 앞 칩을 이 설명으로 읽는다)
      tipFor = chip; tip.textContent = chip.dataset.tip || ''; tip.hidden = false;
      chip.setAttribute('aria-describedby', tip.id);
      tip.style.left = '0px'; tip.style.top = '0px';   // 재기 전에 — 지난 자리(오른쪽 끝)가 남아 있으면 폭이 눌려 좁고 길게 잰다
      const r = chip.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
      let top = r.bottom + 8; if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);   // 아래 자리가 모자라면 위로
      tip.style.left = Math.round(left) + 'px'; tip.style.top = Math.round(top) + 'px';
    };
    const hideTip = (chip?: HTMLElement): void => { if (chip && tipFor !== chip) return; tip.hidden = true; if (tipFor) tipFor.removeAttribute('aria-describedby'); tipFor = null; };
    const toolChips = (xs: string[], empty: string) => (xs.length
      ? xs.map((s) => {
        const c = el('span', { class: 'v2-consent-chip has-tip', text: s, tabindex: '0', 'data-tip': toolExplain(s) }) as HTMLElement;
        c.addEventListener('pointerenter', (e: PointerEvent) => { if (e.pointerType !== 'touch') showTip(c); });
        c.addEventListener('pointerleave', (e: PointerEvent) => { if (e.pointerType !== 'touch') hideTip(c); });
        c.addEventListener('pointerdown', (e: PointerEvent) => { if (e.pointerType === 'touch') { if (tipFor === c) hideTip(c); else showTip(c); } });
        c.addEventListener('focus', () => showTip(c));
        c.addEventListener('blur', () => hideTip(c));
        return c;
      })
      : [el('span', { class: 'v2-consent-chip none', text: empty })]);
    const ov = el('div', { class: 'v2-consent-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': app.title + ' 사용 동의',
      onclick: (e: Event) => { if (e.target === ov) finish(false); else if (tipFor && !(e.target as HTMLElement).closest('.has-tip')) hideTip(); } },
      el('div', { class: 'v2-consent' },
        el('h3', { class: 'v2-consent-t', text: '「' + app.title + '」을(를) 내 자격으로 실행할까요?' }),
        el('p', { class: 'v2-consent-sub', text: '이 앱이 여는 세션은 아래 권한만 내 이름으로 씁니다. 언제든 설정에서 철회할 수 있어요.' }),
        el('div', { class: 'v2-consent-grp' }, el('b', { text: '권한' }), el('div', { class: 'v2-consent-chips' }, ...chips(app.scopes, '추가 권한 없음'))),
        el('div', { class: 'v2-consent-grp' }, el('b', { text: '도구' }), el('div', { class: 'v2-consent-chips' }, ...toolChips(app.tools, '도구 없음'))),
        // 알림(#1891) — 다른 권한과 **성격이 다르다**: 나머지는 '앱이 내 데이터에 무엇을 하나'인데
        //  이건 '앱이 나를 언제 부르나'다. 그래서 도구 칩에 섞지 않고 제 줄로 세운다(선언했을 때만).
        app.notifications ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '알림' }),
          el('div', { class: 'v2-consent-chips' },
            el('span', { class: 'v2-consent-chip', text: '데스크톱 알림을 보낼 수 있어요' }))) : null,
        // 세션에 글 보내기(#4594) — 이것도 성격이 다르다: '앱이 내 AI 세션을 움직이나'. 붙은 세션에만, 내가 누른 동작에서만 들어간다.
        app.chatSend ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '세션에 글 보내기' }),
          el('div', { class: 'v2-consent-chips' },
            el('span', { class: 'v2-consent-chip', text: '이 앱에서 내가 단추를 누르면 그 내용이 이 앱을 붙인 AI 세션에 메시지로 들어가요 — 앱이 혼자 보내진 않아요(분당 20건까지)' }))) : null,
        // 에이전트 작업(#4490) — '앱이 내 Claude 구독으로 사람 없는 작업을 돌리나'. 도구 칩 하나로는 무게가 안 보인다: 작업은 나로서(내 구독 · 내 홈의
        //  로그인·파일) 돌고, 받는 길은 이 앱 화면에서 내가 보낸 것뿐이다(앱 서버 · 자동화 · 작업 안에서는 거절 — agent-jobs/service.ts).
        app.tools.includes('agent_job_run') ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '에이전트 작업' }),
          el('div', { class: 'v2-consent-chips' },
            el('span', { class: 'v2-consent-chip', text: '이 앱 화면에서 내가 보낸 지시를 별도 작업 컨테이너에서 나로서 돌려요 — 내 Claude 구독을 쓰고 내 홈의 파일·로그인에 닿아요. 앱 서버나 자동화가 혼자 보내진 않아요' }))) : null,
        // AI 실행(#4488 앱 v2-9) — '앱이 AI 를 돌리나(누구 돈 · 누구 계정으로)'. 실행 계정은 워크스페이스가 정한다: API 키면 워크스페이스 돈,
        //  구독이면 **내 구독**(내가 이 앱 화면에서 보낸 요청만 · 내 자리). 설계 §5 «grant 항목 — 내 AI 계정 사용 · 붙은 세션에서 실행 · 새 대화 만들기» 를 한 줄에.
        app.tools.includes('app_ai_run') ? el('div', { class: 'v2-consent-grp' }, el('b', { text: 'AI 실행' }),
          el('div', { class: 'v2-consent-chips' },
            el('span', { class: 'v2-consent-chip', text: '이 앱이 AI 에게 일을 시킬 수 있어요 — 워크스페이스 API 키가 있으면 그 돈으로, 아니면 내 Claude 구독으로(내가 이 앱 화면에서 보낸 요청만 · 내 이름으로 새 대화) 돌아요. 실행 기록은 이 앱의 AI 실행 목록에 남아요' }))) : null,
        // 백그라운드 작업(#4486 앱 v2-7) — '앱 서버가 내 이름으로 뒤에서 일을 하나'. 서버를 둔 앱(web.server)이 함의한다. 화면을 닫아도 15분까지 돈다.
        app.tools.includes('app_job_start') ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '백그라운드 작업' }),
          el('div', { class: 'v2-consent-chips' },
            el('span', { class: 'v2-consent-chip', text: '이 앱의 서버가 오래 걸리는 일을 뒤에서 내 이름으로 처리할 수 있어요 — 화면을 닫아도 한 번에 15분까지 돌고, 이 앱에 동의한 범위 안에서만 움직여요. 진행과 결과는 이 앱의 작업 목록에 남아요' }))) : null,
        // 프로젝트 자료 읽기(#4592) — '내 프로젝트의 파일이 앱으로 들어오나'. 붙인 세션의 프로젝트에서, 선언한 종류만, 읽기만.
        app.projectFiles.length ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '프로젝트 자료 읽기' }),
          el('div', { class: 'v2-consent-chips' },
            el('span', { class: 'v2-consent-chip', text: '이 앱을 붙인 세션의 프로젝트 자료에서 ' + app.projectFiles.map((x) => x.toUpperCase()).join(' · ') + ' 파일을 읽을 수 있어요(쓰지는 못해요)' }))) : null,
        // 전체 자료 읽기(#4629) — 위보다 넓다: 붙인 세션의 프로젝트 밖, 내가 볼 수 있는 모든 프로젝트의 자료. 그래서 제 줄로 따로 묻는다.
        app.workspaceFiles.length ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '전체 자료 읽기' }),
          el('div', { class: 'v2-consent-chips' },
            el('span', { class: 'v2-consent-chip', text: '내가 볼 수 있는 모든 프로젝트의 자료에서 ' + app.workspaceFiles.map((x) => x.toUpperCase()).join(' · ') + ' 파일을 읽을 수 있어요(쓰지는 못해요). 읽은 내용은 이 앱의 데이터에 담겨 이 앱을 쓰는 다른 구성원에게 보일 수 있어요' }))) : null,
        // 앱 폴더(#4673) — '앱이 워크스페이스 저장소에 파일을 두나'. 이 앱 전용 폴더(apps/<앱>/)뿐이고 내 이름으로 올린다. 그 폴더는 이 앱에
        //  동의한 구성원이 함께 보고(세션에 붙이면 .lively/apps/<앱>/ 로도 보인다), 다른 폴더 · 다른 앱 폴더에는 닿지 않는다.
        app.appFolder ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '앱 폴더' }),
          el('div', { class: 'v2-consent-chips' },
            el('span', { class: 'v2-consent-chip', text: '이 앱 전용 폴더에 파일을 올리고 받을 수 있어요(내 이름으로 올려요). 이 앱에 동의한 구성원이 그 파일을 함께 봐요 — 다른 폴더에는 닿지 않아요' }))) : null,
        // 선언된 사이트 — 앱이 화면에 싣거나 직접 연결하는 곳. 없으면 줄 자체를 안 그린다(없는 걸 설명하지 않는다).
        app.sites.length ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '사이트' }),
          el('div', { class: 'v2-consent-chips' }, ...chips(app.sites.map((d) => d === '*' ? '모든 사이트(화면에 싣기)' : d), ''))) : null,
        app.net.length ? el('div', { class: 'v2-consent-grp' }, el('b', { text: '연결' }),
          el('div', { class: 'v2-consent-chips' }, ...chips(app.net, ''))) : null,
        el('div', { class: 'v2-consent-acts' },
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => finish(false) }),
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '동의하고 열기', onclick: () => finish(true) }))), tip);
    document.body.append(ov as HTMLElement);
    document.addEventListener('keydown', onKey);
    (ov.querySelector('.btn-primary') as HTMLElement | null)?.focus();
  });
}
