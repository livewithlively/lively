// 지식 저장 게이트(#783) — knowledge_save 가 정책(org_ingest_policy)을 태우는 지점.
//
//  배경: #638 은 자동 인입(distill/mirror)만 게이트했다. knowledge_save 는 "이미 사람 손"이라 보고 무조건 active 로 통과시켰는데,
//   실측하면 그 가정이 틀렸다 — 라이브 WIKI 의 저작 지식 268건 중 230건(86%)이 confidence='ai'(에이전트가 MCP 로 쓴 것)다.
//   즉 '사람이 시켰다'는 게 '사람이 검증했다'가 아니다. 이 파일이 그 구멍을 막는다.
//
//  판정 축(서버가 결정론적으로 안다 — 에이전트 자기보고가 아니다):
//   · actor_kind — ctx.source: mcp(에이전트)=ai · web(사람)=human. confidence 를 정하는 그 신호(knowledge-store.ts).
//   · agent      — 하네스 id(claude-code|codex|openclaw…). 게이트웨이가 접속 신원으로 식별(org/agent-identity.ts).
//   · category/type/provenance — 저장 입력 또는 기존 행에서.
//
//  게이트 우회(의도적):
//   · is_folder     — 구조 노드(본문 없음). 검토할 내용이 없다.
//   · 대상이 active 가 아닌 수정 — 이미 pending(검토 대기 중인 자기 초안)/archived/superseded 인 지식은 수정 게이트 대상이 아니다.
//     (자기 초안을 다듬는 반복 저장이 매번 리비전을 낳으면 큐가 홍수난다.)
//   · content_restore(undo)·seed·미러 — upsertKnowledge 직접 호출이라 애초에 이 경로를 안 탄다(capability 계층 게이트).
import { itemsPool } from "../items/store.js";
import { one } from "../domainmap/db.js";
import { actorKindOf } from "../db/write.js";
import { resolveIngestPolicy, type CreateAction, type UpdateAction } from "../org/ingest-policy.js";
import { getIngestPolicyRules } from "../org/ingest-policy-load.js";
import { slugify } from "./knowledge-store.js";

export interface GateSaveInput {
  name?: string;
  title?: string;
  body_md?: string;
  type?: string | null;
  category?: string;
  provenance?: string;
  lifecycle?: string;
  is_folder?: boolean;
}

// 수정 게이트의 base 스냅샷 — diff·되돌리기 기준.
export interface GateBefore {
  name: string;
  title: string | null;
  body_md: string;
  version: number;
  lifecycle: string;
  confidence: string | null;
  type: string | null;
  provenance: string | null;
}

export interface KnowledgeGate {
  name: string | null;          // 해석된 지식 name(신규 + name 미지정이면 null — upsert 가 슬러그 자동생성)
  isCreate: boolean;
  before: GateBefore | null;
  create: CreateAction;         // 신규일 때 적용할 액션
  update: UpdateAction;         // 수정일 때 적용할 액션
  rule_id: number | null;       // 이 결정을 내린 규칙(설명가능성 — 검토 큐가 "왜 대기 중인지" 보여준다)
  actor_kind: string | null;
  agent: string | null;
}

// 저장 1건에 대한 게이트 결정. 정책 규칙 0개(디폴트)면 create=auto·update=auto → 현행과 100% 동일.
export async function resolveKnowledgeGate(input: GateSaveInput, ctx?: { source?: string; agent?: string }): Promise<KnowledgeGate> {
  const actor_kind = actorKindOf(ctx?.source ?? null);
  const agent = ctx?.agent ?? null;
  const name = input.name ? slugify(input.name) : null;

  const before = name
    ? (await one(itemsPool,
      `SELECT name, title, body_md, version, lifecycle, confidence, type, provenance
         FROM knowledge WHERE name=$1`, [name])) as GateBefore | undefined
    : undefined;
  const isCreate = !before;

  // 폴더(구조 노드)는 검토 대상이 아니다 — 즉시 통과.
  if (input.is_folder === true) {
    return { name, isCreate, before: before ?? null, create: "auto", update: "auto", rule_id: null, actor_kind, agent };
  }

  // 카테고리 축: 저장이 명시하면 그것, 아니면 기존 지식의 카테고리(수정 시 도메인별 규칙이 걸리도록).
  let category: string | null = input.category ?? null;
  if (!category && before) {
    const row = await one(itemsPool,
      `SELECT c.key FROM knowledge_category kc JOIN category c ON c.id=kc.category_id
        WHERE kc.name=$1 LIMIT 1`, [before.name]) as { key: string } | undefined;
    category = row?.key ?? null;
  }

  const decision = resolveIngestPolicy({
    category,
    provenance: input.provenance ?? before?.provenance ?? "authored",
    type: input.type ?? before?.type ?? null,
    actor_kind,
    agent,
    system: null, channel: null, sensitive: null,   // 미러 전용 축(저작 경로엔 신호 없음)
  }, await getIngestPolicyRules());

  // 수정 게이트는 '라이브(active) 지식을 건드릴 때'만. pending 초안·archived·superseded 수정은 그대로 통과.
  const update: UpdateAction = (!isCreate && before?.lifecycle === "active") ? decision.update : "auto";

  return {
    name, isCreate, before: before ?? null,
    create: decision.create,
    update,
    rule_id: isCreate ? decision.create_rule_id : (update === "auto" ? null : decision.update_rule_id),
    actor_kind, agent,
  };
}
