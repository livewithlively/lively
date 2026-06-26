// ClickUp 커넥터 (phase B) — ClickUp API v2 → canonical RawItem.
// 리스트 나열 → 리스트별 태스크 백필/팀 단위 증분 폴(date_updated_gt)
// → 태스크 1건을 type:"task" RawItem 으로 정규화. 캐노니컬 진입은 run-sync.js(태스크 + 커서);
// SPI backfill 은 태스크 RawItem 만 흘린다(run-backfill 호환).
//
// 인증: Authorization: <CLICKUP_API_TOKEN> (Bearer 접두사 없음 — personal token 컨벤션).
// rate limit: 100 req/min/token — X-RateLimit-Remaining=0 선제 대기 + 429 시 retry-after 재시도.
// instance = team(workspace) id. external_id = task id (워크스페이스 내 안정·고유).
// 액터 컨벤션(load-bearing): clickup 신원의 external_id 는 **소문자 이메일**(없으면 숫자 id 문자열) —
// daon 의 manual 신원(clickup / 'lively@lvly.io')이 정확히 매치되어야 한다(resolveActor 정확 일치 룩업).
import type { Connector, RawItem, BackfillOpts } from "./types.js";

export type { Connector, RawItem, BackfillOpts };

// ── ClickUp API 타입(부분) — 변환에 쓰는 필드만 정의 ──
export interface ClickUpUser {
  id: number;
  username?: string | null;
  email?: string | null;
}

export interface ClickUpStatus {
  status?: string;
  type?: string; // open | custom | done | closed
}

export interface ClickUpTask {
  id: string;
  name?: string;
  description?: string | null;
  text_content?: string | null;
  status?: ClickUpStatus | null;
  creator?: ClickUpUser | null;
  assignees?: ClickUpUser[];
  priority?: { priority?: string | null } | null;
  due_date?: string | null; // ms epoch 문자열
  date_created?: string | null; // ms epoch 문자열
  date_updated?: string | null; // ms epoch 문자열
  archived?: boolean;
  parent?: string | null; // 부모 태스크 id (서브태스크)
  top_level_parent?: string | null; // 최상위 부모 태스크 id (깊이 판정 — parent 와 같으면 부모가 top-level Task)
  list?: { id: string; name?: string } | null;
  team_id?: string;
  url?: string;
}

export interface ClickUpFolder {
  id: string;
  name?: string;
  hidden?: boolean;
  archived?: boolean;
}

export interface ClickUpSpace {
  id: string;
  name?: string;
}

export interface ClickUpList {
  id: string;
  name?: string;
  /** 리스트 설명(비어 있으면 ""/null) */
  content?: string | null;
  archived?: boolean;
  space?: { id: string; name?: string } | null;
  folder?: ClickUpFolder | null;
}

export interface ClickUpTeam {
  id: string;
  name?: string;
  members?: { user?: ClickUpUser }[];
}

const API_BASE = "https://api.clickup.com/api/v2";

// ── 순수 변환 계층 (네트워크 없음, 단위 테스트 대상) ──

export interface ToRawItemCtx {
  /** 워크스페이스(team) id — instance/딥링크에 사용 */
  teamId: string;
}

// ms epoch 문자열 → ISO8601. 파싱 불가/부재는 undefined(컬럼 NULL).
export function msToIso(ms?: string | null): string | undefined {
  if (ms == null || ms === "") return undefined;
  const n = Number(ms);
  if (!Number.isFinite(n)) return undefined;
  return new Date(n).toISOString();
}

// ClickUp status.type(open|custom|done|closed) → 정규 카테고리(크로스툴: backlog|unstarted|started|done|canceled).
//  custom=워크플로 중간단계라 started 로 본다. closed=종결류 → done. 원문(status.status)은 fields.status 에 그대로 보존.
//  per-connector 매핑의 ClickUp 구현 — 툴 #2(Jira/Linear/Notion)는 각자 어댑터에서 같은 카테고리로 매핑한다.
export function clickUpStatusCategory(type?: string | null): string {
  switch (type) {
    case "done": return "done";
    case "closed": return "done";
    case "custom": return "started";
    case "open": return "unstarted";
    default: return "unstarted";
  }
}

// ClickUp Task 깊이 → 우리 위계 level. 단일 컨테이너 List 안에서:
//  top-level Task(parent 없음)=우리 project(추적항목, status/멤버 보유 → List 아닌 Task 와 동형),
//  Subtask(parent=project-Task)=우리 task, 중첩 Subtask(parent=task-Subtask)=우리 subtask.
//  깊이는 top_level_parent 로 단판정(부모가 top-level=task, 부모 자체가 서브태스크=subtask) — DB 적재순서 무관 결정적.
//  per-connector 매핑의 ClickUp 구현(툴 #2 Jira/Linear 는 각자 엔티티타입→같은 level 로 매핑).
export function clickUpLevel(task: ClickUpTask): "project" | "task" | "subtask" {
  if (!task.parent) return "project";
  const top = task.top_level_parent ?? null;
  return !top || top === task.parent ? "task" : "subtask";
}

export function toRawItem(task: ClickUpTask, ctx: ToRawItemCtx): RawItem {
  const { teamId } = ctx;
  const creator = task.creator ?? undefined;
  // 액터 키: 이메일 소문자 우선(이메일-as-external_id 컨벤션 — daon manual 신원 매치),
  // 이메일 부재 시 숫자 id 문자열 폴백.
  const email = creator?.email?.trim().toLowerCase() || undefined;
  const actorExternalId = email ?? (creator ? String(creator.id) : undefined);

  return {
    type: "task",
    provenance: {
      category: "pm_tool",
      system: "clickup",
      instance: teamId,
      external_id: task.id,
      external_url: task.url ?? `https://app.clickup.com/t/${task.id}`,
    },
    actor: actorExternalId
      ? {
          external_id: actorExternalId,
          email,
          display_name: creator?.username ?? undefined,
          is_bot: false,
        }
      : undefined,
    container_ref: task.list?.id,
    parent_external_id: task.parent ?? undefined,
    level: clickUpLevel(task), // Task 깊이→우리 level(connector-mirror 가 project/task/subtask 적재 시 사용)
    title: task.name,
    body: task.description || task.text_content || "",
    occurred_at: msToIso(task.date_created),
    updated_at: msToIso(task.date_updated),
    // 소스 고유 필드 — 폴/에코가 같은 shape 로 수렴(ON CONFLICT 가 fields 전체 교체).
    fields: {
      status: task.status?.status ?? null,
      status_type: task.status?.type ?? null,
      status_category: clickUpStatusCategory(task.status?.type),
      assignees: (task.assignees ?? []).map((a) => ({
        id: a.id,
        email: a.email?.trim().toLowerCase() ?? null,
        username: a.username ?? null,
      })),
      priority: task.priority?.priority ?? null,
      due_date: msToIso(task.due_date) ?? null,
      archived: !!task.archived,
      list_id: task.list?.id ?? null,
      list_name: task.list?.name ?? null,
    },
    raw: task,
  };
}

// ── HTTP 계층 ──

function requireToken(): string {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    throw new Error(
      "CLICKUP_API_TOKEN 미설정 — ClickUp personal token 을 환경변수로 주입하세요 (Authorization: <token>).",
    );
  }
  return token;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// rate limit 을 존중하는 fetch. 429 면 retry-after 만큼 대기 후 재시도(최대 5회).
// 남은 토큰(X-RateLimit-Remaining)이 0 이면 reset 까지 선제 대기해 429 를 줄인다.
// 에러 메시지에 토큰을 절대 싣지 않는다(헤더 미포함 + 본문 슬라이스만).
export async function clickupFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = requireToken();
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const maxRetries = 5;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: token,
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });

    if (res.status === 429) {
      let retryAfterSec = 2;
      const h = res.headers.get("retry-after");
      if (h && Number.isFinite(Number(h))) retryAfterSec = Number(h);
      if (attempt >= maxRetries) {
        throw new Error(`ClickUp 429 재시도 초과(${maxRetries}회): ${path}`);
      }
      await sleep(Math.ceil(retryAfterSec * 1000) + 250);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ClickUp ${res.status} ${path}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json().catch(() => ({}))) as T;

    // 정상 응답이라도 버킷 소진이면 다음 호출 전 선제 대기(reset epoch 초 단위).
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (remaining === "0" && reset) {
      const waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 250;
      if (waitMs > 0) await sleep(Math.min(waitMs, 65_000));
    }

    return data;
  }
}

// ── 팀/멤버 (run 단위 메모이즈 — 100/min 예산 절약) ──

let teamMemo: { team: ClickUpTeam; at: number } | null = null;
const TEAM_TTL_MS = 5 * 60 * 1000;

export async function getTeam(): Promise<ClickUpTeam> {
  if (teamMemo && Date.now() - teamMemo.at < TEAM_TTL_MS) return teamMemo.team;
  const res = await clickupFetch<{ teams?: ClickUpTeam[] }>("/team");
  const team = res.teams?.[0];
  if (!team?.id) throw new Error("ClickUp 워크스페이스 없음 — 토큰 권한을 확인하세요");
  teamMemo = { team, at: Date.now() };
  return team;
}

// 소문자 이메일 → 멤버 숫자 id. pm_task_create/assign 의 이메일 해소에 사용.
export async function getMembersEmailMap(teamId: string): Promise<Map<string, number>> {
  const team = await getTeam();
  if (team.id !== teamId) throw new Error(`ClickUp 워크스페이스 불일치: ${teamId}`);
  const map = new Map<string, number>();
  for (const m of team.members ?? []) {
    const u = m.user;
    if (u?.email && typeof u.id === "number") map.set(u.email.trim().toLowerCase(), u.id);
  }
  return map;
}

// ── 컨테이너 나열 ──

export async function listSpaces(teamId: string): Promise<ClickUpSpace[]> {
  const res = await clickupFetch<{ spaces?: ClickUpSpace[] }>(`/team/${teamId}/space?archived=false`);
  return res.spaces ?? [];
}

export async function listSpaceLists(
  spaceId: string, opts?: { archived?: boolean },
): Promise<ClickUpList[]> {
  const archived = opts?.archived ? "true" : "false";
  const res = await clickupFetch<{ lists?: ClickUpList[] }>(`/space/${spaceId}/list?archived=${archived}`);
  return res.lists ?? [];
}

// 폴더 경유 리스트(전방 호환 — 현 워크스페이스 리스트는 전부 hidden 폴더라 folderless 엔드포인트가 진실).
export async function listFolders(spaceId: string): Promise<ClickUpFolder[]> {
  const res = await clickupFetch<{ folders?: ClickUpFolder[] }>(`/space/${spaceId}/folder?archived=false`);
  return res.folders ?? [];
}

export async function listFolderLists(folderId: string): Promise<ClickUpList[]> {
  const res = await clickupFetch<{ lists?: ClickUpList[] }>(`/folder/${folderId}/list`);
  return res.lists ?? [];
}

// 제외 리스트(env CLICKUP_EXCLUDE_LIST_IDS=쉼표구분) — ClickUp 샘플 리스트 등 노이즈 차단.
export function getExcludedListIds(): Set<string> {
  const raw = process.env.CLICKUP_EXCLUDE_LIST_IDS?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// 허용(allow) 리스트(env CLICKUP_INCLUDE_LIST_IDS=쉼표구분). 설정 시 **이 리스트만** 싱크(나머지 전부 무시).
//  우리 모델에선 컨테이너 List 의 top-level Task = project 라, 무관한 리스트의 태스크가 project 로 유입되는 걸 막는다.
//  미설정이면 null(=종전 동작: 전체 - 제외목록). 툴 #2 의 per-connector 리스트 스코핑 config 의 ClickUp 구현.
export function getIncludedListIds(): Set<string> | null {
  const raw = process.env.CLICKUP_INCLUDE_LIST_IDS?.trim();
  if (!raw) return null;
  const s = new Set(raw.split(",").map((x) => x.trim()).filter(Boolean));
  return s.size ? s : null;
}

// ── 태스크 조회 ──

interface TaskPage { tasks?: ClickUpTask[]; last_page?: boolean }

// 한 리스트의 태스크 전부(페이지 루프). include_closed=true 필수 — 'complete'(status.type='closed')는
// 기본 쿼리에서 조용히 빠진다. archived=true 패스는 보관 태스크 수렴용(일반 쿼리에서 제외되는 별도 집합).
export async function fetchListTasks(
  listId: string, opts?: { archived?: boolean; dateUpdatedGt?: number },
): Promise<ClickUpTask[]> {
  const out: ClickUpTask[] = [];
  for (let page = 0; ; page++) {
    const q = new URLSearchParams({
      include_closed: "true", subtasks: "true", page: String(page),
    });
    if (opts?.archived) q.set("archived", "true");
    if (opts?.dateUpdatedGt !== undefined) q.set("date_updated_gt", String(opts.dateUpdatedGt));
    const res = await clickupFetch<TaskPage>(`/list/${listId}/task?${q.toString()}`);
    out.push(...(res.tasks ?? []));
    if (res.last_page !== false) break; // last_page 누락/true = 종료
  }
  return out;
}

// 팀 단위 증분 폴 — list_ids[] 로 허용 리스트만(샘플 리스트 태스크 차단).
export async function fetchTeamTasks(
  teamId: string, opts: { dateUpdatedGt?: number; listIds?: string[] },
): Promise<ClickUpTask[]> {
  const out: ClickUpTask[] = [];
  for (let page = 0; ; page++) {
    const q = new URLSearchParams({
      include_closed: "true", subtasks: "true", page: String(page),
    });
    if (opts.dateUpdatedGt !== undefined) q.set("date_updated_gt", String(opts.dateUpdatedGt));
    for (const id of opts.listIds ?? []) q.append("list_ids[]", id);
    const res = await clickupFetch<TaskPage>(`/team/${teamId}/task?${q.toString()}`);
    out.push(...(res.tasks ?? []));
    if (res.last_page !== false) break;
  }
  return out;
}

export async function getTask(taskId: string): Promise<ClickUpTask> {
  return clickupFetch<ClickUpTask>(`/task/${encodeURIComponent(taskId)}`);
}

// ── 쓰기 (pm_* capability 가 사용 — 검증은 capability 계층이 선행) ──

export async function createTask(listId: string, body: Record<string, unknown>): Promise<ClickUpTask> {
  return clickupFetch<ClickUpTask>(`/list/${encodeURIComponent(listId)}/task`, {
    method: "POST", body: JSON.stringify(body),
  });
}

export async function updateTask(taskId: string, body: Record<string, unknown>): Promise<ClickUpTask> {
  return clickupFetch<ClickUpTask>(`/task/${encodeURIComponent(taskId)}`, {
    method: "PUT", body: JSON.stringify(body),
  });
}

export async function createTaskComment(
  taskId: string, body: { comment_text: string; notify_all: boolean },
): Promise<{ id?: string | number; hist_id?: string; date?: number }> {
  return clickupFetch(`/task/${encodeURIComponent(taskId)}/comment`, {
    method: "POST", body: JSON.stringify(body),
  });
}

// 태스크-태스크 링크(API 는 task↔task 만 지원 — 외부 URL 은 capability 가 코멘트 폴백).
export async function linkTasks(taskId: string, linksTo: string): Promise<unknown> {
  return clickupFetch(`/task/${encodeURIComponent(taskId)}/link/${encodeURIComponent(linksTo)}`, {
    method: "POST", body: JSON.stringify({}),
  });
}

// 허용(=싱크 대상) 리스트 나열: 스페이스 → (폴더 리스트, 전방호환) + folderless(active/archived 패스)
// → 제외 denylist 적용. archived 패스가 있어 툴에서 보관한 리스트도 state='archived' 로 수렴한다.
export async function enumerateLists(teamId: string): Promise<ClickUpList[]> {
  const excluded = getExcludedListIds();
  const included = getIncludedListIds(); // 설정 시 이 리스트만(컨테이너 스코핑)
  const byId = new Map<string, ClickUpList>();
  for (const space of await listSpaces(teamId)) {
    try {
      for (const folder of await listFolders(space.id)) {
        if (folder.hidden) continue; // hidden 폴더 리스트는 folderless 엔드포인트가 커버
        for (const l of await listFolderLists(folder.id)) byId.set(l.id, l);
      }
    } catch (err) {
      console.error(`[clickup] 스페이스 ${space.id} 폴더 나열 실패, folderless 만 진행:`, err);
    }
    for (const l of await listSpaceLists(space.id, { archived: false })) byId.set(l.id, l);
    for (const l of await listSpaceLists(space.id, { archived: true })) byId.set(l.id, { ...l, archived: true });
  }
  return [...byId.values()].filter((l) => !excluded.has(l.id) && (!included || included.has(l.id)));
}

// ── Connector SPI 구현 — 태스크 RawItem 스트림(run-backfill.js clickup 호환).
// 캐노니컬 진입은 run-sync.js(태스크 + 커서) — 여기는 태스크만.
export const clickupConnector: Connector = {
  name: "clickup",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const team = await getTeam();
    const teamId = team.id;
    const sinceMs = opts?.since ? new Date(opts.since).getTime() : undefined;
    const dateUpdatedGt = sinceMs !== undefined && Number.isFinite(sinceMs) ? sinceMs : undefined;

    for (const list of await enumerateLists(teamId)) {
      try {
        const active = await fetchListTasks(list.id, { dateUpdatedGt });
        const archived = await fetchListTasks(list.id, { archived: true, dateUpdatedGt });
        for (const task of [...active, ...archived]) {
          try {
            yield toRawItem(task, { teamId });
          } catch (err) {
            console.error(`[clickup] 태스크 변환 실패 ${task?.id}, skip:`, err);
          }
        }
      } catch (err) {
        console.error(`[clickup] 리스트 ${list.id} 백필 중단(부분 수집됨):`, err);
      }
    }
  },
};
