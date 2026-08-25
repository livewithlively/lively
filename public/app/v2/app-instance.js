// v2 AppInstance 클라이언트(#1780 v2.1) — 상단 탭 하나가 이 실행 인스턴스 하나를 연다.
// AppPackage 설치와 분리되어 같은 앱을 여러 번, 서로 다른 프로젝트 맥락으로 열 수 있다.
import { api, toast } from '../core.js';
const cache = new Map();
export function cachedAppInstance(id) { return cache.get(id) || null; }
function remember(instance) { cache.set(instance.id, instance); return instance; }
export async function getAppInstance(id) {
    const out = await api('/api/ui/app-instances/' + encodeURIComponent(id));
    if (!out?.instance?.id)
        throw new Error('앱 인스턴스를 받지 못했습니다');
    return remember(out.instance);
}
export async function createAppInstance(appId, opts) {
    const out = await api('/api/ui/app-instances', {
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
    if (!out?.instance?.id)
        throw new Error('앱 인스턴스를 만들지 못했습니다');
    return remember(out.instance);
}
/** 기존 세션 route를 ai-session builtin AppInstance로 멱등 등록한다. 화면 렌더 실패와 결합하지 않게 호출자가 오류를 처리한다. */
export function ensureSessionAppInstance(appId, sessionId, opts) {
    return createAppInstance(appId || 'ai-session', {
        projectId: opts?.projectId ?? null,
        subjectKind: 'session',
        subjectRef: sessionId,
        title: opts?.title || 'AI 세션',
    });
}
/** 설치된 앱을 새 실행 인스턴스로 열고 그 인스턴스 route로 이동한다. */
export async function openInstalledApp(app, projectId) {
    try {
        const page = app.pages && app.pages[0] ? app.pages[0].key : undefined;
        const state = app.system?.renderer === 'browser' ? { url: app.system.home || 'https://www.google.com/' } : undefined;
        const instance = await createAppInstance(app.id, { projectId: projectId ?? null, page, title: app.title, state });
        location.hash = '#/i/' + encodeURIComponent(instance.id);
        return true;
    }
    catch (e) {
        toast('앱을 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
        return false;
    }
}
export async function closeAppInstance(id) {
    cache.delete(id);
    await api('/api/ui/app-instances/' + encodeURIComponent(id) + '/close', { method: 'POST', body: '{}' });
}
export async function updateAppInstance(id, patch) {
    const out = await api('/api/ui/app-instances/' + encodeURIComponent(id) + '/update', {
        method: 'POST',
        body: JSON.stringify({
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.page !== undefined ? { page_key: patch.page } : {}),
            ...(patch.state ? { state: patch.state } : {}),
        }),
    });
    if (!out?.instance?.id)
        throw new Error('앱 인스턴스를 갱신하지 못했습니다');
    return remember(out.instance);
}
