// «사유 없이 사라진 판» 을 확인해 `lost`(고장)로 적는다 (#4783).
//
// ── 왜 ───────────────────────────────────────────────────────────────────────
//  세션을 끄는 자리는 전부 끄기 전에 사유를 적는다(시스템 reclaim · 사람 stop · 런처의 하네스 종료코드 — session-end.ts).
//  그러면 사유 없이 사라진 판은 그 밖의 길로 끝난 것이다 — 세션 노드가 죽었거나, 컨테이너가 고장 났거나, 안전망이 살아 있는
//  세션을 걷었거나. 사람에겐 «오류» 로 보여야 하는 끝이다(상민님 2026-10-16 «오류면 빨간 점 같은 걸로 표시하는 게 맞지 않나»).
//
// ── 무엇을 믿고 무엇을 안 믿나 ─────────────────────────────────────────────────
//  ★ 목록에 없다는 것은 사라졌다는 근거가 아니다 — 중계가 못 본 틱·방금 만든 세션·스냅샷 지연이 전부 «없음» 처럼 보인다(#2108·#3694·#3846).
//   그래서 목록은 **후보를 고르는 데만** 쓰고, 적는 근거는 세션 하나하나에 대한 tmux 확답(sessionGoneVerdict === true)뿐이다.
//   «모른다»(null)·«살아 있다»(false) 는 그 판에 아무것도 안 한다.
//  ★ 옛 판(이 규칙 전에 태어난 판 — end_note 표식 없음)은 후보가 아니다. 그 판은 끝낸 자리가 사유를 안 적었으니 사유 없음이 고장의 표시가 아니다.
//  · 한 판에 많이 걸리면(후보가 많고 v1 판의 절반을 넘으면) 그 판 전체를 건너뛴다 — 목록 자체가 잘못 비었을 수 있다(T5 의 H 가드와 같은 자리).
//  · 한 판에 확인하는 수는 상한이 있다(MAX_PROBES) — 노드 한 대가 죽으면 그 세션이 한꺼번에 후보가 된다. 다음 판이 이어서 본다.
//  · 매니지드(세션 컨테이너)만 돈다 — 하네스 종료 규칙과 같은 범위다. 멤버 PC 세션은 PC 가 꺼진 것이 사라진 게 아니라서 후보에서 뺀다(session-end.ts).
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
/** 후보가 이만큼 넘고 v1 판의 절반을 넘으면 그 판은 건너뛴다(목록이 잘못 비었을 수 있다). */
export const LOST_BULK_GUARD = 8;

export interface LostSweepDeps {
  enabled: () => boolean;
  listLive: () => Promise<Array<{ id: string }>>;
  listStates: () => Promise<SessionState[]>;
  listManaged: () => Promise<Array<{ session_id?: string | null }>>;
  goneVerdict: (id: string) => Promise<boolean | null>;
  markLost: (id: string) => Promise<boolean>;
  nowSec: () => number;
}

export interface LostSweepResult {
  enabled: boolean;
  scanned: number;
  candidates: number;
  lost: string[];
  kept: Record<string, number>;
  skipped?: "bulk" | "list-failed";
}

const DEFAULT_DEPS: LostSweepDeps = {
  enabled: () => tmuxInSessionContainer(tenantSlug()),
  listLive: () => listCentralSessions(),
  listStates: () => listAllSessionStates(),
  listManaged: () => listManagedSessions(),
  goneVerdict: (id) => sessionGoneVerdict(id),
  markLost: (id) => markSessionEnded(id, { why: "lost" }),
  nowSec: () => Math.floor(Date.now() / 1000),
};

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
  const v1 = states.filter((s) => s.end_note?.v === 1 && !s.end_note.why).length;
  const cands = states
    .filter((s) => isLostCandidate(s, { liveIds, managedIds, nowSec, graceSec: LOST_GRACE_SEC }))
    .sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0));
  out.candidates = cands.length;
  if (cands.length > LOST_BULK_GUARD && cands.length * 2 > v1) { out.skipped = "bulk"; return out; }
  for (const s of cands.slice(0, LOST_MAX_PROBES)) {
    let verdict: boolean | null;
    try { verdict = await d.goneVerdict(s.id); } catch { verdict = null; }
    if (verdict !== true) { bump(verdict === false ? "alive" : "unknown"); continue; }
    //  확답을 받은 뒤에도 «먼저 적은 쪽이 이긴다» — 그 사이 런처 보고·끄기가 적었으면 이 기록은 아무것도 안 바꾼다.
    if (await d.markLost(s.id).catch(() => false)) out.lost.push(s.id); else bump("written");
  }
  if (cands.length > LOST_MAX_PROBES) out.kept.capped = cands.length - LOST_MAX_PROBES;
  if (out.lost.length) console.info(`[session-end-lost] 사유 없이 사라진 판을 고장으로 적었다: ${out.lost.join(", ")}`);
  return out;
}
