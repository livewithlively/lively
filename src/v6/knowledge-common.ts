// v6 knowledge 공용 프리미티브(#1313 R21) — knowledge-store / knowledge-search / knowledge-links 가 함께 쓰는 최소 조각.
//  왜 store 가 아니라 여기냐: store 는 검색(knowledge-search)·링크(knowledge-links)를 **재수출**하므로 store→그 둘 방향이
//  이미 있다. 이 조각들을 store 에 두면 그 둘이 store 를 되import 해 순환이 난다(#1313 게이트 check-imports 가 잡는다).
//  담는 것은 '어느 표면이든 지식 1건을 다룰 때 필요한' 규칙뿐 — 슬러그·감사·가시성 술어·아이콘 표현식.
//  (K_COLS/K_SEL 등 조회 컬럼 집합은 store 전용이라 그대로 knowledge-store.ts 에 남긴다.)
import { itemsPool, one } from "../db/client.js";
import { auditOrgContent, type WriteCtx } from "./content-audit.js";
import { visibleListIds, effectiveViewer, type Viewer } from "./visibility.js";
import { axisOn } from "./visibility-axes.js";

// 지식 1건의 가시성 술어(#1291) — 'k' 별칭 기준. 뷰어가 몇 번째 바인드 파라미터인지는 호출부가 정한다
//  (번호를 고정하면 파라미터가 하나 늘어나는 순간 조용히 엉뚱한 값으로 판정하게 된다).
//  판정: open 이거나, 직접 대상(멤버·팀)이거나, **참조된 리스트가 그 사람에게 보이거나**.
//  ⚠ 리스트 판정은 여기서 다시 짜지 않는다 — 폴더 상속은 조상 체인 재귀라 손으로 옮겨 적으면 1홉짜리 사본이
//   또 생긴다(그 사본이 스페이스▸폴더▸리스트에서 잠금을 흘렸다). 가시 리스트 집합을 호출부가 넘겨 세미조인한다.
//  별칭(a)은 인자다 — 지식 테이블을 k 가 아닌 이름으로 조인하는 쿼리(예: 리비전 검토 큐의 kk)도 같은 술어를
//  쓸 수 있어야 한다. 생성된 SQL 을 정규식으로 치환해 별칭을 바꾸던 자리가 있었는데, 술어 안에 k. 로 시작하는
//  다른 별칭이 생기는 순간 조용히 깨진다.
export const knowledgeVisSql = (p: number, visibleLists: Set<number> | null, a = "k") => `(${a}.visibility IS DISTINCT FROM 'members'
  OR EXISTS(SELECT 1 FROM knowledge_member km WHERE km.name=${a}.name
             AND ((km.subject_kind='member' AND km.member_id=$${p})
               OR (km.subject_kind='team' AND EXISTS(SELECT 1 FROM team_member tm
                     WHERE tm.team_id::text=km.member_id AND tm.member_id=$${p}))))
  OR EXISTS(SELECT 1 FROM knowledge_list_grant klg
            WHERE klg.name=${a}.name AND ${visibleLists === null ? "TRUE"
              : (visibleLists.size ? `klg.list_id IN (${[...visibleLists].join(",")})` : "FALSE")}))`;

/**
 * 지식 읽기 쿼리에 이어붙일 가시성 술어(#1291 v2) — **모든 읽기 표면의 단일 진입점**.
 *  · 반환값은 항상 `AND ${…}` 로 이어붙일 수 있는 불리언 식이고, 필터가 필요 없으면 리터럴 "TRUE" 다
 *    (호출부가 분기 없이 쓰게 — 분기가 생기면 어느 한 표면에서 술어를 빠뜨리는 게 눈에 안 띈다).
 *  · viewer **undefined = 미배선**(구 동작 유지, 필터 없음). null = 특권(내부 경로·시스템 잡). 이 둘을 구분하는 이유는
 *    visibility.ts Viewer 규약과 같다 — '깜빡함'과 '의도적 특권'이 코드에서 달라 보여야 한다.
 *  · 긴급열람(전체 스코프)이면 여기서 특권으로 승격한다 — 그러지 않으면 knowledge_member 직접 지정만 된
 *    문서(리스트 grant 없음)는 문을 열어도 안 열린다(knowledgeVisSql 의 리스트 절만으로는 못 덮는 사각).
 *  · 별칭은 기본 `k`, 필요하면 세 번째 인자로 바꾼다(리비전 검토 큐는 `kk`). 술어를 손으로 옮겨 적거나
 *    생성된 SQL 을 치환해 쓰지 마라 — 그 사본이 v1 에서 잠금을 흘린 그 결함이다.
 *  ⚠ 파라미터는 호출부의 params 배열에 **여기서 push** 한다 → 반드시 그 쿼리의 다른 파라미터를 다 넣은 시점이나
 *   그 앞에서 부르고, 반환된 문자열을 그 쿼리에만 써라(배열을 공유하는 다른 쿼리에 재사용하면 자리번호가 어긋난다).
 */
export async function knowledgeVisWhere(viewer: Viewer | undefined, params: unknown[], alias = "k"): Promise<string> {
  if (viewer === undefined) return "TRUE";
  if (!(await axisOn("knowledge"))) return "TRUE";   // 축 꺼짐(#1291) — 지식은 종전처럼 전원 공개

  const eff = await effectiveViewer(viewer);
  if (eff === null) return "TRUE";
  const vis = await visibleListIds(eff);
  params.push(eff);
  return knowledgeVisSql(params.length, vis, alias);
}

// export: knowledge_save 게이트(#783)가 upsert 전에 '신규냐 수정이냐'를 알아야 해서 같은 규칙으로 name 을 미리 해석한다.
//  (슬러그 규칙이 두 벌이 되면 게이트가 엉뚱한 행을 보므로 단일 진실원천 유지.)
export function slugify(s: string): string {
  return ((s || "untitled").toLowerCase().trim()
    .replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)) || "untitled";
}

// 레거시 이름 구제(#1600) — slugify 는 대문자·끝 하이픈을 지우고 64자에서 자른다. 그 규칙이 지금 형태로
//  굳기 전에 저장된 행은 name 이 slugify(name) 과 다르다(끝 하이픈 3건·대문자 1건 실측). 정규화만 하고 끝내면
//  그 행은 **어떤 쓰기 경로로도 못 찾는다** — upsert 는 "없는 문서"로 보고 새 문서를 만들고(중복 3건 실측),
//  원본은 영영 편집 불가로 남는다. slug 로 행이 없고 원본 이름의 행이 있으면 그 행이 편집 대상이다.
//  ⚠ 순서가 중요: slug 행 우선(정상 케이스 무변화) → 그 다음에만 원본 이름을 본다.
export async function resolveKnowledgeName(raw: string): Promise<string> {
  const slug = slugify(raw);
  if (slug === raw) return slug;
  if (await one(itemsPool, `SELECT 1 FROM knowledge WHERE name=$1`, [slug])) return slug;
  if (await one(itemsPool, `SELECT 1 FROM knowledge WHERE name=$1`, [raw])) return raw;
  return slug;
}

// icon(#657) = props_ui->>'icon' — 페이지 아이콘(노션형). 목록·검색·트리 행이 문서 글리프 대신 표시.
export const K_ICON_EXPR = `k.props_ui->>'icon' AS icon`;

export const auditKnowledge = (name: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("knowledge", name, op, before, after, ctx);
