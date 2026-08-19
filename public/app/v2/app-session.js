// web/v2/app-session.ts — 설치된 '세션 앱'(org_app)을 연다 (#1780 PR4b).
//  런치패드(전역 side-rail 의 ⊞ 앱)·studio 도크 앱서랍(⊞ 런치패드)이 **공유**하는 단 하나의 진입점이다.
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
/** 설치된 세션 앱 = status 'active' + enabled. 런치패드·앱서랍이 격자에 싣는다. */
export async function listSessionApps() {
    try {
        const out = await api('/api/ui/apps');
        const rows = Array.isArray(out?.apps) ? out.apps : [];
        return rows
            .filter((a) => a && a.status === 'active' && a.enabled !== false)
            .map((a) => {
            const perm = (a.manifest && a.manifest.permissions) || {};
            const tools = [...(perm.tools || []), ...(perm.ext_tools || [])].map(String);
            return { id: String(a.id), title: String(a.title || a.id), version: String(a.version || '0.0.0'),
                scopes: (perm.scopes || []).map(String), tools };
        });
    }
    catch (e) {
        // 앱 레지스트리가 아직 없는 배포(구버전)·권한 없음 등 — 조용히 빈 목록(런치패드는 화면앱만 보인다).
        return [];
    }
}
let spawning = false;
export function isSpawningApp() { return spawning; }
/**
 * 앱 세션을 만든다. 성공하면 { id }, 사용자가 동의를 취소했거나 실패하면 null(이유는 toast).
 *  UI 중립 — **행선지는 호출자가 정한다**: 런치패드는 openAppSession 으로 #/s/<id> 로 가고, studio 는 이 id 로
 *  캔버스에 세션 카드를 올린다. opts.projectId 를 주면 만든 뒤 그 프로젝트에 붙인다(studio 캔버스에서 열 때).
 */
export async function spawnAppSession(appId, opts) {
    if (spawning)
        return null;
    spawning = true;
    try {
        let id = '';
        try {
            id = await postAppSession(appId, opts);
        }
        catch (e) {
            if (e && e.status === 403) {
                // grant 없음 → 동의 창 → grant → 재시도 1회.
                const app = (await listSessionApps()).find((a) => a.id === appId)
                    || { id: appId, title: opts?.title || appId, version: '', scopes: [], tools: [] };
                if (!(await appConsent(app)))
                    return null; // 취소 = 조용히 멈춤
                await api('/api/ui/apps/' + encodeURIComponent(appId) + '/grant', { method: 'POST', body: JSON.stringify({}) });
                id = await postAppSession(appId, opts);
            }
            else
                throw e;
        }
        if (opts?.projectId && Number(opts.projectId) > 0) {
            // 세션은 이미 유효 — 붙이기 실패는 치명 아님(사용자는 우측 '이 세션'에서 나중에 붙일 수 있다).
            try {
                await api('/api/ui/terminal/sessions/' + encodeURIComponent(id) + '/project', { method: 'POST', body: JSON.stringify({ projectId: Number(opts.projectId) }) });
            }
            catch (_) { /* noop */ }
        }
        return { id };
    }
    catch (e) {
        toast('앱을 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
        return null;
    }
    finally {
        spawning = false;
    }
}
/** 앱 세션을 열고 그 대화 화면(#/s/<id>)으로 간다 — 전역 런치패드용. */
export async function openAppSession(appId, opts) {
    const s = await spawnAppSession(appId, opts);
    if (!s)
        return false;
    location.hash = '#/s/' + encodeURIComponent(s.id);
    return true;
}
async function postAppSession(appId, opts) {
    const p = runPrefs();
    const out = await api('/api/ui/terminal/sessions', {
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
    if (!id)
        throw new Error('세션 id 를 받지 못했습니다');
    return id;
}
// ── 동의(grant) 창 — 이 앱을 내 자격으로 쓰겠다는 확인. 선언 상한(scope·도구)을 그대로 보여 준다. ──
//  네이티브 confirm() 은 안 쓴다(브라우저 모달은 이벤트를 막는다) — DOM 오버레이 + Esc/밖클릭 취소.
function appConsent(app) {
    return new Promise((resolve) => {
        let done = false;
        const onKey = (e) => { if (e.key === 'Escape')
            finish(false); };
        const finish = (v) => { if (done)
            return; done = true; ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
        const chips = (xs, empty) => (xs.length
            ? xs.map((s) => el('span', { class: 'v2-consent-chip', text: s }))
            : [el('span', { class: 'v2-consent-chip none', text: empty })]);
        const ov = el('div', { class: 'v2-consent-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': app.title + ' 사용 동의',
            onclick: (e) => { if (e.target === ov)
                finish(false); } }, el('div', { class: 'v2-consent' }, el('h3', { class: 'v2-consent-t', text: '「' + app.title + '」을(를) 내 자격으로 실행할까요?' }), el('p', { class: 'v2-consent-sub', text: '이 앱이 여는 세션은 아래 권한만 내 이름으로 씁니다. 언제든 설정에서 철회할 수 있어요.' }), el('div', { class: 'v2-consent-grp' }, el('b', { text: '권한' }), el('div', { class: 'v2-consent-chips' }, ...chips(app.scopes, '추가 권한 없음'))), el('div', { class: 'v2-consent-grp' }, el('b', { text: '도구' }), el('div', { class: 'v2-consent-chips' }, ...chips(app.tools, '도구 없음'))), el('div', { class: 'v2-consent-acts' }, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => finish(false) }), el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '동의하고 열기', onclick: () => finish(true) }))));
        document.body.append(ov);
        document.addEventListener('keydown', onKey);
        ov.querySelector('.btn-primary')?.focus();
    });
}
