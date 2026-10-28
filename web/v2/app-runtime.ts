// AppInstance worker 상태바(#1780 Stage B) — 앱 화면과 worker 실행 위치는 독립이다.
// 탭 내용 위에 OS 소유 상태바를 얹어, 앱 iframe이 자기 실행 상태를 속이거나 숨기지 못하게 한다.
import { el, toast } from '../core.js';
import type { AppUiFrame } from './app-ui.js';
import { getAppInstance, restartAppInstance, type AppInstanceRecord, type AppWorkerRun } from './app-instance.js';

export interface AppRuntimeView { root: HTMLElement; destroy(): void }

const STATUS_TEXT: Record<AppWorkerRun['status'], string> = {
  prepared: '준비 중',
  starting: '시작 중',
  ready: '실행 중',
  idle: '대기 중',
  running: '작업 중',
  stopping: '종료 중',
  stopped: '중지됨',
  failed: '오류',
};

const REASON_TEXT: Record<string, string> = {
  explicit: '사용자가 멈췄어요.',
  placement_changed: '실행 위치가 바뀌었어요.',
  package_updated: '앱이 새 버전으로 바뀌었어요.',
  instance_closed: '앱 화면을 닫았어요.',
  app_disabled: '앱이 꺼졌어요.',
  app_removed: '앱이 지워졌어요.',
  grant_revoked: '앱 권한을 거둬들였어요.',
  member_deactivated: '구성원 계정이 꺼졌어요.',
  idle_timeout: '오랫동안 쓰지 않아 멈췄어요.',
  memory_budget: '쓸 수 있는 메모리를 넘어 멈췄어요.',
  protocol_error: '앱의 뒤에서 도는 코드가 약속된 방식으로 답하지 않아 멈췄어요.',
  ready_timeout: '정해진 시간 안에 준비되지 않았어요.',
  process_exit: '앱의 뒤에서 도는 코드가 끝났어요.',
  host_shutdown: '실행하던 컴퓨터가 꺼졌어요.',
};

function locationText(instance: AppInstanceRecord): string {
  return instance.execution_host_kind === 'remote'
    ? `원격 노드 · ${instance.execution_host_id || '알 수 없음'}`
    : '이 게이트웨이';
}

function detailText(worker: AppWorkerRun | null): string {
  if (!worker) return '앱의 뒤에서 도는 코드의 실행 기록을 아직 받지 못했어요.';
  const reason = worker.reason ? (REASON_TEXT[worker.reason] || `종료 사유: ${worker.reason}`) : '';
  const exit = worker.exit_code == null ? '' : ` 끝난 번호는 ${worker.exit_code}예요.`;
  return reason ? reason + exit : '앱의 뒤에서 도는 코드가 따로 떨어진 환경에서 실행돼요.';
}

/** 앱 iframe 위에 신뢰 가능한 실행 위치·상태를 표시하고 terminal 상태를 가볍게 갱신한다. */
export function mountAppRuntimeView(initial: AppInstanceRecord, frame: AppUiFrame): AppRuntimeView {
  let current = initial;
  let destroyed = false;
  let refreshing = false;
  let restarting = false;
  const place = el('b', { class: 'v2-worker-place' });
  const state = el('span', { class: 'v2-worker-state', 'aria-live': 'polite' });
  const detail = el('span', { class: 'v2-worker-detail' });
  const restart = el('button', { class: 'btn btn-ghost btn-sm v2-worker-restart', type: 'button', text: '다시 실행' }) as HTMLButtonElement;
  const bar = el('div', { class: 'v2-worker-bar' }, place, state, detail, el('span', { class: 'v2-worker-spacer' }), restart);
  const root = el('div', { class: 'v2-worker-app' }, bar, frame.root);

  const paint = (): void => {
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

  const refresh = async (): Promise<void> => {
    if (destroyed || refreshing || document.hidden) return;
    refreshing = true;
    try { current = await getAppInstance(current.id); paint(); }
    catch { /* 주기적 상태 확인 실패는 화면을 덮거나 반복 알림하지 않는다. */ }
    finally { refreshing = false; }
  };
  restart.onclick = async () => {
    if (restarting) return;
    restarting = true;
    paint();
    try { current = await restartAppInstance(current.id); paint(); }
    catch (error: any) { toast('앱의 뒤에서 도는 코드를 다시 실행하지 못했어요. ' + (error?.message || error), true); }
    finally { restarting = false; paint(); }
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
