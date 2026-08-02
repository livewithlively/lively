// ClickUp 순수 변환 계층(#1313 R22 분할 — 구 clickup.ts 221-594) — 네트워크 없음, 단위 테스트 대상.
import type { RawItem } from "../types.js";
import type {
  ClickUpComment, ClickUpFolder, ClickUpList, ClickUpSpace, ClickUpStatus,
  ClickUpTask, ClickUpTimeEntry, ClickUpUser, ClickUpView, HierarchyList,
} from "./types.js";

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
export function spaceToRawItem(space: ClickUpSpace, ctx: ToRawItemCtx, orderindex?: number): RawItem {
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
      // 스페이스 나열 API 는 orderindex 미제공 — 나열 순서(=ClickUp 사이드바 표시 순서)를 위치값으로 보존(#541 사이드바 정렬).
      orderindex: orderindex ?? null,
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
