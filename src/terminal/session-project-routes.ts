// 세션 프로젝트 소속 바꾸기 — REST (#1719 홈 입력창: "일단 프로젝트 없이 열고, 언제든 붙인다").
//  POST /api/ui/terminal/sessions/:id/project  { projectId: number | null }   (null·0 = 뗀다)
//
//  정책은 여기(게이트웨이)가 정하고 실행은 세션이 사는 곳이 한다(F7):
//   · 소유자만 바꾼다(applySessionProject 가 @box_owner 로 한 번 더 막는다).
//   · 붙일 프로젝트는 **내 프로젝트**(생성자·팀원 = 사이드바 '내 프로젝트'와 같은 집합)여야 한다 — 남의 프로젝트에 내 세션을
//     매달아 그 프로젝트의 타임라인·세션 목록에 끼어드는 걸 막는다.
//   · 로컬(이 게이트웨이의 tmux) 세션은 session-project.applySessionProject, 노드(멤버 PC) 세션은 setProject op 로 릴레이.
//   · DB 는 게이트웨이만: session_project 시간구간(recordSessionProject) + desired-state 미러(복원이 @box_project 를 되살리게).
import type express from "express";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { itemsPool } from "../db/client.js";
import { isProjectMember, recordSessionProject } from "../v6/project-session-store.js";
import { updateSessionStateMeta } from "../sessions/session-state.js";
import { nodeOfSession, nodeRpc } from "../node/registry.js";
import { translateNodeRpcError } from "../node/rpc-error.js";
import { applySessionProject, type SessionProjectBind } from "./session-project.js";

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** v6 프로젝트(level=project) 한 건 — 붙일 대상의 이름·폴더. 없으면 null. */
async function loadProject(id: number): Promise<{ id: number; name: string; folder: string } | null> {
  const r = await itemsPool.query(`SELECT id, name, COALESCE(folder,'') AS folder FROM project WHERE id=$1 AND level='project' LIMIT 1`, [id]);
  const row = r.rows[0] as { id: number; name: string; folder: string } | undefined;
  return row ? { id: Number(row.id), name: String(row.name || ""), folder: String(row.folder || "") } : null;
}

export function registerSessionProjectRoutes(app: express.Express, auth: express.RequestHandler): void {
  app.post("/api/ui/terminal/sessions/:id/project", auth, wrap(async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!SID_RE.test(id)) throw new HttpError(400, "세션 id 형식 오류");
    const u = userOf(req); const me = idOf(u);
    if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const pid = raw.projectId === null || raw.projectId === undefined || raw.projectId === "" ? 0 : Number(raw.projectId);
    if (!Number.isInteger(pid) || pid < 0) throw new HttpError(400, "projectId 형식 오류");

    let bind: SessionProjectBind | null = null;
    if (pid > 0) {
      const p = await loadProject(pid);
      if (!p) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
      if (!(await isProjectMember(pid, me))) throw new HttpError(403, "내 프로젝트(생성자·팀원)에만 붙일 수 있어요");
      bind = { projectId: p.id, folder: p.folder, name: p.name, src: "v6" };
    }

    const nodeId = nodeOfSession(id);
    let out: { ok: true; projectId: number | null; linked: boolean; projectDir: string | null; sessionDir: boolean };
    if (nodeId) {
      try { out = await nodeRpc(nodeId, "setProject", { id, user: { userId: me }, bind }); }
      catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        throw translateNodeRpcError(msg, {
          offline: "그 컴퓨터가 지금 연결돼 있지 않습니다.",
          timeout: "그 컴퓨터가 응답하지 않습니다.",
          unsupported: () => "그 컴퓨터의 라이블리가 오래돼 세션의 프로젝트를 바꾸지 못합니다. 업데이트가 필요합니다.",
          failed: (m) => `그 컴퓨터에서 적용 실패: ${m}`,
        });
      }
    } else {
      out = await applySessionProject(u, id, bind);
    }
    // DB(게이트웨이만) — 시간구간 기록(붙일 때만; 뗌은 구간 모델에 없다 — 과거 귀속은 그대로 남는다) + 복원용 미러.
    if (bind) await recordSessionProject(id, bind.projectId).catch(() => { /* 비치명 */ });
    await updateSessionStateMeta(id, { project_id: bind ? bind.projectId : null, project_src: bind ? "v6" : null }).catch(() => { /* 레코드 없음 등 비치명 */ });
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  }));
}
