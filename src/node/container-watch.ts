// 세션 호스트의 컨테이너 관측을 이어 보기 (#4939 재설계 v2 — 판정 한 곳) — 순수 모듈.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
// 세션이 살았나·끝났나는 게이트웨이만 판정한다(상민님 2026-10-22). 그 판정이 빠뜨리던 모양이 하나 있었다 — 컨테이너 안에 tmux 서버가
//  살아 있어 브로커는 «산 세션» 으로 보고 안 걷는데, 세션 호스트의 목록(그 컨테이너의 `list-sessions`)에는 그 세션이 없어 게이트웨이는
//  아예 모르는 세션. 실측 #4939: box-wonjoon-jang-88ebc543 이 39일 남았다. 게이트웨이가 그걸 알려면 «컨테이너는 있는데 목록에 세션이
//  없다» 를 **이어서** 봐야 한다 — 한 번 본 것으로는 갓 만든 컨테이너(tmux 가 뜨기 전)·중계 한 번의 흔들림과 갈리지 않는다.
//
// ── 무엇을 기억하나 ─────────────────────────────────────────────────────────
//  노드(세션 호스트)마다: 마지막 관측 시각 · 컨테이너 관측을 보내는 판인가(known) · «컨테이너는 있는데 세션이 안 보임» 이 처음 보인 시각(sid 별).
//  ★ 모름 ≠ 없음 — 관측이 끊긴 틈(상태 push·박동이 STATE_STALE_MS 넘게 안 옴)이 있으면 그동안 무슨 일이 있었는지 모르므로 처음부터 다시 센다.
//   그 sid 가 한 번이라도 목록에 보이거나, 컨테이너가 안 돌거나(state 가 running 이 아님), 그 컨테이너 목록을 못 봤으면(error·gone) 지운다.
//  판정(언제 «끝남» 으로 적나)은 sessions/session-unreachable-rule.ts 가 한다 — 여기는 «얼마나 이어졌나» 만 센다.
import type { ContainerObservation } from "../terminal/tmux-route.js";
import type { HostView } from "../sessions/session-unreachable-rule.js";
import { nodeSnapshotVerdict, SESSION_HOST_DEAD_MS } from "./self-node.js";   // 순수 — 목록 소유 판정과 같은 자

export interface ContainerWatch {
  /** 이 노드의 마지막 관측(상태 push 또는 박동) 시각(ms). */
  lastAt: number;
  /** 컨테이너 관측을 보내는 판인가 — 옛 세션 호스트는 안 보낸다(그 노드는 판정 재료가 없다 = 모름). */
  known: boolean;
  /** sid → «컨테이너는 있는데 목록에 세션이 없다» 가 처음 보인 시각과 그 컨테이너. */
  missing: Map<string, { sinceMs: number; container: string }>;
}

/** 상태 push 한 번을 반영한다(순수 — 새 값을 돌려준다). `containers` 가 없으면(옛 판) known:false. */
export function observeContainers(
  prev: ContainerWatch | undefined, containers: ReadonlyArray<ContainerObservation> | undefined, now: number, staleMs: number,
): ContainerWatch {
  if (!containers) return { lastAt: now, known: false, missing: new Map() };
  //  틈이 있었으면(그동안 목록에 보였을 수 있다) 이어 보지 않는다 — 처음부터 다시 센다.
  const carry = prev && prev.known && now - prev.lastAt <= staleMs ? prev.missing : null;
  const missing = new Map<string, { sinceMs: number; container: string }>();
  for (const c of containers) {
    //  판정 재료가 아닌 관측 — 안쪽 표식 없음(목록을 안 물었다) · 못 봄(error) · 컨테이너 없음(gone) · 안 도는 컨테이너.
    if (!c.inside || c.outcome === "skipped" || c.outcome === "error" || c.outcome === "gone") continue;
    if (c.state !== undefined && c.state !== "running") continue;
    if (c.outcome === "ok" && c.listed) continue;   // 목록에 보였다 — 산 세션
    const before = carry?.get(c.sid);
    missing.set(c.sid, { sinceMs: before && before.container === c.container ? before.sinceMs : now, container: c.container });
  }
  return { lastAt: now, known: true, missing };
}

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "no-server", "gone", "skipped", "error"]);
/** 상한 — 한 노드의 한 테넌트 세션 컨테이너 수(노드당 자리 13 남짓)보다 넉넉히. 넘으면 관측 전체를 «모름» 으로 버린다. */
export const MAX_CONTAINER_OBSERVATIONS = 512;

/**
 * 노드가 보낸 `containers` 칸 읽기(순수) — 네트워크에서 온 값이라 모양을 믿지 않는다.
 *  배열이 아니거나·상한을 넘거나·한 줄이라도 모양이 틀리면 undefined(= 그 노드는 이번 판 «모름» — 일부만 믿지 않는다).
 */
export function parseContainerObservations(raw: unknown): ContainerObservation[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_CONTAINER_OBSERVATIONS) return undefined;
  const out: ContainerObservation[] = [];
  for (const x of raw) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    if (typeof o.sid !== "string" || typeof o.container !== "string" || typeof o.inside !== "boolean"
      || typeof o.listed !== "boolean" || typeof o.outcome !== "string" || !OUTCOMES.has(o.outcome)
      || (o.state !== undefined && typeof o.state !== "string")) return undefined;
    out.push({
      sid: o.sid, container: o.container, inside: o.inside, listed: o.listed, outcome: o.outcome as ContainerObservation["outcome"],
      ...(typeof o.state === "string" ? { state: o.state } : {}),
    });
  }
  return out;
}

/** 박동 한 번(«지난번 그대로») — 나이만 되돌린다. 틈이 길었으면 다시 센다. 본 적 없는 노드면 아무것도 안 만든다. */
export function observeBeat(prev: ContainerWatch | undefined, now: number, staleMs: number): ContainerWatch | undefined {
  if (!prev) return undefined;
  if (now - prev.lastAt > staleMs) return { lastAt: now, known: prev.known, missing: new Map() };
  return { ...prev, lastAt: now };
}

/** 세션 호스트 하나의 재료 — registry 가 스냅샷·연결·관측 기억에서 동기로 모은다. */
export interface HostFacts {
  nodeId: string;
  declared: boolean;
  online: boolean;
  stateAgeMs: number;
  sessionIds: readonly string[];
  watch: ContainerWatch | undefined;
}

/**
 * 세션 호스트마다 판정 재료 한 벌(순수, #4939) — 도달 불가 판정(sessions/session-unreachable-rule)의 입력.
 *  · 선언된 호스트만(멤버 PC 는 세션 컨테이너를 안 쥔다). 하루 넘게 소식 없는 호스트는 뺀다 — 목록 소유 판정과 같은 지평선
 *    (`SESSION_HOST_DEAD_MS`): 회수된 노드의 행 하나가 판정을 영영 «모름» 으로 붙들지 않게. 그 밖의 끊김·낡음은 넣는다(판정이 «모름» 으로 읽는다).
 *  · 신선(fresh) = 목록 소유와 같은 술어(`nodeSnapshotVerdict`, 선언 필수) **그리고** 컨테이너 관측도 신선 — 둘은 따로 낡는다
 *    (스냅샷은 attach 전 RPC 재확인으로도 새로워지지만 관측은 상태 push·박동으로만 잇는다).
 */
export function hostViewsOf(nodes: ReadonlyArray<HostFacts>, now: number, staleMs: number, deadMs: number = SESSION_HOST_DEAD_MS): HostView[] {
  const out: HostView[] = [];
  for (const n of nodes) {
    if (!n.declared || n.stateAgeMs > deadMs) continue;
    const w = n.watch;
    const snap = nodeSnapshotVerdict({ declared: true, online: n.online, stateAgeMs: n.stateAgeMs }, staleMs, true).take;
    out.push({
      nodeId: n.nodeId,
      fresh: snap && !!w && now - w.lastAt <= staleMs,
      known: !!w && w.known,
      listed: new Set(n.sessionIds),
      missing: w?.missing ?? new Map(),
    });
  }
  return out;
}
