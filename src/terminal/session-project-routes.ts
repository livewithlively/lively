// 세션 프로젝트 소속 바꾸기 — 코어 로직 (#1719 홈 입력창: "일단 프로젝트 없이 열고, 언제든 붙인다").
//  노출은 capability session_set_project(capabilities/session-project.ts) — MCP + REST 아래 경로 co-exposed(#1798 후속).
//  POST /api/ui/terminal/sessions/:id/project  { projectId: number | null }   (null·0 = 뗀다)
//
//  정책은 여기(게이트웨이)가 정하고 실행은 세션이 사는 곳이 한다(F7):
//   · 소유자만 바꾼다. 관리형 세션은 tmux/desired-state owner를, 외부 실행은 인증 헤더의 자기 id를 확인한다.
//   · 붙일 프로젝트는 **내가 볼 수 있는 프로젝트**(공개범위 밖·긴급열람 제외 = hiddenProjects 아님)면 된다 — 프로젝트 세션의
//     생성·입장이 이미 전원 개방(#452 — project-routes POST /:id/sessions 에 멤버십 게이트가 없다)이라, 바인딩만 멤버로
//     좁히면 "그 프로젝트 폴더에서 세션을 여는 건 되는데 내 세션을 붙이는 건 안 되는" 비대칭이 생긴다. 같은 게이트를 쓴다.
//   · DB execution_session이 현재 소속의 SoT다. session_project는 전환·해제 이력이고 tmux @box_project는 실행 캐시다.
//   · 로컬(이 게이트웨이의 tmux) 세션은 session-project.applySessionProject, 노드(멤버 PC) 세션은 setProject op 로 릴레이.
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { itemsPool } from "../db/client.js";
import { hiddenProjects } from "../v6/visibility.js";
import { getSessionState, updateSessionStateMeta } from "../sessions/session-state.js";
import { nodeOfSession, nodeRpc } from "../node/registry.js";
import { translateNodeRpcError } from "../node/rpc-error.js";
import { applySessionProject, type SessionProjectBind } from "./session-project.js";
import { ensureAgentsMd } from "../v6/agents-md.js";
import { projectAbsPath } from "../project/project-fs.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { getOpt } from "./tmux-exec.js";
import { executionSessionProject, markExecutionSessionApplied, setExecutionSessionProject } from "../v6/execution-session-store.js";
import { syncSessionAppInstanceProject } from "../org/store/app-instances.js";

const idOf = (u: LivelyUser): string => u.userId || u.email || "";
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** 동적 주입으로 보낼 AGENTS.md 상한. */
const AGENTS_MD_MAX = 128 * 1024;

/** 이 프로젝트의 AGENTS.md 전문(#1856). 프로젝트가 소유한 생성물만 최신화해 읽고 세션 cwd는 건드리지 않는다. */
async function projectAgentsMd(id: number, folder: string): Promise<string | null> {
  if (!folder) return null;
  try {
    await ensureAgentsMd(id).catch(() => { /* 생성 실패해도 기존 파일이 있으면 읽는다 */ });
    const body = await fsp.readFile(path.join(projectAbsPath(folder), "AGENTS.md"), "utf8");
    return body.length > AGENTS_MD_MAX ? null : body;
  } catch { return null; }
}

/** v6 프로젝트(level=project) 한 건 — 붙일 대상의 이름·폴더. 없으면 null. */
async function loadProject(id: number): Promise<{ id: number; name: string; folder: string } | null> {
  const r = await itemsPool.query(`SELECT id, name, COALESCE(folder,'') AS folder FROM project WHERE id=$1 AND level='project' LIMIT 1`, [id]);
  const row = r.rows[0] as { id: number; name: string; folder: string } | undefined;
  return row ? { id: Number(row.id), name: String(row.name || ""), folder: String(row.folder || "") } : null;
}

/** 세션↔프로젝트 소속 변경의 단일 구현 — capability `session_set_project`(capabilities/session-project.ts)가
 *  MCP + REST(POST /api/ui/terminal/sessions/:id/project) 양면으로 노출한다(#1798 후속 — 종전 순수 라우트를 capability 로 접음).
 *  pidRaw: null·undefined·""·0 = 뗌, 양의 정수 = 그 프로젝트로. */
export async function setSessionProject(
  u: LivelyUser, id: string, pidRaw: unknown,
  opts: { externalSelf?: boolean; harness?: string | null } = {},
): Promise<{ ok: true; projectId: number | null; linked: boolean; projectDir: string | null; sessionDir: boolean; revision: number; bindingEpoch: number }> {
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
    // 바인딩은 DB current + 실행 캐시만 바꾼다. AGENTS.md 준비/읽기는 다음 UserPromptSubmit의 동적 조회가 맡는다.
    bind = { projectId: p.id, folder: p.folder, name: p.name, src: "v6" };
  }

  const nodeId = nodeOfSession(id);
  // 분산 적용 전에 소유권을 먼저 확정한다. DB가 SoT이므로 runtime 캐시를 먼저 바꾸고 DB 기록에 실패하는
  // 순서를 허용하지 않는다. 반대로 desired-state가 없는 노드 세션 id를 먼저 DB에 claim하게 두면, 남의 실제
  // 세션을 겨냥한 요청이 RPC에서 거부되더라도 DB id는 공격자 소유로 남는다. 그래서 상태 부재도 쓰기 전에 막는다.
  if (nodeId) {
    const state = await getSessionState(id).catch(() => undefined);
    if (!state) throw new HttpError(404, "세션을 찾을 수 없습니다");
    if (state.owner !== me) throw new HttpError(403, "내 세션만 프로젝트를 바꿀 수 있습니다");
  } else {
    const localOwner = await getOpt(id, "@box_owner").catch(() => "");
    if (localOwner && localOwner !== me) throw new HttpError(403, "내 세션만 프로젝트를 바꿀 수 있습니다");
    if (!localOwner && !opts.externalSelf) throw new HttpError(404, "세션을 찾을 수 없습니다");
  }

  // DB desired를 먼저 커밋한다. 아래 분산 적용이 실패하면 desired_revision > applied_revision으로 남아
  // 다음 동적 주입은 올바른 프로젝트를 보고, 운영자는 미적용 상태를 진단·재시도할 수 있다.
  const current = await setExecutionSessionProject({ id, owner: me, harness: opts.harness, nodeId, projectId: bind ? bind.projectId : null });
  if (!current) throw new HttpError(403, "다른 사용자의 실행 세션 id입니다");

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
    const localOwner = await getOpt(id, "@box_owner").catch(() => "");
    if (localOwner) out = await applySessionProject(u, id, bind);
    else if (opts.externalSelf) out = { ok: true, projectId: bind ? bind.projectId : null, linked: false, projectDir: null, sessionDir: false };
    else throw new HttpError(404, "세션을 찾을 수 없습니다"); // 위 선검사의 TOCTOU(세션 종료)만 여기로 온다.
  }
  await markExecutionSessionApplied(id, me, current.desired_revision);
  await updateSessionStateMeta(id, { project_id: bind ? bind.projectId : null, project_src: bind ? "v6" : null }).catch(() => { /* 레코드 없음 등 비치명 */ });
  // 세션 화면은 ai-session AppInstance다. 세션 바인딩이 권위이므로 열린/복원 인스턴스의 현재 맥락도 같은 값으로 맞춘다.
  // 시간 이력은 app-instances 스토어가 별도로 남겨, 옮긴 뒤에도 과거 활동의 소속을 소급 변경하지 않는다.
  await syncSessionAppInstanceProject(id, bind ? bind.projectId : null).catch(() => { /* UI 메타데이터 실패는 세션 바인딩을 되돌리지 않는다 */ });
  return { ...out, revision: current.desired_revision, bindingEpoch: current.binding_epoch };
}

/** 동적 AGENTS 주입용 단일 조회. cwd를 전혀 받지 않으며 실행 세션 id와 DB current binding만 본다.
 *  조회만으로 applied_revision을 올리지 않는다 — 훅이 stdout 전달을 끝낸 뒤 별도 ACK한다. */
export async function sessionProjectContext(
  u: LivelyUser, id: string, knownRevisionRaw?: unknown,
): Promise<{ found: boolean; changed: boolean; session_id: string; project_id: number | null; revision: number; applied_revision: number; binding_epoch: number; name?: string; content?: string }> {
  if (!SID_RE.test(id)) throw new HttpError(400, "세션 id 형식 오류");
  const me = idOf(u);
  if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
  const known = knownRevisionRaw == null || knownRevisionRaw === "" ? -1 : Number(knownRevisionRaw);
  if (!Number.isSafeInteger(known) || known < -1) throw new HttpError(400, "knownRevision 형식 오류");
  const current = await executionSessionProject(id, me);
  if (!current) return { found: false, changed: known !== 0, session_id: id, project_id: null, revision: 0, applied_revision: 0, binding_epoch: 0 };
  const base = {
    found: true, changed: known !== current.desired_revision, session_id: id, project_id: current.project_id,
    revision: current.desired_revision, applied_revision: current.applied_revision, binding_epoch: current.binding_epoch,
  };
  if (!base.changed) return base;
  if (current.project_id == null) return base;
  const project = await loadProject(current.project_id);
  if (!project) return { ...base, project_id: null };
  const content = await projectAgentsMd(project.id, project.folder);
  if (content == null) throw new HttpError(503, "프로젝트 AGENTS.md를 준비하지 못했습니다");
  return { ...base, name: project.name, content };
}

/** 훅이 동적 문맥(또는 detach 무효화)을 stdout에 넘긴 뒤 보내는 전달 확인. */
export async function acknowledgeSessionProjectContext(
  u: LivelyUser, id: string, revisionRaw: unknown,
): Promise<{ ok: true; revision: number; desired_revision: number }> {
  if (!SID_RE.test(id)) throw new HttpError(400, "세션 id 형식 오류");
  const me = idOf(u);
  if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
  const revision = Number(revisionRaw);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400, "revision 형식 오류");
  const current = await executionSessionProject(id, me);
  if (!current) throw new HttpError(404, "실행 세션을 찾을 수 없습니다");
  if (revision > current.desired_revision) throw new HttpError(409, "아직 존재하지 않는 revision입니다");
  await markExecutionSessionApplied(id, me, revision);
  return { ok: true, revision, desired_revision: current.desired_revision };
}
