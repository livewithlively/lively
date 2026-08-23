// v6 휴지통 capability — 삭제됨 조회 + 복원(공통 경로). 삭제는 엔티티별(knowledge_delete·category_delete·
//  project_delete_v6)이 담당하고, 여기는 그것들이 남긴 감사 스냅샷을 한곳에서 보여주고 되돌린다.
//  scope='memory'(공유 평면). 복원은 ⚠ 사람(웹)만 — 에이전트(MCP)는 403(파괴/되돌리기는 사람 큐레이션).
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listDeleted, getDeleteSnapshot, type DeletedRow } from "../v6/trash-store.js";
import { restoreKnowledge } from "../v6/knowledge-store.js";
import { restoreProject } from "../v6/project-store.js";
import { restoreCategory } from "../v6/category-store.js";
import { visibleListIds, type Viewer } from "../v6/visibility.js";
import { isAdmin } from "./principal.js";

const ENTITIES = ["knowledge", "project", "category"] as const;

// 삭제 스냅샷의 공개범위 판정 — 지식은 스냅샷의 visibility 로, 프로젝트는 스냅샷의 list_id 로.
//  ⚠ 인자를 `any[]` 로 두지 마라 — 처음 이 게이트는 스토어가 돌려주지 않는 필드(`before`·`entity_key`)를
//  읽어 **전체가 no-op** 이었다(모든 판정이 undefined 로 떨어져 전부 통과). `DeletedRow[]` 로 받으면
//  같은 실수가 컴파일 에러가 된다.
async function filterVisibleDeleted(entries: DeletedRow[], viewer: Viewer): Promise<DeletedRow[]> {
  if (viewer === null || !entries?.length) return entries;
  const visIds = await visibleListIds(viewer);
  const out: DeletedRow[] = [];
  for (const e of entries) {
    if (e.entity === "knowledge") {
      // 삭제된 지식은 knowledge 행이 없어 canSeeKnowledge 가 판정할 근거를 잃는다 → 스냅샷의 visibility 로 본다.
      if (e.visibility === "members") continue;
      out.push(e); continue;
    }
    if (e.entity === "project") {
      if (e.list_id != null && visIds && !visIds.has(e.list_id)) continue;
      out.push(e); continue;
    }
    out.push(e);   // 카테고리 — 조직 공용 분류축이라 종전대로(콘텐츠 본문이 아니다)
  }
  return out;
}

// 복원 게이트 — 목록(filterVisibleDeleted)과 **같은 근거**를 쓴다. 목록에서 숨긴 것을 복원으로 꺼낼 수
//  있으면 그 숨김은 장식이다. 여기선 스냅샷 전문을 이미 손에 들고 있으므로 그걸 그대로 본다.
async function canRestore(before: Record<string, unknown>, entity: string, viewer: Viewer): Promise<boolean> {
  if (viewer === null) return true;   // 특권(내부·긴급 열람)
  if (entity === "knowledge") return before.visibility !== "members";
  if (entity === "project") {
    const listId = before.list_id == null ? null : Number(before.list_id);
    if (listId == null) return true;
    const visIds = await visibleListIds(viewer);
    return !visIds || visIds.has(listId);
  }
  return true;   // 카테고리 — 조직 공용 분류축
}

const deletedList: Capability = {
  name: "deleted_list",
  title: "삭제됨(휴지통)",
  description:
    "삭제된 항목(지식/프로젝트/카테고리)을 최신 삭제순으로 조회한다 — 감사로그(org_content_audit) 기반으로 " +
    "각 항목의 마지막 작업이 'delete' 인 것만(이후 복원/재생성된 건 제외). 복원은 content_restore.",
  scope: "memory",
  input: {
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — 최신 삭제 N건 너머 옛 항목 순회(#709)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/deleted"],
      parse: (req) => ({
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const entries = await listDeleted(input.limit, input.offset);
    // 휴지통 항목은 **삭제 시점의 전문 스냅샷**(before)을 그대로 들고 있다(#1291) — 잠긴 리스트의 프로젝트나
    //  대상 제한 지식이 여기로 새면, 지우기만 하면 누구나 읽을 수 있게 된다.
    //  스냅샷만으로 공개범위를 판정할 수 없는 항목(카테고리 등 컨테이너가 없는 것)은 **비특권에게 숨긴다** —
    //  근거가 없을 땐 닫는 쪽이 안전하다. admin(특권)은 종전대로 전부 본다(복원은 관리 행위다).
    // v2: admin 도 우회하지 않는다. 다만 휴지통은 '무엇이 지워졌나'를 아는 게 운영의 핵심이라
    //  admin 에겐 **행은 보이되 스냅샷 본문을 지운 형태**로 준다(메타만). 내용이 필요하면 긴급 열람.
    const visible = await filterVisibleDeleted(entries, ctx?.viewer ?? null);
    if (!isAdmin(user)) return { entries: visible };
    const shownKeys = new Set(visible.map((e) => `${e.entity}:${e.key}`));
    const withMeta = entries.map((e) => shownKeys.has(`${e.entity}:${e.key}`)
      ? e
      : { ...e, locked: true, note: "공개범위 제한 — 복원·열람은 긴급 열람으로만" });
    return { entries: withMeta };
  },
};

const contentRestore: Capability = {
  name: "content_restore",
  title: "삭제 복원",
  description:
    "삭제된 항목을 감사 스냅샷(마지막 delete 의 before)으로 재적재한다. entity=knowledge|project|category, " +
    "key=name(지식)|id(프로젝트/카테고리). 본문/메타는 삭제 시점 그대로 복구되고, 복원 사실은 감사 op='restore' 로 남는다. " +
    "⚠ 자식·연결(카테고리/프로젝트/활동 링크 등)은 삭제 시 cascade 됐으므로 복원되지 않는다(본체만). " +
    "⚠ 사람(웹)만 — 에이전트(MCP)는 403. 카테고리 복원은 context 권한이 필요하다.",
  scope: "memory",
  input: { entity: z.enum(ENTITIES), key: z.string().min(1) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/deleted/restore"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const entity = String(b.entity ?? "");
        if (!(ENTITIES as readonly string[]).includes(entity)) throw new HttpError(400, "entity 는 knowledge|project|category");
        const key = String(b.key ?? "").trim();
        if (!key) throw new HttpError(400, "key 가 필요합니다");
        return { entity, key };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    // 비가역 큐레이션 — 에이전트(MCP) 금지. deny pattern 은 domain_delete 와 동형.
    if (ctx?.source === "mcp") {
      throw new HttpError(403, "복원은 사람(웹)만 가능합니다 — 에이전트는 거부됩니다(큐레이션)");
    }
    // 카테고리는 context scope 자원 — memory 만으론 복원 불가(엔티티별 권한 정합).
    if (input.entity === "category" && !((user?.scopes ?? []) as string[]).includes("context")) {
      throw new HttpError(403, "카테고리 복원은 context 권한이 필요합니다");
    }
    const before = await getDeleteSnapshot(input.entity, input.key);
    if (!before) throw new HttpError(404, `복원할 삭제 스냅샷이 없습니다(entity=${input.entity}, key=${input.key})`);
    // #1291 — **삭제는 잠금을 푸는 문이 아니다.** 게이트가 없으면 "지우고 되살리기"가 세탁 경로가 된다:
    //  잠긴 지식을 복원하면 응답에 body_md 가 실려 오고, grant 테이블은 CASCADE 로 이미 비었으므로
    //  복원된 행은 DDL 기본값(open)으로 되살아난다. 목록에서 안 보이는 것을 복원할 수는 없어야 한다.
    if (!(await canRestore(before, input.entity, ctx?.viewer ?? null))) {
      throw new HttpError(404, `복원할 삭제 스냅샷이 없습니다(entity=${input.entity}, key=${input.key})`);
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    let item: unknown;
    if (input.entity === "knowledge") item = await restoreKnowledge(before, writeCtx);
    else if (input.entity === "project") item = await restoreProject(before, writeCtx);
    else item = await restoreCategory(before, writeCtx);
    return { restored: true, entity: input.entity, key: input.key, item };
  },
};

export const trashCapabilities: Capability[] = [deletedList, contentRestore];
