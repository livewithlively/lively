// 세션 휴지통 라우트(#1851) — POST /api/ui/terminal/session-trash {op, ids}
//
//  흐름(원준 2026-08-23): 도는 세션 → ×(지난 세션으로, DELETE ?reclaim=1) → 지난 세션에서 휴지통 → **휴지통 안에서만**
//  완전 삭제(종전 '완전 삭제' ×)·비우기. 종전엔 지난 세션 행의 × 가 곧바로 desired-state 를 지웠다(되돌릴 수 없고, 중앙 기록
//  행이 '기록'으로 다시 떠올랐다). 이 라우트가 그 한 단계를 둘로 가른다.
//   · trash   — 휴지통으로. 도는 세션은 거부(먼저 ×로 멈춰야 한다 — 휴지통은 '지난 세션'의 다음 단계다).
//   · untrash — 되돌리기(지난 세션으로 복귀).
//   · purge   — 완전 삭제: desired-state 행을 지우고(되살리기 불가) 휴지통 표식을 purged 로(목록에서 영영 빠진다).
//   · empty   — 휴지통 비우기 = 휴지통의 내 세션 전부 purge.
//  owner 게이트 — 자기 세션만(desired-state 의 owner, 중앙 기록의 owner). 남의 것이 섞여 오면 그 id 만 건너뛰고 skipped 로 알린다.
//  한 세션의 두 이름(박스 id·대화 uuid)을 **함께** 표식한다 — 프론트가 넘긴 ids 에 더해 desired-state 의 claude_session_id 도 덧붙인다.
import type express from "express";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { logger } from "../log.js";
import { listSessions, killSession, sessionGone } from "../terminal/terminal-sessions.js";
import { nodeSessionsFor, nodeRpc, nodeOnline } from "../node/registry.js";
import { getSessionState, deleteSessionState } from "./session-state.js";
import { clearSessionWorkspace } from "../org/tenancy/registry.js";
import { itemsPool } from "../db/client.js";
import { trashSessions, untrashSessions, purgeSessions, listTrashedIds, trashMarkedIds } from "./session-trash.js";

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";
const OPS = new Set(["trash", "untrash", "purge", "empty"]);

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
async function stopForPurge(u: LivelyUser, me: string, id: string, nodeId: string | null): Promise<true | string> {
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

/** id 하나를 '내 것'으로 확정하고, 같은 세션의 다른 이름(대화 uuid)까지 모은다. 내 것이 아니면 null. */
async function resolveMine(id: string, me: string): Promise<{ ids: string[]; hasState: boolean } | null> {
  const st = await getSessionState(id).catch(() => undefined);
  if (st) {
    if (st.owner !== me) return null;
    const ids = [id];
    if (st.claude_session_id) ids.push(st.claude_session_id);
    return { ids, hasState: true };
  }
  const owner = await logOwnerOf(id);
  if (owner === null) return null;     // desired-state 도 기록도 없다 — 우리가 아는 세션이 아니다
  if (owner !== me) return null;
  return { ids: [id], hasState: false };
}

export function registerSessionTrashRoutes(app: express.Express, auth: express.RequestHandler): void {
  app.post("/api/ui/terminal/session-trash", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const u = userOf(req);
    const me = idOf(u);
    if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const op = String(b.op ?? "").trim();
    if (!OPS.has(op)) throw new HttpError(400, "op 는 trash|untrash|purge|empty");
    let ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
    if (op === "empty") ids = await listTrashedIds(me);
    else if (!ids.length) throw new HttpError(400, "ids 가 필요합니다");
    if (ids.length > 500) throw new HttpError(400, "한 번에 500개까지");

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
      if (!r && marked.has(id)) r = { ids: [id], hasState: false };
      if (!r) { skipped.push({ id, why: "본인 세션이 아니거나 없는 세션" }); continue; }
      if (liveIds.has(id)) {
        // 휴지통으로 보내는 것(trash)만 거부한다 — 휴지통은 '지난 세션'의 다음 단계다. 완전 삭제는 **멈추고 지운다**.
        if (op !== "purge") { skipped.push({ id, why: "아직 돌고 있는 세션 — 먼저 지난 세션으로 보내 주세요" }); continue; }
        const st = await getSessionState(id).catch(() => undefined);
        const nodeId = st?.node_id || nodeSessionsFor(me).find((x) => x.id === id)?.node.id || null;
        const stopped = await stopForPurge(u, me, id, nodeId);
        if (stopped !== true) { skipped.push({ id, why: stopped }); continue; }
      }
      // 표식 저장소는 **바꾼 행 수**를 돌려준다 — 0 이면 한 것이 없다(이미 완전 삭제된 이름은 trash/untrash 가 건드리지 않는다).
      //  그걸 done 으로 올리면 화면이 "되돌렸어요"라고 말한다(실측: 완전 삭제한 직후 되돌리기가 done 으로 왔다).
      if (op === "trash") {
        if (!(await trashSessions(me, r.ids))) { skipped.push({ id, why: "완전 삭제된 세션은 휴지통에 다시 넣을 수 없어요" }); continue; }
      } else if (op === "untrash") {
        if (!(await untrashSessions(me, r.ids))) { skipped.push({ id, why: "이미 완전 삭제됐거나 휴지통에 없는 세션" }); continue; }
      } else {
        // 완전 삭제 — desired-state(되살리기 좌표)는 실제로 지운다. 워크스페이스 소속 맵도 함께(종전 DELETE 와 같은 뒷정리).
        if (r.hasState) {
          await deleteSessionState(id).catch((e) => logger.warn({ err: e, id }, "휴지통 완전 삭제 — desired-state 삭제 실패(비치명)"));
          void clearSessionWorkspace(id).catch(() => { /* 비치명 */ });
        }
        await purgeSessions(me, r.ids);
      }
      done.push(id);
    }
    res.json({ ok: true, op, done, skipped });
  }));
}
