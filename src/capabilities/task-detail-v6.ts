// v6 태스크 상세(클릭업형 모달) capability — 한 태스크의 태그·시간추적·체크리스트·의존성·댓글/활동피드.
//  전부 REST 전용(웹 프로젝트 탭 모달이 소비), scope='memory'(조직 공유 작업 평면 — projects-v6 와 동일).
//  데이터 접근/감사는 v6/task-detail-store 가 담당. 경로 prefix=/api/ui/v6/tasks|tags|projects.
import { z } from "zod";
import { HttpError, parseId, clampPage } from "./rest-util.js";
import { canSeeProjectRow } from "../v6/visibility.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import {
  getTaskDetail, listAllTags, addTaskTag, removeTaskTag, updateTag, deleteTag,
  startTimer, stopTimer, addManualTime, deleteTimeEntry,
  createChecklist, renameChecklist, deleteChecklist, addChecklistItem, updateChecklistItem, deleteChecklistItem,
  addTaskLink, removeTaskLink, searchLinkTargets,
  postComment, toggleCommentReaction, getTaskFeedPage,
} from "../v6/task-detail-store.js";

function body(req: any): Record<string, unknown> { return (req.body ?? {}) as Record<string, unknown>; }
function actorOf(user: LivelyUser, ctx?: CapabilityCtx): string | null { return ctx?.actor ?? user?.userId ?? null; }

// ── GET 상세(모달 1회 페치) ──
// 공개범위 게이트(#1291) — 태스크는 자기 list_id 가 비어 있어 조상 프로젝트로 판정한다(canSeeProjectRow).
//  거부는 404: "권한 없음"이라고 답하면 그 id 의 무언가가 있다는 사실을 알려준다.
async function assertTaskVisible(id: unknown, ctx?: CapabilityCtx, label = "태스크"): Promise<void> {
  const viewer = ctx?.viewer ?? null;
  if (viewer === null || id == null) return;
  if (!(await canSeeProjectRow(Number(id), viewer))) throw new HttpError(404, `${label}를 찾을 수 없습니다`);
}

const taskDetailV6Input = { id: z.number().int().positive() };
type TaskDetailV6Input = z.infer<z.ZodObject<typeof taskDetailV6Input>>;
const taskDetailV6: Capability = {
  name: "task_detail_v6",
  title: "태스크 상세(v6)",
  description: "태스크 1건 + 하위·태그·시간추적·체크리스트·의존성·활동피드·첨부(task_attachment)·커스텀필드(fields/field_values). 프로젝트 탭 모달 전용.",
  scope: "memory",
  input: taskDetailV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/tasks/:id/detail"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: TaskDetailV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertTaskVisible(input.id, ctx);
    const detail = await getTaskDetail(input.id, actorOf(user, ctx));
    if (!detail) throw new HttpError(404, "태스크를 찾을 수 없습니다");
    return detail;
  },
};

// ── GET 태그 레지스트리(자동완성) ──
const tagListV6: Capability = {
  name: "task_tag_list_v6",
  title: "태그 목록(v6)",
  description: "워크스페이스 태그 레지스트리 전체(자동완성용).",
  scope: "memory",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/v6/tags"], parse: () => ({}) }] },
  handler: async () => ({ tags: await listAllTags() }),
};

// ── POST 태그 부착/해제 ──
const taskTagsV6Input = { id: z.number().int().positive(), name: z.string().optional(), tag_id: z.number().optional(),
  color: z.string().optional(), remove: z.boolean().optional() };
type TaskTagsV6Input = z.infer<z.ZodObject<typeof taskTagsV6Input>>;
const taskTagsV6: Capability = {
  name: "task_tags_v6",
  title: "태스크 태그(v6)",
  description: "태스크에 태그를 달거나 뗀다. {name|tag_id, color?, remove?}.",
  scope: "memory",
  input: taskTagsV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/tags"],
      parse: (req) => {
        const b = body(req);
        const out: Record<string, unknown> = { id: parseId(req.params?.id) };
        if (b.tag_id != null && b.tag_id !== "") out.tag_id = parseId(b.tag_id);
        if (b.name != null) out.name = String(b.name);
        if (b.color != null) out.color = String(b.color);
        out.remove = b.remove === true || b.remove === "true";
        return out;
      } }],
  },
  handler: async (input: TaskTagsV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertTaskVisible(input.id, ctx);
    if (input.remove) {
      if (input.tag_id == null) throw new HttpError(400, "tag_id 가 필요합니다");
      return { tags: await removeTaskTag(input.id, input.tag_id) };
    }
    return { tags: await addTaskTag(input.id, { tagId: input.tag_id, name: input.name, color: input.color }) };
  },
};

// ── POST 시간추적(start|stop|add|delete) ──
// 조건부 필수(action 별)를 **필드 설명에 싣는다** — 평평한 shape 은 "add 면 seconds 필수"를 구조로 담지 못한다.
//  ⚠ z.discriminatedUnion 은 채택 불가다(#1403 실측): SDK 1.29 의 normalizeObjectSchema 가 union 을 object 로
//   정규화하지 못해 **tools/list 에 EMPTY_OBJECT_JSON_SCHEMA 를 싣고**(하네스는 필드를 하나도 못 본다) 호출 때만
//   union 으로 검증한다 — 정확히 #923 이 퇴치한 "광고는 되는데 안 되는 툴"의 재생산이다. describe 는 JSON Schema
//   의 property description 으로 나가 하네스가 그 필드를 채울 때 읽는다(구조 변경 0, 회귀 0).
const taskTimeV6Input = { id: z.number().int().positive(), action: z.enum(["start", "stop", "add", "delete"]),
  seconds: z.number().optional().describe("action='add' 일 때 **필수** — 추가할 시간(초, 0 초과). 다른 action 에선 무시."),
  note: z.string().optional().describe("action='add' 의 메모(선택)."),
  entry_id: z.number().optional().describe("action='delete' 일 때 **필수** — 지울 시간기록 항목 id(task_detail_v6 의 time.entries[].id).") };
type TaskTimeV6Input = z.infer<z.ZodObject<typeof taskTimeV6Input>>;
const taskTimeV6: Capability = {
  name: "task_time_v6",
  title: "태스크 시간추적(v6)",
  // ⚠ action 별 조건부 필수는 평평한 zod shape 으로 표현할 수 없어(전부 optional) **문구로 계약을 명시**한다 —
  //  하네스는 inputSchema 와 이 설명만 보고 호출하므로, 여기 안 적으면 400 을 맞고 나서야 알게 된다(#1403).
  description: "태스크 타이머/수동입력. {action: start|stop|add|delete, seconds?, note?, entry_id?}. action 별 필수: add→seconds(초, 0 초과) · delete→entry_id. start/stop 은 추가 인자 없음.",
  scope: "memory",
  input: taskTimeV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/time"],
      parse: (req) => {
        const b = body(req);
        const action = String(b.action ?? "");
        if (!["start", "stop", "add", "delete"].includes(action)) throw new HttpError(400, "action 이 올바르지 않습니다");
        const out: Record<string, unknown> = { id: parseId(req.params?.id), action };
        if (b.seconds != null) out.seconds = Number(b.seconds);
        if (b.note != null) out.note = String(b.note);
        if (b.entry_id != null && b.entry_id !== "") out.entry_id = parseId(b.entry_id);
        return out;
      } }],
  },
  // seconds/entry_id 는 스키마상 optional 이지만 action 별로는 필수다(add→seconds, delete→entry_id) — 평평한 zod
  //  shape 이 조건부 필수를 못 담으므로 **핸들러가 그 계약의 집행점**이고, 위 description 이 그걸 문구로 광고한다.
  //  (같은 규약을 task_checklist_v6 도 따른다 — #1403.)
  handler: async (input: TaskTimeV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertTaskVisible(input.id, ctx);
    const member = actorOf(user, ctx);
    if (input.action === "start") return { time: await startTimer(input.id, member) };
    if (input.action === "stop") return { time: await stopTimer(input.id, member) };
    if (input.action === "add") {
      // NaN(REST 의 Number("abc"))·0·음수·누락을 한 조건으로 거른다 — 캐스팅 없이 number 로 좁혀진다.
      if (input.seconds == null || !(input.seconds > 0)) throw new HttpError(400, "seconds 가 필요합니다");
      return { time: await addManualTime(input.id, member, input.seconds, input.note ?? null) };
    }
    if (input.entry_id == null) throw new HttpError(400, "entry_id 가 필요합니다");
    return { time: await deleteTimeEntry(input.id, input.entry_id) };
  },
};

// ── POST 체크리스트(create|rename|delete|add_item|update_item|delete_item) ──
// action 은 z.enum 으로 좁힌다 — 종전 z.string() 은 유효값 6종을 하네스에 전혀 알려주지 않았다(설명에만 있었다).
//  조건부 필수는 위 task_time_v6 와 같은 이유로 필드 설명에 싣는다(#1403).
//  handler 의 `default:` 400 은 그대로 둔다 — REST 는 zod 를 안 타므로 여전히 그 분기가 필요하다.
const taskChecklistV6Input = { id: z.number().int().positive(),
  action: z.enum(["create", "rename", "delete", "add_item", "update_item", "delete_item"]),
  checklist_id: z.number().optional().describe("action 이 rename·delete·add_item 일 때 **필수** — 대상 체크리스트 id."),
  item_id: z.number().optional().describe("action 이 update_item·delete_item 일 때 **필수** — 대상 항목 id."),
  name: z.string().optional().describe("action 이 create·rename·add_item 일 때 쓰는 이름(add_item 은 비울 수 없다)."),
  done: z.boolean().optional().describe("action='update_item' 의 체크 상태."),
  assignee: z.string().nullable().optional().describe("action='update_item' 의 담당자(null=해제).") };
type TaskChecklistV6Input = z.infer<z.ZodObject<typeof taskChecklistV6Input>>;
const taskChecklistV6: Capability = {
  name: "task_checklist_v6",
  title: "태스크 체크리스트(v6)",
  // ⚠ task_time_v6 와 같은 사유로 조건부 필수를 문구에 싣는다(#1403) — 누락 시 핸들러가 400.
  description: "체크리스트/항목 CRUD. {action: create|rename|delete|add_item|update_item|delete_item, checklist_id?, item_id?, name?, done?, assignee?}. action 별 필수: rename·delete·add_item→checklist_id · update_item·delete_item→item_id · create·rename·add_item→name.",
  scope: "memory",
  input: taskChecklistV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/checklists"],
      parse: (req) => {
        const b = body(req);
        const action = String(b.action ?? "");
        const out: Record<string, unknown> = { id: parseId(req.params?.id), action };
        if (b.checklist_id != null && b.checklist_id !== "") out.checklist_id = parseId(b.checklist_id);
        if (b.item_id != null && b.item_id !== "") out.item_id = parseId(b.item_id);
        if (b.name != null) out.name = String(b.name);
        if (b.done != null) out.done = b.done === true || b.done === "true";
        if ("assignee" in b) out.assignee = b.assignee == null || b.assignee === "" ? null : String(b.assignee);
        return out;
      } }],
  },
  // action 별 필수 인자는 **여기가 집행점**이다(#1403) — 평평한 zod shape 이 "rename 이면 checklist_id 필수" 같은
  //  조건부 필수를 표현하지 못하므로(스키마상 전부 optional), 누락은 핸들러가 400 으로 거절한다.
  //  ⚠ 이전엔 `as number` 로 캐스팅해 그대로 store 에 넘겼고, 그러면 쿼리가 `WHERE id=NULL` 로 **0행을 갱신하고 200**
  //   을 돌려준다 — 호출자에겐 성공으로 보이는 조용한 실패였다(add_item 만 소유확인 덕에 우연히 에러가 났다).
  //   같은 파일의 task_time_v6(add→seconds·delete→entry_id)가 이미 쓰던 규약을 체크리스트에도 맞춘 것.
  handler: async (input: TaskChecklistV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertTaskVisible(input.id, ctx);
    const t = input.id;
    // 조건부 필수 1건을 확인하고 좁힌 타입으로 돌려준다(캐스팅 대신 검증 — 누락이면 여기서 멈춘다).
    const need = (v: number | undefined, field: string): number => {
      if (v == null) throw new HttpError(400, `${field} 가 필요합니다`);
      return v;
    };
    switch (input.action) {
      case "create": return { checklists: await createChecklist(t, input.name ?? "") };
      case "rename": return { checklists: await renameChecklist(t, need(input.checklist_id, "checklist_id"), input.name ?? "") };
      case "delete": return { checklists: await deleteChecklist(t, need(input.checklist_id, "checklist_id")) };
      case "add_item": {
        if (!input.name || !input.name.trim()) throw new HttpError(400, "항목 이름이 필요합니다");
        return { checklists: await addChecklistItem(t, need(input.checklist_id, "checklist_id"), input.name) };
      }
      case "update_item": {
        const patch: { name?: string; done?: boolean; assignee?: string | null } = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.done !== undefined) patch.done = input.done;
        if ("assignee" in input) patch.assignee = input.assignee;
        return { checklists: await updateChecklistItem(t, need(input.item_id, "item_id"), patch) };
      }
      case "delete_item": return { checklists: await deleteChecklistItem(t, need(input.item_id, "item_id")) };
      default: throw new HttpError(400, "action 이 올바르지 않습니다");
    }
  },
};

// ── POST 의존성/연결 부착·해제 ──
const taskLinksV6Input = { id: z.number().int().positive(), to_task: z.number(), type: z.enum(["blocking", "waiting_on", "linked"]),
  remove: z.boolean().optional() };
type TaskLinksV6Input = z.infer<z.ZodObject<typeof taskLinksV6Input>>;
const taskLinksV6: Capability = {
  name: "task_links_v6",
  title: "태스크 의존성/연결(v6)",
  description: "태스크 간 blocking/waiting_on/linked 부착·해제(상호적). {to_task, type, remove?}.",
  scope: "memory",
  input: taskLinksV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/links"],
      parse: (req) => {
        const b = body(req);
        const type = String(b.type ?? "");
        if (!["blocking", "waiting_on", "linked"].includes(type)) throw new HttpError(400, "type 이 올바르지 않습니다");
        return { id: parseId(req.params?.id), to_task: parseId(b.to_task), type,
          remove: b.remove === true || b.remove === "true" };
      } }],
  },
  handler: async (input: TaskLinksV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertTaskVisible(input.id, ctx);
    if (input.remove) return { links: await removeTaskLink(input.id, input.to_task, input.type) };
    return { links: await addTaskLink(input.id, input.to_task, input.type) };
  },
};

// ── GET 연결 후보 검색(같은 프로젝트 내 다른 작업) ──
const linkTargetsV6Input = { id: z.number().int().positive(), exclude: z.number().optional(), q: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().describe("최대 후보 수(1~100, 기본 20) — 구 `LIMIT 20` 하드코딩 해제(#709)") };
type LinkTargetsV6Input = z.infer<z.ZodObject<typeof linkTargetsV6Input>>;
const linkTargetsV6: Capability = {
  name: "task_link_targets_v6",
  title: "연결 후보 검색(v6)",
  description: "프로젝트 내 task/subtask 를 이름으로 검색(의존성 추가 피커).",
  scope: "memory",
  input: linkTargetsV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/:id/link-targets"],
      parse: (req) => ({ id: parseId(req.params?.id),
        exclude: req.query?.exclude ? parseId(req.query.exclude) : 0,
        q: req.query?.q ? String(req.query.q) : "",
        limit: req.query?.limit ? Number(req.query.limit) : undefined }) }],
  },
  handler: async (input: LinkTargetsV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertTaskVisible(input.id, ctx);
    return { targets: await searchLinkTargets(input.id, input.exclude ?? 0, input.q ?? "", input.limit) };
  },
};

// ── POST 댓글 작성 ──
const taskCommentV6Input = { id: z.number().int().positive(), text: z.string().min(1), parent_id: z.number().int().positive().nullable().optional() };
type TaskCommentV6Input = z.infer<z.ZodObject<typeof taskCommentV6Input>>;
const taskCommentV6: Capability = {
  name: "task_comment_v6",
  title: "태스크 댓글(v6)",
  description: "태스크에 댓글을 단다(task_comment 테이블). {text}. 작성 후 갱신된 피드 반환.",
  scope: "memory",
  input: taskCommentV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/comments"],
      parse: (req) => {
        const b = body(req);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, "댓글 내용이 필요합니다");
        const pid = b.parent_id != null ? parseId(b.parent_id) : null;
        return { id: parseId(req.params?.id), text, parent_id: pid || null };
      } }],
  },
  handler: async (input: TaskCommentV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertTaskVisible(input.id, ctx);
    return { feed: await postComment(input.id, input.text, { actor: actorOf(user, ctx), source: ctx?.source ?? "web" }, input.parent_id ?? null) };
  },
};

// — POST 댓글 반응 토글(이모지) —
const commentReactionV6Input = { id: z.number().int().positive(), emoji: z.string().min(1) };
type CommentReactionV6Input = z.infer<z.ZodObject<typeof commentReactionV6Input>>;
const commentReactionV6: Capability = {
  name: "task_comment_reaction_v6",
  title: "댓글 반응(v6)",
  description: "댓글(task_comment)에 이모지 반응을 토글한다. {emoji}.",
  scope: "memory",
  input: commentReactionV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/comments/:id/reactions"],
      parse: (req) => {
        const b = body(req);
        const e = String(b.emoji ?? "").trim();
        if (!e) throw new HttpError(400, "emoji 가 필요합니다");
        return { id: parseId(req.params?.id), emoji: e };
      } }],
  },
  handler: async (input: CommentReactionV6Input, user: LivelyUser, ctx?: CapabilityCtx) => ({ reactions: await toggleCommentReaction(input.id, input.emoji, actorOf(user, ctx) ?? "") }),
};

// — POST 태그 레지스트리 수정(이름/색) —
const tagUpdateV6Input = { id: z.number().int().positive(), name: z.string().optional(), color: z.string().nullable().optional() };
type TagUpdateV6Input = z.infer<z.ZodObject<typeof tagUpdateV6Input>>;
const tagUpdateV6: Capability = {
  name: "task_tag_update_v6",
  title: "태그 수정(v6)",
  description: "태그 레지스트리의 이름/색을 수정한다(모든 태스크 반영). {name?, color?}.",
  scope: "memory",
  input: tagUpdateV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tags/:id"],
      parse: (req) => {
        const b = body(req);
        const out: Record<string, unknown> = { id: parseId(req.params?.id) };
        if ("name" in b) out.name = String(b.name ?? "");
        if ("color" in b) out.color = (b.color === null || b.color === "") ? null : String(b.color);
        return out;
      } }],
  },
  handler: async (input: TagUpdateV6Input) => {
    try { return { tag: await updateTag(input.id, { name: input.name, color: input.color }) }; }
    catch (e: any) { throw new HttpError(400, e?.message ?? "태그 수정 실패"); }
  },
};
// — POST 태그 레지스트리 삭제 —
const tagDeleteV6Input = { id: z.number().int().positive() };
type TagDeleteV6Input = z.infer<z.ZodObject<typeof tagDeleteV6Input>>;
const tagDeleteV6: Capability = {
  name: "task_tag_delete_v6",
  title: "태그 삭제(v6)",
  description: "태그를 레지스트리에서 삭제한다(모든 태스크에서 제거).",
  scope: "memory",
  input: tagDeleteV6Input,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/v6/tags/:id/delete"], parse: (req) => ({ id: parseId(req.params?.id) }) }] },
  handler: async (input: TagDeleteV6Input) => ({ deleted: true, ...(await deleteTag(input.id)) }),
};

// — GET 프로젝트 코멘트 피드(드로어) — getTaskDetail 은 task/subtask 레벨만 처리하므로, 프로젝트(루트) 행의
//   코멘트는 이 전용 GET 으로 읽는다. task_comment(task_id=프로젝트) + 감사 이벤트(getTaskFeed). —
const projectCommentsV6Input = {
  id: z.number().int().positive(),
  limit: z.number().int().min(1).max(500).optional().describe("페이지 크기(≤500, 기본 300) — 구 `slice(-300)` 하드캡 해제(#709)"),
  offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — 오래된 코멘트/이벤트 순회(#709)"),
};
type ProjectCommentsV6Input = z.infer<z.ZodObject<typeof projectCommentsV6Input>>;
const projectCommentsV6: Capability = {
  name: "project_comments_v6",
  title: "프로젝트 코멘트(v6)",
  description: "프로젝트(루트) 행의 코멘트/활동 피드. 댓글(task_comment) + 시스템 이벤트. 웹 코멘트 드로어 전용.",
  scope: "memory",
  input: projectCommentsV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/:id/comments"],
      parse: (req) => ({
        id: parseId(req.params?.id),
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      }) }],
  },
  handler: async (input: ProjectCommentsV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertTaskVisible(input.id, ctx, "프로젝트");
    const { limit, offset } = clampPage(input, 300, 500);
    const { feed, total } = await getTaskFeedPage(input.id, actorOf(user, ctx), { limit, offset });
    return { feed, total, limit, offset, has_more: offset + feed.length < total };
  },
};

export const taskDetailV6Capabilities: Capability[] = [
  taskDetailV6, tagListV6, taskTagsV6, tagUpdateV6, tagDeleteV6, taskTimeV6, taskChecklistV6, taskLinksV6, linkTargetsV6, taskCommentV6, commentReactionV6, projectCommentsV6,
];
