// #1791 — **노드 세션의 desired-state 를 게이트웨이가 소유한다**(org_session_state.node_id).
//
// 왜: 노드 세션(멤버 PC·워커·매니지드 실행환경)은 노드 에이전트가 만드는데 노드엔 DB 가 없어 desired-state 행이 없었다.
//  그 tmux/psmux 가 죽으면 노드의 3초 상태 push 에서 빠지는 순간 **어디에도 흔적이 없어** 웹은 "세션을 찾을 수 없어요"
//  로 끝났다(2026-08-18 hammurabi — 세션 5개 동시 사망, 복원 카드조차 없음). #1059 E 가 정한 "DB = desired, 실행 표면 =
//  observed" 가 노드 세션에만 안 닿아 있던 갭이다.
// 어떻게: 게이트웨이가 노드 create 릴레이에 **성공한 직후** 행을 쓴다(노드는 DB 를 모른다 — session-state.ts ON_NODE).
//  행의 좌표(root_key·subpath)는 노드의 createSession 이 쓰는 규칙과 **같은 식**으로 게이트웨이가 계산한다
//  (sessions.ts createSession: sessionDir 이면 rootKey||personal + sessions/<id>) — 복원이 그 노드에 같은 좌표로 create 를
//  다시 릴레이한다. best-effort: 행을 못 써도 세션은 이미 떠 있다(박스 세션 미러와 같은 규약).
// 이 모듈은 **게이트웨이 전용**이다 — node/registry(WS 서버)를 import 하므로 노드 에이전트 번들에 들어가면 안 된다
//  (sessions.ts 가 이걸 import 하지 않는 이유. routes 가 부른다).
import type { CreateInput, SessionInfo } from "./catalog.js";
import { SESSION_DIR_SUBDIR } from "./session-project.js";
import { upsertSessionState, type SessionStateInput } from "../sessions/session-state.js";
import { liveNodes } from "../node/registry.js";
import { listNodes } from "../node/store.js";
import { logger } from "../log.js";

/**
 * 순수 — 노드 create 릴레이 결과(session) + 그 요청 입력(input) → desired-state 행.
 *  · id·label·harness·dir·flags·invites·created 는 노드가 실제로 적용한 값(응답)을 쓴다 — 요청과 다를 수 있다(라벨 기본값·플래그 화이트리스트).
 *  · root_key/subpath 는 노드가 안 돌려주므로 createSession 과 같은 규칙으로 계산한다(세션 전용 폴더 = sessions/<id>).
 *  · project_id 는 응답 우선(노드가 폴더로 판정), 없으면 요청값.
 */
export function nodeSessionStateInput(session: SessionInfo, nodeId: string, input: CreateInput, ownerId: string): SessionStateInput {
  const rootKey = input.sessionDir ? (input.rootKey || "personal") : (input.rootKey || null);
  const subpath = input.sessionDir ? `${SESSION_DIR_SUBDIR}/${session.id}` : (input.subpath || null);
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

/**
 * 복원 목록의 노드 행 보강 — listRestorableSessions 는 node_id 만 알아 `{id, name:id, online:false}` 자리표시자를 싣는다
 *  (그 모듈은 노드 번들에도 들어가 레지스트리를 못 본다). 여기서 레지스트리(연결·스냅샷)와 DB(이름)로 채운다. 제자리 수정.
 */
export async function decorateNodeRows(rows: SessionInfo[]): Promise<void> {
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
