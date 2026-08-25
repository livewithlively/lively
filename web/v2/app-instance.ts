// v2 AppInstance 클라이언트(#1780 v2.1) — 상단 탭 하나가 이 실행 인스턴스 하나를 연다.
// AppPackage 설치와 분리되어 같은 앱을 여러 번, 서로 다른 프로젝트 맥락으로 열 수 있다.
import { api, toast } from '../core.js';

export interface AppInstanceRecord {
  id: string;
  app_id: string;
  owner_member: string;
  project_id: number | null;
  subject_kind: string | null;
  subject_ref: string | null;
  page_key: string | null;
  title: string | null;
  state: Record<string, unknown>;
  status: 'active' | 'closed';
  created_at?: string | null;
  updated_at?: string | null;   // 좌측 목록의 정렬 키(#1883) — 창이 없어도 최근 활동 순으로 선다.
  app: {
    id: string;
    title: string;
    source: { kind: 'builtin' | 'installed' };
    instances: { project: 'global' | 'optional' | 'required'; multiplicity: 'single' | 'multiple' };
    system: { renderer: 'session' | 'browser' | 'classic'; route?: string; home?: string } | null;
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
    }),
  });
  if (!out?.instance?.id) throw new Error('앱 인스턴스를 만들지 못했습니다');
  return remember(out.instance as AppInstanceRecord);
}

/** 기존 세션 route를 ai-session builtin AppInstance로 멱등 등록한다. 화면 렌더 실패와 결합하지 않게 호출자가 오류를 처리한다. */
export function ensureSessionAppInstance(appId: string, sessionId: string, opts?: { projectId?: number | null; title?: string }): Promise<AppInstanceRecord> {
  return createAppInstance(appId || 'ai-session', {
    projectId: opts?.projectId ?? null,
    subjectKind: 'session',
    subjectRef: sessionId,
    title: opts?.title || 'AI 세션',
  });
}

/** 설치된 앱을 새 실행 인스턴스로 열고 그 인스턴스 route로 이동한다. */
export async function openInstalledApp(app: { id: string; title: string; pages?: Array<{ key: string }>; system?: { renderer?: string; home?: string } | null }, projectId?: number | null): Promise<boolean> {
  try {
    const page = app.pages && app.pages[0] ? app.pages[0].key : undefined;
    const state = app.system?.renderer === 'browser' ? { url: app.system.home || 'https://www.google.com/' } : undefined;
    const instance = await createAppInstance(app.id, { projectId: projectId ?? null, page, title: app.title, state });
    location.hash = '#/i/' + encodeURIComponent(instance.id);
    return true;
  } catch (e: any) {
    toast('앱을 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
    return false;
  }
}

export async function closeAppInstance(id: string): Promise<void> {
  cache.delete(id);
  await api('/api/ui/app-instances/' + encodeURIComponent(id) + '/close', { method: 'POST', body: '{}' });
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
