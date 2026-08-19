// 세션 프로젝트 소속 바꾸기 — 코어 로직 (#1719 홈 입력창: "일단 프로젝트 없이 열고, 언제든 붙인다").
//  노출은 capability session_set_project(capabilities/session-project.ts) — MCP + REST 아래 경로 co-exposed(#1798 후속).
//  POST /api/ui/terminal/sessions/:id/project  { projectId: number | null }   (null·0 = 뗀다)
//
//  정책은 여기(게이트웨이)가 정하고 실행은 세션이 사는 곳이 한다(F7):
//   · 소유자만 바꾼다(applySessionProject 가 @box_owner 로 한 번 더 막는다).
//   · 붙일 프로젝트는 **내가 볼 수 있는 프로젝트**(공개범위 밖·긴급열람 제외 = hiddenProjects 아님)면 된다 — 프로젝트 세션의
//     생성·입장이 이미 전원 개방(#452 — project-routes POST /:id/sessions 에 멤버십 게이트가 없다)이라, 바인딩만 멤버로
//     좁히면 "그 프로젝트 폴더에서 세션을 여는 건 되는데 내 세션을 붙이는 건 안 되는" 비대칭이 생긴다. 같은 게이트를 쓴다.
//   · 로컬(이 게이트웨이의 tmux) 세션은 session-project.applySessionProject, 노드(멤버 PC) 세션은 setProject op 로 릴레이.
//   · DB 는 게이트웨이만: session_project 시간구간(recordSessionProject) + desired-state 미러(복원이 @box_project 를 되살리게).
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { itemsPool } from "../db/client.js";
import { recordSessionProject } from "../v6/project-session-store.js";
import { hiddenProjects } from "../v6/visibility.js";
import { updateSessionStateMeta } from "../sessions/session-state.js";
import { nodeOfSession, nodeRpc } from "../node/registry.js";
import { translateNodeRpcError } from "../node/rpc-error.js";
import { applySessionProject, type SessionProjectBind } from "./session-project.js";

const idOf = (u: LivelyUser): string => u.userId || u.email || "";
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** v6 프로젝트(level=project) 한 건 — 붙일 대상의 이름·폴더. 없으면 null. */
async function loadProject(id: number): Promise<{ id: number; name: string; folder: string } | null> {
  const r = await itemsPool.query(`SELECT id, name, COALESCE(folder,'') AS folder FROM project WHERE id=$1 AND level='project' LIMIT 1`, [id]);
  const row = r.rows[0] as { id: number; name: string; folder: string } | undefined;
  return row ? { id: Number(row.id), name: String(row.name || ""), folder: String(row.folder || "") } : null;
}

/** 세션↔프로젝트 소속 변경의 단일 구현 — capability `session_set_project`(capabilities/session-project.ts)가
 *  MCP + REST(POST /api/ui/terminal/sessions/:id/project) 양면으로 노출한다(#1798 후속 — 종전 순수 라우트를 capability 로 접음).
 *  pidRaw: null·undefined·""·0 = 뗌, 양의 정수 = 그 프로젝트로. 소유권은 applySessionProject(@box_owner)/노드가 집행. */
export async function setSessionProject(u: LivelyUser, id: string, pidRaw: unknown): Promise<{ ok: true; projectId: number | null; linked: boolean; projectDir: string | null; sessionDir: boolean }> {
  if (!SID_RE.test(id)) throw new HttpError(400, "세션 id 형식 오류");
  const me = idOf(u);
  if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
  const pid = pidRaw === null || pidRaw === undefined || pidRaw === "" ? 0 : Number(pidRaw);
  if (!Number.isInteger(pid) || pid < 0) throw new HttpError(400, "projectId 형식 오류");

  let bind: SessionProjectBind | null = null;
  if (pid > 0) {
    const p = await loadProject(pid);
    if (!p) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
    // 공개범위(#1291) — 내가 못 보는 프로젝트엔 못 붙인다(붙이면 사이드바·타임라인에서 그 이름이 새어 나온다). 판정 불가면 거부(fail-closed).
    const hidden = await hiddenProjects(me).catch(() => null);
    if (!hidden || hidden.ids.has(pid)) throw new HttpError(403, "이 프로젝트에는 붙일 수 없어요(공개범위 밖입니다)");
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
  return out;
}

