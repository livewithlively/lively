// G(도메인 부채) 자동 평가 — 의도(should)와 구조(is)의 diff 중 *결정론적으로 깨끗이 떨어지는 슬라이스*만.
//
// 정직한 범위 선언: 일반적인 'D/K knowledge_unit(의도) ↔ S domainmap(구조)' 시맨틱 diff 는
// 의미 판단(어느 knowledge_unit 이 어느 domain 에 해당하나)을 요하고, 두 스토어 간 canonical join
// key 가 없다 — 이건 NL/임베딩 판단이라 '무리한 자동분해'다(보류, 보고 참조). 대신 여기서는
// domainmap 테이블만으로 결정론적으로 계산되는 *구조→의도 발산* 신호 두 종을 debt_finding 으로
// 자동 생성한다(둘 다 도메인의 should 가 코드 구조에서 증발한 케이스 — domain-debt 도메인 정의 그대로):
//   (A) vanished:   confirmed-매핑 code_unit 이 *전부* removed(active 0, removed ≥1) — 도메인의
//                   should 는 살아있는데 구조엔 산 코드가 0. 도메인 폐기/재구현/경계 재검토 신호.
//   (B) eroded:     active 매핑 코드는 남아있지만 removed 가 1건 이상 — 부분 침식(경고 수준).
//
// 비파괴·멱등: upsertDebtRow((category_id,title) 키 upsert; 사람이 닫은 resolved/dismissed/ack 은 재개 안 함).
// kind='domain_debt'. 도메인 매핑은 한 줄도 안 건드린다(읽기 + debt_finding 쓰기뿐).
// V6: 도메인=space='product' category(repo-free). 카운트는 category_id 로 매핑→code_unit(전 레포 union)을 본다.
//  부채는 debt_finding.category_id 로 착지(구조부채 structural_drift 는 repo_id 키 — 별 경로).
import { q, one, type Db } from "../db.js";
import { httpErr, type Actor } from "./types.js";
import { upsertDebtRow } from "./debts.js";

// 도메인별 구조 카운트(PURE 분류 입력). 읽기 SQL 은 evaluate* 가 소유, 분류는 classifyDomainDebt 가.
//  V6: 도메인 = space='product' category. category_id 를 분류 출력까지 운반해 debt_finding.category_id 로 쓴다.
export interface DomainStructureCount {
  category_id: number;    // V6: 부채 귀속 대상(debt_finding.category_id) — 멀티레포라 repo_id 가 아니다.
  key: string;
  name: string;
  should: string | null;  // P5: 의도(당위) 스펙 — 선언됐는데 is(코드)가 없으면 should_no_is
  active_units: number;   // 비-rejected 매핑 + active code_unit
  removed_units: number;  // 비-rejected 매핑 + removed code_unit (confirmed 이 보존된 orphan)
  active_commits: number; // P5: 이 도메인 코드를 건드린 commit 작업(activity) 수 — 통합 DB 네이티브 join(통합 전 불가)
}

export interface DomainDebtFinding {
  category_id: number;    // V6: debt_finding.category_id 로 착지(카테고리 귀속 부채).
  key: string;
  severity: "vanished" | "eroded" | "should_no_is";
  title: string;
  detail: string;
}

// 결정론적 분류(PURE — DB 무접촉, 단위테스트 가능). active==0 && removed>0 → vanished;
// active>0 && removed>0 → eroded; 그 외(removed==0)는 부채 아님(빈 배열).
export function classifyDomainDebt(rows: DomainStructureCount[]): DomainDebtFinding[] {
  const out: DomainDebtFinding[] = [];
  for (const r of rows) {
    const hasShould = !!(r.should && r.should.trim());
    if (r.active_units === 0) {
      if (hasShould) {
        // P5 핵심 — 의도(should)는 선언됐는데 산 코드(is)가 0. 통합 DB 라 commit 작업(activity)도 함께 본다.
        const cause = r.removed_units > 0
          ? `확정-매핑 code_unit ${r.removed_units}건이 모두 removed — 코드가 증발했다`
          : `구현된 적이 없다(should-only)`;
        out.push({
          category_id: r.category_id, key: r.key, severity: "should_no_is",
          title: `의도-구조 괴리: ${r.name} (${r.key})`,
          detail: `도메인 '${r.name}'(${r.key})에 의도(should)가 선언돼 있으나 살아있는(active) 매핑 코드(is)가 0건이다 — ${cause}.`
            + (r.active_commits > 0 ? ` 관련 commit 작업 ${r.active_commits}건이 기록돼 있어 한때 작업이 있었다.` : ``)
            + ` 의도를 코드로 구현하거나, 의도를 폐기/재정의해야 한다(should↔is 정합).`,
        });
      } else if (r.removed_units > 0) {
        // should 미선언 + 코드 증발 — 구조 신호만(의도 불명).
        out.push({
          category_id: r.category_id, key: r.key, severity: "vanished",
          title: `도메인 구조 증발: ${r.name} (${r.key})`,
          detail: `도메인 '${r.name}'(${r.key})의 확정-매핑 code_unit ${r.removed_units}건이 모두 removed 상태이고 살아있는(active) 매핑 코드가 0건이다. 의도(should)도 미선언 — 도메인 폐기/재구현/경계 재검토가 필요.`,
        });
      }
      // else: active=0, removed=0, should 없음 → 빈 도메인(부채 아님, skip).
    } else if (r.removed_units > 0) {
      out.push({
        category_id: r.category_id, key: r.key, severity: "eroded",
        title: `도메인 구조 침식: ${r.name} (${r.key})`,
        detail: `도메인 '${r.name}'(${r.key})의 매핑 코드 중 ${r.removed_units}건이 removed 되고 ${r.active_units}건만 active 로 남았다. 일부 구조가 사라졌으니 매핑/경계 재검토가 필요(리팩터 후 매핑 재배치 누락 가능).`,
      });
    }
  }
  return out;
}

// 도메인별 active/removed 매핑 코드 카운트 읽기. V6: 도메인=space='product' category(repo-free 멀티레포),
//  매핑은 category_id 로 코드에 닿는다 — 카운트는 그 category 에 매핑된 모든 레포의 code_unit 을 합산한다
//  (category 의 'is'는 전 레포 union 이 진실 — 부채는 카테고리 속성이지 per-repo 가 아니다). rejected 매핑 제외
//  (술어는 v6 listProductDomains 의 units 카운트와 동일 정신 — COALESCE state, status<>'rejected').
async function readDomainStructureCounts(db: Db): Promise<DomainStructureCount[]> {
  return q(db, `
    SELECT c.id AS category_id, c.key, c.name, c.should,
      (SELECT COUNT(*)::int FROM mapping m JOIN code_unit cu ON cu.id=m.target_id
         WHERE m.target_kind='code_unit' AND m.category_id=c.id
         AND m.status<>'rejected' AND COALESCE(cu.state,'active')='active') active_units,
      (SELECT COUNT(*)::int FROM mapping m JOIN code_unit cu ON cu.id=m.target_id
         WHERE m.target_kind='code_unit' AND m.category_id=c.id
         AND m.status<>'rejected' AND cu.state='removed') removed_units,
      -- P5: 통합 DB 네이티브 join — 이 도메인 코드를 건드린 commit 작업(activity) 수(통합 전엔 별 DB라 불가).
      (SELECT COUNT(DISTINCT a.id)::int FROM activity a
         JOIN activity_touch at2 ON at2.activity_id=a.id AND at2.target_kind='code_unit'
         JOIN mapping m ON m.target_kind='code_unit' AND m.target_id=at2.target_id
           AND m.category_id=c.id AND m.status<>'rejected'
         WHERE a.type='commit') active_commits
    FROM category c
    WHERE c.space='product' AND c.state<>'merged'
    ORDER BY c.key`);
}

// 자동 평가 + upsert. trust-default 환경이라 자동 생성 debt 는 origin=actor.type 보존(누가 만들었나),
// status='open' 으로 착지(upsertDebtRow). 같은 title 재실행은 unchanged(멱등), 사람이 닫으면 kept-*.
// 반환: 평가된 finding 목록 + upsert action 통계(insert/unchanged/kept-*).
export async function evaluateDomainStructureDebt(
  repoName: string, actor: Actor,
): Promise<{ findings: DomainDebtFinding[]; tally: Record<string, number> }> {
  const { dmPool } = await import("../db.js");
  const pool = dmPool();
  const r = await one(pool, "SELECT id FROM repo WHERE name=$1", [repoName]);
  if (!r) throw httpErr(404, "no such repo: " + repoName);
  // V6: 카운트는 category-global(멀티레포 union). repo 는 actor/provenance 용으로만 해소 — 부채 키는 category_id.
  const counts = await readDomainStructureCounts(pool);
  const findings = classifyDomainDebt(counts);
  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  for (const f of findings) {
    // category 귀속 부채 — debt_finding.category_id 로 키(repo_id 는 provenance 로 동반 기록).
    const action = await upsertDebtRow(pool, r.id, null, actor, {
      kind: "domain_debt", title: f.title, detail: f.detail, cited_refs: [], category_id: f.category_id,
    });
    bump(`${f.severity}:${action}`);
  }
  return { findings, tally };
}
