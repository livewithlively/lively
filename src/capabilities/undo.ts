// #702 전역 실행취소(Cmd+Z) — org_content_audit(before/after 스냅샷)를 단일 소스로 '내 마지막 웹 변경'을 되돌린다.
//  아키텍처: 프론트 243곳 뮤테이션을 개별 배선하지 않고, 이미 모든 콘텐츠 쓰기가 남기는 감사 스냅샷을 역적용.
//  - 대상: actor=나 AND channel='web'(내가 UI 에서 한 액션) AND 아래 핸들러 행렬이 아는 (entity, op)만.
//  - 되돌리기 = '그 시점 상태(before)를 다시 쓴다' — 기존 스토어 fn 을 그대로 호출하므로 감사·외부푸시(ClickUp)·
//    임베딩 등 부수효과가 정상 경로와 동일하게 따라간다(리버트 행 자체도 감사에 남아 투명).
//  - 재실행(redo) = 같은 감사 행의 after 를 다시 쓴다(reapply). 프론트가 탭 세션에서 undo/redo 스택을 관리.
//  - 리버트 ctx.source='undo' → channel='unknown' 이라 픽커(channel='web')에서 자연 제외 — Z 연타가 자기 리버트를
//    다시 되돌리며 핑퐁하지 않고 그 다음 옛 작업으로 걸어간다.
//  한계(v1): 태그·체크리스트·댓글·시간추적·커스텀필드값·정렬(reorder)은 비감사라 대상 아님.
//    knowledge link_category 는 교체(replace) 시맨틱이라 이전 카테고리가 스냅샷에 없어 제외.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { listContentAudit, type ContentAuditRow } from "../org/store.js";
import {
  updateProject, updateProjectStatus, setProjectFolder, restoreProject, deleteProject, deleteTaskNode,
  updateTask, updateTaskStatus, setProjectMembers, setProjectRepos,
  linkProjectKnowledge, unlinkProjectKnowledge, linkProjectEdge, unlinkProjectEdge,
} from "../v6/project-store.js";
import {
  upsertKnowledge, restoreKnowledge, deleteKnowledge, setKnowledgeLifecycle, setKnowledgeWiki,
  setKnowledgePropsUi, moveKnowledge, linkKnowledgeCategory, unlinkKnowledgeCategory,
  linkKnowledge, unlinkKnowledge, linkKnowledgeSource, unlinkKnowledgeSource,
} from "../v6/knowledge-store.js";
import { updateCategory, setCategoryView, restoreCategory, deleteCategory } from "../v6/category-store.js";
import { updateProjectList } from "../v6/list-store.js";
import { updateProjectFolder } from "../v6/folder-store.js";

type Dir = "before" | "after";
type Row = ContentAuditRow;
const rec = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

// ── 핸들러 행렬 — apply(row, dir): '그 방향의 상태를 다시 쓴다'. dir='before'=실행취소, 'after'=다시실행. ──
//  각 항목은 검증된 감사 페이로드 형태에만 의존한다(모르는 op 는 행렬에 없음 = 픽커가 건너뜀).
type Apply = (row: Row, dir: Dir, ctx: CapabilityCtx) => Promise<void>;

// 프로젝트 행 스냅샷(전체 행)에서 update 계열이 만지는 편집 필드만 뽑는다 — 미변경 필드도 같은 값 재기록(no-op).
const projPatch = (s: Record<string, any>) => ({
  name: s.name, description: s.description ?? null, priority: s.priority ?? null,
  assignee: s.assignee ?? null, start_date: s.start_date ?? null, due_date: s.due_date ?? null,
});
const isTaskLevel = (s: Record<string, any>) => s.level === "task" || s.level === "subtask";

const PROJECT_OPS: Record<string, Apply> = {
  set_status: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    const id = Number(r.entity_key);
    if (isTaskLevel(s)) await updateTaskStatus(id, String(s.status), ctx);
    else await updateProjectStatus(id, String(s.status), ctx, s.status_raw ?? null);
  },
  update: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    const id = Number(r.entity_key);
    if (isTaskLevel(s)) await updateTask(id, { ...projPatch(s), status: s.status }, ctx);
    else await updateProject(id, projPatch(s), ctx);
  },
  set_folder: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    if (s.folder == null) throw new Error("이 폴더 경로 변경은 되돌릴 수 없습니다(이전 경로 없음)");
    await setProjectFolder(Number(r.entity_key), String(s.folder), ctx);
  },
  delete: async (r, d, ctx) => {
    if (d === "before") await restoreProject(rec(r.before), ctx);
    else if (isTaskLevel(rec(r.before))) await deleteTaskNode(Number(r.entity_key), ctx);
    else await deleteProject(Number(r.entity_key), ctx);
  },
  insert: async (r, d, ctx) => {
    if (d === "after") await restoreProject(rec(r.after), ctx);
    else if (isTaskLevel(rec(r.after))) await deleteTaskNode(Number(r.entity_key), ctx);
    else await deleteProject(Number(r.entity_key), ctx);
  },
  restore: async (r, d, ctx) => {
    if (d === "after") await restoreProject(rec(r.after), ctx);
    else if (isTaskLevel(rec(r.after))) await deleteTaskNode(Number(r.entity_key), ctx);
    else await deleteProject(Number(r.entity_key), ctx);
  },
  set_members: async (r, d, ctx) => {
    const ids = (d === "before" ? r.before : r.after);
    if (!Array.isArray(ids)) throw new Error("팀원 스냅샷 형식이 달라 되돌릴 수 없습니다");
    await setProjectMembers(Number(r.entity_key), ids.map(String), ctx);
  },
  set_repos: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    await setProjectRepos(Number(r.entity_key), Array.isArray(s.repos) ? s.repos.map(String) : [], ctx);
  },
  link_knowledge: async (r, d, ctx) => {
    const t = rec(r.after ?? r.before);
    if (d === "before") await unlinkProjectKnowledge(Number(r.entity_key), String(t.name), String(t.relation), ctx);
    else await linkProjectKnowledge(Number(r.entity_key), String(t.name), String(t.relation), ctx);
  },
  unlink_knowledge: async (r, d, ctx) => {
    const t = rec(r.before ?? r.after);
    if (d === "before") await linkProjectKnowledge(Number(r.entity_key), String(t.name), String(t.relation), ctx);
    else await unlinkProjectKnowledge(Number(r.entity_key), String(t.name), String(t.relation), ctx);
  },
  link_project: async (r, d, ctx) => {
    const t = rec(r.after ?? r.before);
    if (d === "before") await unlinkProjectEdge(Number(r.entity_key), Number(t.to), String(t.relation), ctx);
    else await linkProjectEdge(Number(r.entity_key), Number(t.to), String(t.relation), ctx);
  },
  unlink_project: async (r, d, ctx) => {
    const t = rec(r.before ?? r.after);
    if (d === "before") await linkProjectEdge(Number(r.entity_key), Number(t.to), String(t.relation), ctx);
    else await unlinkProjectEdge(Number(r.entity_key), Number(t.to), String(t.relation), ctx);
  },
};

// 지식 행 스냅샷 → upsertKnowledge 입력(본문·메타 재기록; 카테고리는 미전송=보존, lifecycle 은 update 경로에서 불변).
//  export(#1546): 지식 이력 패널의 '이 버전으로 되돌리기'가 같은 매핑을 쓴다 — 스냅샷을 upsert 입력으로 옮기는
//  규칙이 두 벌이면 한쪽만 facet 을 빠뜨려도 조용히 그 필드가 지워진다(is_wiki·type 유실이 그 사고).
export const knowledgeUpsertInput = (s: Record<string, any>) => ({
  name: String(s.name), title: s.title ?? undefined, body_md: String(s.body_md ?? ""),
  injection: s.injection ?? undefined, provenance: s.provenance ?? undefined,
  supersedes: s.supersedes ?? undefined, summary: s.summary ?? null, sort: s.sort ?? undefined,
  is_wiki: s.is_wiki ?? undefined, type: s.type ?? undefined, is_folder: s.is_folder ?? undefined,
  parent_name: s.parent_name ?? null, confidence: s.confidence ?? undefined, source: s.source ?? undefined,
});

const KNOWLEDGE_OPS: Record<string, Apply> = {
  update: async (r, d, ctx) => { await upsertKnowledge(knowledgeUpsertInput(rec(d === "before" ? r.before : r.after)), ctx); },
  set_lifecycle: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    await setKnowledgeLifecycle(String(r.entity_key), String(s.lifecycle), ctx);
  },
  set_wiki: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    await setKnowledgeWiki(String(r.entity_key), !!s.is_wiki, ctx);
  },
  set_props_ui: async (r, d, ctx) => {
    // 전체 교체 — 스냅샷에 없는 키는 null(제거)로 명시해 병합 시맨틱에서도 정확 복원.
    const ui = rec(rec(d === "before" ? r.before : r.after).props_ui);
    await setKnowledgePropsUi(String(r.entity_key), {
      show: (ui.show as string[] | undefined) ?? null, hide: (ui.hide as string[] | undefined) ?? null,
      full_width: (ui.full_width as boolean | undefined) ?? null,
      icon: (ui.icon as string | undefined) ?? null, cover: (ui.cover as string | undefined) ?? null,
    }, ctx);
  },
  move: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    await moveKnowledge(String(r.entity_key), s.parent_name ?? null, typeof s.sort === "number" ? s.sort : undefined, ctx);
  },
  delete: async (r, d, ctx) => {
    if (d === "before") await restoreKnowledge(rec(r.before), ctx);
    else await deleteKnowledge(String(r.entity_key), ctx);
  },
  insert: async (r, d, ctx) => {
    if (d === "after") await restoreKnowledge(rec(r.after), ctx);
    else await deleteKnowledge(String(r.entity_key), ctx);
  },
  restore: async (r, d, ctx) => {
    if (d === "after") await restoreKnowledge(rec(r.after), ctx);
    else await deleteKnowledge(String(r.entity_key), ctx);
  },
  unlink_category: async (r, d, ctx) => {
    const t = rec(r.before ?? r.after);
    if (d === "before") await linkKnowledgeCategory(String(r.entity_key), Number(t.category_id), "confirmed", ctx);
    else await unlinkKnowledgeCategory(String(r.entity_key), Number(t.category_id), ctx);
  },
  link_knowledge: async (r, d, ctx) => {
    const t = rec(r.after ?? r.before);
    if (d === "before") await unlinkKnowledge(String(r.entity_key), String(t.to_name), String(t.relation), ctx);
    else await linkKnowledge(String(r.entity_key), String(t.to_name), String(t.relation), ctx);
  },
  unlink_knowledge: async (r, d, ctx) => {
    const t = rec(r.before ?? r.after);
    if (d === "before") await linkKnowledge(String(r.entity_key), String(t.to_name), String(t.relation), ctx);
    else await unlinkKnowledge(String(r.entity_key), String(t.to_name), String(t.relation), ctx);
  },
  link_source: async (r, d, ctx) => {
    const t = rec(r.after ?? r.before);
    if (d === "before") await unlinkKnowledgeSource(String(r.entity_key), Number(t.source_id), String(t.relation), ctx);
    else await linkKnowledgeSource(String(r.entity_key), Number(t.source_id), String(t.relation), ctx);
  },
  unlink_source: async (r, d, ctx) => {
    const t = rec(r.before ?? r.after);
    if (d === "before") await linkKnowledgeSource(String(r.entity_key), Number(t.source_id), String(t.relation), ctx);
    else await unlinkKnowledgeSource(String(r.entity_key), Number(t.source_id), String(t.relation), ctx);
  },
  // link_category 는 교체(replace) — 이전 카테고리가 스냅샷에 없어 제외(행렬 부재 = 픽커가 건너뜀).
};

const CATEGORY_OPS: Record<string, Apply> = {
  update: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    await updateCategory(Number(s.id), {
      name: s.name ?? undefined, description: s.description ?? undefined,
      should: s.should ?? undefined, cross_cutting: s.cross_cutting ?? undefined,
    }, ctx);
  },
  set_view: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    await setCategoryView(Number(s.id), { view_mode: s.view_mode ?? undefined, entry_name: s.entry_name ?? null }, ctx);
  },
  delete: async (r, d, ctx) => {
    if (d === "before") await restoreCategory(rec(r.before), ctx);
    else await deleteCategory(Number(rec(r.before).id), ctx);
  },
};

const LIST_OPS: Record<string, Apply> = {
  update: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    await updateProjectList(Number(r.entity_key), { name: s.name, color: s.color ?? null, sort: s.sort }, ctx);
  },
};

const FOLDER_OPS: Record<string, Apply> = {
  update: async (r, d, ctx) => {
    const s = rec(d === "before" ? r.before : r.after);
    await updateProjectFolder(Number(r.entity_key), { name: s.name, color: s.color ?? null, sort: s.sort }, ctx);
  },
};

const MATRIX: Record<string, Record<string, Apply>> = {
  project: PROJECT_OPS, knowledge: KNOWLEDGE_OPS, category: CATEGORY_OPS,
  project_list: LIST_OPS, project_folder: FOLDER_OPS,
};

// ── 한국어 라벨 — 토스트에 '무엇을 되돌렸나'를 사람이 읽게. ──
const OP_LABEL: Record<string, string> = {
  set_status: "상태 변경", update: "수정", set_folder: "폴더 경로 변경", delete: "삭제", insert: "생성",
  restore: "복원", set_members: "팀원 변경", set_repos: "레포 연결 변경",
  link_knowledge: "지식 연결", unlink_knowledge: "지식 연결 해제", link_project: "프로젝트 연결",
  unlink_project: "프로젝트 연결 해제", set_lifecycle: "수명 상태 변경", set_wiki: "WIKI 핀 토글",
  set_props_ui: "속성 표시 설정", move: "이동", unlink_category: "카테고리 해제",
  link_source: "자료 연결", unlink_source: "자료 연결 해제", set_view: "보기 설정",
};
function entityLabel(r: Row): string {
  if (r.entity === "knowledge") return "지식";
  if (r.entity === "category") return "카테고리";
  if (r.entity === "project_list") return "리스트";
  if (r.entity === "project_folder") return "폴더";
  const lv = rec(r.before).level ?? rec(r.after).level;
  return lv === "task" || lv === "subtask" ? "작업" : "프로젝트";
}
function rowLabel(r: Row): string {
  const b = rec(r.before), a = rec(r.after);
  const name = b.name ?? a.name ?? b.title ?? a.title ?? r.entity_key ?? "";
  return `${entityLabel(r)} '${String(name).slice(0, 40)}' ${OP_LABEL[r.op] ?? r.op}`;
}

function applier(r: Row): Apply | undefined {
  return MATRIX[r.entity]?.[r.op];
}
// 카테고리 되돌리기는 context 권한(content_restore 와 동일 정합) — 없으면 그 행은 건너뛴다.
function scopeOk(r: Row, user: LivelyUser): boolean {
  if (r.entity !== "category") return true;
  return ((user?.scopes ?? []) as string[]).includes("context");
}

const contentUndo: Capability = {
  name: "content_undo",
  title: "실행 취소(Cmd+Z)",
  description:
    "내(현재 사용자)가 웹 UI 에서 한 마지막 콘텐츠 변경을 감사 스냅샷(org_content_audit before)으로 되돌린다. " +
    "skip=이 탭에서 이미 되돌린 감사 id 목록(그 다음 옛 작업으로 진행), reapply=특정 감사 행의 after 재적용(다시 실행). " +
    "대상: knowledge/project/category/list/folder 의 감사되는 op. ⚠ 사람(웹) 전용.",
  scope: "memory",
  input: {
    skip: z.array(z.number().int().positive()).max(200).optional(),
    reapply: z.number().int().positive().optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/undo"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const skip = Array.isArray(b.skip) ? b.skip.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200) : [];
        const reapply = b.reapply != null ? Number(b.reapply) : undefined;
        if (reapply != null && (!Number.isInteger(reapply) || reapply <= 0)) throw new HttpError(400, "reapply 는 감사 id(양의 정수)");
        return { skip, reapply };
      } }],
  },
  handler: async (input: any, user: LivelyUser, ctx?: CapabilityCtx) => {
    if (ctx?.source === "mcp") throw new HttpError(403, "실행 취소는 사람(웹)만 가능합니다");
    const me = ctx?.actor ?? user?.userId ?? null;
    if (!me) throw new HttpError(401, "인증 필요");
    const writeCtx: CapabilityCtx = { ...ctx, actor: me, source: "undo" }; // channel 'unknown' → 픽커(channel=web)에서 리버트 행 자연 제외

    // ── 다시 실행(redo) — 프론트가 기억하는 '방금 되돌린 원본 감사 행'의 after 를 재적용. ──
    if (input.reapply != null) {
      // listContentAudit 에 id 단건 조회가 없어 내 최근 웹 작업에서 찾는다 — 감사 행은 append-only(불변)라 안전.
      //  ⚠ pg 드라이버가 bigint id 를 문자열로 반환 — Number 정규화 없이 === 비교하면 영원히 미스.
      const { rows: cand } = await listContentAudit({ actor: me, channel: "web", limit: 500 });
      const row = cand.find((x) => Number(x.id) === Number(input.reapply));
      if (!row) throw new HttpError(404, "다시 실행할 작업을 찾지 못했습니다(내 웹 작업 최근 500건 밖이거나 남의 작업)");
      const fn = applier(row);
      if (!fn || !scopeOk(row, user)) throw new HttpError(400, "이 작업은 다시 실행을 지원하지 않습니다");
      await fn(row, "after", writeCtx);
      return { ok: true, redone: { id: Number(row.id), entity: row.entity, key: row.entity_key, op: row.op, label: rowLabel(row) } };
    }

    // ── 실행 취소 — 내 최근 웹 변경(최신순)에서 첫 '되돌릴 수 있는' 행을 찾아 before 재적용. ──
    const skip = new Set<number>(((input.skip ?? []) as number[]).map(Number));
    const { rows } = await listContentAudit({ actor: me, channel: "web", limit: 100 });
    for (const row of rows) {
      if (skip.has(Number(row.id))) continue; // ⚠ pg bigint → 문자열: Number 정규화 필수
      if (row.source === "undo") continue; // 이중 안전망(채널 필터가 이미 제외)
      const fn = applier(row);
      if (!fn || !scopeOk(row, user)) continue;
      await fn(row, "before", writeCtx);
      return { ok: true, undone: { id: Number(row.id), entity: row.entity, key: row.entity_key, op: row.op, label: rowLabel(row) } };
    }
    throw new HttpError(404, "되돌릴 내 작업이 없습니다");
  },
};

export const undoCapabilities: Capability[] = [contentUndo];
