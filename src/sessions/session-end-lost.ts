// «사유 없이 사라진 판» 을 확인해 `lost`(고장)로 적는다 (#4783).
//
// ── 왜 ───────────────────────────────────────────────────────────────────────
//  끝을 보고하는 런처(catalog LAUNCH_STOP_SH)로 뜬 판은 끝내는 자리가 전부 끄기 전에 사유를 적는다(시스템 reclaim · 사람 stop ·
//  런처의 하네스 종료코드 — session-end.ts). 그런 판이 사유 없이 사라졌으면 그 밖의 길로 끝난 것이다 — 세션 노드가 죽었거나,
//  컨테이너가 고장 났거나, 안전망이 살아 있는 세션을 걷었거나. 사람에겐 «오류» 로 보여야 하는 끝이다
//  (상민님 2026-10-16 «오류면 빨간 점 같은 걸로 표시하는 게 맞지 않나»).
//  ⚠ 보고 런처 밖의 판(셸 세션 · grok·opencode · 대화 런타임 pane · 노드)은 정상 종료를 적는 자리가 없다 — 그 판엔 표식이 없어
//   후보가 아니다(session-state upsert end_mark · 격리 리뷰).
//
// ── 무엇을 믿고 무엇을 안 믿나 ─────────────────────────────────────────────────
//  ★ 목록에 없다는 것은 사라졌다는 근거가 아니다 — 중계가 못 본 틱·방금 만든 세션·스냅샷 지연이 전부 «없음» 처럼 보인다(#2108·#3694·#3846).
//   그래서 목록은 **후보를 고르는 데만** 쓰고, 적는 근거는 세션 하나하나에 대한 tmux 확답(sessionGoneVerdict === true)뿐이다.
//   «모른다»(null)·«살아 있다»(false)·시간 초과는 그 판에 아무것도 안 한다.
//  ★ 적을 때는 **확인한 그 판**에만 적는다(판 시작 created 를 같이 건다) — 확인하는 사이 같은 id 로 되살아났으면 아무것도 안 바뀐다.
//  · 한 판에 확인하는 수(LOST_MAX_PROBES)·동시 수(LOST_CONCURRENCY)·한 번의 시간(LOST_PROBE_TIMEOUT_MS)에 상한이 있다 —
//    노드 한 대가 죽으면 그 세션이 한꺼번에 후보가 된다. 남은 것은 다음 판이 본다.
//  · 확답을 못 받은 후보는 한동안(LOST_RETRY_MS) 다시 안 본다 — 영영 «모름» 인 몇 개가 상한을 차지해 나머지가 굶지 않게.
//  · 끄는 손잡이: env LIVELY_SESSION_END_LOST=off(0·false·no) — 이 확인만 멈춘다(사유 기록은 그대로).
//  · 매니지드(세션 컨테이너)만 돈다 — 하네스 종료 규칙과 같은 범위다.
import { listCentralSessions } from "../node/registry.js";
import { tenantSlug } from "../terminal/catalog.js";
import { tmuxInSessionContainer } from "../terminal/session-tmux.js";
import { sessionGoneVerdict } from "../terminal/tmux-exec.js";
import { listAllSessionStates, markSessionEnded, type SessionState } from "./session-state.js";
import { listManagedSessions } from "./managed-sessions.js";
import { isLostCandidate } from "./session-end.js";

/** 판이 선 뒤 이만큼은 후보로 안 본다 — 갓 만든(또는 방금 되살린) 판은 아직 목록에 안 잡혔을 수 있다(#4065 «시작 중» 90초보다 길게). */
export const LOST_GRACE_SEC = 180;
/** 한 판에 확답을 구하는 세션 수 상한. */
export const LOST_MAX_PROBES = 12;
/** 동시에 확답을 구하는 수. */
export const LOST_CONCURRENCY = 4;
/** 확답 하나를 기다리는 시간 — 넘으면 «모름» 이다. */
export const LOST_PROBE_TIMEOUT_MS = 5_000;
/** 확답을 못 받은 후보를 다시 보기까지. */
export const LOST_RETRY_MS = 10 * 60_000;

/** env 손잡이 — off·0·false·no 면 이 확인을 멈춘다. */
export function lostSweepSwitchOn(v: string | undefined): boolean {
  return !/^(off|0|false|no)$/i.test(String(v ?? "").trim());
}

export interface LostSweepDeps {
  enabled: () => boolean;
  listLive: () => Promise<Array<{ id: string }>>;
  listStates: () => Promise<SessionState[]>;
  listManaged: () => Promise<Array<{ session_id?: string | null }>>;
  goneVerdict: (id: string) => Promise<boolean | null>;
  /** 확인한 판(created)에만 lost 를 적는다. 반환 = 적었나. */
  markLost: (id: string, created: number) => Promise<boolean>;
  nowSec: () => number;
  nowMs: () => number;
  /** 확답을 못 받은 후보의 다음 확인 시각(ms) — 시험이 주입한다(기본 모듈 하나). */
  retryAfter: Map<string, number>;
  probeTimeoutMs: number;
}

export interface LostSweepResult {
  enabled: boolean;
  scanned: number;
  candidates: number;
  lost: string[];
  kept: Record<string, number>;
  skipped?: "list-failed";
}

const RETRY_AFTER = new Map<string, number>();

const DEFAULT_DEPS: LostSweepDeps = {
  enabled: () => lostSweepSwitchOn(process.env.LIVELY_SESSION_END_LOST) && tmuxInSessionContainer(tenantSlug()),
  listLive: () => listCentralSessions(),
  listStates: () => listAllSessionStates(),
  listManaged: () => listManagedSessions(),
  goneVerdict: (id) => sessionGoneVerdict(id),
  markLost: (id, created) => markSessionEnded(id, { why: "lost" }, { created }),
  nowSec: () => Math.floor(Date.now() / 1000),
  nowMs: () => Date.now(),
  retryAfter: RETRY_AFTER,
  probeTimeoutMs: LOST_PROBE_TIMEOUT_MS,
};

/** 약속을 상한 시간까지만 기다린다 — 넘거나 실패하면 null(«모름»). */
function verdictWithin(p: Promise<boolean | null>, ms: number): Promise<boolean | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

export async function sweepLostSessions(over: Partial<LostSweepDeps> = {}): Promise<LostSweepResult> {
  const d: LostSweepDeps = { ...DEFAULT_DEPS, ...over };
  const out: LostSweepResult = { enabled: d.enabled(), scanned: 0, candidates: 0, lost: [], kept: {} };
  if (!out.enabled) return out;
  const bump = (k: string): void => { out.kept[k] = (out.kept[k] ?? 0) + 1; };
  let live: Array<{ id: string }>, states: SessionState[], managed: Array<{ session_id?: string | null }>;
  try { [live, states, managed] = await Promise.all([d.listLive(), d.listStates(), d.listManaged()]); }
  catch { out.skipped = "list-failed"; return out; }   // 못 봤으면 아무것도 안 한다
  out.scanned = states.length;
  const liveIds = new Set(live.map((s) => String(s.id)));
  const managedIds = new Set(managed.map((m) => String(m.session_id ?? "")).filter(Boolean));
  const nowSec = d.nowSec();
  const nowMs = d.nowMs();
  for (const [id, until] of d.retryAfter) if (until <= nowMs) d.retryAfter.delete(id);   // 지난 기억은 버린다(무한히 안 자라게)
  const cands = states
    .filter((s) => isLostCandidate(s, { liveIds, managedIds, nowSec, graceSec: LOST_GRACE_SEC }))
    .sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0));
  out.candidates = cands.length;
  const ready = cands.filter((s) => { if ((d.retryAfter.get(s.id) ?? 0) > nowMs) { bump("retry-later"); return false; } return true; });
  const batch = ready.slice(0, LOST_MAX_PROBES);
  if (ready.length > batch.length) out.kept.capped = ready.length - batch.length;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batch.length) {
      const s = batch[next++];
      const verdict = await verdictWithin(d.goneVerdict(s.id), d.probeTimeoutMs);
      if (verdict !== true) { bump(verdict === false ? "alive" : "unknown"); d.retryAfter.set(s.id, nowMs + LOST_RETRY_MS); continue; }
      //  확답을 받은 뒤에도 «먼저 적은 쪽이 이긴다» · 확인한 그 판에만 — 그 사이 적혔거나 되살아났으면 이 기록은 아무것도 안 바꾼다.
      if (await d.markLost(s.id, Number(s.created) || 0).catch(() => false)) out.lost.push(s.id); else bump("written");
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOST_CONCURRENCY, batch.length) }, () => worker()));
  if (out.lost.length) console.info(`[session-end-lost] 사유 없이 사라진 판을 고장으로 적었다: ${out.lost.join(", ")}`);
  return out;
}
