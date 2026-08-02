// ClickUp 커넥터 타입 표면(#1313 R22 분할 — 구 clickup.ts 16-217·912-915).
//  전 계층(transform·api·stream)이 공유하는 순수 타입만 — 런타임 의존 0.
export type { Connector, RawItem, BackfillOpts } from "../types.js";

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

// ── 계층 트리(무손실) — Space›Folder›List 를 status/뷰/필드정의와 함께 보존해 반환. enumerateLists 는 이걸 평탄화. ──
export interface HierarchyList { list: ClickUpList; views: ClickUpView[]; fields: ClickUpCustomField[] }
export interface HierarchyFolder { folder: ClickUpFolder; lists: HierarchyList[]; views: ClickUpView[] }
export interface HierarchySpace { space: ClickUpSpace; folders: HierarchyFolder[]; folderlessLists: HierarchyList[]; views: ClickUpView[] }
