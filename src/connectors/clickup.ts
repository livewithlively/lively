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
import { resolveConnectorConfig } from "./config.js";

export type { Connector, RawItem, BackfillOpts };

// ── ClickUp API 타입(부분) — 무손실 이관에 쓰는 필드 정의. 미정의 필드는 raw(원본 통째)에 보존되므로 손실 0. ──
export interface ClickUpUser {
  id: number;
  username?: string | null;
  email?: string | null;
  color?: string | null;
  profilePicture?: string | null;
  initials?: string | null;
}

export interface ClickUpStatus {
  id?: string;
  status?: string;
  color?: string | null;
  orderindex?: number | null;
  type?: string; // open | custom | done | closed
}

export interface ClickUpTag {
  name: string;
  tag_fg?: string | null;
  tag_bg?: string | null;
  creator?: number | null;
}

export interface ClickUpChecklistItem {
  id: string;
  name?: string;
  orderindex?: number | null;
  assignee?: ClickUpUser | number | null; // GET 은 유저객체, 리스트는 bare int 인 경우가 있어 union
  resolved?: boolean;
  parent?: string | null; // 중첩 체크리스트 항목 부모
  date_created?: string | null;
  children?: ClickUpChecklistItem[];
}

export interface ClickUpChecklist {
  id: string;
  name?: string;
  orderindex?: number | null;
  resolved?: number | null;
  unresolved?: number | null;
  items?: ClickUpChecklistItem[];
}

export interface ClickUpAttachment {
  id: string;
  title?: string | null;
  date?: string | null;
  extension?: string | null;
  mimetype?: string | null;
  size?: number | null;
  url?: string | null;
  url_w_query?: string | null;
  url_w_host?: string | null;
  thumbnail_large?: string | null;
  thumbnail_medium?: string | null;
  thumbnail_small?: string | null;
  parent?: string | null;
  is_folder?: boolean | null;
}

export interface ClickUpCustomField {
  id: string;
  name?: string;
  type?: string; // text|textarea|number|money|date|drop_down|labels|checkbox|url|email|phone|rating|progress|tasks|users|emoji|location|short_text|list_relationship|…
  type_config?: Record<string, unknown> | null; // 옵션/설정(드롭다운 options 등 — value 디코딩에 필수)
  value?: unknown; // 인코딩된 값(type 별 상이) — 미설정 시 필드 자체가 omit
  value_richtext?: unknown;
  value_markdown?: string | null;
  date_created?: string | null;
  hide_from_guests?: boolean;
  required?: boolean;
}

export interface ClickUpTask {
  id: string;
  custom_id?: string | null;
  custom_item_id?: number | null; // 태스크 타입(0=Task, 1=Milestone, …)
  name?: string;
  description?: string | null;
  text_content?: string | null;
  markdown_description?: string | null; // ?include_markdown_description=true 시에만 — 서식 무손실의 진실
  status?: ClickUpStatus | null;
  orderindex?: string | number | null;
  creator?: ClickUpUser | null;
  assignees?: ClickUpUser[];
  group_assignees?: ClickUpUser[];
  watchers?: ClickUpUser[];
  priority?: { id?: string | number | null; priority?: string | null; color?: string | null } | null;
  due_date?: string | null; // ms epoch 문자열
  start_date?: string | null; // ms epoch 문자열
  date_created?: string | null; // ms epoch 문자열
  date_updated?: string | null; // ms epoch 문자열
  date_closed?: string | null;
  date_done?: string | null;
  time_estimate?: number | null; // ms
  time_spent?: number | null; // ms
  points?: number | null;
  archived?: boolean;
  tags?: ClickUpTag[];
  checklists?: ClickUpChecklist[];
  attachments?: ClickUpAttachment[];
  custom_fields?: ClickUpCustomField[];
  dependencies?: unknown[];
  linked_tasks?: unknown[];
  parent?: string | null; // 부모 태스크 id (서브태스크)
  top_level_parent?: string | null; // 최상위 부모 태스크 id (깊이 판정 — parent 와 같으면 부모가 top-level Task)
  subtasks?: ClickUpTask[]; // ?include_subtasks=true
  list?: { id: string; name?: string } | null;
  folder?: { id: string; name?: string; hidden?: boolean } | null;
  space?: { id: string; name?: string } | null;
  team_id?: string;
  url?: string;
}

export interface ClickUpFolder {
  id: string;
  name?: string;
  hidden?: boolean;
  archived?: boolean;
  orderindex?: number | null;
  task_count?: string | number | null;
  lists?: ClickUpList[];
}

export interface ClickUpSpace {
  id: string;
  name?: string;
  color?: string | null;
  private?: boolean;
  archived?: boolean;
  statuses?: ClickUpStatus[]; // 스페이스 기본 status set(리스트가 override_statuses=false 면 상속)
  multiple_assignees?: boolean;
  features?: Record<string, unknown> | null; // due_dates/time_tracking/tags/custom_fields/checklists/… 어떤 데이터가 존재하는지 지배
}

export interface ClickUpList {
  id: string;
  name?: string;
  /** 리스트 설명(비어 있으면 ""/null) */
  content?: string | null;
  orderindex?: number | null;
  archived?: boolean;
  statuses?: ClickUpStatus[]; // 리스트 status set(override_statuses=true 면 리스트 고유, false 면 스페이스 상속)
  override_statuses?: boolean;
  task_count?: number | null;
  start_date?: string | null;
  due_date?: string | null;
  space?: { id: string; name?: string } | null;
  folder?: ClickUpFolder | null;
}

export interface ClickUpView {
  id: string;
  name?: string;
  type?: string; // list|board|calendar|gantt|table|timeline|workload|activity|map|conversation|doc
  parent?: { id?: string; type?: number } | null;
  grouping?: Record<string, unknown> | null;
  divide?: Record<string, unknown> | null;
  sorting?: Record<string, unknown> | null;
  filters?: Record<string, unknown> | null;
  columns?: Record<string, unknown> | null; // { fields: [{ field, idx, width, hidden, name }] }
  team_sidebar?: Record<string, unknown> | null;
  settings?: Record<string, unknown> | null;
  orderindex?: string | number | null;
  protected?: boolean;
}

export interface ClickUpTeam {
  id: string;
  name?: string;
  members?: { user?: ClickUpUser }[];
}

// 댓글(GET /task/:id/comment). comment_text=평문, comment[]=구조화 블록(서식·멘션·이미지) — raw 백스톱 대상.
export interface ClickUpComment {
  id: string | number;
  comment?: unknown[]; // 구조화 블록(무손실은 raw 로)
  comment_text?: string | null;
  user?: ClickUpUser | null;
  resolved?: boolean;
  assignee?: ClickUpUser | null;
  assigned_by?: ClickUpUser | null;
  reactions?: unknown[];
  date?: string | null; // ms epoch 문자열
  reply_count?: string | number | null;
}

// 타임엔트리(GET /team/:id/time_entries). duration ms, start/end ms epoch.
export interface ClickUpTimeEntry {
  id: string | number;
  task?: { id?: string; name?: string } | null;
  user?: ClickUpUser | null;
  start?: string | number | null;
  end?: string | number | null;
  duration?: string | number | null; // ms(실행중이면 음수)
  description?: string | null;
  billable?: boolean;
  source?: string | null;
  at?: string | number | null; // 마지막 수정 ms
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

// 상태 라벨 → settings.statuses[].key 슬러그. 유니코드 보존(한글 상태명) — 미러가 key(리스트 설정)와
//  status_raw(태스크)를 **둘 다** 이 함수로 쓰므로 자기일관(웹 편집기 genKey 와 달라도 무방 — key 는 불투명 식별자).
export function clickUpStatusKey(label?: string | null): string {
  const base = String(label ?? "status").toLowerCase().normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return base || "status";
}

// ClickUp status.type → #475 리스트 설정 카테고리(active|done|closed). open/custom=active.
export function clickUpUiCategory(type?: string | null): "active" | "done" | "closed" {
  if (type === "done") return "done";
  if (type === "closed") return "closed";
  return "active";
}

// 리스트의 유효 status set — override_statuses=true(또는 스페이스 set 부재) 면 리스트 고유, 아니면 스페이스 상속.
//  #475 UI 계약 shape [{key,label,color,category}] 로 정규화(orderindex 순). key 충돌은 -2 접미(라벨 유일 전제 방어).
export function effectiveStatusDefs(list: ClickUpList, space?: ClickUpSpace | null): Array<{ key: string; label: string; color: string | null; category: string }> {
  const src = (list.override_statuses || !(space?.statuses?.length) ? list.statuses : space?.statuses) ?? list.statuses ?? space?.statuses ?? [];
  // orderindex 정렬 — 비유한(누락·이상 문자열)은 배열 인덱스 폴백(응답 배열 순서 = ClickUp 표시 순서의 최선 근사).
  const oi = (s: ClickUpStatus, idx: number) => { const n = Number(s.orderindex); return Number.isFinite(n) ? n : idx; };
  const sorted = src.map((s, idx) => ({ s, k: oi(s, idx) })).sort((a, b) => a.k - b.k).map((x) => x.s);
  const seen = new Set<string>();
  return sorted.filter((s) => s.status).map((s) => {
    let key = clickUpStatusKey(s.status);
    let n = 2;
    while (seen.has(key)) key = `${clickUpStatusKey(s.status)}-${n++}`;
    seen.add(key);
    return { key, label: String(s.status), color: s.color ?? null, category: clickUpUiCategory(s.type) };
  });
}

// ── 계층 → RawItem 변환 (무손실 이관 #541) ──
//  external_id 프리픽스: project_folder 테이블은 Space 와 Folder 를 함께 담으므로 'space:<id>'/'folder:<id>' 로
//  좌표를 분리한다(숫자 id 시퀀스 충돌 방어). 리스트/뷰/태스크는 각자 전용 테이블이라 raw id 그대로.
export function spaceToRawItem(space: ClickUpSpace, ctx: ToRawItemCtx): RawItem {
  return {
    type: "space",
    provenance: {
      category: "collab_tool", system: "clickup", instance: ctx.teamId,
      external_id: `space:${space.id}`,
    },
    title: space.name ?? `Space ${space.id}`,
    fields: {
      clickup_id: space.id,
      color: space.color ?? null,
      private: !!space.private,
      archived: !!space.archived,
      statuses: space.statuses ?? [],
      features: space.features ?? null,
    },
    raw: space,
  };
}

export function folderToRawItem(folder: ClickUpFolder, spaceId: string, ctx: ToRawItemCtx): RawItem {
  return {
    type: "folder",
    provenance: {
      category: "collab_tool", system: "clickup", instance: ctx.teamId,
      external_id: `folder:${folder.id}`,
    },
    parent_external_id: `space:${spaceId}`,
    title: folder.name ?? `Folder ${folder.id}`,
    fields: {
      clickup_id: folder.id,
      hidden: !!folder.hidden,
      archived: !!folder.archived,
      orderindex: folder.orderindex ?? null,
      task_count: folder.task_count ?? null,
    },
    raw: { ...folder, lists: undefined }, // lists 는 개별 list RawItem 으로 — 백스톱 중복 제거
  };
}

export function listToRawItem(hl: HierarchyList, space: ClickUpSpace, ctx: ToRawItemCtx): RawItem {
  const list = hl.list;
  // 폴더 소속이면 폴더가 부모, folderless(또는 hidden 폴더)는 스페이스가 부모(Space 폴더 바로 아래).
  const parent = list.folder?.id && !list.folder.hidden ? `folder:${list.folder.id}` : `space:${space.id}`;
  return {
    type: "list",
    provenance: {
      category: "collab_tool", system: "clickup", instance: ctx.teamId,
      external_id: list.id,
    },
    parent_external_id: parent,
    title: list.name ?? `List ${list.id}`,
    fields: {
      status_defs: effectiveStatusDefs(list, space), // #475 settings.statuses 계약 shape
      override_statuses: !!list.override_statuses,
      content: list.content ?? null,
      orderindex: list.orderindex ?? null,
      archived: !!list.archived,
      task_count: list.task_count ?? null,
      start_date: list.start_date ?? null,
      due_date: list.due_date ?? null,
      space_id: space.id, space_name: space.name ?? null,
      folder_id: list.folder?.id ?? null, folder_name: list.folder?.name ?? null,
      field_defs: hl.fields, // 리스트 커스텀필드 정의(값 없는 필드 포함 완전 회수)
    },
    raw: list,
  };
}

export function viewToRawItem(view: ClickUpView, scope: { kind: "list" | "space" | "folder"; id: string }, ctx: ToRawItemCtx): RawItem {
  return {
    type: "view",
    provenance: {
      category: "collab_tool", system: "clickup", instance: ctx.teamId,
      external_id: `view:${view.id}`,
    },
    parent_external_id: scope.kind === "list" ? scope.id : `${scope.kind}:${scope.id}`,
    title: view.name ?? `View ${view.id}`,
    fields: {
      view_type: view.type ?? "list",
      scope_kind: scope.kind,
      config: {
        columns: view.columns ?? null,
        grouping: view.grouping ?? null,
        divide: view.divide ?? null,
        sorting: view.sorting ?? null,
        filters: view.filters ?? null,
        settings: view.settings ?? null,
        team_sidebar: view.team_sidebar ?? null,
      },
      orderindex: view.orderindex ?? null,
      protected: !!view.protected,
    },
    raw: view,
  };
}

export function commentToRawItem(c: ClickUpComment, taskId: string, ctx: ToRawItemCtx, replyToExternalId?: string): RawItem {
  const user = c.user ?? undefined;
  const email = user?.email?.trim().toLowerCase() || undefined;
  return {
    type: "comment",
    provenance: {
      category: "collab_tool", system: "clickup", instance: ctx.teamId,
      external_id: `comment:${c.id}`,
    },
    actor: user ? {
      external_id: email ?? String(user.id),
      display_name: user.username ?? undefined,
      email: email,
    } : undefined,
    parent_external_id: taskId, // 귀속 태스크(project 행 해소용)
    body: c.comment_text ?? "",
    occurred_at: msToIso(typeof c.date === "string" ? c.date : c.date != null ? String(c.date) : undefined),
    fields: {
      task_external_id: taskId,
      reply_to_external_id: replyToExternalId ?? null,
      resolved: !!c.resolved,
      author: user ? toActorShape(user) : null,
      reactions: c.reactions ?? [],
      assignee: c.assignee ? toActorShape(c.assignee) : null,
    },
    raw: c,
  };
}

export function timeEntryToRawItem(t: ClickUpTimeEntry, ctx: ToRawItemCtx): RawItem | null {
  const taskId = t.task?.id;
  if (!taskId) return null; // 태스크 무귀속 엔트리는 우리 모델 밖(raw 유실 아님 — 다음 스윕 재수집)
  const user = t.user ?? undefined;
  const email = user?.email?.trim().toLowerCase() || undefined;
  const durMs = Number(t.duration ?? 0);
  return {
    type: "time",
    provenance: {
      category: "collab_tool", system: "clickup", instance: ctx.teamId,
      external_id: `time:${t.id}`,
    },
    parent_external_id: taskId,
    occurred_at: msToIso(t.start != null ? String(t.start) : undefined),
    fields: {
      task_external_id: taskId,
      member: email ?? (user ? String(user.id) : null),
      started_at: msToIso(t.start != null ? String(t.start) : undefined) ?? null,
      ended_at: msToIso(t.end != null ? String(t.end) : undefined) ?? null,
      duration_seconds: Number.isFinite(durMs) && durMs > 0 ? Math.round(durMs / 1000) : null,
      note: t.description ?? null,
    },
    raw: t,
  };
}

// 유저 객체 → 정규 assignee/actor shape(이메일 소문자 컨벤션 + 표시 메타 보존).
function toActorShape(u: ClickUpUser): { id: number; email: string | null; username: string | null; color: string | null; avatar: string | null; initials: string | null } {
  return {
    id: u.id,
    email: u.email?.trim().toLowerCase() ?? null,
    username: u.username ?? null,
    color: u.color ?? null,
    avatar: u.profilePicture ?? null,
    initials: u.initials ?? null,
  };
}

// 인라인 이미지/첨부 URL 을 markdown 에서 긁어 attachments 로 보강(GET /task 의 attachments[] 와 dedup).
//  ClickUp 인라인 이미지는 ![](https://.../clickup-attachments.com/...) 형태 — attachments[] 에 안 잡히는 케이스 커버(무손실).
const ATTACHMENT_URL_RE = /https?:\/\/[^\s)"']*(?:clickup-attachments\.com|attachments\.clickup\.com)[^\s)"']*/gi;
export function extractInlineAttachments(markdown?: string | null): Array<{ external_id: string | null; url: string; title: string | null; source: string }> {
  if (!markdown) return [];
  const seen = new Set<string>();
  const out: Array<{ external_id: string | null; url: string; title: string | null; source: string }> = [];
  for (const m of markdown.matchAll(ATTACHMENT_URL_RE)) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    // 파일명 추정(경로 마지막 세그먼트, 쿼리 제거).
    let title: string | null = null;
    try { const u = new URL(url); title = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "") || null; } catch { /* keep null */ }
    out.push({ external_id: null, url, title, source: "clickup_inline" });
  }
  return out;
}

export function toRawItem(task: ClickUpTask, ctx: ToRawItemCtx): RawItem {
  const { teamId } = ctx;
  const creator = task.creator ?? undefined;
  // 액터 키: 이메일 소문자 우선(이메일-as-external_id 컨벤션 — daon manual 신원 매치),
  // 이메일 부재 시 숫자 id 문자열 폴백.
  const email = creator?.email?.trim().toLowerCase() || undefined;
  const actorExternalId = email ?? (creator ? String(creator.id) : undefined);

  // 본문: markdown_description(서식·불릿·들여쓰기 무손실) 우선 → description(평문) → text_content 폴백.
  //  마이그레이션 손실 1순위였던 "- 불릿/탭 들여쓰기"는 markdown_description 에만 있다(hydration 필수).
  const body = task.markdown_description || task.description || task.text_content || "";

  // 첨부: hydration 의 attachments[] + 본문 인라인 이미지 파싱을 URL 로 dedup 병합(무손실).
  const nativeAtt = (task.attachments ?? []).map((a) => ({
    external_id: a.id ?? null,
    title: a.title ?? null,
    url: a.url_w_query || a.url || a.url_w_host || null,
    mimetype: a.mimetype ?? null,
    extension: a.extension ?? null,
    size: a.size ?? null,
    thumbnail: a.thumbnail_large || a.thumbnail_medium || a.thumbnail_small || null,
    parent_type: "task",
    source: "clickup",
    raw: a as unknown,
  }));
  const attUrls = new Set(nativeAtt.map((a) => a.url).filter(Boolean) as string[]);
  const inlineAtt = extractInlineAttachments(body)
    .filter((a) => !attUrls.has(a.url))
    .map((a) => ({ external_id: a.external_id, title: a.title, url: a.url, mimetype: null as string | null, extension: null as string | null, size: null as number | null, thumbnail: null as string | null, parent_type: "task_inline", source: a.source, raw: null as unknown }));
  const attachments = [...nativeAtt, ...inlineAtt];

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
    body,
    occurred_at: msToIso(task.date_created),
    updated_at: msToIso(task.date_updated),
    // 소스 고유 필드 — 폴/에코가 같은 shape 로 수렴(ON CONFLICT 가 fields 전체 교체). raw 가 최종 무손실 백스톱.
    fields: {
      // 상태(커스텀 status 무손실) — status_raw=원문 라벨, color/orderindex 보존, category=정규 투영.
      status: task.status?.status ?? null,
      status_type: task.status?.type ?? null,
      status_color: task.status?.color ?? null,
      status_orderindex: task.status?.orderindex ?? null,
      status_category: clickUpStatusCategory(task.status?.type),
      // 담당자/워처(계정 메타 보존 → 미러가 email→org_member 해소).
      assignees: (task.assignees ?? []).map(toActorShape),
      group_assignees: (task.group_assignees ?? []).map(toActorShape),
      watchers: (task.watchers ?? []).map(toActorShape),
      // 우선순위(id 맵 1=urgent..4=low + 라벨 + 색).
      priority: task.priority ? { id: task.priority.id ?? null, label: task.priority.priority ?? null, color: task.priority.color ?? null } : null,
      // 날짜(ISO + 원본 ms 병존 — 시각정밀 무손실).
      due_date: msToIso(task.due_date) ?? null,
      start_date: msToIso(task.start_date) ?? null,
      date_closed: msToIso(task.date_closed) ?? null,
      date_done: msToIso(task.date_done) ?? null,
      due_date_ms: task.due_date ?? null,
      start_date_ms: task.start_date ?? null,
      time_estimate: task.time_estimate ?? null,
      time_spent: task.time_spent ?? null,
      points: task.points ?? null,
      custom_item_id: task.custom_item_id ?? null,
      custom_id: task.custom_id ?? null,
      archived: !!task.archived,
      // 계층 좌표(미러가 list_id 해소 + settings.space/folder 백스톱).
      list_id: task.list?.id ?? null,
      list_name: task.list?.name ?? null,
      folder_id: task.folder?.id ?? null,
      folder_name: task.folder?.name ?? null,
      space_id: task.space?.id ?? null,
      space_name: task.space?.name ?? null,
      // 태그(name 정체성 + fg/bg 색).
      tags: (task.tags ?? []).map((t) => ({ name: t.name, fg: t.tag_fg ?? null, bg: t.tag_bg ?? null })),
      // 체크리스트(중첩 items 보존 — assignee 는 유저객체/bare int union).
      checklists: (task.checklists ?? []).map((c) => ({
        external_id: c.id, name: c.name ?? null, orderindex: c.orderindex ?? null,
        items: (c.items ?? []).map((i) => ({
          external_id: i.id, name: i.name ?? null, resolved: !!i.resolved, orderindex: i.orderindex ?? null,
          parent: i.parent ?? null,
          assignee: typeof i.assignee === "object" && i.assignee ? toActorShape(i.assignee as ClickUpUser) : (i.assignee != null ? { id: i.assignee as number, email: null, username: null } : null),
        })),
      })),
      // 커스텀 필드(값+정의 type_config 보존 — 미러가 task_field/value 로 투영, 미설정 필드는 omit 이라 손실 없음).
      custom_fields: (task.custom_fields ?? []).map((cf) => ({
        external_id: cf.id, name: cf.name ?? null, type: cf.type ?? null,
        type_config: cf.type_config ?? null, value: cf.value ?? null, value_markdown: cf.value_markdown ?? null,
      })),
      // 첨부(hydration + 인라인 병합).
      attachments,
      // 링크/의존(무손실 백스톱 — raw 에도 있으나 편의 노출).
      dependencies: task.dependencies ?? [],
      linked_tasks: task.linked_tasks ?? [],
      url: task.url ?? null,
    },
    raw: task, // ★ 최종 무손실 백스톱 — 위 typed 추출에서 빠진 어떤 필드도 여기 원본 그대로 보존.
  };
}

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
  const q = new URLSearchParams({
    start_date: String(opts?.sinceMs ?? 0),
    end_date: String(Date.now() + 24 * 3600 * 1000),
  });
  if (memberIds.length) q.set("assignee", memberIds.join(","));
  try {
    const res = await clickupFetch<{ data?: ClickUpTimeEntry[] }>(`/team/${teamId}/time_entries?${q.toString()}`);
    out.push(...(res.data ?? []));
  } catch (err) {
    opts?.onError?.();
    console.error(`[clickup] 타임엔트리 스윕 실패(best-effort, skip):`, err);
  }
  return out;
}

// 리스트 커스텀필드 정의(값 없는 필드는 태스크 custom_fields[] 에서 omit 되므로 정의는 여기서만 완전 회수).
export async function getListFields(listId: string): Promise<ClickUpCustomField[]> {
  const res = await clickupFetch<{ fields?: ClickUpCustomField[] }>(`/list/${encodeURIComponent(listId)}/field`);
  return res.fields ?? [];
}

// 스페이스 태그 팔레트(태스크에 안 달린 태그도 보존 — 색/정의 완전).
export async function getSpaceTags(spaceId: string): Promise<ClickUpTag[]> {
  const res = await clickupFetch<{ tags?: ClickUpTag[] }>(`/space/${encodeURIComponent(spaceId)}/tag`);
  return res.tags ?? [];
}

// ── 계층 트리(무손실) — Space›Folder›List 를 status/뷰/필드정의와 함께 보존해 반환. enumerateLists 는 이걸 평탄화. ──
export interface HierarchyList { list: ClickUpList; views: ClickUpView[]; fields: ClickUpCustomField[] }
export interface HierarchyFolder { folder: ClickUpFolder; lists: HierarchyList[]; views: ClickUpView[] }
export interface HierarchySpace { space: ClickUpSpace; folders: HierarchyFolder[]; folderlessLists: HierarchyList[]; views: ClickUpView[] }

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

  // 리스트 1건 → 메타 hydrate(뷰/필드). best-effort(실패해도 리스트 자체는 보존).
  const hydrate = async (list: ClickUpList): Promise<HierarchyList> => {
    if (!withMeta) return { list, views: [], fields: [] };
    // 상세 GET 으로 statuses(orderindex)·override_statuses 완전화 — 나열 응답은 orderindex 누락 가능(상태 순서 박제 버그).
    //  실패해도 나열 응답으로 진행(best-effort). 상세엔 space/folder 좌표가 빠질 수 있어 나열 응답 값을 보존 병합.
    try {
      const full = await getList(list.id);
      list = { ...full, folder: list.folder ?? full.folder, space: list.space ?? full.space, archived: list.archived ?? full.archived };
    } catch (err) { console.error(`[clickup] 리스트 ${list.id} 상세 조회 실패(나열 응답으로 진행):`, err); }
    let views: ClickUpView[] = [];
    let fields: ClickUpCustomField[] = [];
    try { views = await getListViews(list.id); } catch (err) { console.error(`[clickup] 리스트 ${list.id} 뷰 조회 실패:`, err); }
    try { fields = await getListFields(list.id); } catch (err) { console.error(`[clickup] 리스트 ${list.id} 필드정의 조회 실패:`, err); }
    return { list, views, fields };
  };

  const out: HierarchySpace[] = [];
  for (const spaceLite of await listSpaces(teamId)) {
    // 스페이스 status set/피처 완전화(리스트 override_statuses=false 상속 판정).
    let space: ClickUpSpace = spaceLite;
    try { space = await getSpace(spaceLite.id); } catch (err) { console.error(`[clickup] 스페이스 ${spaceLite.id} 상세 실패:`, err); }

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
        const lists: HierarchyList[] = [];
        for (const l of rawLists) lists.push(await hydrate({ ...l, folder, space: { id: space.id, name: space.name } }));
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
      folderlessLists.push(await hydrate({ ...l, space: { id: space.id, name: space.name } }));
    }
    for (const l of await listSpaceLists(space.id, { archived: true })) {
      if (!keep(l) || seenListIds.has(l.id)) continue;
      seenListIds.add(l.id);
      folderlessLists.push(await hydrate({ ...l, archived: true, space: { id: space.id, name: space.name } }));
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

// ══════════════════════════════════════════════════════════════════════════
// ── 무손실 스트림(#541) — 계층(Space→Folder→List→View) → 태스크(hydration·부모우선·미지 서브태스크 수렴)
//    → 태스크별 댓글 → 팀 타임엔트리. run-backfill(full)·run-sync(incr) 공용 단일 경로.
//  · 계층은 since 무관 매 run 재수집(멱등 upsert·저비용) — 커스텀상태/뷰 변경이 항상 수렴.
//  · 태스크는 hydration(getTaskFull) 필수 — markdown_description(서식)·attachments·custom_fields 값·subtasks 는
//    리스트 나열 응답에 없다. 태스크당 1콜 + 댓글 1콜(rate 100/min 은 clickupFetch 선제대기가 흡수).
//  · yield 순서가 미러의 부모 해소를 보장: 컨테이너 먼저, 태스크는 부모 먼저(위상), 댓글은 귀속 태스크 뒤.
// ══════════════════════════════════════════════════════════════════════════
export interface LosslessOpts {
  sinceMs?: number;       // 증분 — 태스크 date_updated_gt(계층·뷰는 항상 재수집)
  comments?: boolean;     // 기본 true
  timeEntries?: boolean;  // 기본 true
  hydrate?: boolean;      // 기본 true(false=얕은 나열만 — 디버그용)
  /** 수집(fetch) 실패 집계 — 소비자(run-sync)가 커서 동결 판정에 사용('커서는 모든 단계 성공 후에만 전진' 불변식).
   *  스트림 내부 catch 는 부분 수집을 계속하되(가능한 만큼 적재) 여기에 실패를 남긴다 — 삼키고 성공 위장 금지. */
  stats?: { fetchFailures: number };
}

export async function* losslessStream(opts?: LosslessOpts): AsyncIterable<RawItem> {
  const team = await getTeam();
  const teamId = team.id;
  const ctx: ToRawItemCtx = { teamId };
  const withComments = opts?.comments !== false;
  const withTime = opts?.timeEntries !== false;
  const doHydrate = opts?.hydrate !== false;
  const stats = opts?.stats;
  const bumpFail = () => { if (stats) stats.fetchFailures++; };
  const sinceMs = opts?.sinceMs !== undefined && Number.isFinite(opts.sinceMs) ? opts.sinceMs : undefined;
  // 스코프 필터(#541 리뷰) — 컨테이너 나열(enumerateHierarchy)뿐 아니라 hydration 이 드러내는 부모/이동 서브태스크에도
  //  동일 적용. 제외(denylist)·미포함(allowlist 밖) 리스트의 태스크가 위상 재귀로 새어 들어오는 걸 막는다.
  const excluded = await getExcludedListIds();
  const included = await getIncludedListIds();
  const listAllowed = (listId?: string | null) =>
    !listId || (!excluded.has(listId) && (!included || included.has(listId)));

  // ① 계층 — Space → Folder → List → View 순서(미러 부모 해소 순서 의존). 부분 실패는 stats 로(커서 동결).
  const tree = await enumerateHierarchy(teamId, { withMeta: true, onError: bumpFail });
  const allLists: ClickUpList[] = [];
  for (const s of tree) {
    yield spaceToRawItem(s.space, ctx);
    for (const f of s.folders) yield folderToRawItem(f.folder, s.space.id, ctx);
    for (const f of s.folders) for (const hl of f.lists) { allLists.push(hl.list); yield listToRawItem(hl, s.space, ctx); }
    for (const hl of s.folderlessLists) { allLists.push(hl.list); yield listToRawItem(hl, s.space, ctx); }
    for (const v of s.views) yield viewToRawItem(v, { kind: "space", id: s.space.id }, ctx);
    for (const f of s.folders) for (const v of f.views) yield viewToRawItem(v, { kind: "folder", id: f.folder.id }, ctx);
    for (const f of s.folders) for (const hl of f.lists) for (const v of hl.views) yield viewToRawItem(v, { kind: "list", id: hl.list.id }, ctx);
    for (const hl of s.folderlessLists) for (const v of hl.views) yield viewToRawItem(v, { kind: "list", id: hl.list.id }, ctx);
  }

  // ② 태스크 얕은 나열 — full=리스트별 active+archived, incr=team date_updated_gt + per-list archived 패스.
  //  실패는 부분 수집 계속 + stats 집계(커서 동결 근거 — 실패 윈도가 커서에 덮여 영구 유실되는 것 방지).
  const shallow = new Map<string, ClickUpTask>();
  if (sinceMs !== undefined) {
    try {
      for (const t of await fetchTeamTasks(teamId, { dateUpdatedGt: sinceMs, listIds: allLists.map((l) => l.id) })) shallow.set(t.id, t);
    } catch (err) { bumpFail(); console.error(`[clickup] 팀 증분 폴 실패(archived 패스만 진행):`, err); }
    for (const l of allLists) {
      try {
        for (const t of await fetchListTasks(l.id, { archived: true, dateUpdatedGt: sinceMs })) if (!shallow.has(t.id)) shallow.set(t.id, t);
      } catch (err) { bumpFail(); console.error(`[clickup] 리스트 ${l.id} archived 증분 실패, skip:`, err); }
    }
  } else {
    for (const l of allLists) {
      try {
        for (const t of await fetchListTasks(l.id, {})) shallow.set(t.id, t);
        for (const t of await fetchListTasks(l.id, { archived: true })) if (!shallow.has(t.id)) shallow.set(t.id, t);
      } catch (err) { bumpFail(); console.error(`[clickup] 리스트 ${l.id} 백필 중단(부분 수집됨):`, err); }
    }
  }

  // ③ hydration + 부모우선(위상) + 미지 서브태스크 수렴 + 댓글.
  //  hydration 실패는 **skip + 실패 집계** — 얕은 응답 폴백 금지(#541 리뷰): 얕은 응답엔 markdown 본문·첨부·
  //  커스텀필드 값이 없어, 폴백을 미러에 흘리면 파괴적 reconcile(첨부 삭제·본문 다운그레이드)이 기존 무손실
  //  데이터를 훼손한다. skip+커서 동결이면 다음 run 이 같은 윈도를 재수화해 무손상 수렴.
  const emitted = new Set<string>();
  const getFull = async (id: string): Promise<ClickUpTask | null> => {
    if (!doHydrate) return shallow.get(id) ?? null;
    try { return await getTaskFull(id); } catch (err) {
      bumpFail();
      console.error(`[clickup] 태스크 ${id} hydration 실패 — skip(커서 동결로 다음 run 재수화):`, err);
      return null;
    }
  };
  const emitTask = async function* (id: string, depth: number): AsyncIterable<RawItem> {
    if (emitted.has(id) || depth > 12) return;
    emitted.add(id); // 선등록 — 순환(이론상)·중복 재귀 방지
    const full = await getFull(id);
    if (!full) { return; }
    // 스코프 필터 — 제외/미포함 리스트의 태스크(부모 위상·이동 서브태스크로 유입)는 자신·부속을 적재하지 않는다.
    if (!listAllowed(full.list?.id ?? null)) return;
    // 부모 먼저(미러 parent_id 즉시 해소). incr 에서 부모가 미변경분이어도 재수화(멱등·1콜) — 정합 우선.
    const parentId = full.parent ?? null;
    if (parentId && !emitted.has(parentId)) yield* emitTask(parentId, depth + 1);
    try {
      yield toRawItem(full, ctx);
    } catch (err) {
      console.error(`[clickup] 태스크 변환 실패 ${full.id}, skip:`, err);
      return;
    }
    // hydration 이 드러낸 미지 서브태스크(타 리스트 이동 포함) 수렴.
    for (const st of full.subtasks ?? []) if (st?.id && !emitted.has(st.id)) yield* emitTask(st.id, depth + 1);
    // 댓글 — 귀속 태스크 뒤(미러 task 해소 순서). 실패도 stats 집계(커서 전진 시 이 태스크 댓글만 영구 누락 방지).
    if (withComments) {
      try {
        for (const { comment, replyTo } of await getTaskComments(full.id)) yield commentToRawItem(comment, full.id, ctx, replyTo);
      } catch (err) { bumpFail(); console.error(`[clickup] 태스크 ${full.id} 댓글 수집 실패, skip:`, err); }
    }
  };
  for (const id of [...shallow.keys()]) yield* emitTask(id, 0);

  // ④ 타임엔트리 — 팀 스윕(태스크 귀속만; 태스크가 이번 스트림 밖이어도 DB 기존 행에 붙는다 — 미러가 해소).
  //  start_date 필터는 엔트리 '시작시각' 기준이라 과거로 소급 기록(어제 작업을 오늘 입력)이 커서 뒤로 숨는다
  //  → 7일 마진으로 재수집(멱등 upsert라 무비용). 7일 이전 소급은 다음 --full 이 수렴.
  if (withTime) {
    const timeSince = sinceMs !== undefined ? Math.max(0, sinceMs - 7 * 864e5) : undefined;
    for (const t of await fetchTimeEntries(teamId, { sinceMs: timeSince, onError: bumpFail })) {
      const ri = timeEntryToRawItem(t, ctx);
      if (ri) yield ri;
    }
  }
}

// ── Connector SPI 구현 — 무손실 스트림 그대로(run-backfill.js/run-sync generic 호환).
export const clickupConnector: Connector = {
  name: "clickup",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const sinceMs = opts?.since ? new Date(opts.since).getTime() : undefined;
    yield* losslessStream({ sinceMs: sinceMs !== undefined && Number.isFinite(sinceMs) ? sinceMs : undefined });
  },
};
