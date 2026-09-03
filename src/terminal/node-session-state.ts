// #1791 — **노드 세션의 desired-state 를 게이트웨이가 소유한다**(org_session_state.node_id).
//
// 왜: 노드 세션(멤버 PC·워커·매니지드 실행환경)은 노드 에이전트가 만드는데 노드엔 DB 가 없어 desired-state 행이 없었다.
//  그 tmux/psmux 가 죽으면 노드의 3초 상태 push 에서 빠지는 순간 **어디에도 흔적이 없어** 웹은 "세션을 찾을 수 없어요"
//  로 끝났다(2026-08-18 hammurabi — 세션 5개 동시 사망, 복원 카드조차 없음). #1059 E 가 정한 "DB = desired, 실행 표면 =
//  observed" 가 노드 세션에만 안 닿아 있던 갭이다.
// 어떻게: 게이트웨이가 노드 create 릴레이에 **성공한 직후** 행을 쓴다(노드는 DB 를 모른다 — session-state.ts ON_NODE).
//  행의 좌표(root_key·subpath)는 노드의 createSession 이 쓰는 규칙과 **같은 식**으로 게이트웨이가 계산한다
//  (sessions.ts createSession과 같은 rootKey/subpath) — 복원이 그 노드에 같은 좌표로 create 를
//  다시 릴레이한다. best-effort: 행을 못 써도 세션은 이미 떠 있다(박스 세션 미러와 같은 규약).
// 이 모듈은 **게이트웨이 전용**이다 — node/registry(WS 서버)를 import 하므로 노드 에이전트 번들에 들어가면 안 된다
//  (sessions.ts 가 이걸 import 하지 않는 이유. routes 가 부른다).
import type { CreateInput, SessionInfo } from "./catalog.js";
import { upsertSessionState, insertDiscoveredSessionState, getSessionStates, clearSelfNodeSessionRows, type SessionStateInput } from "../sessions/session-state.js";
import { liveNodes, onNodeSessions, onSelfNodeJudged, isSelfNode } from "../node/registry.js";
import { selfNodeMessage } from "../node/self-node.js";
import { listNodes } from "../node/store.js";
import { logger } from "../log.js";

/**
 * 순수 — 노드 create 릴레이 결과(session) + 그 요청 입력(input) → desired-state 행.
 *  · id·label·harness·dir·flags·invites·created 는 노드가 실제로 적용한 값(응답)을 쓴다 — 요청과 다를 수 있다(라벨 기본값·플래그 화이트리스트).
 *  · root_key/subpath 는 노드가 안 돌려주므로 createSession 과 같은 workspace 좌표 규칙으로 계산한다.
 *  · project_id 는 응답 우선(노드가 폴더로 판정), 없으면 요청값.
 */
export function nodeSessionStateInput(session: SessionInfo, nodeId: string, input: CreateInput, ownerId: string): SessionStateInput {
  const rootKey = input.rootKey || "personal";
  const subpath = input.subpath || null;
  const projectId = session.projectId || input.projectId || null;
  return {
    id: session.id, owner: ownerId, label: session.label || input.label || null,
    harness: session.harness || input.harness || "claude", dir: session.dir || null,
    root_key: rootKey, subpath,
    flags: session.flags || {}, auto_approve: !!(session.autoApprove ?? input.autoApprove),
    invites: Array.isArray(session.invites) ? session.invites : [],
    project_id: projectId, project_src: projectId ? (input.projectSrc === "org" ? "org" : "v6") : null,
    read_only: !!input.readOnly, incognito: !!input.incognito,
    write_vis: input.writeVis ?? null, restrict_read: !!input.restrictRead,
    created: session.created || Math.floor(Date.now() / 1000), last_busy: null,
    node_id: nodeId,
    app_id: input.appId || null,
  };
}

/** 노드 create 릴레이 직후 — 행을 쓴다(best-effort). 실패해도 세션은 떠 있다(로그만). */
export async function mirrorNodeSession(session: SessionInfo, nodeId: string, input: CreateInput, ownerId: string): Promise<void> {
  try { await upsertSessionState(nodeSessionStateInput(session, nodeId, input, ownerId)); }
  catch (e) { logger.warn({ err: e, id: session.id, node: nodeId }, "노드 세션 desired-state 기록 실패(비치명 — 이 세션은 죽으면 복원 카드가 안 남는다)"); }
}

// ── 노드가 **스스로** 띄운 세션도 기억한다(#2022) ──────────────────────────────
//  #1791 이 채운 건 "게이트웨이가 create 를 릴레이한 노드 세션"까지다. 그런데 노드 에이전트는 3초마다
//  **자기 tmux 의 box-* 세션을 전부** 밀어 올린다(agent.ts listSessionsRaw) — 그 컴퓨터에서 사람이 직접 띄운
//  세션도 그 안에 있고, 그건 create 릴레이를 안 탔으니 행이 없다. 그래서:
//   · 그 노드가 꺼지면 스냅샷이 끊긴다 → 라이브 목록에도, 복원 목록에도 없다 = **어디에도 없는 세션**.
//   · 게이트웨이가 재배포되면 메모리 스냅샷이 비어 같은 상태가 된다(노드가 다시 붙을 때까지).
//   · 세션 창(app_instance)에 실어 보내는 정본(subject_label·subject_project_id)도 재료가 없어 비어 나간다.
//  ⇒ 처음 보는 id 는 그 자리에서 행을 적는다. **좌표(root_key·subpath)는 비운다** — 노드는 dir(제 파일시스템의
//   절대경로)만 보고하고, 그걸 좌표로 되돌리려면 그 노드의 루트 설정을 알아야 하는데 게이트웨이엔 없다.
//   대신 `discovered=true` 로 박아 **복원이 좌표를 추측하지 않게** 한다(terminal/routes.ts 가 거절한다).
//   '보이게 하는 것'과 '되살릴 수 있다고 말하는 것'은 다르다 — 앞의 것만 한다.
//
//  ⚠ 3초마다 DB 를 묻지 않는다: 이 프로세스가 이미 본 id 는 메모리에 남겨 두고, **처음 보는 id 가 있을 때만**
//   한 번의 일괄 조회를 한다. 정상 상태(새 세션 없음)에선 쿼리가 0 이다.
const seenNodeSessions = new Set<string>();

/** 스냅샷 한 판 — 처음 보는 세션만 골라 행을 적는다. best-effort(실패해도 다음 push 가 다시 본다). */
export async function discoverNodeSessions(nodeId: string, sessions: SessionInfo[]): Promise<number> {
  // ★ #2592 — 셀프 노드의 스냅샷은 **발견이 아니다.** 그 세션들은 게이트웨이 자신의 tmux 에 있는 중앙 세션이고,
  //  중앙 경로가 만든 것이면 이미 정확한 좌표를 가진 행이 있다. 여기서 적으면 «좌표 미상 + node_id=그 노드» 라는
  //  거짓 행이 생기고, 그건 되살릴 수 없는 채로 사이드바에 영원히 남는다(discovered 행은 복원 거절 — routes.ts).
  //  dev 실측(2026-09-03): 그렇게 쌓인 행 286개 중 72개가 «복원 불가 노드 세션» 으로 목록에 남아 있었다.
  //  판정이 서기 전 첫 스냅샷도 새지 않는다 — registry.applyState 가 판정 완결 뒤에 이 구독자를 부른다.
  if (isSelfNode(nodeId)) return 0;
  const fresh = sessions.filter((s) => s && s.id && !seenNodeSessions.has(s.id));
  if (!fresh.length) return 0;
  let wrote = 0;
  try {
    const have = await getSessionStates(fresh.map((s) => s.id));
    for (const s of fresh) {
      seenNodeSessions.add(s.id);          // 있든 없든 이 판에서 확인했다 — 다시 묻지 않는다
      if (have.has(s.id)) continue;
      const owner = String(s.owner || "").trim();
      if (!owner) continue;                // 주인을 모르는 행은 적지 않는다(가시성 판정의 재료가 owner 다)
      const ok = await insertDiscoveredSessionState({
        id: s.id, owner, label: s.label || null, harness: s.harness || "claude", dir: s.dir || null,
        root_key: null, subpath: null,     // ★ 모른다 — 추측하지 않는다(위 주석)
        flags: s.flags || {}, auto_approve: !!s.autoApprove,
        invites: Array.isArray(s.invites) ? s.invites : [],
        project_id: s.projectId || null, project_src: s.projectId ? "v6" : null,
        read_only: false, incognito: false, write_vis: null, restrict_read: false,
        created: s.created || Math.floor(Date.now() / 1000), last_busy: null,
        node_id: nodeId, app_id: s.appId || null,
      });
      if (ok) wrote++;
    }
  } catch (e) {
    for (const s of fresh) seenNodeSessions.delete(s.id);   // 실패한 판은 안 본 것으로 — 다음 push 가 다시 본다
    logger.warn({ err: e, node: nodeId }, "노드 세션 발견 기록 실패(비치명 — 다음 상태 보고에 재시도)");
    return 0;
  }
  if (wrote) logger.info({ node: nodeId, wrote }, "노드가 직접 띄운 세션을 desired-state 에 기록(좌표 미상)");
  return wrote;
}

/** 부팅 때 한 번 — 노드 상태 push 를 구독한다(registry 는 DB 를 모르므로 이쪽에서 건다). */
export function armNodeSessionDiscovery(): void {
  onNodeSessions((nodeId, sessions) => { void discoverNodeSessions(nodeId, sessions); });
  // #2592 — 판정이 **새로 설 때** 그 노드 이름으로 쌓인 거짓 좌표를 치운다. 부팅 훅이 아닌 이유: 판정은
  //  관측이라(같은 tmux 를 봐야 성립) 부팅 시점엔 아직 없다. 멱등이라 게이트웨이가 재배포될 때마다 다시 돌아도 무해.
  onSelfNodeJudged((nodeId) => cleanupSelfNodeRows(nodeId));
}

/**
 * 셀프 노드로 판정된 노드의 기존 행 정리(#2592). **살아 있는 세션 목록을 확답으로 얻었을 때만** 돈다 —
 *  tmux 를 못 본 판을 '세션 0' 으로 읽으면 살아 있는 세션의 행까지 삭제 갈래로 몰린다(clearSelfNodeSessionRows 계약).
 */
export async function cleanupSelfNodeRows(nodeId: string): Promise<void> {
  let liveIds: Set<string>;
  try {
    const { listSessionsRaw } = await import("./sessions.js");
    liveIds = new Set((await listSessionsRaw({ strict: true })).map((s) => s.id));
  } catch (e) {
    logger.warn({ err: e, node: nodeId }, "셀프 노드 기존 행 정리 보류 — 지금 살아 있는 세션을 확인하지 못했다(다음 판정에 재시도)");
    return;
  }
  try {
    const r = await clearSelfNodeSessionRows(nodeId, liveIds);
    if (r.deleted || r.cleared) {
      logger.warn({ node: nodeId, ...r }, `셀프 노드가 남긴 세션 행을 정리했습니다 — ${selfNodeMessage(nodeId)}`);
    }
  } catch (e) {
    logger.warn({ err: e, node: nodeId }, "셀프 노드 기존 행 정리 실패(비치명 — 다음 판정에 재시도)");
  }
}

/**
 * 복원 목록의 노드 행 보강 — listRestorableSessions 는 node_id 만 알아 `{id, name:id, online:false}` 자리표시자를 싣는다
 *  (그 모듈은 노드 번들에도 들어가 레지스트리를 못 본다). 여기서 레지스트리(연결·스냅샷)와 DB(이름)로 채운다. 제자리 수정.
 */
export async function decorateNodeRows(rows: SessionInfo[]): Promise<void> {
  // #2592 — **먼저** 거짓 좌표를 턴다. 이 행들의 좌표는 라이브 스냅샷이 아니라 DB(org_session_state.node_id)에서
  //  오므로, 아래 마이그레이션이 돌기 전(또는 다른 게이트웨이가 쓴 행)에는 셀프 노드 id 가 그대로 실려 온다.
  //  좌표가 붙은 채로 나가면 화면이 `&node=` 로 붙어 릴레이 경로를 다시 연다 — 목록만 고치고 여기를 빼면 새는 자리다.
  for (const r of rows) if (r.node && isSelfNode(r.node.id)) delete r.node;
  const need = rows.filter((r) => r.node && r.restorable);
  if (!need.length) return;
  const live = new Map(liveNodes().map((n) => [n.id, n]));
  let db: Map<string, { name: string }> | null = null;
  for (const r of need) {
    const id = r.node!.id;
    const l = live.get(id);
    if (l) { r.node = { id, name: l.name || id, online: l.online }; continue; }
    if (!db) db = new Map((await listNodes().catch(() => [])).map((n) => [n.id, { name: n.name }]));
    r.node = { id, name: db.get(id)?.name || id, online: false };
  }
}
