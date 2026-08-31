// 세션 작업 표면 (#2439 ③) — **백그라운드 셸과 서브에이전트를 한 자리에** 보여준다.
//
//  ── 왜 필요한가 ──────────────────────────────────────────────────────────────────
//  상민님(2026-08-31): *"백그라운드 셸 정보나 서브에이전트 정보나 만든 아티팩트 정보 같이 하네스 아래쪽에
//   뜨는 것들은 확인할 방법이 하나도 없네."* — 맞는 말이었다. 그 정보는 **대화 파일에 아예 없어서**
//  (실측: transcript 26줄에 task 이벤트 0건) 대화창이 읽을 길 자체가 없었다. 대화 런타임(#2439 ②)이
//  생기고서야 이벤트로 오기 시작했고, 이 파일이 그걸 그린다.
//
//  ── ★ 왜 카드 하나로 둘 다 되나 ─────────────────────────────────────────────────
//  claude 실측: 백그라운드 셸과 서브에이전트가 **완전히 같은 봉투**로 온다 — `task_started` 에
//  `task_type` 만 `local_bash` / `local_agent` 로 다르다(+ 서브에이전트는 subagent_type·spawn_depth).
//  그래서 «작업(task)» 하나를 1급으로 두면 둘이 한 번에 덮인다. 서버가 그걸 `kind: shell|agent` 로
//  옮겨 주므로(session-event.ts ★3) 이 화면은 **하네스를 모른다.**
//
//  ── 화면이 하지 않는 것 ─────────────────────────────────────────────────────────
//  · 접기를 다시 하지 않는다. 서버가 언제나 **접힌 스냅샷**을 준다(runtime-bus) — 두 벌이면 갈린다.
//  · 모르는 이벤트에 던지지 않는다. 새 표면이 생겨도 화면은 조용히 건너뛴다(session-event.ts ★2).
import { apiUrl, el, TOKEN_KEY } from './core.js';
import { splitSse } from './sse-frames.js';

/** 서버 어휘(harness-io/session-event.ts)의 화면 쪽 그림자 — **필드를 늘릴 때 서버와 함께 늘린다.** */
interface TaskInfo {
  id: string;
  kind: 'shell' | 'agent' | 'other';
  title: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  agentType?: string;
  depth?: number;
  summary?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface SessionTasksHandle { destroy(): void }

//  토큰은 주소가 아니라 헤더로 — EventSource 를 못 쓰는 이유이자, 이 한 줄이 그 대가를 갚는 자리다.
function authHeaders(base: Record<string, string>): Record<string, string> {
  const tok = localStorage.getItem(TOKEN_KEY);
  return tok ? { ...base, Authorization: 'Bearer ' + tok } : base;
}

const KIND_ICON: Record<string, string> = { shell: '⌘', agent: '◆', other: '•' };
const STATUS_LABEL: Record<string, string> = {
  running: '도는 중', completed: '끝남', failed: '실패', killed: '중단됨',
};

/** 경과 시간 — 도는 중이면 지금까지, 끝났으면 걸린 시간. */
function elapsed(t: TaskInfo, now: number): string {
  const from = t.startedAt;
  if (!from) return '';
  const to = t.endedAt || now;
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/**
 * 작업 도크를 붙인다. 세션 상태 통로(SSE)를 구독해 목록을 그린다.
 *
 *  ⚠ 도는 작업이 없으면 **통째로 숨긴다** — 빈 상자를 늘 띄워 두면 대화가 그만큼 밀린다.
 */
export function mountSessionTasks(host: HTMLElement, o: { sessionId: string }): SessionTasksHandle {
  let tasks: TaskInfo[] = [];
  let closed = false;
  const ctl = new AbortController();

  const wrap = el('div', { class: 'stk-dock' });
  wrap.hidden = true;
  host.append(wrap);

  function paint(): void {
    const now = Date.now();
    //  끝난 작업은 잠깐만 남긴다 — 결과를 볼 틈은 주되 목록이 무한히 자라지 않게.
    const show = tasks.filter((t) => t.status === 'running' || !t.endedAt || now - t.endedAt < 60_000);
    wrap.hidden = show.length === 0;
    if (!show.length) { wrap.replaceChildren(); return; }

    const running = show.filter((t) => t.status === 'running').length;
    wrap.replaceChildren(
      el('div', { class: 'stk-head', text: running ? `작업 ${running}개 도는 중` : '방금 끝난 작업' }),
      ...show.map((t) => el('div', { class: `stk-row stk-${t.status}` },
        el('span', { class: 'stk-ic', text: KIND_ICON[t.kind] ?? '•' }),
        el('span', { class: 'stk-title', text: t.title || (t.kind === 'agent' ? '서브에이전트' : '명령') }),
        //  서브에이전트는 «무엇이 도는지» 가 종류에 있다 — 셸과 같은 줄에서 구분되게 칩으로 세운다.
        t.kind === 'agent' && t.agentType ? el('span', { class: 'stk-chip', text: t.agentType }) : null,
        t.depth && t.depth > 1 ? el('span', { class: 'stk-chip', text: `${t.depth}겹` }) : null,
        el('span', { class: 'stk-state', text: STATUS_LABEL[t.status] ?? t.status }),
        el('span', { class: 'stk-time', text: elapsed(t, now) }),
      )),
    );
  }

  //  도는 작업이 있으면 경과 시간을 1초마다 다시 그린다(없으면 타이머도 안 돈다).
  const tick = setInterval(() => { if (tasks.some((t) => t.status === 'running')) paint(); }, 1000);

  function handle(ev: unknown): void {
    const e = ev as { t?: string; tasks?: TaskInfo[] };
    //  ★ 서버가 접어서 스냅샷으로 준다 — 화면은 접지 않는다.
    if (e?.t === 'tasks.snapshot' && Array.isArray(e.tasks)) { tasks = e.tasks; paint(); return; }
    //  ★ 모르는 이벤트는 조용히 건너뛴다(새 표면이 생겨도 화면이 안 깨진다).
  }

  //  ── 스트림 ────────────────────────────────────────────────────────────────────
  //  EventSource 는 헤더를 못 싣는다(토큰이 주소로 샌다) — fetch 스트림으로 읽는다.
  //  ★ 서버가 25초마다 하트비트를 보내므로, 그보다 넉넉한 동안 **한 바이트도 안 오면 죽은 것**이다.
  //   말 없는 연결을 살아 있는 것으로 착각하면 재접속 루프가 통째로 멈춘다(2026-08-26 실측 사고).
  const SILENCE_MS = 40_000;

  async function pump(): Promise<void> {
    let wait = 1000;
    while (!closed) {
      const attempt = new AbortController();
      const onAbortAll = (): void => attempt.abort();
      ctl.signal.addEventListener('abort', onAbortAll);
      let silence: ReturnType<typeof setTimeout> | null = null;
      const beat = (): void => {
        if (silence) clearTimeout(silence);
        silence = setTimeout(() => attempt.abort(), SILENCE_MS);
      };
      try {
        const res = await fetch(apiUrl(`/api/ui/terminal/sessions/${encodeURIComponent(o.sessionId)}/events`), {
          headers: authHeaders({}), signal: attempt.signal, credentials: 'same-origin',
        });
        if (!res.ok || !res.body) throw new Error(`스트림 실패 (${res.status})`);
        wait = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = '';
        beat();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          beat();
          acc += dec.decode(value, { stream: true });
          const cut = splitSse(acc);
          acc = cut.rest;
          for (const d of cut.data) {
            try { handle(JSON.parse(d)); } catch { /* 깨진 프레임 한 장은 넘긴다 */ }
          }
        }
      } catch { /* 끊겼다 — 아래에서 다시 붙는다 */ }
      finally {
        if (silence) clearTimeout(silence);
        ctl.signal.removeEventListener('abort', onAbortAll);
      }
      if (closed) break;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 1.6, 15_000);   // 게이트웨이 재기동 중에 폭주하지 않게
    }
  }
  void pump();

  return {
    destroy(): void {
      closed = true;
      clearInterval(tick);
      try { ctl.abort(); } catch { /* noop */ }
      wrap.remove();
    },
  };
}
