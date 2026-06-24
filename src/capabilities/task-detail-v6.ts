// v6 태스크 상세(클릭업형 모달) capability — 한 태스크의 태그·시간추적·체크리스트·의존성·댓글/활동피드.
//  전부 REST 전용(웹 프로젝트 탭 모달이 소비), scope='memory'(조직 공유 작업 평면 — projects-v6 와 동일).
//  데이터 접근/감사는 v6/task-detail-store 가 담당. 경로 prefix=/api/ui/v6/tasks|tags|projects.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  getTaskDetail, listAllTags, addTaskTag, removeTaskTag, updateTag, deleteTag,
  startTimer, stopTimer, addManualTime, deleteTimeEntry,
  createChecklist, renameChecklist, deleteChecklist, addChecklistItem, updateChecklistItem, deleteChecklistItem,
  addTaskLink, removeTaskLink, searchLinkTargets,
  postComment, toggleCommentReaction,
} from "../v6/task-detail-store.js";

function parseId(v: unknown): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 가 올바르지 않습니다");
  return id;
}
function body(req: any): Record<string, unknown> { return (req.body ?? {}) as Record<string, unknown>; }
function actorOf(user: any, ctx: any): string | null { return ctx?.actor ?? user?.userId ?? null; }

// ── GET 상세(모달 1회 페치) ──
const taskDetailV6: Capability = {
  name: "task_detail_v6",
  title: "태스크 상세(v6)",
  description: "태스크 1건 + 하위·태그·시간추적·체크리스트·의존성·활동피드. 프로젝트 탭 모달 전용.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/tasks/:id/detail"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const detail = await getTaskDetail(input.id, actorOf(user, ctx));
    if (!detail) throw new HttpError(404, "태스크를 찾을 수 없습니다");
    return detail;
  },
};

// ── GET 태그 레지스트리(자동완성) ──
const tagListV6: Capability = {
  name: "task_tag_list_v6",
  title: "태그 목록(v6)",
  description: "워크스페이스 태그 레지스트리 전체(자동완성용). 웹 전용.",
  scope: "memory",
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/v6/tags"], parse: () => ({}) }] },
  handler: async () => ({ tags: await listAllTags() }),
};

// ── POST 태그 부착/해제 ──
const taskTagsV6: Capability = {
  name: "task_tags_v6",
  title: "태스크 태그(v6)",
  description: "태스크에 태그를 달거나 뗀다. {name|tag_id, color?, remove?}. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), name: z.string().optional(), tag_id: z.number().optional(),
    color: z.string().optional(), remove: z.boolean().optional() },
  expose: {
    mcp: false,
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
  handler: async (input: any) => {
    if (input.remove) {
      if (input.tag_id == null) throw new HttpError(400, "tag_id 가 필요합니다");
      return { tags: await removeTaskTag(input.id, input.tag_id) };
    }
    return { tags: await addTaskTag(input.id, { tagId: input.tag_id, name: input.name, color: input.color }) };
  },
};

// ── POST 시간추적(start|stop|add|delete) ──
const taskTimeV6: Capability = {
  name: "task_time_v6",
  title: "태스크 시간추적(v6)",
  description: "태스크 타이머/수동입력. {action: start|stop|add|delete, seconds?, note?, entry_id?}. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), action: z.enum(["start", "stop", "add", "delete"]),
    seconds: z.number().optional(), note: z.string().optional(), entry_id: z.number().optional() },
  expose: {
    mcp: false,
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
  handler: async (input: any, user: any, ctx: any) => {
    const member = actorOf(user, ctx);
    if (input.action === "start") return { time: await startTimer(input.id, member) };
    if (input.action === "stop") return { time: await stopTimer(input.id, member) };
    if (input.action === "add") {
      if (!(input.seconds > 0)) throw new HttpError(400, "seconds 가 필요합니다");
      return { time: await addManualTime(input.id, member, input.seconds, input.note ?? null) };
    }
    if (input.entry_id == null) throw new HttpError(400, "entry_id 가 필요합니다");
    return { time: await deleteTimeEntry(input.id, input.entry_id) };
  },
};

// ── POST 체크리스트(create|rename|delete|add_item|update_item|delete_item) ──
const taskChecklistV6: Capability = {
  name: "task_checklist_v6",
  title: "태스크 체크리스트(v6)",
  description: "체크리스트/항목 CRUD. {action, checklist_id?, item_id?, name?, done?, assignee?}. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), action: z.string(), checklist_id: z.number().optional(),
    item_id: z.number().optional(), name: z.string().optional(), done: z.boolean().optional(),
    assignee: z.string().nullable().optional() },
  expose: {
    mcp: false,
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
  handler: async (input: any) => {
    const t = input.id;
    switch (input.action) {
      case "create": return { checklists: await createChecklist(t, input.name ?? "") };
      case "rename": return { checklists: await renameChecklist(t, input.checklist_id, input.name ?? "") };
      case "delete": return { checklists: await deleteChecklist(t, input.checklist_id) };
      case "add_item": {
        if (!input.name || !input.name.trim()) throw new HttpError(400, "항목 이름이 필요합니다");
        return { checklists: await addChecklistItem(t, input.checklist_id, input.name) };
      }
      case "update_item": {
        const patch: any = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.done !== undefined) patch.done = input.done;
        if ("assignee" in input) patch.assignee = input.assignee;
        return { checklists: await updateChecklistItem(t, input.item_id, patch) };
      }
      case "delete_item": return { checklists: await deleteChecklistItem(t, input.item_id) };
      default: throw new HttpError(400, "action 이 올바르지 않습니다");
    }
  },
};

// ── POST 의존성/연결 부착·해제 ──
const taskLinksV6: Capability = {
  name: "task_links_v6",
  title: "태스크 의존성/연결(v6)",
  description: "태스크 간 blocking/waiting_on/linked 부착·해제(상호적). {to_task, type, remove?}. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), to_task: z.number(), type: z.enum(["blocking", "waiting_on", "linked"]),
    remove: z.boolean().optional() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/links"],
      parse: (req) => {
        const b = body(req);
        const type = String(b.type ?? "");
        if (!["blocking", "waiting_on", "linked"].includes(type)) throw new HttpError(400, "type 이 올바르지 않습니다");
        return { id: parseId(req.params?.id), to_task: parseId(b.to_task), type,
          remove: b.remove === true || b.remove === "true" };
      } }],
  },
  handler: async (input: any) => {
    if (input.remove) return { links: await removeTaskLink(input.id, input.to_task, input.type) };
    return { links: await addTaskLink(input.id, input.to_task, input.type) };
  },
};

// ── GET 연결 후보 검색(같은 프로젝트 내 다른 작업) ──
const linkTargetsV6: Capability = {
  name: "task_link_targets_v6",
  title: "연결 후보 검색(v6)",
  description: "프로젝트 내 task/subtask 를 이름으로 검색(의존성 추가 피커). 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), exclude: z.number().optional(), q: z.string().optional() },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/:id/link-targets"],
      parse: (req) => ({ id: parseId(req.params?.id),
        exclude: req.query?.exclude ? parseId(req.query.exclude) : 0,
        q: req.query?.q ? String(req.query.q) : "" }) }],
  },
  handler: async (input: any) => ({ targets: await searchLinkTargets(input.id, input.exclude, input.q) }),
};

// ── POST 댓글 작성 ──
const taskCommentV6: Capability = {
  name: "task_comment_v6",
  title: "태스크 댓글(v6)",
  description: "태스크에 댓글을 단다(activity 미러, type=comment). {text}. 작성 후 갱신된 피드 반환. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), text: z.string().min(1) },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/comments"],
      parse: (req) => {
        const b = body(req);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, "댓글 내용이 필요합니다");
        return { id: parseId(req.params?.id), text };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) =>
    ({ feed: await postComment(input.id, input.text, { actor: actorOf(user, ctx), source: ctx?.source ?? "web" }) }),
};

// — POST 댓글 반응 토글(이모지) —
const commentReactionV6: Capability = {
  name: "task_comment_reaction_v6",
  title: "댓글 반응(v6)",
  description: "댓글(activity)에 이모지 반응을 토글한다. {emoji}. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), emoji: z.string().min(1) },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/comments/:id/reactions"],
      parse: (req) => {
        const b = body(req);
        const e = String(b.emoji ?? "").trim();
        if (!e) throw new HttpError(400, "emoji 가 필요합니다");
        return { id: parseId(req.params?.id), emoji: e };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => ({ reactions: await toggleCommentReaction(input.id, input.emoji, actorOf(user, ctx) ?? "") }),
};

// — POST 태그 레지스트리 수정(이름/색) —
const tagUpdateV6: Capability = {
  name: "task_tag_update_v6",
  title: "태그 수정(v6)",
  description: "태그 레지스트리의 이름/색을 수정한다(모든 태스크 반영). {name?, color?}. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), name: z.string().optional(), color: z.string().nullable().optional() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tags/:id"],
      parse: (req) => {
        const b = body(req);
        const out: Record<string, unknown> = { id: parseId(req.params?.id) };
        if ("name" in b) out.name = String(b.name ?? "");
        if ("color" in b) out.color = (b.color === null || b.color === "") ? null : String(b.color);
        return out;
      } }],
  },
  handler: async (input: any) => {
    try { return { tag: await updateTag(input.id, { name: input.name, color: input.color }) }; }
    catch (e: any) { throw new HttpError(400, e?.message ?? "태그 수정 실패"); }
  },
};
// — POST 태그 레지스트리 삭제 —
const tagDeleteV6: Capability = {
  name: "task_tag_delete_v6",
  title: "태그 삭제(v6)",
  description: "태그를 레지스트리에서 삭제한다(모든 태스크에서 제거). 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/v6/tags/:id/delete"], parse: (req) => ({ id: parseId(req.params?.id) }) }] },
  handler: async (input: any) => ({ deleted: true, ...(await deleteTag(input.id)) }),
};

export const taskDetailV6Capabilities: Capability[] = [
  taskDetailV6, tagListV6, taskTagsV6, tagUpdateV6, tagDeleteV6, taskTimeV6, taskChecklistV6, taskLinksV6, linkTargetsV6, taskCommentV6, commentReactionV6,
];
