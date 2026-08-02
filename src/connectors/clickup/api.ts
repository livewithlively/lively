// ClickUp HTTP·조회·쓰기 계층(#1313 R22 분할 — 구 clickup.ts 219·596-1054).
import { resolveConnectorConfig } from "../config.js";
import type {
  ClickUpComment, ClickUpCustomField, ClickUpFolder, ClickUpList, ClickUpSpace,
  ClickUpTag, ClickUpTask, ClickUpTeam, ClickUpTimeEntry, ClickUpView,
  HierarchyFolder, HierarchyList, HierarchySpace,
} from "./types.js";

const API_BASE = "https://api.clickup.com/api/v2";

// ── HTTP 계층 ──

async function requireToken(): Promise<string> {
  const token = (await resolveConnectorConfig("clickup")).api_token;
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
  const token = await requireToken();
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
//  archived 패스 추가(#541 무손실) — 보관 폴더 안 리스트/태스크도 수렴.
export async function listFolders(spaceId: string, opts?: { archived?: boolean }): Promise<ClickUpFolder[]> {
  const archived = opts?.archived ? "true" : "false";
  const res = await clickupFetch<{ folders?: ClickUpFolder[] }>(`/space/${spaceId}/folder?archived=${archived}`);
  return res.folders ?? [];
}

export async function listFolderLists(folderId: string): Promise<ClickUpList[]> {
  const res = await clickupFetch<{ lists?: ClickUpList[] }>(`/folder/${folderId}/list`);
  return res.lists ?? [];
}

// 제외 리스트(env CLICKUP_EXCLUDE_LIST_IDS=쉼표구분) — ClickUp 샘플 리스트 등 노이즈 차단.
export async function getExcludedListIds(): Promise<Set<string>> {
  const raw = (await resolveConnectorConfig("clickup")).exclude_list_ids?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// 허용(allow) 리스트(env CLICKUP_INCLUDE_LIST_IDS=쉼표구분). 설정 시 **이 리스트만** 싱크(나머지 전부 무시).
//  우리 모델에선 컨테이너 List 의 top-level Task = project 라, 무관한 리스트의 태스크가 project 로 유입되는 걸 막는다.
//  미설정이면 null(=종전 동작: 전체 - 제외목록). 툴 #2 의 per-connector 리스트 스코핑 config 의 ClickUp 구현.
export async function getIncludedListIds(): Promise<Set<string> | null> {
  const raw = (await resolveConnectorConfig("clickup")).include_list_ids?.trim();
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

// 무손실 hydration — 단건 GET 에 markdown_description(서식 진실) + subtasks 를 포함해 리스트 나열이 누락하는
//  본문서식·attachments·custom_fields 값을 완전화한다. include_subtasks 는 다른 리스트로 옮겨진 서브태스크까지 수렴.
//  rate limit 100/min 이 바인딩이라 이건 태스크당 1콜 — 마이그레이션은 스로틀(clickupFetch 가 선제 대기)로 흡수.
export async function getTaskFull(taskId: string): Promise<ClickUpTask> {
  return clickupFetch<ClickUpTask>(
    `/task/${encodeURIComponent(taskId)}?include_markdown_description=true&include_subtasks=true`,
  );
}

// ── 계층 메타 조회(무손실 이관 — 커스텀 status set·뷰·커스텀필드 정의·스페이스 태그팔레트) ──

export async function getSpace(spaceId: string): Promise<ClickUpSpace> {
  return clickupFetch<ClickUpSpace>(`/space/${encodeURIComponent(spaceId)}`);
}

// 리스트 상세(#541 상태순서) — 나열 API(listFolderLists/listSpaceLists)의 statuses 는 orderindex 가 빠질 수 있어
//  정렬이 무의미해진다(내부 저장순 박제). 상세 GET 은 statuses(orderindex 포함)·override_statuses 가 완전하다.
export async function getList(listId: string): Promise<ClickUpList> {
  return clickupFetch<ClickUpList>(`/list/${encodeURIComponent(listId)}`);
}

// 리스트 뷰(사용자 "뷰 저장 안됨/커스텀 컬럼" — ClickUp View 를 project_view 로 이관). best-effort(권한/피처에 따라 빈 배열).
export async function getListViews(listId: string): Promise<ClickUpView[]> {
  const res = await clickupFetch<{ views?: ClickUpView[]; required_views?: Record<string, ClickUpView> }>(
    `/list/${encodeURIComponent(listId)}/view`,
  );
  const views = res.views ?? [];
  // required_views(리스트 기본 List/Board 뷰)도 보존 — 객체 형태라 값만 취해 병합(id dedup).
  const req = res.required_views ? Object.values(res.required_views).filter((v) => v && (v as ClickUpView).id) : [];
  const byId = new Map<string, ClickUpView>();
  for (const v of [...req, ...views]) if (v?.id) byId.set(v.id, v);
  return [...byId.values()];
}

export async function getView(viewId: string): Promise<ClickUpView | null> {
  const res = await clickupFetch<{ view?: ClickUpView }>(`/view/${encodeURIComponent(viewId)}`);
  return res.view ?? null;
}

// 스페이스/폴더 스코프 뷰(#541 무손실) — 리스트 뷰(getListViews)와 같은 shape. best-effort.
export async function getScopeViews(kind: "space" | "folder", id: string): Promise<ClickUpView[]> {
  const res = await clickupFetch<{ views?: ClickUpView[]; required_views?: Record<string, ClickUpView> }>(
    `/${kind}/${encodeURIComponent(id)}/view`,
  );
  const views = res.views ?? [];
  const req = res.required_views ? Object.values(res.required_views).filter((v) => v && (v as ClickUpView).id) : [];
  const byId = new Map<string, ClickUpView>();
  for (const v of [...req, ...views]) if (v?.id) byId.set(v.id, v);
  return [...byId.values()];
}

// ── 댓글(#541 무손실) — GET /task/:id/comment 는 최신 25개, start(ms)+start_id 로 과거 페이지. ──
//  reply_count>0 인 댓글은 GET /comment/:id/reply 로 답글까지 회수(우리 task_comment.reply_to 1단 스레드와 호환).
export async function getTaskComments(taskId: string): Promise<Array<{ comment: ClickUpComment; replyTo?: string }>> {
  const out: Array<{ comment: ClickUpComment; replyTo?: string }> = [];
  let start: string | undefined;
  let startId: string | undefined;
  for (let page = 0; page < 200; page++) { // 5000개 안전 상한
    const q = new URLSearchParams();
    if (start) { q.set("start", start); if (startId) q.set("start_id", startId); }
    const res = await clickupFetch<{ comments?: ClickUpComment[] }>(
      `/task/${encodeURIComponent(taskId)}/comment${q.size ? `?${q.toString()}` : ""}`,
    );
    const batch = res.comments ?? [];
    if (!batch.length) break;
    for (const c of batch) {
      out.push({ comment: c });
      const rc = Number(c.reply_count ?? 0);
      if (rc > 0) {
        try {
          const rr = await clickupFetch<{ comments?: ClickUpComment[] }>(`/comment/${encodeURIComponent(String(c.id))}/reply`);
          for (const r of rr.comments ?? []) out.push({ comment: r, replyTo: `comment:${c.id}` });
        } catch (err) {
          console.error(`[clickup] 댓글 ${c.id} 답글 조회 실패(원댓글은 보존):`, err);
        }
      }
    }
    if (batch.length < 25) break; // 마지막 페이지
    const oldest = batch[batch.length - 1];
    start = oldest.date != null ? String(oldest.date) : undefined;
    startId = String(oldest.id);
    if (!start) break;
  }
  return out;
}

// ── 타임엔트리(#541 무손실) — 팀 스윕 1콜(+페이지). assignee 전원 지정(기본은 토큰 소유자 것만 반환). ──
export async function fetchTimeEntries(teamId: string, opts?: { sinceMs?: number; onError?: () => void }): Promise<ClickUpTimeEntry[]> {
  const team = await getTeam();
  const memberIds = (team.members ?? []).map((m) => m.user?.id).filter((x): x is number => typeof x === "number");
  const out: ClickUpTimeEntry[] = [];
  const baseQ = () => new URLSearchParams({
    start_date: String(opts?.sinceMs ?? 0),
    end_date: String(Date.now() + 24 * 3600 * 1000),
  });
  const is403 = (err: unknown) => String((err as Error)?.message ?? "").includes("ClickUp 403");
  const q = baseQ();
  if (memberIds.length) q.set("assignee", memberIds.join(","));
  try {
    const res = await clickupFetch<{ data?: ClickUpTimeEntry[] }>(`/team/${teamId}/time_entries?${q.toString()}`);
    out.push(...(res.data ?? []));
  } catch (err) {
    if (is403(err)) {
      // 권한 경계(TIMEENTRY_059 — 토큰 유저가 타 멤버 엔트리 열람 불가). 일시 장애가 아니라 **커서 동결 사유가 아님**
      //  (onError 미호출) — 본인 엔트리만 폴백 수집(assignee 생략 = 기본 자기 자신).
      console.warn(`[clickup] 타임엔트리 전체조회 권한 없음(403) — 토큰 유저 본인 엔트리만 수집(폴백)`);
      try {
        const res = await clickupFetch<{ data?: ClickUpTimeEntry[] }>(`/team/${teamId}/time_entries?${baseQ().toString()}`);
        out.push(...(res.data ?? []));
      } catch (err2) {
        if (is403(err2)) console.warn(`[clickup] 타임엔트리 기능 접근 불가(403) — skip(권한/ClickApp 경계, 커서 무관)`);
        else { opts?.onError?.(); console.error(`[clickup] 타임엔트리 폴백 실패(best-effort, skip):`, err2); }
      }
    } else {
      opts?.onError?.();
      console.error(`[clickup] 타임엔트리 스윕 실패(best-effort, skip):`, err);
    }
  }
  return out;
}

// 커스텀필드 정의 — ClickUp 은 정의가 **레벨별**(list/folder/space/team)이고 각 엔드포인트는 그 레벨 정의만 반환.
//  GET /list/field 만 보면 상위 레벨(스페이스·워크스페이스)에 정의된 필드가 통째로 누락된다(#541 고객사 A 관찰).
export async function getFieldsAt(kind: "team" | "space" | "folder" | "list", id: string): Promise<ClickUpCustomField[]> {
  const res = await clickupFetch<{ fields?: ClickUpCustomField[] }>(`/${kind}/${encodeURIComponent(id)}/field`);
  return res.fields ?? [];
}
export async function getListFields(listId: string): Promise<ClickUpCustomField[]> {
  return getFieldsAt("list", listId);
}

// 스페이스 태그 팔레트(태스크에 안 달린 태그도 보존 — 색/정의 완전).
export async function getSpaceTags(spaceId: string): Promise<ClickUpTag[]> {
  const res = await clickupFetch<{ tags?: ClickUpTag[] }>(`/space/${encodeURIComponent(spaceId)}/tag`);
  return res.tags ?? [];
}


// 포함/제외 필터 적용된 계층 트리. 살아남는 리스트만 뷰/필드정의를 fetch(rate 예산 절약). 빈 폴더/스페이스는 그래도 보존
//  (스페이스 계층 자체가 사용자 요구 — "스페이스가 없자나"). withMeta=false 면 뷰/필드 fetch 생략(빠른 나열).
//  onError: 부분 실패(폴더 나열 등) 통지 — losslessStream 이 커서 동결 판정에 사용(실패한 컨테이너의 태스크가
//  이번 run 나열에서 빠진 채 커서만 전진하는 유실 방지).
export async function enumerateHierarchy(
  teamId: string, opts?: { withMeta?: boolean; onError?: () => void },
): Promise<HierarchySpace[]> {
  const withMeta = opts?.withMeta !== false;
  const onError = opts?.onError ?? (() => {});
  const excluded = await getExcludedListIds();
  const included = await getIncludedListIds();
  const keep = (l: ClickUpList) => !excluded.has(l.id) && (!included || included.has(l.id));

  // 워크스페이스(팀) 레벨 필드 — 1회 수집해 전 리스트에 상속(#541: 정의는 레벨별이라 4레벨 합집합이 완전).
  let teamFields: ClickUpCustomField[] = [];
  if (withMeta) { try { teamFields = await getFieldsAt("team", teamId); } catch (err) { console.error(`[clickup] 팀 필드정의 조회 실패(진행):`, err); } }

  // 리스트 1건 → 메타 hydrate(뷰/필드). inherited=상위(팀→스페이스→폴더) 정의 — 리스트 레벨이 우선(dedup by id).
  const hydrate = async (list: ClickUpList, inherited: ClickUpCustomField[] = []): Promise<HierarchyList> => {
    if (!withMeta) return { list, views: [], fields: [] };
    // 상세 GET 으로 statuses(orderindex)·override_statuses 완전화 — 나열 응답은 orderindex 누락 가능(상태 순서 박제 버그).
    //  실패해도 나열 응답으로 진행(best-effort). 상세엔 space/folder 좌표가 빠질 수 있어 나열 응답 값을 보존 병합.
    try {
      const full = await getList(list.id);
      list = { ...full, folder: list.folder ?? full.folder, space: list.space ?? full.space, archived: list.archived ?? full.archived };
    } catch (err) { console.error(`[clickup] 리스트 ${list.id} 상세 조회 실패(나열 응답으로 진행):`, err); }
    let views: ClickUpView[] = [];
    let listFields: ClickUpCustomField[] = [];
    try { views = await getListViews(list.id); } catch (err) { console.error(`[clickup] 리스트 ${list.id} 뷰 조회 실패:`, err); }
    try { listFields = await getListFields(list.id); } catch (err) { console.error(`[clickup] 리스트 ${list.id} 필드정의 조회 실패:`, err); }
    const byId = new Map<string, ClickUpCustomField>();
    for (const f of [...inherited, ...listFields]) if (f?.id) byId.set(f.id, f); // 리스트 레벨이 상위 정의를 덮음
    return { list, views, fields: [...byId.values()] };
  };

  const out: HierarchySpace[] = [];
  for (const spaceLite of await listSpaces(teamId)) {
    // 스페이스 status set/피처 완전화(리스트 override_statuses=false 상속 판정).
    let space: ClickUpSpace = spaceLite;
    try { space = await getSpace(spaceLite.id); } catch (err) { console.error(`[clickup] 스페이스 ${spaceLite.id} 상세 실패:`, err); }
    let spaceFields: ClickUpCustomField[] = [];
    if (withMeta) { try { spaceFields = await getFieldsAt("space", space.id); } catch (err) { console.error(`[clickup] 스페이스 ${space.id} 필드정의 조회 실패(진행):`, err); } }
    const spaceInherited = [...teamFields, ...spaceFields];

    const folders: HierarchyFolder[] = [];
    try {
      // active + archived 2패스(#541 — 보관 폴더 안 리스트도 수렴). id dedup.
      const seenFolderIds = new Set<string>();
      const folderBatches: Array<{ f: ClickUpFolder; archived: boolean }> = [];
      for (const f of await listFolders(space.id)) { if (!seenFolderIds.has(f.id)) { seenFolderIds.add(f.id); folderBatches.push({ f, archived: false }); } }
      try {
        for (const f of await listFolders(space.id, { archived: true })) {
          if (!seenFolderIds.has(f.id)) { seenFolderIds.add(f.id); folderBatches.push({ f: { ...f, archived: true }, archived: true }); }
        }
      } catch (err) { onError(); console.error(`[clickup] 스페이스 ${space.id} 보관 폴더 나열 실패(active 만 진행):`, err); }

      for (const { f: folder } of folderBatches) {
        // 폴더의 리스트: 폴더 응답에 inline lists 있으면 그것, 없으면 개별 조회.
        const rawLists = (folder.lists && folder.lists.length ? folder.lists : await listFolderLists(folder.id)).filter(keep);
        let folderFields: ClickUpCustomField[] = [];
        if (withMeta && rawLists.length) { try { folderFields = await getFieldsAt("folder", folder.id); } catch (err) { console.error(`[clickup] 폴더 ${folder.id} 필드정의 조회 실패(진행):`, err); } }
        const lists: HierarchyList[] = [];
        for (const l of rawLists) lists.push(await hydrate({ ...l, folder, space: { id: space.id, name: space.name } }, [...spaceInherited, ...folderFields]));
        // 폴더 스코프 뷰(무손실) — withMeta 시에만(rate 예산).
        let fviews: ClickUpView[] = [];
        if (withMeta) { try { fviews = await getScopeViews("folder", folder.id); } catch (err) { console.error(`[clickup] 폴더 ${folder.id} 뷰 조회 실패:`, err); } }
        folders.push({ folder, lists, views: fviews });
      }
    } catch (err) {
      onError();
      console.error(`[clickup] 스페이스 ${space.id} 폴더 나열 실패, folderless 만 진행:`, err);
    }

    const folderlessLists: HierarchyList[] = [];
    const seenListIds = new Set<string>();
    for (const l of await listSpaceLists(space.id, { archived: false })) {
      if (!keep(l) || seenListIds.has(l.id)) continue;
      seenListIds.add(l.id);
      folderlessLists.push(await hydrate({ ...l, space: { id: space.id, name: space.name } }, spaceInherited));
    }
    for (const l of await listSpaceLists(space.id, { archived: true })) {
      if (!keep(l) || seenListIds.has(l.id)) continue;
      seenListIds.add(l.id);
      folderlessLists.push(await hydrate({ ...l, archived: true, space: { id: space.id, name: space.name } }, spaceInherited));
    }
    // 폴더 경유로 이미 수집된 리스트는 folderless 중복 제거(위 hydrate 비용은 keep 필터 뒤라 무해).
    const folderListIds = new Set(folders.flatMap((f) => f.lists.map((hl) => hl.list.id)));
    const dedupedFolderless = folderlessLists.filter((hl) => !folderListIds.has(hl.list.id));

    // 스페이스 스코프 뷰(무손실).
    let sviews: ClickUpView[] = [];
    if (withMeta) { try { sviews = await getScopeViews("space", space.id); } catch (err) { console.error(`[clickup] 스페이스 ${space.id} 뷰 조회 실패:`, err); } }

    out.push({ space, folders, folderlessLists: dedupedFolderless, views: sviews });
  }
  return out;
}

// ── 쓰기 (clickup-push.ts 가 사용하는 얇은 API 래퍼 — 오케스트레이션·검증은 push 쪽) ──

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

// 허용(=싱크 대상) 리스트 나열 — enumerateHierarchy 트리를 평탄화·dedup. 태스크 백필/증분의 리스트 스코프.
//  space/folder 부착 상태로 반환(list.space/list.folder) — 미러가 계층을 재구성. withMeta=false(뷰/필드 fetch 생략, 빠름).
export async function enumerateLists(teamId: string): Promise<ClickUpList[]> {
  const tree = await enumerateHierarchy(teamId, { withMeta: false });
  const byId = new Map<string, ClickUpList>();
  for (const s of tree) {
    for (const f of s.folders) for (const hl of f.lists) byId.set(hl.list.id, hl.list);
    for (const hl of s.folderlessLists) byId.set(hl.list.id, hl.list);
  }
  return [...byId.values()];
}
