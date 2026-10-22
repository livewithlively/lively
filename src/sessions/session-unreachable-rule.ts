// 도달 불가 세션 판정 (#4939 재설계 v2 — 판정 한 곳) — 장부는 «원함» 인데 세션 호스트 목록에 계속 안 보이는 세션을 «끝남» 으로 적는다.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
// 세션이 살았나·끝났나는 게이트웨이만 판정하고 브로커는 그 판정대로 지우기만 한다(상민님 2026-10-22). 종전엔 둘이 따로 판정해 엇갈리면
//  서로 미뤘다 — 게이트웨이(종료 규칙·옛 회수)는 세션 호스트 목록에 보이는 세션만 끄고, 브로커는 안에 tmux 서버가 살아 있으면 안 걷는다.
//  그래서 «안은 살아 있는데 목록엔 안 보이는» 컨테이너는 아무도 손대지 않았다(실측 #4939: box-wonjoon-jang-88ebc543 이 39일).
//  이 판정은 그 모양을 게이트웨이가 스스로 맞추는 규칙이다. 적는 곳은 기존 장부 칸(exited_at · exit_reason='unreachable')이고,
//  브로커는 장부의 «끝남» 을 판정 시각보다 먼저 뜬 컨테이너에 집행한다(lvly-cloud sessionledger gatewayPlan).
//
// ── 규칙(상민님 확정 H1·H6) ───────────────────────────────────────────────────
//  · 신선한 세션 호스트가 «컨테이너는 있는데 그 목록에 세션이 없다» 를 **15분 연속** 확답하고(node/container-watch),
//    마지막 작업(훅이 올리는 last_busy — 목록 가시성과 무관하게 오른다)이 **1시간 이전**이면 끝남으로 적는다.
//  · 그 세션이 어느 호스트 목록에든 다시 보이면 표식을 지운다(되살아남) — 이 규칙이 적은 것(exit_reason='unreachable')만.
//  · 호스트가 끊기거나 낡거나 컨테이너 관측을 안 보내면(옛 판) «모름» 이다 — 그 판은 아무것도 안 적고, 연속 시계는 처음부터 다시 센다.
//  · 상시 세션에도 적용한다(H6) — DB 행이 없으므로(설계 #1059 E) 표식은 메모리에 두고 장부가 «끝남» 행으로 싣는다. keep-alive 가 다시 띄운다.
//  · 스위치 LIVELY_SESSION_LOST_RULE = off · shadow(기본 — 판정만 로그로 남긴다) · on.
//  ⚠ 이름이 겹치는 #4783 session-end-lost.ts(«사유 없이 사라진 판» — end_note 의 lost)와 다른 판정이다. 그래서 사유 값은 'unreachable' 이다.
//  ⚠ 이 파일은 **순수**다(런타임 import 0) — 화면 판정(session-meta)도 여기서 사유 값을 가져간다. 배선(DB·레지스트리)은 session-unreachable-sweep.ts.

/** 표식의 사유 값 — 사용자 종료(prompt_input_exit·logout)·OOM 과 갈린다. 화면은 이 사유를 «종료됨(내가 끝냄)» 으로 그리지 않는다. */
export const UNREACHABLE_REASON = "unreachable";
/**
 * 화면의 «종료됨(사람이 끝냄)» 인가(순수) — 끝남 표식이 있고 그 사유가 이 규칙이 아닐 때만. 도달 불가로 적힌 세션은 사람이 끝낸 것이 아니라
 *  «중단됨(복원 가능)» 으로 그린다(행은 남는다 — 다시 열면 같은 id 로 복원된다). 목록 행(terminal/sessions)과 단건 메타(session-meta)가 같은 자를 쓴다.
 */
export function exitedByUserOf(s: { exited_at?: string | null; exit_reason?: string | null }): boolean {
  return !!s.exited_at && s.exit_reason !== UNREACHABLE_REASON;
}
/** «컨테이너는 있는데 세션이 안 보임» 이 이만큼 이어져야 적는다(H1). */
export const UNREACHABLE_AFTER_MS = 15 * 60_000;
/** 마지막 작업이 이보다 최근이면 적지 않는다(H1). */
export const UNREACHABLE_BUSY_MS = 60 * 60_000;

export type LostRuleMode = "off" | "shadow" | "on";

/** env `LIVELY_SESSION_LOST_RULE` 읽기(순수) — 기본 shadow. off·0·false·no 면 off, on·1·true·yes 면 on, 그 밖은 shadow(동작은 off 와 같다). */
export function lostRuleModeOf(raw: string | null | undefined): LostRuleMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(v)) return "off";
  if (["on", "1", "true", "yes"].includes(v)) return "on";
  return "shadow";
}

/** 세션 호스트(노드) 하나의 관측 — 판정 재료. */
export interface HostView {
  nodeId: string;
  /** 선언·연결·신선(STATE_STALE_MS) — 목록 소유 판정과 같은 술어. */
  fresh: boolean;
  /** 컨테이너 관측을 보내는 판인가. */
  known: boolean;
  /** 그 호스트 목록에 보인 세션 id. */
  listed: ReadonlySet<string>;
  /** «컨테이너는 있는데 세션이 안 보임» 이 처음 보인 시각(container-watch). */
  missing: ReadonlyMap<string, { sinceMs: number; container: string }>;
}

/** DB 행(org_session_state)에서 이 판정이 쓰는 칸. */
export interface UnreachableRow {
  id: string;
  superseded_by: string | null;
  exited_at: string | null;
  exit_reason: string | null;
  /** 마지막 작업 epoch초(훅·목록 관측이 올린다). */
  last_busy: number | null;
}

export interface UnreachableInput {
  nowMs: number;
  hosts: ReadonlyArray<HostView>;
  rows: ReadonlyArray<UnreachableRow>;
  /** 상시 세션 id. */
  managed: ReadonlyArray<string>;
  /** 이 프로세스가 훅으로 본 마지막 작업 epoch초(모르면 0) — DB 행이 없는 상시 세션의 유일한 작업 근거. */
  lastBusyMem: (id: string) => number;
  /** 이 게이트웨이가 뜬 지(ms) — 메모리 근거가 «1시간» 을 말할 수 있으려면 그만큼은 떠 있어야 한다. */
  upMs: number;
  /** 이 규칙이 이미 적은 상시 세션(메모리 표식). */
  markedManaged: ReadonlyMap<string, number>;
}

export interface UnreachableDecision {
  /** 판단 보류 사유 — 있으면 이번 판은 아무것도 안 적는다(되살아남은 적는다 — 그건 «보였다» 는 확답이다). */
  blind: string | null;
  mark: Array<{ id: string; node: string; container: string; sinceMs: number; lastBusySec: number | null; managed: boolean }>;
  revive: Array<{ id: string; managed: boolean }>;
  /** kind — 로그를 판마다 되풀이하지 않는 열쇠(why 의 분 단위 숫자는 판마다 바뀐다). */
  hold: Array<{ id: string; kind: "busy" | "no-evidence"; why: string }>;
}

/** 판정(순수). */
export function judgeUnreachable(i: UnreachableInput): UnreachableDecision {
  const out: UnreachableDecision = { blind: null, mark: [], revive: [], hold: [] };
  if (i.hosts.length === 0) { out.blind = "세션 호스트 없음(이 배포·테넌트는 호스트가 목록을 쥐지 않는다)"; return out; }
  const stale = i.hosts.filter((h) => !h.fresh).map((h) => h.nodeId);
  const unknown = i.hosts.filter((h) => h.fresh && !h.known).map((h) => h.nodeId);
  if (stale.length) out.blind = `세션 호스트 관측이 낡았다(${stale.join(", ")}) — 모름`;
  else if (unknown.length) out.blind = `세션 호스트가 컨테이너 관측을 안 보낸다(${unknown.join(", ")} — 옛 판) — 모름`;
  //  «보였다» 는 신선한 호스트의 확답이다 — 판단을 보류하는 판에도 되살림은 한다(지워서 손해 볼 일이 없다).
  const listed = (id: string): boolean => i.hosts.some((h) => h.fresh && h.listed.has(id));
  const rows = new Map(i.rows.map((r) => [r.id, r]));
  for (const r of i.rows) {
    if (r.exit_reason === UNREACHABLE_REASON && r.exited_at && !r.superseded_by && listed(r.id)) out.revive.push({ id: r.id, managed: false });
  }
  for (const id of i.markedManaged.keys()) if (listed(id)) out.revive.push({ id, managed: true });
  if (out.blind) return out;
  const managed = new Set(i.managed);
  const candidates = new Set<string>();
  for (const r of i.rows) if (!r.superseded_by && !r.exited_at) candidates.add(r.id);
  for (const id of managed) if (!i.markedManaged.has(id)) candidates.add(id);
  const nowSec = Math.floor(i.nowMs / 1000);
  for (const id of candidates) {
    if (listed(id)) continue;
    let seen: { node: string; sinceMs: number; container: string } | null = null;
    for (const h of i.hosts) {
      const m = h.missing.get(id);
      if (m && (!seen || m.sinceMs < seen.sinceMs)) seen = { node: h.nodeId, sinceMs: m.sinceMs, container: m.container };
    }
    if (!seen || i.nowMs - seen.sinceMs < UNREACHABLE_AFTER_MS) continue;   // 재료가 없거나 아직 세는 중
    const row = rows.get(id);
    const isManaged = managed.has(id);
    const lastBusySec = Math.max(row?.last_busy ?? 0, i.lastBusyMem(id)) || null;
    if (lastBusySec !== null && (nowSec - lastBusySec) * 1000 < UNREACHABLE_BUSY_MS) {
      out.hold.push({ id, kind: "busy", why: `최근 작업 ${Math.round((nowSec - lastBusySec) / 60)}분 전 — 일하는 세션일 수 있다` });
      continue;
    }
    //  DB 행이 없으면(상시 세션) 작업 근거는 이 프로세스의 기억뿐이다 — 뜬 지 1시간이 안 됐으면 «1시간 동안 작업 없음» 을 말할 수 없다.
    if (lastBusySec === null && !row && i.upMs < UNREACHABLE_BUSY_MS) {
      out.hold.push({ id, kind: "no-evidence", why: "마지막 작업을 모른다(DB 행 없음 · 게이트웨이가 뜬 지 1시간 미만)" });
      continue;
    }
    out.mark.push({ id, node: seen.node, container: seen.container, sinceMs: seen.sinceMs, lastBusySec, managed: isManaged && !row });
  }
  return out;
}

/** 정비 한 판의 재료·손(주입) — 시험이 DB·레지스트리 없이 돌린다. */
export interface UnreachableSweepDeps {
  mode: LostRuleMode;
  nowMs: number;
  upMs: number;
  hosts: () => HostView[];
  rows: () => Promise<UnreachableRow[]>;
  managed: () => Promise<string[]>;
  lastBusyMem: (id: string) => number;
  /** DB 행에 적는다 — `sinceMs` 뒤에 살아 있다는 기록을 받은 행은 안 적는다(session-state.markSessionUnreachable). 반환 = 적었나. */
  markRow: (id: string, sinceMs: number) => Promise<boolean>;
  reviveRow: (id: string) => Promise<boolean>;
  /** 이 테넌트의 상시 세션 표식(메모리 — on 에서만 바뀐다). */
  marks: Map<string, number>;
  /** 같은 판정을 같은 말로 두 번 하지 않기 위한 기억(세션 id → 마지막으로 말한 것). */
  said: Map<string, string>;
  log: (level: "info" | "warn", obj: Record<string, unknown>, msg: string) => void;
  tenant?: string | null;
}

/** 정비 한 판(주입된 손으로). off 면 아무것도 안 읽고 null. */
export async function runUnreachableSweep(d: UnreachableSweepDeps): Promise<UnreachableDecision | null> {
  if (d.mode === "off") return null;
  const hosts = d.hosts();
  if (hosts.length === 0) return { blind: "세션 호스트 없음", mark: [], revive: [], hold: [] };   // 셀프호스트 — DB 도 안 읽는다
  const [rows, managed] = await Promise.all([d.rows(), d.managed()]);
  const dec = judgeUnreachable({
    nowMs: d.nowMs, hosts, rows, managed, lastBusyMem: d.lastBusyMem, upMs: d.upMs, markedManaged: d.marks,
  });
  const shadow = d.mode === "shadow";
  const tag = shadow ? "도달 불가 판정(#4939 그림자)" : "도달 불가 판정(#4939)";
  //  같은 세션에 같은 말을 되풀이하지 않는다(정비는 30초마다 돈다) — 말할 거리가 바뀔 때만 한 줄.
  const say = (key: string, what: string, level: "info" | "warn", obj: Record<string, unknown>, msg: string): void => {
    if (d.said.get(key) === what) return;
    d.said.set(key, what);
    d.log(level, { tenant: d.tenant ?? null, ...obj }, msg);
  };
  say("*blind", dec.blind ?? "", "info", { blind: dec.blind }, dec.blind ? `${tag} — 판단 보류: ${dec.blind}` : `${tag} — 판단 재개(관측 신선)`);
  const failed = (what: string, id: string) => (err: unknown): false => {
    d.log("warn", { tenant: d.tenant ?? null, id, err: (err as Error)?.message ?? String(err) }, `${tag} — ${what} 실패(다음 판에 다시)`);
    return false;
  };
  for (const m of dec.mark) {
    const ctx = { id: m.id, node: m.node, container: m.container, unseenMin: Math.round((d.nowMs - m.sinceMs) / 60_000),
      lastBusyAgoMin: m.lastBusySec === null ? null : Math.round((d.nowMs / 1000 - m.lastBusySec) / 60), managed: m.managed };
    if (shadow) { say(m.id, "mark", "warn", ctx, `${tag} — 켜져 있었다면 끝남으로 적었다(브로커가 그 컨테이너를 걷는다)`); continue; }
    if (m.managed) d.marks.set(m.id, d.nowMs);
    //  안 맞았으면(그 사이 끝났거나 · 이어졌거나 · 살아 있다는 기록을 받았다) 그 판은 안 적는다 — 조건부 UPDATE.
    else if (!(await d.markRow(m.id, m.sinceMs).catch(failed("끝남 기록", m.id)))) continue;
    say(m.id, "mark", "warn", ctx, `${tag} — 끝남으로 적었다(exit_reason=${UNREACHABLE_REASON} · 브로커가 그 컨테이너를 걷는다)`);
  }
  for (const r of dec.revive) {
    if (shadow) { say(r.id, "revive", "info", { id: r.id, managed: r.managed }, `${tag} — 다시 보였다(켜져 있었다면 끝남 표식을 지웠다)`); continue; }
    if (r.managed) d.marks.delete(r.id);
    else if (!(await d.reviveRow(r.id).catch(failed("표식 지우기", r.id)))) continue;
    say(r.id, "revive", "info", { id: r.id, managed: r.managed }, `${tag} — 다시 보여 끝남 표식을 지웠다`);
  }
  for (const h of dec.hold) say(h.id, `hold:${h.kind}`, "info", { id: h.id, why: h.why }, `${tag} — 보류: ${h.why}`);
  //  기억 정리 — 이번 판에 말할 거리가 없는 세션은 잊는다(다시 나타나면 다시 한 줄). 상시 목록에서 빠진 세션의 표식도 버린다.
  const spoken = new Set<string>(["*blind", ...dec.mark.map((m) => m.id), ...dec.revive.map((r) => r.id), ...dec.hold.map((h) => h.id)]);
  for (const k of [...d.said.keys()]) if (!spoken.has(k)) d.said.delete(k);
  const managedNow = new Set(managed);
  for (const id of [...d.marks.keys()]) if (!managedNow.has(id)) d.marks.delete(id);
  return dec;
}
