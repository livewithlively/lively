// ClickUp 커넥터 (phase B) — ClickUp API v2 → canonical RawItem + domainmap 프로젝트 싱크.
// 리스트(프로젝트 단위) 나열 → 리스트별 태스크 백필/팀 단위 증분 폴(date_updated_gt)
// → 태스크 1건을 type:"task" RawItem 으로 정규화. 캐노니컬 진입은 run-sync.js(프로젝트 싱크 +
// 태스크 + declared 매핑); SPI backfill 은 태스크 RawItem 만 흘린다(run-backfill 호환).
//
// 인증: Authorization: <CLICKUP_API_TOKEN> (Bearer 접두사 없음 — personal token 컨벤션).
// rate limit: 100 req/min/token — X-RateLimit-Remaining=0 선제 대기 + 429 시 retry-after 재시도.
// instance = team(workspace) id. external_id = task id (워크스페이스 내 안정·고유).
// 액터 컨벤션(load-bearing): clickup 신원의 external_id 는 **소문자 이메일**(없으면 숫자 id 문자열) —
// daon 의 manual 신원(clickup / 'lively@lvly.io')이 정확히 매치되어야 한다(resolveActor 정확 일치 룩업).
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { syncProject } from "../domainmap/core/projects.js";
import { resolveRepo } from "../domainmap/core/types.js";

// 고객 배포 불변: 커넥터 대상 repo·actor 를 코드에 하드코딩하지 않는다(고객사 노출 금지). repo 는
//  DOMAINMAP_DEFAULT_REPO(resolveRepo, 미설정 시 throw — 설정 강제), actor 는 LIVELY_CONNECTOR_ACTOR
//  (미설정 시 중립 'connector'). 옛 'productivity'/'daon' 리터럴 제거.
const CONNECTOR_ACTOR = process.env.LIVELY_CONNECTOR_ACTOR || "connector";

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
    title: task.name,
    body: task.description || task.text_content || "",
    occurred_at: msToIso(task.date_created),
    updated_at: msToIso(task.date_updated),
    // 소스 고유 필드 — 폴/에코가 같은 shape 로 수렴(ON CONFLICT 가 fields 전체 교체).
    fields: {
      status: task.status?.status ?? null,
      status_type: task.status?.type ?? null,
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

// 프로젝트 키 컨벤션 — domainmap syncProject 의 기본 slugKey('clickup-<listid>')와 일치.
export const taskProjectKey = (listId: string): string => `clickup-${listId}`;

// 리스트 1개 → domainmap project/sync 페이로드.
// description: 빈 content 는 **생략**(omit) — syncProject 의 `p.description ?? ex.description` 이
// 큐레이션된 기존 설명(예: 프로젝트 46)을 보존한다(load-bearing — 빈 문자열을 보내면 영구 소실).
// fields: 비휘발 메타만(space[, folder(숨김 아님일 때만)]) — task_count 같은 휘발 값을 넣으면
// 매 싱크가 change_log churn 이 된다.
export function toProjectSyncPayload(
  list: ClickUpList, ctx: ToRawItemCtx,
): Record<string, unknown> {
  const { teamId } = ctx;
  const description = list.content?.trim() ? list.content : undefined;
  const fields: Record<string, unknown> = {};
  if (list.space?.name) fields.space = list.space.name;
  if (list.folder && !list.folder.hidden && list.folder.name) fields.folder = list.folder.name;
  return {
    prov_system: "clickup",
    prov_instance: teamId,
    external_id: list.id,
    name: list.name ?? list.id,
    ...(description !== undefined ? { description } : {}),
    state: list.archived ? "archived" : "active",
    external_url: `https://app.clickup.com/${teamId}/v/li/${list.id}`,
    fields,
    raw: list,
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

// ── domainmap 프로젝트 싱크 — 리스트(프로젝트 단위)별 1 POST. repo 는 'productivity' 하드코딩
// (DOMAINMAP_DEFAULT_REPO='lively' 에 절대 의존하지 않는다 — lively 는 서버측 403 백스톱도 있음). ──
export interface ProjectSyncResult {
  listId: string; listName: string;
  ok: boolean;
  action?: string; projectKey?: string; projectId?: number;
  error?: string;
}

export async function syncProjects(
  lists: ClickUpList[], ctx: ToRawItemCtx,
): Promise<ProjectSyncResult[]> {
  const out: ProjectSyncResult[] = [];
  for (const list of lists) {
    const base = { listId: list.id, listName: list.name ?? list.id };
    try {
      // 코어 syncProject 가 SYNC_BLOCKED_REPOS 가드·409 소유-repo 안내를 그대로 수행. repo/actor 는
      //  배포 설정에서(하드코딩 금지 — 고객사 노출 방지).
      const r = (await syncProject(
        resolveRepo(),
        toProjectSyncPayload(list, ctx),
        { type: "agent", id: CONNECTOR_ACTOR },
      )) as { id?: number; key?: string; action?: string };
      out.push({ ...base, ok: true, action: r.action, projectKey: r.key, projectId: r.id });
    } catch (err) {
      out.push({ ...base, ok: false, error: (err as Error).message });
    }
  }
  return out;
}

// 허용(=싱크 대상) 리스트 나열: 스페이스 → (폴더 리스트, 전방호환) + folderless(active/archived 패스)
// → 제외 denylist 적용. archived 패스가 있어 툴에서 보관한 리스트도 state='archived' 로 수렴한다.
export async function enumerateLists(teamId: string): Promise<ClickUpList[]> {
  const excluded = getExcludedListIds();
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
  return [...byId.values()].filter((l) => !excluded.has(l.id));
}

// ── Connector SPI 구현 — 태스크 RawItem 스트림(run-backfill.js clickup 호환).
// 캐노니컬 진입은 run-sync.js(프로젝트 싱크 + declared 매핑 + 커서) — 여기는 태스크만.
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
