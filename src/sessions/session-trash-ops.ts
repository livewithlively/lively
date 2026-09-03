// 세션 휴지통 조작의 **핵심**(#1851) — 라우트(POST /terminal/session-trash)와 프로젝트 휴지통(capabilities/projects-v6 의
//  project_trash_v6 · project_purge_v6)이 같은 함수를 부른다. 프로젝트를 통째로 버릴 때 그 아래 세션도 여기서 같은 규칙으로 들어간다.
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";
import { listSessions, killSession, sessionGone } from "../terminal/terminal-sessions.js";
import { nodeSessionsFor, nodeRpc, nodeOnline, isSelfNode } from "../node/registry.js";
import { relayNodeId } from "../node/self-node.js";   // #2592 — 셀프 노드 좌표는 릴레이 지시가 아니다
import { getSessionState, deleteSessionState, sessionStateByClaudeUuid } from "./session-state.js";
import { sessionNames, isLiveByAnyName } from "./session-names.js";   // #2151 — 세션의 두 이름(박스 id·대화 uuid)을 재는 규칙
import { closeSessionAppInstances } from "../org/store/app-instances.js";   // #2022 — 완전 삭제한 세션의 앱 인스턴스도 함께 닫는다(안 닫으면 좌측 목록에 유령 행이 남는다)
import { clearSessionWorkspace } from "../org/tenancy/registry.js";
import { itemsPool } from "../db/client.js";
import { trashSessions, untrashSessions, purgeSessions, trashMarkedIds } from "./session-trash.js";

export type TrashOp = "trash" | "untrash" | "purge" | "empty";
export interface TrashOutcome { done: string[]; skipped: Array<{ id: string; why: string }> }

// 중앙 기록(session 표)의 소유자 — 노드 무관(uuid 는 전역 유일). 없으면 null(기록 없는 id).
async function logOwnerOf(sessionId: string): Promise<string | null> {
  try {
    const r = await itemsPool.query(`SELECT owner FROM session WHERE session_id=$1 LIMIT 1`, [sessionId]);
    return (r.rows[0]?.owner as string | null) ?? null;
  } catch { return null; }
}

/** 완전 삭제 직전 — 돌고 있는 세션을 멈춘다(× 와 같은 동작, DELETE /terminal/sessions/:id 의 kill 경로를 따른다).
 *  왜 여기서 하나(원준 2026-08-24): 휴지통에 넣은 세션을 제목 클릭으로 열면 되살아나는데(#1820 '열면 살아난다'), 휴지통엔
 *  × 버튼이 없어 "먼저 지난 세션으로 보내 주세요"를 따를 길이 없었다. 완전 삭제는 '멈추고 지운다'가 맞다.
 *  반환: true=멈췄거나 이미 멈춰 있음 · string=못 멈춘 이유(그 id 는 건너뛴다). 노드가 꺼져 있으면 tmux 는 못 건드리지만
 *  × 의 기본(완전 삭제) 경로와 같은 규칙으로 진행한다 — 표식이 purged 면 그 노드가 돌아와 다시 보고해도 이 사람 목록엔 안 뜬다. */
export async function stopForPurge(u: LivelyUser, me: string, id: string, nodeId: string | null): Promise<true | string> {
  if (nodeId) {
    if (!nodeOnline(nodeId)) return true;
    const gone = await nodeRpc<boolean>(nodeId, "gone", { id }).catch(() => null);
    if (gone === true) return true;
    try { await nodeRpc(nodeId, "kill", { user: { userId: me }, id }); return true; }
    catch (e) {
      const goneNow = await nodeRpc<boolean>(nodeId, "gone", { id }).catch(() => null);
      return goneNow === true ? true : `돌고 있는 세션을 멈추지 못했어요 — ${(e as Error)?.message ?? e}`;
    }
  }
  if (await sessionGone(id).catch(() => true)) return true;
  try { await killSession(u, id, { preserveState: true }); return true; }
  catch (e) { return `돌고 있는 세션을 멈추지 못했어요 — ${(e as Error)?.message ?? e}`; }
}

/** id 하나를 '내 것'으로 확정하고, 같은 세션의 다른 이름(대화 uuid)까지 모은다. 내 것이 아니면 null.
 *  boxId = 그 세션의 desired-state 행 id(모르면 null). **라이브 판정·멈춤·행 삭제는 전부 이 이름으로 한다** —
 *  호출자가 손에 든 id 는 대화 uuid 일 수 있고(중앙 기록 목록이 주는 이름), tmux·노드는 그 이름을 모른다(#2151). */
async function resolveMine(id: string, me: string): Promise<{ ids: string[]; hasState: boolean; boxId: string | null } | null> {
  const st = await getSessionState(id).catch(() => undefined);
  if (st) {
    if (st.owner !== me) return null;
    return { ids: sessionNames(id, st.id, st.claude_session_id), hasState: true, boxId: st.id };
  }
  // #2151 — id 가 **대화 uuid** 면 desired-state 는 그 이름으로 안 찾아진다(행의 키는 박스 id). 훅이 보고한
  //  매핑을 거꾸로 타 그 박스를 찾는다. 이게 없으면 박스를 못 찾아 ① 라이브인데 안 돌고 있다고 읽고
  //  ② 표식을 대화 uuid 한쪽에만 붙이고 ③ 완전 삭제 때 desired-state 행을 고아로 남긴다(전부 실측).
  const byUuid = await sessionStateByClaudeUuid(id).catch(() => undefined);
  if (byUuid) {
    if (byUuid.owner !== me) return null;
    return { ids: sessionNames(id, byUuid.id, byUuid.claude_session_id), hasState: true, boxId: byUuid.id };
  }
  const owner = await logOwnerOf(id);
  if (owner === null) return null;     // desired-state 도 기록도 없다 — 우리가 아는 세션이 아니다
  if (owner !== me) return null;
  return { ids: [id], hasState: false, boxId: null };
}


/**
 * 세션 여러 개에 휴지통 조작 하나를 적용한다.
 *  · trash   — 휴지통으로. 기본은 **도는 세션 거부**(휴지통은 '지난 세션'의 다음 단계). opts.stopLive 면 멈추고 넣는다 —
 *              프로젝트를 통째로 버릴 때(원준 2026-08-24: "지난 세션으로 이동하는 거 없이 바로 휴지통으로"). opts.projectId 는 묶음 표식.
 *  · untrash — 되돌리기. · purge/empty — 완전 삭제(멈추고 지운다).
 *  결과는 done/skipped — 못 한 이름은 예외가 아니라 skipped(이유) 로 돌아온다. 호출자는 반드시 읽는다.
 */
export async function applySessionTrashOp(u: LivelyUser, me: string, op: TrashOp, ids: string[], opts: { projectId?: number | null; stopLive?: boolean } = {}): Promise<TrashOutcome> {
    // 도는 세션은 휴지통에 못 넣고 완전 삭제도 못 한다 — 먼저 ×(지난 세션으로)로 멈춰야 한다(휴지통은 '지난 세션'의 다음 단계).
    //  살아 있는 것의 판정은 라이브 목록(중앙 tmux + 노드 스냅샷). 되돌리기(untrash)는 검사할 것이 없다.
    let liveIds = new Set<string>();
    if (op !== "untrash") {
      const live = await listSessions(u).catch(() => []);
      liveIds = new Set([...live.map((s) => s.id), ...nodeSessionsFor(me).map((s) => s.id)]);
    }

    // 소유 근거 ① — **내 휴지통 표식**. 되돌리기·완전 삭제는 휴지통 안의 것에 하는 일이고, 넣을 때 이미 owner 를 확정했다.
    //  desired-state·중앙 기록은 완전 삭제 도중 먼저 사라질 수 있어(① 기록 파기 → ② 표식) 그것만 보면 ② 가 "없는 세션"으로
    //  거부된다(#1851 실측 — 화면은 그 거부를 삼키고 "지웠어요"라고 했다). 표식이 있으면 그 이름은 내 것이다.
    const marked = new Set(op === "trash" ? [] : await trashMarkedIds(me, ids));

    const done: string[] = [];
    const skipped: Array<{ id: string; why: string }> = [];
    for (const id of ids) {
      let r = await resolveMine(id, me);
      if (!r && marked.has(id)) r = { ids: [id], hasState: false, boxId: null };
      if (!r) { skipped.push({ id, why: "본인 세션이 아니거나 없는 세션" }); continue; }
      // #2151 — 라이브 판정은 이 세션의 **모든 이름**으로 잰다. 라이브 집합(tmux·노드 스냅샷)엔 박스 id 만
      //  들어 있어, 대화 uuid 로 들어온 세션은 종전에 늘 '안 돌고 있음'으로 읽혔다 → 돌고 있는 세션이
      //  멈춤도 경고도 없이 휴지통에 들어갔다(실측 2026-08-26: 대화 9a0f069a 가 그 뒤로도 계속 일했다).
      if (isLiveByAnyName(r.ids, liveIds)) {
        // 휴지통으로 보내는 것(trash)만 거부한다 — 휴지통은 '지난 세션'의 다음 단계다. 완전 삭제는 **멈추고 지운다**.
        if (op !== "purge" && !(op === "trash" && opts.stopLive)) { skipped.push({ id, why: "아직 돌고 있는 세션 — 먼저 지난 세션으로 보내 주세요" }); continue; }
        const boxId = r.boxId ?? id;   // 멈추는 것은 tmux/노드 — 그쪽이 아는 이름으로만 부른다
        const st = await getSessionState(boxId).catch(() => undefined);
        const nodeId = relayNodeId(st?.node_id, isSelfNode) || nodeSessionsFor(me).find((x) => x.id === boxId)?.node?.id || null;   // #2592 — 셀프 좌표는 중앙(tmux 직접)으로
        const stopped = await stopForPurge(u, me, boxId, nodeId);
        if (stopped !== true) { skipped.push({ id, why: stopped }); continue; }
      }
      // 표식 저장소는 **바꾼 행 수**를 돌려준다 — 0 이면 한 것이 없다(이미 완전 삭제된 이름은 trash/untrash 가 건드리지 않는다).
      //  그걸 done 으로 올리면 화면이 "되돌렸어요"라고 말한다(실측: 완전 삭제한 직후 되돌리기가 done 으로 왔다).
      if (op === "trash") {
        if (!(await trashSessions(me, r.ids, opts.projectId ?? null))) { skipped.push({ id, why: "완전 삭제된 세션은 휴지통에 다시 넣을 수 없어요" }); continue; }
      } else if (op === "untrash") {
        if (!(await untrashSessions(me, r.ids))) { skipped.push({ id, why: "이미 완전 삭제됐거나 휴지통에 없는 세션" }); continue; }
      } else {
        // 완전 삭제 — desired-state(되살리기 좌표)는 실제로 지운다. 워크스페이스 소속 맵도 함께(종전 DELETE 와 같은 뒷정리).
        if (r.hasState) {
          const boxId = r.boxId ?? id;   // #2151 — 행의 키는 박스 id. 대화 uuid 로 지우면 0행 = 고아 행이 남는다.
          await deleteSessionState(boxId).catch((e) => logger.warn({ err: e, id: boxId }, "휴지통 완전 삭제 — desired-state 삭제 실패(비치명)"));
          void clearSessionWorkspace(boxId).catch(() => { /* 비치명 */ });
        }
        // #2022 — 세션이 영영 사라졌으면 그 세션을 subject 로 쥔 앱 인스턴스도 닫는다. 안 닫으면 좌측 '열린 앱'
        //  목록에 되살릴 수도 없는 행이 `세션 <id꼬리>` · '프로젝트 없음' 으로 영영 남는다.
        for (const sid of r.ids) await closeSessionAppInstances(sid).catch((e) => logger.warn({ err: e, id: sid }, "완전 삭제 — 앱 인스턴스 닫기 실패(비치명)"));
        await purgeSessions(me, r.ids);
      }
      done.push(id);
    }
    return { done, skipped };
}
