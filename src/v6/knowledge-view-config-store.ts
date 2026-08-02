// #592 지식 뷰 전역 설정(knowledge_view_config 싱글턴, id=1) — 속성 카탈로그의 전역 기본 숨김 키(hidden_props).
//  ⚠ 이름 주의(#1313 R49 개명): 같은 디렉터리의 view-store.ts 는 **프로젝트 저장 뷰**(project_view, 리스트/폴더
//   스코프)를 다루는 완전히 다른 store 다. 이 파일은 오직 지식(WIKI) 속성 노출 설정 — REST 표면도
//   /api/ui/knowledge-view-config 라 파일명을 그 계약에 맞췄다. 소비자는 capabilities/knowledge/wiki-ui.ts 하나.
//  org_profile(updateOrgProfile, org/store.ts) 패턴: 단일 행 UPDATE + before/after 감사(org_content_audit).
//  의미(#592 §1): 전역 기본 노출 = 카탈로그 전체 − hidden_props. 항목 오버라이드(knowledge.props_ui show/hide)가 우선.
import { itemsPool } from "../db/client.js";
import { one } from "../db/client.js";
import { auditOrgContent, type WriteCtx } from "./content-audit.js";

export interface KnowledgeViewConfig {
  hidden_props: string[];
  updated_at: string | null;
  updated_by: string | null;
}

export async function getKnowledgeViewConfig(): Promise<KnowledgeViewConfig> {
  const r = await one(itemsPool, `SELECT hidden_props, updated_at, updated_by FROM knowledge_view_config WHERE id=1`);
  // 방어적 파싱 — JSONB 오염(비배열/비문자열 요소) 시에도 문자열 배열만 반환(프론트 계약 고정).
  const raw = (r as { hidden_props?: unknown } | undefined)?.hidden_props;
  const hidden = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  return {
    hidden_props: hidden,
    updated_at: (r as { updated_at?: string } | undefined)?.updated_at ?? null,
    updated_by: (r as { updated_by?: string } | undefined)?.updated_by ?? null,
  };
}

export async function setKnowledgeViewConfig(hiddenProps: string[], ctx?: WriteCtx): Promise<KnowledgeViewConfig> {
  // 문자열만·트림·중복 제거·최대 64키(방어 상한 — 속성 카탈로그는 ~19키, #592 §1). 검증 1차는 capability zod.
  const keys = [...new Set(
    (hiddenProps ?? []).filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean),
  )].slice(0, 64);
  const before = await getKnowledgeViewConfig();
  // 스키마가 id=1 을 시드하지만(ON CONFLICT DO NOTHING), 유실 대비 upsert(싱글턴 불변식 자가치유).
  await itemsPool.query(
    `INSERT INTO knowledge_view_config(id, hidden_props, updated_at, updated_by)
     VALUES(1, $1::jsonb, now(), $2)
     ON CONFLICT (id) DO UPDATE SET hidden_props=EXCLUDED.hidden_props, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [JSON.stringify(keys), ctx?.actor ?? null]);
  const after = await getKnowledgeViewConfig();
  await auditOrgContent("knowledge_view_config", "1", "update", before, after, ctx);
  return after;
}
