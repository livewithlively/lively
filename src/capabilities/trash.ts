// v6 휴지통 capability — 삭제됨 조회 + 복원(공통 경로). 삭제는 엔티티별(knowledge_delete·category_delete·
//  project_delete_v6)이 담당하고, 여기는 그것들이 남긴 감사 스냅샷을 한곳에서 보여주고 되돌린다.
//  scope='memory'(공유 평면). 복원은 ⚠ 사람(웹)만 — 에이전트(MCP)는 403(파괴/되돌리기는 사람 큐레이션).
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listDeleted, getDeleteSnapshot } from "../v6/trash-store.js";
import { restoreKnowledge } from "../v6/knowledge-store.js";
import { restoreProject } from "../v6/project-store.js";
import { restoreCategory } from "../v6/category-store.js";

const ENTITIES = ["knowledge", "project", "category"] as const;

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
  handler: async (input: any) => ({ entries: await listDeleted(input.limit, input.offset) }),
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
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    let item: unknown;
    if (input.entity === "knowledge") item = await restoreKnowledge(before, writeCtx);
    else if (input.entity === "project") item = await restoreProject(before, writeCtx);
    else item = await restoreCategory(before, writeCtx);
    return { restored: true, entity: input.entity, key: input.key, item };
  },
};

export const trashCapabilities: Capability[] = [deletedList, contentRestore];
