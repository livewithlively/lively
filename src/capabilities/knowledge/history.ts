// 지식 변경 이력 표면(#1546) — 문서 한 건의 시간축 조회 + 임의 버전 되돌리기.
//  데이터는 org_content_audit(이미 before/after 전문을 남기고 있다) — 새 테이블·마이그레이션 없음.
//  구현 근거·실측은 지식 'knowledge-versioning-asis-plan-1546'.
//
//  REST 전용(mcp:false) — P0 은 사람이 웹에서 '뭐가 바뀌었나'를 보는 화면이다. 읽기라 위험은 없지만
//   에이전트 툴 목록 비용이 실재해서, 웹에서 형태가 굳은 뒤 열지 판단한다(#783 검토 큐와 같은 판단).
//   ⚠ mcp:false 여도 input 은 parse 산출과 같은 필드를 선언한다(#1403 규약 — review.ts 헤더 참조).
//
//  scope='memory' — knowledge_get 과 **같은 등급**이다. 이력은 결국 그 문서의 옛 본문이라, 문서를 읽을 수
//   있는 자격과 다른 자격을 요구하면(더 낮든 높든) 어느 쪽이든 게이트가 어긋난다.
import { z } from "zod";
import { HttpError, clampPage } from "../rest-util.js";
import type { Capability, CapabilityCtx } from "../types.js";
import type { LivelyUser } from "../../context.js";
import { canSeeKnowledge } from "../../v6/visibility.js";
import { assertKnowledgeWritable } from "./shared.js";
import {
  listKnowledgeHistory, getKnowledgeHistoryEntry, getKnowledgeSnapshot,
} from "../../v6/knowledge-history-store.js";
import { upsertKnowledge } from "../../v6/knowledge-store.js";
// 스냅샷 → upsert 입력 매핑은 #702 undo 의 것을 그대로 쓴다(두 벌 금지 — 한쪽만 facet 을 빠뜨리면 조용히 지워진다).
import { knowledgeUpsertInput } from "../undo.js";

// 이력은 그 문서의 옛 본문이다 — 지금 그 문서를 못 보는 사람에겐 **없는 문서와 같은 문구**로 답한다(존재 은닉).
//  ⚠ 판정 기준은 감사 스냅샷 안의 옛 visibility 가 아니라 **현재 knowledge 행**이다. 스냅샷 기준으로 열면
//   open 이었다가 members 로 잠긴 문서의 과거 본문이 그대로 샌다(잠금이 소급되지 않는 구멍).
async function assertHistoryReadable(name: string, ctx?: CapabilityCtx): Promise<void> {
  if (!(await canSeeKnowledge(name, ctx?.viewer ?? null))) throw new HttpError(404, `지식 '${name}' 없음`);
}

const knowledgeHistoryInput = {
  name: z.string().min(1).max(64),
  include_meta: z.boolean().optional().describe("true 면 분류·핀·트리이동 같은 메타 변경도 포함(기본 false — 내용 변경만)"),
  limit: z.number().int().min(1).max(200).optional().describe("페이지 크기(1~200, 기본 50)"),
  offset: z.number().int().min(0).optional(),
};
type KnowledgeHistoryInput = z.infer<z.ZodObject<typeof knowledgeHistoryInput>>;
export const knowledgeHistory: Capability = {
  name: "knowledge_history",
  title: "지식 변경 이력",
  description:
    "지식 1건의 변경 이력을 최신순으로 반환한다 — 언제·누가(사람/AI)·어느 경로(웹/MCP/커넥터)·무엇을(±줄수·제목변경·버전). " +
    "기본은 내용 변경(insert·update·set_title·delete·restore)만, include_meta=true 면 분류·핀·이동 등 메타 변경도 포함. " +
    "⚠ 본문은 포함하지 않는다(목록이 무거워진다) — 특정 시점의 전문·diff 는 knowledge_history_entry.",
  scope: "memory",
  input: knowledgeHistoryInput,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/:name/history"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        const im = query.include_meta;
        return {
          name: String(req.params?.name ?? ""),
          include_meta: im != null ? (String(im) === "true" || String(im) === "1") : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        };
      } }],
  },
  handler: async (input: KnowledgeHistoryInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const name = String(input.name);
    await assertHistoryReadable(name, ctx);
    const { limit, offset } = clampPage(input, 50, 200);
    const { rows, total } = await listKnowledgeHistory(name, { includeMeta: !!input.include_meta, limit, offset });
    return { entries: rows, total, limit, offset, has_more: offset + rows.length < total };
  },
};

const knowledgeHistoryEntryInput = {
  name: z.string().min(1).max(64),
  audit_id: z.number().int().positive(),
};
type KnowledgeHistoryEntryInput = z.infer<z.ZodObject<typeof knowledgeHistoryEntryInput>>;
export const knowledgeHistoryEntry: Capability = {
  name: "knowledge_history_entry",
  title: "지식 이력 단건(전문)",
  description:
    "변경 이력 한 항목의 전문 2종(before/after: 제목·본문) — diff 렌더용. " +
    "before 가 null 이면 그 시점 이전엔 문서가 없었다는 뜻(insert), after 가 null 이면 그 변경이 삭제였다는 뜻.",
  scope: "memory",
  input: knowledgeHistoryEntryInput,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/:name/history/:audit_id"],
      parse: (req) => ({
        name: String(req.params?.name ?? ""),
        audit_id: Number(req.params?.audit_id),
      }) }],
  },
  handler: async (input: KnowledgeHistoryEntryInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const name = String(input.name);
    await assertHistoryReadable(name, ctx);
    const id = Number(input.audit_id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "audit_id 는 양의 정수");
    // 스토어가 (name, id) 로 조회한다 — id 만으로 열면 남의 문서 감사행을 id 추측으로 읽을 수 있다.
    const entry = await getKnowledgeHistoryEntry(name, id);
    if (!entry) throw new HttpError(404, "이력 항목 없음");
    return entry;
  },
};

const knowledgeRevertInput = {
  name: z.string().min(1).max(64),
  audit_id: z.number().int().positive(),
  to: z.enum(["before", "after"]).optional().describe("after(기본)=그 변경 직후 버전으로 · before=그 변경을 취소(직전 버전으로)"),
};
type KnowledgeRevertInput = z.infer<z.ZodObject<typeof knowledgeRevertInput>>;
export const knowledgeRevert: Capability = {
  name: "knowledge_revert",
  title: "지식 버전 되돌리기",
  description:
    "이력의 특정 시점 본문·메타를 현재 문서에 다시 적용한다. " +
    "⚠ 파괴적 롤백이 아니다 — 되돌린 결과가 **새 버전으로 앞에 쌓인다**(version+1, 감사행 1건 추가). 이력은 지워지지 않는다. " +
    "⚠ 사람(웹) 전용.",
  scope: "memory",
  input: knowledgeRevertInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/revert"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const to = b.to == null ? undefined : String(b.to);
        if (to != null && to !== "before" && to !== "after") throw new HttpError(400, "to 는 before|after");
        return { name: String(req.params?.name ?? ""), audit_id: Number(b.audit_id), to };
      } }],
  },
  handler: async (input: KnowledgeRevertInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 에이전트 금지 — content_undo(#702) 선례. 에이전트가 자기가 덮어쓴 걸 스스로 되돌릴 수 있으면
    //  #783 검토 게이트(사람이 판단한다)가 무의미해진다. 되돌리기는 사람의 판단이다.
    if (ctx?.source === "mcp") throw new HttpError(403, "되돌리기는 사람(웹)만 가능합니다");
    const name = String(input.name);
    // 쓰기 게이트 = 읽기 게이트와 같은 판정(shared.ts) — 안 보이는 문서는 되돌릴 수도 없다.
    await assertKnowledgeWritable(name, ctx?.viewer ?? null);
    if (!(await canSeeKnowledge(name, ctx?.viewer ?? null))) throw new HttpError(404, `지식 '${name}' 없음`);
    const id = Number(input.audit_id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "audit_id 는 양의 정수");
    const dir = input.to === "before" ? "before" : "after";

    const { op, snapshot } = await getKnowledgeSnapshot(name, id, dir).catch(() => {
      throw new HttpError(404, "이력 항목 없음");
    });
    if (!snapshot) {
      // insert 의 before, delete 의 after 는 '그 시점엔 문서가 없었다'는 뜻이다. 되돌리면 삭제가 되는데,
      //  삭제는 별도 표면(휴지통·knowledge_delete)의 일이라 여기서 조용히 수행하지 않는다.
      throw new HttpError(400, dir === "before"
        ? "이 변경 이전엔 문서가 없었습니다(최초 생성) — 되돌릴 이전 버전이 없습니다."
        : "이 변경은 삭제였습니다 — 되돌릴 이후 버전이 없습니다.");
    }
    // 전체 행 스냅샷을 가진 op 만 되돌린다. set_props_ui({props_ui})·link_category({category_id}) 같은
    //  부분 스냅샷을 upsertKnowledge 에 넘기면 body_md 가 빈 문자열로 들어가 **문서를 통째로 비운다**.
    if (typeof snapshot.name !== "string" || typeof snapshot.body_md !== "string") {
      throw new HttpError(400, `'${op}' 변경은 본문 스냅샷이 없어 되돌릴 수 없습니다(분류·표시설정 등은 해당 화면에서 되돌리세요).`);
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    // upsertKnowledge 재사용 = 감사·version+1·임베딩 재예약·위키링크 재구성이 정상 저장과 동일하게 따라간다.
    //  source 를 'web' 그대로 두는 건 의도다 — 되돌리기도 사람의 웹 변경이라 Cmd+Z(#702, channel='web')로
    //  다시 취소할 수 있어야 한다(source='undo' 로 감추면 그 되돌리기만 취소 불가가 된다).
    const after = await upsertKnowledge(knowledgeUpsertInput(snapshot), writeCtx);
    return {
      ok: true,
      name,
      reverted_from: { audit_id: id, op, to: dir },
      version: (after as { version?: number }).version ?? null,
      note: "되돌린 결과가 새 버전으로 저장됐습니다 — 이력은 그대로 남아 있습니다.",
    };
  },
};

// /knowledge/:name/history · /history/:audit_id · /revert — 전부 :name 하위 경로라 /knowledge/:name 과 안 겹친다.
export const historyCapabilities: Capability[] = [knowledgeHistory, knowledgeHistoryEntry, knowledgeRevert];
