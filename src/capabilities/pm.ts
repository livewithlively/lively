// pm_* 그룹 capability (phase B) — ClickUp write-through. 하네스(MCP) 전용(expose.rest=false).
// 철학: **아카이브 온리** — 하드 삭제 op 는 어디에도 없다. 모든 쓰기는
//   검증 → ClickUp API(실패 시 ClickUp 메시지 그대로 표면화) → 에코 업서트(같은 toRawItem→ingestItems
//   경로 + declareItemProject) — 미러가 즉시 반영(read-your-writes)되고 이후 폴이 같은 external_id 로
//   멱등 수렴한다. ClickUp 계정은 토큰 1개(daon)지만, 실제 지시자는 **DB 영속** pm_write_audit
//   (op·by·outcome·detail — 게이트웨이 stdout 로그 위치와 무관하게 내구)와 item_mapping_audit.actor
//   + 에코 fields {via:'harness', initiator} 에 기록된다(폴이 fields 를 정규화하면 via/initiator 는
//   사라짐 — 내구 기록은 감사 테이블. 의도된 설계).
// 스코프: 'items' 재사용 — curate_item_mapping(쓰기)과 동급 표면, 2인 조직에서 별도 'pm' 스코프 분리는
// 실익 없이 union/AUTH_TOKENS_JSON 변경만 유발(런북에 업그레이드 경로로 문서화).
import { z } from "zod";
import {
  ingestItems, declareItemProject, supersedeSiblingDeclaredProjects,
  getItemIdsByExternalIds, recordPmWriteAudit,
} from "../items/store.js";
import { loadCandidates, validateProjectKey } from "../items/mapping-candidates.js";
import {
  getTeam, getMembersEmailMap, getTask, createTask, updateTask, createTaskComment, linkTasks,
  getExcludedListIds, toRawItem, taskProjectKey, type ClickUpTask,
} from "../connectors/clickup.js";
import { logger } from "../log.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";

const REPO = "productivity"; // pm 쓰기는 항상 productivity — lively 기본값에 절대 의존 금지.

// ── 쓰기 공통 audit — domainmap-curation.ts 의 audited() idiom(결과 시점 기록). ──
// 성공 = outcome:'ok', 실패 = outcome:'failed' + error. ClickUp 쓰기는 성공했는데 에코만 실패한
// 케이스는 clickupOk:true 로 구분(운영자가 create 를 맹복구 재시도하면 ClickUp 태스크가 중복된다).
// 영속: logger 라인 + **pm_write_audit DB 행**(append-only) 이중 기록 — stdout 로그는 리다이렉트
// 위치(과거 /tmp)에 따라 휘발이라 '누가 어떤 op 를 언제' 의 내구 진실은 DB 행이다.
// DB 기록 실패는 op 를 깨지 않고 logger.error 로만 표면화(best-effort — ClickUp 쓰기는 이미 끝났을
// 수 있어 여기서 throw 하면 false-failure).
async function audited<T>(
  action: string, user: LivelyUser, ctx: CapabilityCtx | undefined,
  extra: Record<string, unknown>, fn: () => Promise<T>,
): Promise<T> {
  const source = ctx?.source ?? "unknown";
  const base = { audit: "pm_write", action, by: user.userId, source, ...extra };
  const persist = async (row: { outcome: "ok" | "failed"; clickupOk?: boolean; error?: string }) => {
    try {
      await recordPmWriteAudit({ action, by: user.userId, source, detail: extra, ...row });
    } catch (err) {
      logger.error({ err, action, by: user.userId }, "pm_write_audit 영속 실패(op 는 계속)");
    }
  };
  try {
    const result = await fn();
    logger.info({ ...base, outcome: "ok" });
    await persist({ outcome: "ok" });
    return result;
  } catch (err) {
    const clickupOk = (err as { clickupOk?: boolean }).clickupOk === true;
    const message = err instanceof Error ? err.message : String(err);
    logger.info({ ...base, outcome: "failed", ...(clickupOk ? { clickupOk } : {}), error: message });
    await persist({ outcome: "failed", ...(clickupOk ? { clickupOk } : {}), error: message });
    throw err;
  }
}

// ── 에코 업서트 — ClickUp 응답 task 를 폴과 **동일한** 순수 변환으로 미러에 반영. ──
// fields 에 via/initiator 스탬프(transient — 다음 폴이 정규화하며 사라짐, 내구 기록은 audit).
// declare 는 declareItemProject(유일한 mapped_by='declared' 경로) — repo 'productivity' 고정.
// 에코 **선검증**(create 외 5 op 는 임의 taskId 를 받으므로 여기가 리스트 게이트):
//  · excluded 리스트(CLICKUP_EXCLUDE_LIST_IDS): run-sync 가 영원히 안 긁는다 — ingest 하면 영구
//    스테일 미러 행이 되므로 **미러 자체를 스킵**(mirrored:false + 경고; ClickUp 쓰기는 성공이므로
//    op 는 성공으로 반환 — 과거엔 ingest 후 declare throw 로 false-failure + '다음 run-sync 가
//    수렴' 이라는 거짓 힌트를 냈다).
//  · 미동기화 리스트(후보 vocab 에 없음): item 은 에코하되 declare 만 스킵(경고) — 다음 run-sync 가
//    프로젝트 싱크 후 매핑을 수렴한다(이 힌트는 참).
async function echoTask(
  task: ClickUpTask, user: LivelyUser,
): Promise<{ itemId: number | null; projectKey: string | null; mirrored: boolean; warning?: string }> {
  try {
    const teamId = task.team_id ?? (await getTeam()).id;
    const listId = task.list?.id ?? null;
    if (listId && getExcludedListIds().has(listId)) {
      const warning = `리스트 ${listId} 는 싱크 제외 대상(CLICKUP_EXCLUDE_LIST_IDS) — 미러 미반영(ClickUp 쓰기는 성공)`;
      logger.warn({ audit: "pm_echo_skipped", taskId: task.id, listId, reason: "excluded-list" });
      return { itemId: null, projectKey: null, mirrored: false, warning };
    }
    const declaredKey = listId ? taskProjectKey(listId) : null;
    const declarable = declaredKey !== null
      && validateProjectKey(await loadCandidates(REPO), declaredKey);
    const raw = toRawItem(task, { teamId });
    raw.fields = { ...raw.fields, via: "harness", initiator: user.userId };
    await ingestItems([raw]);
    const ids = await getItemIdsByExternalIds("clickup", teamId, [task.id]);
    const itemId = ids.get(task.id);
    if (!itemId) throw new Error(`에코 item 조회 실패(external_id=${task.id})`);
    if (declaredKey && declarable) {
      await declareItemProject(
        { itemId, projectKey: declaredKey, repo: REPO, evidence: `pm write-through by ${user.userId}` },
        { audit: { source: "pm-write", actor: user.userId } },
      );
      // 리스트 간 이동 수렴(run-sync 와 동일 reconcile) — 옛 리스트 declared 행 강등(대부분 no-op).
      await supersedeSiblingDeclaredProjects(
        { itemId, keepProjectKey: declaredKey, repo: REPO },
        { audit: { source: "pm-write", actor: user.userId } },
      );
      return { itemId, projectKey: declaredKey, mirrored: true };
    }
    const warning = declaredKey
      ? `리스트 ${listId}(${declaredKey}) 미동기화 — item 은 에코됨, 매핑은 다음 run-sync 가 수렴`
      : `태스크에 리스트 정보 없음 — 매핑 스킵`;
    logger.warn({ audit: "pm_echo_declare_skipped", taskId: task.id, listId, projectKey: declaredKey });
    return { itemId, projectKey: null, mirrored: true, warning };
  } catch (err) {
    // ClickUp 쓰기는 이미 성공 — 미러만 스테일. 다음 run-sync 가 수렴하므로 재시도 금지(특히 create).
    const e = new Error(
      `ClickUp 쓰기는 성공했으나 미러 반영 실패(taskId=${task.id}) — 다음 run-sync 가 수렴: ${(err as Error).message}`,
    ) as Error & { clickupOk: boolean };
    e.clickupOk = true;
    throw e;
  }
}

// listKeyOrId 정규화: 'clickup-<id>' 접두 허용 → 숫자 리스트 id.
function normalizeListId(listKeyOrId: string): string {
  const s = listKeyOrId.trim().replace(/^clickup-/, "");
  if (!/^\d+$/.test(s)) {
    throw new Error(`listKeyOrId 형식 오류 — 'clickup-<listId>' 또는 숫자 리스트 id 필요(받은 값: ${listKeyOrId})`);
  }
  return s;
}

// 이메일 → ClickUp 멤버 id 해소. 미상 이메일은 명확한 에러(무쓰기).
async function resolveAssigneeIds(teamId: string, emails: string[]): Promise<number[]> {
  const map = await getMembersEmailMap(teamId);
  return emails.map((e) => {
    const id = map.get(e.trim().toLowerCase());
    if (id === undefined) throw new Error(`ClickUp 멤버 없음: ${e}`);
    return id;
  });
}

const zTaskId = z.string().trim().min(1).max(64);

// ════════ 6 ops — 전부 scope 'items', MCP 전용 ════════

const pmTaskCreate: Capability = {
  name: "pm_task_create",
  title: "PM 태스크 생성",
  description:
    "ClickUp 리스트에 태스크 생성(write-through: 생성 즉시 미러 item + declared 매핑까지 반영 — read-your-writes). " +
    "listKeyOrId 는 'clickup-<listId>' 프로젝트 키 또는 숫자 리스트 id. 리스트가 아직 동기화 전이면 거부(무쓰기) — run-sync 먼저. " +
    "assigneeEmails 는 ClickUp 멤버 이메일로 해소(미상 이메일 = 에러). priority 1(urgent)~4(low). dueDate ISO8601. " +
    "ClickUp 표시 계정은 토큰 계정이지만 실제 지시자는 audit 에 기록된다.",
  scope: "items",
  input: {
    listKeyOrId: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20000).optional(),
    assigneeEmails: z.array(z.string().email()).max(20).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    dueDate: z.string().optional().describe("ISO8601"),
  },
  expose: { mcp: true, rest: false },
  handler: async (
    input: { listKeyOrId: string; title: string; description?: string; assigneeEmails?: string[]; priority?: number; dueDate?: string },
    user, ctx,
  ) => {
    const listId = normalizeListId(input.listKeyOrId);
    const projectKey = taskProjectKey(listId);
    return audited("task_create", user, ctx, { listId, title: input.title }, async () => {
      // 제로-쓰기 보장: ClickUp 호출 **전에** 후보 vocab 으로 리스트 존재를 선검증.
      const candidates = await loadCandidates(REPO);
      if (!validateProjectKey(candidates, projectKey)) {
        throw new Error(`리스트/프로젝트 후보 없음: ${projectKey} — run-sync 로 먼저 동기화하세요`);
      }
      const teamId = (await getTeam()).id;
      const assignees = input.assigneeEmails?.length
        ? await resolveAssigneeIds(teamId, input.assigneeEmails)
        : [];
      let dueMs: number | undefined;
      if (input.dueDate !== undefined) {
        const t = Date.parse(input.dueDate);
        if (Number.isNaN(t)) throw new Error("dueDate 형식 오류 — ISO8601 필요");
        dueMs = t;
      }
      const task = await createTask(listId, {
        name: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        assignees,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(dueMs !== undefined ? { due_date: dueMs } : {}),
      });
      const echo = await echoTask(task, user);
      return { taskId: task.id, url: task.url, status: task.status?.status ?? null, ...echo };
    });
  },
};

const pmTaskUpdateStatus: Capability = {
  name: "pm_task_update_status",
  title: "PM 태스크 상태 변경",
  description:
    "태스크 상태 변경(write-through 미러 에코). status 는 해당 스페이스의 상태 문자열 그대로(소문자 — 예: 'to do'|'in progress'|'complete'); " +
    "잘못된 값은 ClickUp 의 에러 메시지를 그대로 표면화. 완료 처리도 삭제가 아니라 상태 전환(아카이브 온리 철학).",
  scope: "items",
  input: { taskId: zTaskId, status: z.string().trim().min(1).max(100) },
  expose: { mcp: true, rest: false },
  handler: async (input: { taskId: string; status: string }, user, ctx) =>
    audited("task_update_status", user, ctx, { taskId: input.taskId, status: input.status }, async () => {
      const task = await updateTask(input.taskId, { status: input.status });
      const echo = await echoTask(task, user);
      return { taskId: task.id, status: task.status?.status ?? null, ...echo };
    }),
};

const pmTaskAssign: Capability = {
  name: "pm_task_assign",
  title: "PM 태스크 담당자 지정",
  description:
    "태스크 담당자를 **교체(replace) 의미론**으로 선언적 지정 — 주어진 이메일 목록이 최종 담당자 집합이 된다" +
    "(기존 담당자 중 목록에 없는 사람은 해제). 미상 이메일 = 에러(무쓰기). write-through 미러 에코.",
  scope: "items",
  input: { taskId: zTaskId, assigneeEmails: z.array(z.string().email()).min(1).max(20) },
  expose: { mcp: true, rest: false },
  handler: async (input: { taskId: string; assigneeEmails: string[] }, user, ctx) =>
    audited("task_assign", user, ctx, { taskId: input.taskId, emails: input.assigneeEmails }, async () => {
      const teamId = (await getTeam()).id;
      const wanted = await resolveAssigneeIds(teamId, input.assigneeEmails); // ClickUp 호출 전 검증
      const current = await getTask(input.taskId);
      const currentIds = (current.assignees ?? []).map((a) => a.id);
      const add = wanted.filter((id) => !currentIds.includes(id));
      const rem = currentIds.filter((id) => !wanted.includes(id));
      const task = await updateTask(input.taskId, { assignees: { add, rem } });
      const echo = await echoTask(task, user);
      return { taskId: task.id, assignees: input.assigneeEmails, added: add.length, removed: rem.length, ...echo };
    }),
};

const pmTaskComment: Capability = {
  name: "pm_task_comment",
  title: "PM 태스크 코멘트",
  description:
    "태스크에 코멘트 작성(notify_all=false). 코멘트는 phase B 에선 별도 item 으로 미러링하지 않는다 — " +
    "부모 태스크의 에코(updated_at 전진)가 미러 신호. 반환 {commentId, itemId}.",
  scope: "items",
  input: { taskId: zTaskId, text: z.string().trim().min(1).max(10000) },
  expose: { mcp: true, rest: false },
  handler: async (input: { taskId: string; text: string }, user, ctx) =>
    audited("task_comment", user, ctx, { taskId: input.taskId }, async () => {
      const res = await createTaskComment(input.taskId, { comment_text: input.text, notify_all: false });
      // 코멘트 응답은 부분({id,hist_id,date}) — 전체 태스크를 후속 GET 해서 에코.
      const task = await getTask(input.taskId);
      const echo = await echoTask(task, user);
      return { taskId: input.taskId, commentId: res.id ?? null, ...echo };
    }),
};

const pmTaskLink: Capability = {
  name: "pm_task_link",
  title: "PM 태스크 링크",
  description:
    "태스크에 링크 부착. url 이 ClickUp 태스크 딥링크(app.clickup.com/t/<id>)면 태스크-태스크 링크(mode='task-link'), " +
    "그 외 URL 은 ClickUp API 제약상 '링크: <url>' 코멘트로 폴백(mode='comment'). write-through 미러 에코.",
  scope: "items",
  input: { taskId: zTaskId, url: z.string().url().max(2000) },
  expose: { mcp: true, rest: false },
  handler: async (input: { taskId: string; url: string }, user, ctx) =>
    audited("task_link", user, ctx, { taskId: input.taskId, url: input.url }, async () => {
      // 딥링크 판별은 **앵커드** URL 파싱 — 호스트가 정확히 app.clickup.com 이고 경로가 /t/<id> 일 때만.
      // (비앵커 regex 는 https://evil.com/app.clickup.com/t/x 류 URL 을 태스크 링크로 오분류하는
      //  mode-confusion 이 있었다 — 사용자 입력이므로 보수적으로.)
      let linkTargetId: string | null = null;
      try {
        const u = new URL(input.url);
        const m = /^\/t\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
        if (u.hostname === "app.clickup.com" && m) linkTargetId = m[1];
      } catch { /* zod .url() 통과 후라 사실상 도달 불가 — 코멘트 폴백 */ }
      let mode: "task-link" | "comment";
      if (linkTargetId) {
        await linkTasks(input.taskId, linkTargetId);
        mode = "task-link";
      } else {
        await createTaskComment(input.taskId, { comment_text: `링크: ${input.url}`, notify_all: false });
        mode = "comment";
      }
      const task = await getTask(input.taskId);
      const echo = await echoTask(task, user);
      return { taskId: input.taskId, mode, ...echo };
    }),
};

const pmTaskArchive: Capability = {
  name: "pm_task_archive",
  title: "PM 태스크 아카이브",
  description:
    "태스크 아카이브(archived=true) — **하드 삭제는 어떤 pm op 에도 없다**(아카이브 온리 철학; 감사 추적 보존). " +
    "write-through 미러 에코(fields.archived=true). 보관 해제는 ClickUp UI 에서.",
  scope: "items",
  input: { taskId: zTaskId },
  expose: { mcp: true, rest: false },
  handler: async (input: { taskId: string }, user, ctx) =>
    audited("task_archive", user, ctx, { taskId: input.taskId }, async () => {
      const task = await updateTask(input.taskId, { archived: true });
      const echo = await echoTask(task, user);
      return { taskId: task.id, archived: true, ...echo };
    }),
};

export const pmCapabilities: Capability[] = [
  pmTaskCreate, pmTaskUpdateStatus, pmTaskAssign, pmTaskComment, pmTaskLink, pmTaskArchive,
];
