// v2 AppInstance 클라이언트(#1780 v2.1) — 상단 탭 하나가 이 실행 인스턴스 하나를 연다.
// AppPackage 설치와 분리되어 같은 앱을 여러 번, 서로 다른 프로젝트 맥락으로 열 수 있다.
import { api, el, toast } from '../core.js';
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
            ...(opts?.execution ? { execution: opts.execution } : {}),
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
        const execution = app.runtime ? await pickWorkerExecution(app.title, app.runtime) : undefined;
        if (app.runtime && !execution)
            return false;
        const page = app.pages && app.pages[0] ? app.pages[0].key : undefined;
        const state = app.system?.renderer === 'browser' ? { url: app.system.home || 'https://www.google.com/' } : undefined;
        const instance = await createAppInstance(app.id, { projectId: projectId ?? null, page, title: app.title, state, execution: execution ?? undefined });
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
export async function restartAppInstance(id) {
    const out = await api('/api/ui/app-instances/' + encodeURIComponent(id) + '/restart', { method: 'POST', body: '{}' });
    if (!out?.instance?.id)
        throw new Error('앱 worker를 다시 실행하지 못했습니다');
    return remember(out.instance);
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
/** runtime.placement 선언 안에서만 실제 실행 위치를 고른다. 취소·가용 원격 노드 없음은 null. */
async function pickWorkerExecution(title, runtime) {
    if (runtime.placement === 'central')
        return { kind: 'central' };
    let nodes = [];
    try {
        const out = await api('/api/ui/nodes?usable=1');
        nodes = (Array.isArray(out?.nodes) ? out.nodes : []).filter((n) => n?.online === true && n?.agent_latest === true)
            .map((n) => ({ id: String(n.id), name: String(n.name || n.id), online: true, agent_latest: true }));
    }
    catch { /* 선택 창에서 중앙 실행은 계속 가능하다. remote 전용은 아래에서 막는다. */ }
    if (runtime.placement === 'remote' && !nodes.length) {
        toast('이 앱을 실행할 수 있는 최신 원격 노드가 온라인 상태가 아닙니다.', true);
        return null;
    }
    if (runtime.placement === 'any' && !nodes.length)
        return { kind: 'central' };
    return await executionDialog(title, runtime.placement === 'any', nodes);
}
function executionDialog(title, allowCentral, nodes) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (choice) => {
            if (done)
                return;
            done = true;
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(choice);
        };
        const onKey = (event) => { if (event.key === 'Escape')
            finish(null); };
        const choices = [];
        if (allowCentral)
            choices.push(el('button', { class: 'v2-exec-opt', type: 'button', onclick: () => finish({ kind: 'central' }) }, el('b', { text: '이 게이트웨이' }), el('span', { text: '조직 서버에서 계속 실행합니다.' }), el('small', { text: '기본' })));
        for (const node of nodes)
            choices.push(el('button', { class: 'v2-exec-opt', type: 'button', onclick: () => finish({ kind: 'remote', node_id: node.id }) }, el('b', { text: node.name }), el('span', { text: '원격 노드에서 같은 worker 계약으로 실행합니다.' }), el('small', { text: node.id })));
        const overlay = el('div', { class: 'v2-exec-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': title + ' 실행 위치 선택',
            onclick: (event) => { if (event.target === overlay)
                finish(null); } }, el('div', { class: 'v2-exec' }, el('h3', { text: '「' + title + '」을(를) 어디에서 실행할까요?' }), el('p', { text: '앱 화면은 지금 탭에 열리고, 아래 선택은 앱의 worker 코드가 도는 컴퓨터입니다.' }), el('div', { class: 'v2-exec-list' }, ...choices), el('div', { class: 'v2-exec-actions' }, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => finish(null) }))));
        document.body.append(overlay);
        document.addEventListener('keydown', onKey);
        choices[0]?.focus();
    });
}
