// AppInstance worker 상태바(#1780 Stage B) — 앱 화면과 worker 실행 위치는 독립이다.
// 탭 내용 위에 OS 소유 상태바를 얹어, 앱 iframe이 자기 실행 상태를 속이거나 숨기지 못하게 한다.
import { el, toast } from '../core.js';
import { getAppInstance, restartAppInstance } from './app-instance.js';
const STATUS_TEXT = {
    prepared: '준비 중',
    starting: '시작 중',
    ready: '실행 중',
    idle: '대기 중',
    running: '작업 중',
    stopping: '종료 중',
    stopped: '중지됨',
    failed: '오류',
};
const REASON_TEXT = {
    explicit: '사용자가 중지했습니다.',
    placement_changed: '실행 위치가 바뀌었습니다.',
    package_updated: '앱이 업데이트되었습니다.',
    instance_closed: '앱 인스턴스를 닫았습니다.',
    app_disabled: '앱이 비활성화되었습니다.',
    app_removed: '앱이 제거되었습니다.',
    grant_revoked: '앱 권한을 철회했습니다.',
    member_deactivated: '구성원이 비활성화되었습니다.',
    idle_timeout: '오랫동안 사용하지 않아 중지했습니다.',
    memory_budget: '메모리 예산을 넘어 중지했습니다.',
    protocol_error: 'worker 통신 규약을 지키지 않아 중지했습니다.',
    ready_timeout: '정해진 시간 안에 준비되지 않았습니다.',
    process_exit: 'worker 프로세스가 종료되었습니다.',
    host_shutdown: '실행 호스트가 종료되었습니다.',
};
function locationText(instance) {
    return instance.execution_host_kind === 'remote'
        ? `원격 노드 · ${instance.execution_host_id || '알 수 없음'}`
        : '이 게이트웨이';
}
function detailText(worker) {
    if (!worker)
        return 'worker 실행 기록을 아직 받지 못했습니다.';
    const reason = worker.reason ? (REASON_TEXT[worker.reason] || `종료 사유: ${worker.reason}`) : '';
    const exit = worker.exit_code == null ? '' : ` 종료 코드 ${worker.exit_code}입니다.`;
    return reason ? reason + exit : '앱의 worker 코드가 격리된 환경에서 실행됩니다.';
}
/** 앱 iframe 위에 신뢰 가능한 실행 위치·상태를 표시하고 terminal 상태를 가볍게 갱신한다. */
export function mountAppRuntimeView(initial, frame) {
    let current = initial;
    let destroyed = false;
    let refreshing = false;
    let restarting = false;
    const place = el('b', { class: 'v2-worker-place' });
    const state = el('span', { class: 'v2-worker-state', 'aria-live': 'polite' });
    const detail = el('span', { class: 'v2-worker-detail' });
    const restart = el('button', { class: 'btn btn-ghost btn-sm v2-worker-restart', type: 'button', text: '다시 실행' });
    const bar = el('div', { class: 'v2-worker-bar' }, place, state, detail, el('span', { class: 'v2-worker-spacer' }), restart);
    const root = el('div', { class: 'v2-worker-app' }, bar, frame.root);
    const paint = () => {
        const worker = current.worker;
        const status = worker?.status || 'prepared';
        place.textContent = locationText(current);
        state.textContent = worker ? STATUS_TEXT[worker.status] : '상태 확인 중';
        state.className = 'v2-worker-state ' + ((status === 'failed' || status === 'stopped') ? 'is-terminal' : 'is-live');
        detail.textContent = detailText(worker);
        const terminal = worker?.status === 'failed' || worker?.status === 'stopped';
        restart.hidden = !terminal;
        restart.disabled = restarting;
        restart.textContent = restarting ? '실행하는 중…' : '다시 실행';
    };
    const refresh = async () => {
        if (destroyed || refreshing || document.hidden)
            return;
        refreshing = true;
        try {
            current = await getAppInstance(current.id);
            paint();
        }
        catch { /* 주기적 상태 확인 실패는 화면을 덮거나 반복 알림하지 않는다. */ }
        finally {
            refreshing = false;
        }
    };
    restart.onclick = async () => {
        if (restarting)
            return;
        restarting = true;
        paint();
        try {
            current = await restartAppInstance(current.id);
            paint();
        }
        catch (error) {
            toast('앱 worker를 다시 실행하지 못했어요 — ' + (error?.message || error), true);
        }
        finally {
            restarting = false;
            paint();
        }
    };
    paint();
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    return {
        root,
        destroy: () => {
            destroyed = true;
            window.clearInterval(timer);
            frame.destroy();
            root.remove();
        },
    };
}
