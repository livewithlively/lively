// org 섹션(항상-주입 규칙 markdown) + 구 org_memory 쓰기 래퍼 — 둘 다 v6 knowledge 위 얇은 래퍼.
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
// 섹션(injection='always')은 v6 knowledge 사용(knowledge_unit 컷오버 완료 2026-06-24).
//  (#1256) 구 org_memory 읽기 경로가 사라져 listKnowledge 임포트도 함께 제거 — 남은 건 쓰기(upsertMemory→upsertK6)뿐.
import {
  upsertKnowledge as upsertK6,
  type KnowledgeRow,
} from "../../v6/knowledge-store.js";
import { audit } from "./audit.js";

export interface OrgMemory {
  name: string;
  title: string | null;
  summary: string | null;      // 카드 표시용 '쉬운 한 줄' 요약(NULL 이면 title 폴백). 실제 제목·본문과 별개.
  body_md: string;
  sort: number;
  domain_key: string | null;   // v6: 대표 category.key(표시용). 구 domainmap 도메인 약결합의 후신.
  domain_repo: string | null;  // v6 미사용(항상 null) — category 는 repo 비종속. 호환 위해 필드 유지.
  is_wiki: boolean;            // WIKI 핀 — 제목+메타가 가이드 ${wiki} 로 항상-주입(본문 제외).
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}
export interface OrgSection {
  section: string;
  body_md: string;
  version: number;
  sort: number;
  updated_at: string | null;
  updated_by: string | null;
}

// ── org 섹션(규칙·페르소나 markdown) — v6 knowledge 테이블 injection='always' 위 얇은 래퍼(캐노니컬 단일진실). ──
//  매핑: section ↔ name(=section), injection='always'. 섹션은 분류대상이 아니라 category 없이 존재(주입 설정 — managed-policy/org-defaults/가이드).
//  v6 컷오버(2026-06-24): 구 knowledge_unit kind='R' → knowledge injection='always'. 반환 shape(OrgSection) 불변(소비자 무수정).
//  v6 upsertKnowledge 는 신규에 category 필수라 섹션엔 부적합 → 직접 SQL(injection='always', 분류 없음).
const SECTION_COLS = "name, body_md, version, sort, updated_at, updated_by";
function rowToSection(r: Record<string, unknown>): OrgSection {
  return {
    section: r.name as string, body_md: (r.body_md as string) ?? "",
    version: (r.version as number) ?? 1, sort: (r.sort as number) ?? 0,
    updated_at: (r.updated_at as string) ?? null, updated_by: (r.updated_by as string) ?? null,
  };
}

export async function getSection(section: string): Promise<OrgSection | null> {
  const r = await itemsPool.query(
    `SELECT ${SECTION_COLS} FROM knowledge WHERE name=$1 AND injection='always' AND lifecycle='active'`, [section]);
  return r.rows[0] ? rowToSection(r.rows[0]) : null;
}

// 항상-주입 섹션 전체(=injection='always' 행) — sort 우선, 동률이면 name. #335: 섹션이 곧 항상-주입의 전부(N개 관리형).
export async function listSections(): Promise<OrgSection[]> {
  const r = await itemsPool.query(
    `SELECT ${SECTION_COLS} FROM knowledge WHERE injection='always' AND lifecycle='active' ORDER BY sort, name`);
  return r.rows.map(rowToSection);
}

// 섹션 upsert(생성/편집) — injection='always' 고정, 분류 없음. 신규는 sort=말미(max+1), 기존은 sort 보존. version 증가·감사.
//  #669: 본문 실변경 시 embedding_* 리셋 — 섹션도 knowledge 행이라 검색 임베딩 대상. 재임베딩은 자동 pending 백필이 줍는다.
export async function updateSection(
  section: string,
  body_md: string,
  actor?: string,
  source?: string,
): Promise<OrgSection> {
  const before = await getSection(section);
  await itemsPool.query(
    `INSERT INTO knowledge(name, body_md, injection, provenance, lifecycle, confidence, source, sort, version, updated_at, updated_by)
     VALUES($1,$2,'always','authored','active',$3,$4,
       COALESCE((SELECT MAX(sort) FROM knowledge WHERE injection='always' AND lifecycle='active'),-1)+1,
       1,now(),$5)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       body_md=EXCLUDED.body_md, injection='always', lifecycle='active',
       embedding_vector=CASE WHEN knowledge.body_md IS DISTINCT FROM EXCLUDED.body_md THEN NULL ELSE knowledge.embedding_vector END,
       embedding_model=CASE WHEN knowledge.body_md IS DISTINCT FROM EXCLUDED.body_md THEN NULL ELSE knowledge.embedding_model END,
       embedding_updated_at=CASE WHEN knowledge.body_md IS DISTINCT FROM EXCLUDED.body_md THEN NULL ELSE knowledge.embedding_updated_at END,
       version=knowledge.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [section, body_md, source === "mcp" ? "ai" : "human", source ?? "web", actor ?? null]);
  const after = await getSection(section);
  await audit("org_section", section, before ? "update" : "insert", before, after, actor, source);
  return after!;
}

// 섹션 삭제 — 행 제거(감사 스냅샷 before 보존, content_restore 복원가능). 섹션은 카테고리·프로젝트 링크가 없어 CASCADE 영향 없음.
export async function deleteSection(section: string, actor?: string, source?: string): Promise<boolean> {
  const before = await getSection(section);
  if (!before) return false;
  await itemsPool.query(`DELETE FROM knowledge WHERE name=$1 AND injection='always'`, [section]);
  await audit("org_section", section, "delete", before, null, actor, source);
  return true;
}

// 섹션 이름 충돌 검사 — 같은 name 이 이미 '일반 지식'(injection!='always')이면 섹션화 시 그 지식을 덮어쓸 위험 → 차단용.
//  반환: 'section'(이미 섹션)·'knowledge'(일반 지식 충돌)·null(미사용).
export async function sectionNameInUse(name: string): Promise<"section" | "knowledge" | null> {
  const r = await itemsPool.query(`SELECT injection FROM knowledge WHERE name=$1`, [name]);
  if (!r.rows[0]) return null;
  return r.rows[0].injection === "always" ? "section" : "knowledge";
}

// 섹션 주입 순서 일괄 설정 — orderedNames 순서대로 sort=0,1,2…(=조립 순서). 목록에 없는 섹션은 그대로(뒤로 밀림).
export async function setSectionsOrder(orderedNames: string[], actor?: string, source?: string): Promise<void> {
  for (let i = 0; i < orderedNames.length; i++) {
    await itemsPool.query(
      `UPDATE knowledge SET sort=$2, updated_at=now() WHERE name=$1 AND injection='always' AND lifecycle='active'`,
      [orderedNames[i], i]);
  }
  await audit("org_section", null, "reorder", null, { order: orderedNames }, actor, source);
}

// ── org_memory(WIKI 인덱스) — v6 knowledge 위 얇은 래퍼(2026-06-23 cutover). 진실원천=v6 knowledge. ──
//  매핑: memory ↔ injection='recalled'(규칙 아님) ∧ provenance='authored'(외부 미러 아님). 신규 메모=recalled/authored.
//  구 kind<>'R' ∧ confidence<>'observed' 와 동치. OrgMemory shape 불변(delivery·UI·MCP 무수정) — domain_key=대표 category.key.
function knowledgeToMemory(k: KnowledgeRow, domainKey: string | null = null): OrgMemory {
  return {
    name: k.name, title: k.title, summary: k.summary, body_md: k.body_md, sort: Number(k.sort) || 0,
    domain_key: domainKey, domain_repo: null, is_wiki: !!k.is_wiki,
    version: k.version, updated_at: k.updated_at as string | null, updated_by: k.updated_by as string | null,
  };
}

// (#1256) listMemory·repCategoryKeys 제거 — 구 org_memory **읽기** 표면. 소비자가 org_overview/org_sections
//  페이로드의 memory 필드뿐이었고 그걸 읽는 화면·툴이 없었다(관리탭 '메모리' 탭은 #1059 RAM 게이지로 이름만 같다).
//  대가: injection=recalled 500건을 **본문까지** 실어 그 응답의 대부분을 차지했다(고객사 A 실박스 2026-07-30 실측
//  — /api/ui/org/sections 4,371KB 중 4,356KB, body_md 4,137KB). 게다가 #1247 과 같은 LIMIT-후-필터라
//  소비자가 is_wiki 로 핀을 고르면 창 밖 핀이 조용히 빠졌다(같은 실측에서 3건 중 1건).
//  핀 목록의 정본은 listKnowledge({is_wiki:true})·주입은 listWikiPins 다. 쓰기(upsertMemory)의 소비자였던
//  일회성 org migrate 는 scripts/archive/org-migrate.ts 로 보관됨(#1313 R5).

export interface MemoryInput {
  name: string;
  title?: string | null;
  summary?: string | null;     // 카드 표시용 '쉬운 한 줄'(미전송=보존, null=클리어 → title 폴백)
  body_md?: string;
  sort?: number;
  domain_key?: string | null;
  domain_repo?: string | null;
}

export async function upsertMemory(mem: MemoryInput, actor?: string, source?: string): Promise<OrgMemory> {
  // 메모는 항상 recalled/authored(규칙·미러 아님). summary/sort 는 v6 컬럼에 직접 보존.
  // 미분류 금지: domain_key(=category.key)를 upsertK6 category 로 넘겨 신규 시 category 강제
  //  (upsertK6 가 key→id 해소·link·미분류 throw 를 일원 처리). 갱신 시 domain_key 없으면 기존 매핑 보존.
  const k = await upsertK6({
    name: mem.name, title: mem.title ?? undefined, body_md: mem.body_md ?? "",
    summary: mem.summary, sort: mem.sort, injection: "recalled", provenance: "authored",
    category: mem.domain_key ? [mem.domain_key] : undefined,
  }, { actor: actor ?? null, source });
  return knowledgeToMemory(k, mem.domain_key ?? null);
}

// (removeMemory 는 #536 에서 제거 — 유일 소비자였던 org_memory_remove 엔드포인트가 사라짐.
//  메모리 삭제는 knowledge_delete 로 일원화. 읽기(listMemory)도 #1256 에서 제거 — 남은 건 쓰기 upsertMemory 뿐
//  (소비자였던 일회성 migrate 는 scripts/archive/org-migrate.ts 로 보관 — #1313 R5).)
