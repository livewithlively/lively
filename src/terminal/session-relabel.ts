// 세션이 **자기 이름을 짓는다** — 서버측 실행부 (#1979 · 발의 윤상민 2026-08-25).
//
//  ── 왜 이 파일이 생겼나 ───────────────────────────────────────────────────
//  종전(#1719)엔 서버가 하네스를 **헤드리스로 따로 스폰**해 이름을 지었다(구 src/terminal/session-name-ai.ts).
//  그 스폰이 `{ ...process.env }` 로 부모 세션의 LIVELY_SESSION_ID·LIVELY_TOKEN·훅 배선을 상속했고, 시드 훅
//  `project-auto-bind`(UserPromptSubmit)가 **이름짓기 프롬프트를 사람의 첫 실질 지시로 오인**해 프로젝트를 만들어
//  부모 세션에 붙였다. 프로덕션 실측 2026-08-25 — #1946·#1957(제목이 이름짓기 프롬프트 첫 줄 그대로), 후자는
//  실사용자 세션. 무관한 세션에 #1946 의 AGENTS.md 가 주입되는 것까지 관측됐다.
//  → **이름짓기는 더 이상 '세션'이 아니다.** 이미 도는 그 세션이 자기 맥락(첫 지시 + 주입된 프로젝트 AGENTS.md)으로
//    짓고 `session_rename` 으로 등록한다. 스폰 0 = 그 오염 경로가 완화가 아니라 구조적으로 없다.
//
//  ── 이 함수의 두 가지 성격 ────────────────────────────────────────────────
//  ① **걸쇠가 먼저다.** DB 의 원자적 UPDATE(claimSessionLabel)로 "이 출처가 지금 출처를 이기나"를 판정과 동시에
//     쓴다. 졌으면 tmux 는 건드리지도 않는다 — 화면에 이름이 붙었는데 DB 는 안 바뀐 상태가 남으면 다음 복원에서
//     되돌아가 '고쳤는데 돌아온다'가 된다.
//  ② **실패를 만들지 않는다.** 진 것·죽은 세션·꺼진 노드·다듬으니 빈 이름 — 전부 `applied:false` 로 조용히 돌려준다.
//     이름은 화면 장식이다. 여기서 에러를 던지면 모델이 그걸 문제로 보고 다시 부르느라 **사용자 턴만 길어진다**
//     (이 설계의 전제가 "응답시간을 늘리지 않는다"이므로 그건 곧 설계 위반이다). 진짜로 막는 건 남의 세션뿐이다.
import { HttpError } from "../http/rest-util.js";
import type { LivelyUser } from "../context.js";
import { getSessionState, claimSessionLabel } from "../sessions/session-state.js";
import { type LabelSource } from "../sessions/session-label-source.js";
import { sessionNameFromAgent } from "./session-name.js";
import { nodeOfSession, nodeRpc } from "../node/registry.js";
import { getOpt, tmux } from "./tmux-exec.js";
import { renameShellProjectForSession } from "../project/first-prompt-project.js";
import { ensureSessionTask, sessionTaskOf, type SessionTask } from "../v6/session-task.js";

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// session-project-routes.ts 와 같은 규칙(userId 우선, 없으면 email) — 소유자 비교의 축이 갈리면 안 된다.
const idOf = (u: LivelyUser): string => u.userId || u.email || "";

export interface RelabelResult {
  ok: true;
  /** 이름이 실제로 바뀌었나. false 는 **실패가 아니다**(아래 reason 참고). */
  applied: boolean;
  label: string;
  source: LabelSource;
  /** applied=false 일 때만 — `taken`(이미 지어졌다) · `empty`(다듬으니 남는 게 없다) · `unknown`(미러 행 없음). */
  reason?: "taken" | "empty" | "unknown";
  /**
   * #4084 — 이 세션이 맡은 태스크(프로젝트 세션만). created=true 면 **이번 이름으로 방금 만들었다**.
   *  이름이 걸쇠에 져도(applied:false) 이미 맡은 태스크가 있으면 싣는다 — 태스크에서 연 세션은 이름이 사람 것이라
   *  늘 지는데, 모델이 자기 태스크를 아는 첫 자리가 바로 이 응답이다.
   */
  task?: SessionTask & { created: boolean };
  /** task 가 있을 때 모델에게 주는 한 줄 — 완료 처리 방법. */
  task_hint?: string;
}

const TASK_HINT =
  "이 세션이 맡은 태스크입니다(프로젝트 보드에 보입니다). 요청받은 일을 끝내면(검증까지 마치고) " +
  "`session_task {status:\"done\"}` 로 완료 처리하세요 — 같은 세션에서 후속 작업을 시작하면 `{status:\"in_progress\"}`.";

/** 결과에 태스크를 얹는다 — 조회 실패는 조용히 무시(이름짓기는 실패를 만들지 않는다). */
function withTask(r: RelabelResult, task: (SessionTask & { created: boolean }) | null): RelabelResult {
  return task ? { ...r, task, task_hint: TASK_HINT } : r;
}

/**
 * 세션 이름을 `source` 자격으로 바꾼다. 걸쇠에 지면 조용히 applied:false.
 *  ⚠ throw 는 신원·형식 문제일 때만(남의 세션·id 형식) — 그 밖은 전부 정상 반환이다.
 */
export async function relabelSession(
  u: LivelyUser, id: string, rawName: string, source: LabelSource,
): Promise<RelabelResult> {
  if (!SID_RE.test(id)) throw new HttpError(400, "세션 id 형식 오류");
  const me = idOf(u);
  if (!me) throw new HttpError(403, "사용자 신원이 없습니다");

  // 길이 초과·따옴표·마침표는 **거절하지 않고 다듬는다**(#1979 윤상민: "글자수 초과 이런건 걍 trim").
  const label = sessionNameFromAgent(rawName);
  if (!label) return { ok: true, applied: false, label: "", source, reason: "empty" };
  const taskNow = async () => {
    const t = await sessionTaskOf(id, me).catch(() => null);
    return t ? { ...t, created: false } : null;
  };

  // 소유권을 **쓰기 전에** 확정한다 — setSessionProject 와 같은 순서·같은 근거(남의 세션 id 를 DB 에 먼저
  //  claim 하게 두면 RPC 가 거부돼도 그 행이 공격자 소유로 남는다).
  const nodeId = nodeOfSession(id);
  if (nodeId) {
    const state = await getSessionState(id).catch(() => undefined);
    if (!state) throw new HttpError(404, "세션을 찾을 수 없습니다");
    if (state.owner !== me) throw new HttpError(403, "내 세션만 이름을 바꿀 수 있습니다");
  } else {
    const localOwner = await getOpt(id, "@box_owner").catch(() => "");
    if (localOwner && localOwner !== me) throw new HttpError(403, "내 세션만 이름을 바꿀 수 있습니다");
  }

  // ① 걸쇠 — 원자적. 지면 여기서 끝(tmux 미접촉).
  const won = await claimSessionLabel(id, label, source, me);
  if (!won) {
    // 미러 행이 아예 없을 수도 있다(구 세션·managed·미러 실패) — 그건 '졌다'와 다르지만 결과는 같다: 그냥 둔다.
    const exists = await getSessionState(id).then((s) => !!s).catch(() => false);
    return withTask({ ok: true, applied: false, label, source, reason: exists ? "taken" : "unknown" }, await taskNow());
  }

  // ② 화면 반영 — best-effort. 죽은 세션·꺼진 노드는 **정상**이다(DB 가 정본이고, 복원본이 이 이름으로 뜬다).
  try {
    if (nodeId) await nodeRpc(nodeId, "edit", { user: { userId: me }, id, patch: { label } });
    else await tmux(["set-option", "-t", id, "@box_label", label]);
  } catch (e) {
    console.warn(`[terminal] 세션 이름 tmux 반영 실패(${id}) — DB 에는 남았다:`, (e as Error)?.message ?? e);
  }
  // ③ 자동 생성 껍데기 프로젝트의 이름도 같은 것으로(#1867 · 상민님 제안 2026-08-25: "llm이 세션명 지을 때
  //  플젝명도 그거랑 똑같게 업뎃하는 게 좋지 않을까, 기계적으로 만들어진 세션이었다면").
  //  세션을 열 때 만든 껍데기의 이름은 **첫 지시를 70자에서 자른 것**이라 보드에서 읽기 나쁘다 — 지금 막
  //  지어진 이름은 같은 재료를 사람이 읽을 문장으로 만든 것이니, 그 세션 하나를 담으려고 만든 껍데기라면 따라간다.
  //  사람이 손댄 프로젝트는 AUTO_CREATED_MARK 가 없어 걸러진다(판정은 shouldRenameShellProject 한 곳).
  //  출처(agent·human)로 가르지 않는다: 어느 쪽이든 기계로 자른 제목보다 낫고, 판정 근거는 '껍데기인가'다.
  //  실패·미소속·못 찾음은 전부 조용한 no-op — 이름은 부가정보고 이 함수는 실패를 만들지 않는다(파일 머리말 ②).
  await renameShellProjectForSession({ executionId: id, owner: me, name: label }).catch(() => { /* 비치명 */ });
  // ④ 세션 = 태스크(#4084 · 원준님 2026-09-19: "그 제목으로 하드하게 태스크를 만들도록").
  //  이름이 정해지는 이 한 번의 왕복에 붙이면 모델이 기억해 주길 기대하지 않아도 태스크가 생긴다. 이미 맡은 태스크가
  //  있으면(태스크에서 연 세션·두 번째 개명) 그대로 돌려줄 뿐 새로 만들지 않는다. 프로젝트 밖 세션은 null.
  //  출처로 가르지 않는다 — 사람이 웹에서 처음 이름을 붙여도 그 세션의 일은 생긴 것이다.
  const task = await ensureSessionTask({ sessionId: id, owner: me, name: label });
  return withTask({ ok: true, applied: true, label, source }, task);
}
