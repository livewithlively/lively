// v2 AppInstance 클라이언트(#1780 v2.1) — 상단 탭 하나가 이 실행 인스턴스 하나를 연다.
// AppPackage 설치와 분리되어 같은 앱을 여러 번, 서로 다른 프로젝트 맥락으로 열 수 있다.
import { api, el, toast } from '../core.js';

export interface AppWorkerRuntime {
  kind: 'worker';
  placement: 'any' | 'central' | 'remote';
  idle_timeout_sec: number;
  memory_mb: number;
}

export interface AppWorkerRun {
  id: string;
  status: 'prepared' | 'starting' | 'ready' | 'idle' | 'running' | 'stopping' | 'stopped' | 'failed';
  host_kind: 'central' | 'remote';
  host_id: string | null;
  pid: number | null;
  exit_code: number | null;
  reason: string | null;
  started_at: string | null;
  ready_at: string | null;
  stopped_at: string | null;
}

export type AppExecution = { kind: 'central' } | { kind: 'remote'; node_id: string };

export interface AppInstanceRecord {
  id: string;
  app_id: string;
  owner_member: string;
  project_id: number | null;
  subject_kind: string | null;
  subject_ref: string | null;
  page_key: string | null;
  title: string | null;
  // ── 세션 인스턴스의 **지금의 정본**(#2022) — 서버가 desired-state(DB)/라이브를 조인해 실어 준다.
  //  위 title 은 인스턴스를 연 그 순간의 스냅샷이라 늙는다(실측 'claude · resume'·'/status'·box id 그대로).
  //  세션이 목록에 아직·영영 없을 때 화면은 이 값으로 이름·소속을 그린다(main.ts sessFallback).
  subject_label?: string | null;
  subject_project_id?: number | null;
  subject_state?: 'live' | 'restorable' | 'gone';
  state: Record<string, unknown>;
  execution_host_kind: 'central' | 'remote' | null;
  execution_host_id: string | null;
  status: 'active' | 'closed';
  worker: AppWorkerRun | null;
  created_at?: string | null;
  updated_at?: string | null;   // 좌측 목록의 정렬 키(#1883) — 창이 없어도 최근 활동 순으로 선다.
  app: {
    id: string;
    title: string;
    source: { kind: 'builtin' | 'installed' };
    instances: { project: 'global' | 'optional' | 'required'; multiplicity: 'single' | 'multiple' };
    system: { renderer: 'session' | 'browser' | 'classic'; route?: string; home?: string } | null;
    runtime: AppWorkerRuntime | null;
    ui: { pages: Array<{ key: string; title: string; display: string[] }> };
  };
}

const cache = new Map<string, AppInstanceRecord>();
export function cachedAppInstance(id: string): AppInstanceRecord | null { return cache.get(id) || null; }
function remember(instance: AppInstanceRecord): AppInstanceRecord { cache.set(instance.id, instance); return instance; }

/**
 * 내 앱 인스턴스 목록(#1780 v2.2 §2.2) — status=active 만. 창(탭)이 없어도 인스턴스는 살아 있으므로
 *  좌측 목록은 이 서버 사실을 읽는다(브라우저 탭 목록이 아니다, #1883).
 */
export async function listAppInstances(): Promise<AppInstanceRecord[]> {
  const out: any = await api('/api/ui/app-instances');
  const rows: AppInstanceRecord[] = Array.isArray(out?.instances) ? out.instances : [];
  for (const r of rows) if (r && r.id) remember(r);
  return rows;
}

export async function getAppInstance(id: string): Promise<AppInstanceRecord> {
  const out: any = await api('/api/ui/app-instances/' + encodeURIComponent(id));
  if (!out?.instance?.id) throw new Error('앱 인스턴스를 받지 못했습니다');
  return remember(out.instance as AppInstanceRecord);
}

export async function createAppInstance(appId: string, opts?: {
  projectId?: number | null;
  subjectKind?: 'session';
  subjectRef?: string;
  page?: string;
  title?: string;
  state?: Record<string, unknown>;
  execution?: AppExecution;
}): Promise<AppInstanceRecord> {
  const out: any = await api('/api/ui/app-instances', {
    method: 'POST',
    body: JSON.stringify({
      app_id: appId,
      project_id: opts?.projectId ?? null,
      ...(opts?.subjectKind ? { subject_kind: opts.subjectKind, subject_ref: opts.subjectRef } : {}),
      ...(opts?.page ? { page_key: opts.page } : {}),
      ...(opts?.title ? { title: opts.title } : {}),
      ...(opts?.state ? { state: opts.state } : {}),
      ...(opts?.execution ? { execution: opts.execution } : {}),
    }),
  });
  if (!out?.instance?.id) throw new Error('앱 인스턴스를 만들지 못했습니다');
  return remember(out.instance as AppInstanceRecord);
}

/** 기존 세션 route를 ai-session builtin AppInstance로 멱등 등록한다. 화면 렌더 실패와 결합하지 않게 호출자가 오류를 처리한다.
 *  ⚠ 이름을 **모르면 안 보낸다**(#2022) — 서버는 conflict 시 title 을 COALESCE 로 덮으므로, 세션 목록이 늦은
 *   한 판이 자리표시자('AI 세션')를 저장된 멀쩡한 이름 위에 굳혀 버린다. 안 보내면 이전 값이 그대로 산다. */
export function ensureSessionAppInstance(appId: string, sessionId: string, opts?: { projectId?: number | null; title?: string; execution?: AppExecution }): Promise<AppInstanceRecord> {
  return createAppInstance(appId || 'ai-session', {
    projectId: opts?.projectId ?? null,
    subjectKind: 'session',
    subjectRef: sessionId,
    ...(opts?.title ? { title: opts.title } : {}),
    execution: opts?.execution,
  });
}

/** 설치된 앱을 새 실행 인스턴스로 열고 그 인스턴스 route로 이동한다. */
export async function openInstalledApp(app: {
  id: string;
  title: string;
  pages?: Array<{ key: string }>;
  runtime?: AppWorkerRuntime | null;
  system?: { renderer?: string; home?: string } | null;
}, projectId?: number | null): Promise<boolean> {
  try {
    if (app.runtime) {
      const { ensureAppGrant } = await import('./app-session.js');
      if (!(await ensureAppGrant(app.id, app.title))) return false;
    }
    const execution = app.runtime ? await chooseAppExecution(app.title, app.runtime) : undefined;
    if (app.runtime && !execution) return false;
    const page = app.pages && app.pages[0] ? app.pages[0].key : undefined;
    const state = app.system?.renderer === 'browser' ? { url: app.system.home || 'https://www.google.com/' } : undefined;
    const instance = await createAppInstance(app.id, { projectId: projectId ?? null, page, title: app.title, state, execution: execution ?? undefined });
    location.hash = '#/i/' + encodeURIComponent(instance.id);
    return true;
  } catch (e: any) {
    toast('앱을 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
    return false;
  }
}

/**
 * single-instance 빌트인 앱의 인스턴스를 멱등 확보한다(#1891 inbox).
 *
 * 서버가 multiplicity='single' 인 앱을 subject(singleton, app_id) 로 멱등 처리하므로,
 *  여러 번 불러도 같은 인스턴스가 돌아온다. 실패는 **삼킨다** — 인스턴스는 정체성·프로젝트 귀속을
 *  주는 것이지 화면을 그리는 조건이 아니다(앱이 아직 안 깔린 게이트웨이에서도 화면은 떠야 한다).
 */
export async function ensureSingletonAppInstance(appId: string, title: string): Promise<AppInstanceRecord | null> {
  try { return await createAppInstance(appId, { title }); }
  catch { return null; }
}

export async function closeAppInstance(id: string): Promise<void> {
  cache.delete(id);
  await api('/api/ui/app-instances/' + encodeURIComponent(id) + '/close', { method: 'POST', body: '{}' });
}

export async function restartAppInstance(id: string): Promise<AppInstanceRecord> {
  const out: any = await api('/api/ui/app-instances/' + encodeURIComponent(id) + '/restart', { method: 'POST', body: '{}' });
  if (!out?.instance?.id) throw new Error('앱 worker를 다시 실행하지 못했습니다');
  return remember(out.instance as AppInstanceRecord);
}

export async function updateAppInstance(id: string, patch: { title?: string | null; page?: string | null; state?: Record<string, unknown> }): Promise<AppInstanceRecord> {
  const out: any = await api('/api/ui/app-instances/' + encodeURIComponent(id) + '/update', {
    method: 'POST',
    body: JSON.stringify({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.page !== undefined ? { page_key: patch.page } : {}),
      ...(patch.state ? { state: patch.state } : {}),
    }),
  });
  if (!out?.instance?.id) throw new Error('앱 인스턴스를 갱신하지 못했습니다');
  return remember(out.instance as AppInstanceRecord);
}

interface ExecutionNode {
  id: string;
  name: string;
  online: boolean;
  agent_latest: boolean | null;
}

/** runtime.placement 선언 안에서만 실제 실행 위치를 고른다. 취소·가용 원격 노드 없음은 null. */
export async function chooseAppExecution(title: string, runtime: AppWorkerRuntime): Promise<AppExecution | null> {
  if (runtime.placement === 'central') return { kind: 'central' };
  let nodes: ExecutionNode[] = [];
  try {
    const out: any = await api('/api/ui/nodes?usable=1');
    nodes = (Array.isArray(out?.nodes) ? out.nodes : []).filter((n: any) => n?.online === true && n?.agent_latest === true)
      .map((n: any) => ({ id: String(n.id), name: String(n.name || n.id), online: true, agent_latest: true }));
  } catch { /* 선택 창에서 중앙 실행은 계속 가능하다. remote 전용은 아래에서 막는다. */ }
  if (runtime.placement === 'remote' && !nodes.length) {
    toast('이 앱을 실행할 수 있는 최신 원격 노드가 온라인 상태가 아닙니다.', true);
    return null;
  }
  if (runtime.placement === 'any' && !nodes.length) return { kind: 'central' };
  return await executionDialog(title, runtime.placement === 'any', nodes);
}

function executionDialog(title: string, allowCentral: boolean, nodes: ExecutionNode[]): Promise<AppExecution | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (choice: AppExecution | null): void => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(choice);
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') finish(null); };
    const choices: HTMLElement[] = [];
    if (allowCentral) choices.push(el('button', { class: 'v2-exec-opt', type: 'button', onclick: () => finish({ kind: 'central' }) },
      el('b', { text: '이 게이트웨이' }),
      el('span', { text: '조직 서버에서 계속 실행합니다.' }),
      el('small', { text: '기본' })));
    for (const node of nodes) choices.push(el('button', { class: 'v2-exec-opt', type: 'button', onclick: () => finish({ kind: 'remote', node_id: node.id }) },
      el('b', { text: node.name }),
      el('span', { text: '원격 노드에서 같은 worker 계약으로 실행합니다.' }),
      el('small', { text: node.id })));
    const overlay = el('div', { class: 'v2-exec-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': title + ' 실행 위치 선택',
      onclick: (event: Event) => { if (event.target === overlay) finish(null); } },
      el('div', { class: 'v2-exec' },
        el('h3', { text: '「' + title + '」을(를) 어디에서 실행할까요?' }),
        el('p', { text: '앱 화면은 지금 탭에 열리고, 아래 선택은 앱의 worker 코드가 도는 컴퓨터입니다.' }),
        el('div', { class: 'v2-exec-list' }, ...choices),
        el('div', { class: 'v2-exec-actions' }, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => finish(null) }))));
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    choices[0]?.focus();
  });
}
