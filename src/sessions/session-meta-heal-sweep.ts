// 세션 호스트 스냅샷에서 **표식이 빈 판**을 찾아 DB 행으로 되채우는 정비 (#3892 후속).
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// #3892 는 게이트웨이 목록(`collectSessions`)에 되채우기를 달았다. 그런데 매니지드는 세션 목록 소유를 노드의 세션 호스트로
//  넘기고 있고(#2600 T2 d — `gatewayDefersHere()` 가 참이면 게이트웨이는 목록용 tmux 를 안 부른다), 세션 호스트는 노드
//  프로세스라 DB 가 없다. 그 판에서 생성이 판과 표식 사이에서 끊기면(롤 교대 SIGTERM · 중계 실패):
//   · 세션 호스트는 빈 표식을 그대로 스냅샷에 싣는다(소유자 "" · 하네스 "shell")
//   · 게이트웨이 가시성(`nodeSessionVisible`: 소유자·초대)이 그 행을 **주인에게서도** 거른다
//   · 그 id 가 라이브 집합에서 빠지니 DB 행이 «중단됨» 으로 뜬다 → 사람은 «돌던 세션이 회수됐다» 로 겪는다
//  실측(2026-09-11): box-sangmin-yoon-d78e541c 가 10:07~10:23Z 동안 목록에서 «중단됨» 이었다. 10:23:00Z 롤로 뜬 새 게이트웨이가
//   목록을 넘기기 **직전** 한 번 `collectSessions` 를 돌려 되채웠고(로그 via 없음·pid 3156868), 그 뒤 스냅샷에 소유자가 실려
//   다시 보였다. 우연한 순서였다 — 목록을 넘긴 뒤에 끊긴 판은 아무도 안 고친다.
//
// ── 무엇을 하나 ─────────────────────────────────────────────────────────────
//  요청에 얹은 테넌트 정비(outbox-request-sweep `SWEEP_JOBS`)로 돈다. 선언된 세션 호스트의 신선한 스냅샷에서 소유자 칸이
//   빈 행만 골라(대부분의 판에선 0건이라 DB 를 묻지도 않는다) DB 행을 한 번에 읽고, `needsSnapshotMetaHeal` 이 참인 판에
//   게이트웨이 목록과 **같은 창구**(`healSessionMeta` — 같은 쿨다운·같은 명령)로 보낸다.
import type { SessionInfo } from "../terminal/catalog.js";
import type { SessionState } from "./session-state.js";
import { needsSnapshotMetaHeal } from "../terminal/session-meta-heal.js";

export interface MetaHealSweepDeps {
  /** 선언된 세션 호스트의 신선한 스냅샷(가시성 필터 없이). */
  snapshotSessions: () => SessionInfo[];
  /** DB desired 행 — 한 번에(목록 폴링과 같은 창구). */
  loadDesired: (ids: string[]) => Promise<Map<string, SessionState>>;
  /** 보낸다 — 쿨다운에 걸리면 거짓. */
  heal: (id: string, row: SessionState) => boolean;
}

export interface MetaHealSweepResult {
  /** 본 스냅샷 행 수. */
  scanned: number;
  /** 소유자 칸이 빈 행 수(DB 를 물은 수). */
  ownerless: number;
  /** 이번에 보낸 세션 id. */
  healed: string[];
}

async function defaultDeps(): Promise<MetaHealSweepDeps> {
  const [{ sessionHostSnapshotSessions }, { loadDesiredMap }, { healSessionMeta }] = await Promise.all([
    import("../node/registry.js"),
    import("./session-desired.js"),
    import("../terminal/sessions.js"),
  ]);
  return {
    snapshotSessions: () => sessionHostSnapshotSessions(),
    loadDesired: loadDesiredMap,
    heal: (id, row) => healSessionMeta(id, row, "snapshot"),
  };
}

/** 한 번 돈다 — 이 요청의 테넌트 스코프 안에서(스냅샷은 registry 가, DB 는 RLS 가 좁힌다). */
export async function sweepSessionMetaHeal(deps?: MetaHealSweepDeps): Promise<MetaHealSweepResult> {
  const d = deps ?? await defaultDeps();
  const rows = d.snapshotSessions();
  const ownerless = rows.filter((s) => !String(s.owner || "").trim() && !String(s.managed || "").trim());
  if (!ownerless.length) return { scanned: rows.length, ownerless: 0, healed: [] };
  const desired = await d.loadDesired(ownerless.map((s) => s.id));
  const healed: string[] = [];
  for (const s of ownerless) {
    const row = desired.get(s.id);
    if (!row || !needsSnapshotMetaHeal({ snapshotOwner: s.owner, row, managed: s.managed })) continue;
    if (d.heal(s.id, row)) healed.push(s.id);
  }
  return { scanned: rows.length, ownerless: ownerless.length, healed };
}
