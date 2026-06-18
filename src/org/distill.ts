// P-V3-6 증류 v1(규칙판) — 활동(observed A/W)에서 지속가치 있는 지식(K/D)을 **결정론 규칙**으로 추출해
//  proposed 후보(knowledge_unit, confidence='ai')로 만들어 사람 검토에 올린다. **LLM 0**(측정가능 규칙만).
//
//  ── 설계 골격(H4 완화) ──────────────────────────────────────────────────────────────────────
//  · 후보 = knowledge_unit 의 confidence='ai', lifecycle='active' 행. 큐레이션된 ai 와 같은 신뢰축이지만
//    **distill: 접두 source_ref** 로 식별된다(자동 추출물 vs 에이전트 저작물 구분).
//  · 멱등 후보키: source_ref = `distill:<rule>:<seed>`. name 도 같은 규칙으로 결정론 생성. 같은 시드 재실행 →
//    ON CONFLICT(name)·source_ref 동일 → 중복 후보 0(신규 생성 없음, 본문만 최신화). **재후보화 억제**.
//  · TTL: 미검토(confidence='ai' AND distill source_ref AND 사람 confirm/reject 없음) 후보가 N일(기본 30) 지나면
//    자동 만료(lifecycle='superseded') — **적체 방지**. '미검토'는 사람 손길 부재로 판정한다:
//    confidence 가 여전히 'ai'(human 으로 승격 안 됨) AND lifecycle='active'(reject 으로 superseded 안 됨).
//    만료 기준시각은 최종 추출 시각(updated_at). **runDistill 은 expire 를 upsert 후에** 부르므로, 이번 실행에서
//    rules 가 여전히 산출한 시드는 갓 갱신돼 안 죽고, rules 가 더는 안 내는 dead 시드(활동 소멸)만 N일 후 만료된다.
//  · 캡: 1회 실행 최대 신규 후보 수(기본 20) — 규칙 폭주·후보 홍수 방지. 캡 초과분은 보고만 하고 생성 안 함.
//  · provenance: source_ref(규칙·시드) + evidence(어느 활동에서 왔는지 — 단위 수·근거 요약). 본문에도 근거 명시.
//
//  ── 주입 격리(H2 와 정합) ───────────────────────────────────────────────────────────────────
//  · observed 원본(A/W)은 query-only(인덱스 비주입, H2). 후보 K/D 는 confidence='ai' 라 **검토 큐엔 뜨지만**,
//    materialize.buildKnowledgeIndex 가 **distill: source_ref 후보를 항상-주입 인덱스에서 제외**한다
//    (= '승인 시 인덱스 진입'). 사람이 confirm(→human 승격 + distill 마커 해제)해야 인덱스로 들어온다.
//
//  ── v1 한계(정직) ──────────────────────────────────────────────────────────────────────────
//  규칙판은 본질적으로 제한적이다: '의미'를 못 본다. 측정가능 신호(매핑 수·반복)만 규칙으로 뽑으므로
//  '진짜 지속가치'의 부분집합만 잡고, 억지 규칙은 노이즈가 된다. **억지 규칙 금지** — 실제 데이터에 깨끗이
//  떨어지는 규칙만 싣는다. LLM 증류(본문 의미 요약·중복 병합·진짜 인사이트 추출)는 v2.
import { itemsPool } from "../items/store.js";

// ── 파라미터(기본값) — CLI 가 덮어쓸 수 있다. ──
export const DISTILL_DEFAULTS = {
  ttlDays: 30,        // 미검토 후보 만료 일수
  cap: 20,            // 1회 실행 최대 신규 후보 수
  minWorkPerDomain: 3,  // R-DOMAIN-WORKLOAD: 도메인당 최소 distinct W 수
  minWorkPerProject: 3, // R-PROJECT-CLUSTER: declared 프로젝트당 최소 distinct W 수
} as const;

export const DISTILL_SOURCE_PREFIX = "distill:";

export interface DistillCandidate {
  rule: string;            // 규칙 id (예 'domain-workload')
  seed: string;            // 멱등 시드 (예 'productivity/domain-cartography')
  name: string;            // knowledge_unit name (결정론)
  kind: "K";               // V4-P2a: 본질 4종 narrow — 도메인은 area(domain_key) 축이라 후보는 K(+domain_key). (distill 은 P3 에서 제거.)
  title: string;
  body_md: string;
  domain_key: string | null;
  domain_repo: string | null;
  evidence: string;        // provenance — 근거 요약(단위 수·소속)
  source_ref: string;      // `distill:<rule>:<seed>`
}

export interface DistillReport {
  dry: boolean;
  ttlDays: number;
  cap: number;
  candidates: DistillCandidate[];   // 규칙이 산출한 전체 후보(캡 적용 전)
  created: number;                  // 실제 신규 생성(없던 name)
  refreshed: number;                // 이미 있던 후보 본문 갱신(멱등 — 신규 아님)
  cappedOut: number;                // 캡 초과로 생성하지 않은 신규 후보 수
  expired: number;                  // TTL 만료(superseded) 처리된 후보 수
  expiredNames: string[];
}

// ── 결정론 name/seed 생성 — 같은 입력은 항상 같은 name(멱등 후보키). ──
//  name = `distill-<rule>-<slug(seed)>`(소문자 영숫자/-, 64자 상한). seed 는 (repo/key) 안정 식별자.
function candidateName(rule: string, seed: string): string {
  const slug = `${rule}-${seed}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ("distill-" + slug).slice(0, 64);
}
function sourceRef(rule: string, seed: string): string {
  return `${DISTILL_SOURCE_PREFIX}${rule}:${seed}`;
}

// ════════ 규칙 엔진(결정론·측정가능) ════════
// 각 규칙은 우리 데이터에 **깨끗이 떨어지는** 신호만 본다. 모든 규칙은 observed(A/W) 단위와 그 매핑만 입력으로
//  받고, knowledge_unit 의 큐레이션물(K/R 등)·다른 후보는 보지 않는다(증류는 활동→지식 단방향).

// ── R-DOMAIN-WORKLOAD: 한 도메인에 distinct observed W(작업) 단위가 N개 이상 → 그 도메인 '활성 작업영역' D 후보. ──
//  근거: 같은 도메인 슬러그에 여러 작업이 매핑됐다는 건 그 도메인이 *지금 일이 일어나는 곳*이라는 측정가능 신호.
//  ⚠ 정직: 우리 데이터의 W↔domain 링크는 전부 proposed(rule/llm 추론)다 — confirmed/declared 가 아니다.
//   따라서 이 후보는 본질적으로 **약한 ai 제안**(검토 필수). 그래서 confidence='ai' 로 검토 큐에만 올리고 인덱스
//   비주입(승인 시 진입)인 것이 정확하다. 링크 상태(state)는 evidence 에 정직히 표기한다.
async function ruleDomainWorkload(minWork: number, repos?: string[]): Promise<DistillCandidate[]> {
  const params: unknown[] = [minWork];
  let repoClause = "";
  if (repos && repos.length) { params.push(repos); repoClause = ` AND kud.repo = ANY($${params.length})`; }
  const rows = (await itemsPool.query(
    `SELECT kud.repo, kud.domain_key,
            COUNT(DISTINCT ku.name)::int AS work_count,
            -- state 분포(provenance evidence 용) — declared/confirmed 가 있으면 더 강한 신호.
            COUNT(DISTINCT ku.name) FILTER (WHERE kud.state IN ('confirmed') OR kud.mapped_by='declared')::int AS strong_count
       FROM knowledge_unit ku
       JOIN knowledge_unit_domain kud ON kud.name = ku.name
      WHERE ku.kind='W' AND ku.confidence='observed' AND kud.state <> 'rejected'
        AND kud.domain_key IS NOT NULL AND kud.repo IS NOT NULL${repoClause}
      GROUP BY kud.repo, kud.domain_key
     HAVING COUNT(DISTINCT ku.name) >= $1
      ORDER BY work_count DESC, kud.repo, kud.domain_key`,
    params,
  )).rows;

  return rows.map((r) => {
    const repo = r.repo as string;
    const domainKey = r.domain_key as string;
    const seed = `${repo}/${domainKey}`;
    const n = Number(r.work_count);
    const strong = Number(r.strong_count);
    const evidence =
      `observed W ${n}건이 도메인 '${domainKey}'(repo=${repo})에 매핑됨` +
      (strong > 0 ? ` (그중 ${strong}건은 declared/confirmed 강신호)` : ` (전부 proposed 추론 링크 — 약신호, 검토 필수)`);
    return {
      rule: "domain-workload",
      seed,
      name: candidateName("domain-workload", seed),
      kind: "K" as const, // V4-P2a: 도메인은 area(domain_key) 축 — 후보는 K + domain_key(아래)로 area 표현
      title: `활성 작업영역: ${domainKey}`,
      body_md:
        `도메인 '${domainKey}'(repo \`${repo}\`)에 최근 작업(observed W task)이 ${n}건 매핑되어 ` +
        `**활성 작업영역**으로 보입니다.\n\n` +
        `- 근거: ${evidence}\n` +
        `- 출처: 규칙 증류 \`domain-workload\`(측정가능 신호 — W↔domain 매핑 수). 본문 의미는 미검증(규칙판 한계).\n` +
        `- 다음: 이 도메인이 실제 활성 작업영역이면 확정(confirm), 아니면 반려(reject)하세요.`,
      domain_key: domainKey,
      domain_repo: repo,
      evidence,
      source_ref: sourceRef("domain-workload", seed),
    };
  });
}

// ── R-PROJECT-CLUSTER: declared 프로젝트(예 ClickUp 리스트)에 distinct observed W 가 N개 이상 → 그 프로젝트가 ──
//  반복적으로 작업이 모이는 '작업 클러스터'라는 K(노트) 후보. **반복 신호** — 같은 declared 그룹에 다회 활동.
//  근거: knowledge_unit_project 의 mapped_by='declared'(PM 툴이 단언한 그룹핑 — 추론 아님)는 우리 데이터에서
//   가장 강한 그룹 신호다(W↔clickup list, 30건 declared/confirmed). 깨끗이 떨어진다.
async function ruleProjectCluster(minWork: number, repos?: string[]): Promise<DistillCandidate[]> {
  const params: unknown[] = [minWork];
  let repoClause = "";
  if (repos && repos.length) { params.push(repos); repoClause = ` AND kup.repo = ANY($${params.length})`; }
  const rows = (await itemsPool.query(
    `SELECT kup.repo, kup.project_key,
            COUNT(DISTINCT ku.name)::int AS work_count
       FROM knowledge_unit ku
       JOIN knowledge_unit_project kup ON kup.name = ku.name
      WHERE ku.kind='W' AND ku.confidence='observed'
        AND kup.mapped_by='declared' AND kup.state='confirmed'
        AND kup.project_key IS NOT NULL AND kup.repo IS NOT NULL${repoClause}
      GROUP BY kup.repo, kup.project_key
     HAVING COUNT(DISTINCT ku.name) >= $1
      ORDER BY work_count DESC, kup.repo, kup.project_key`,
    params,
  )).rows;

  return rows.map((r) => {
    const repo = r.repo as string;
    const projectKey = r.project_key as string;
    const seed = `${repo}/${projectKey}`;
    const n = Number(r.work_count);
    const evidence = `observed W ${n}건이 declared 프로젝트 '${projectKey}'(repo=${repo})에 PM-툴 단언 링크로 묶임`;
    return {
      rule: "project-cluster",
      seed,
      name: candidateName("project-cluster", seed),
      kind: "K" as const,
      title: `작업 클러스터: ${projectKey}`,
      body_md:
        `프로젝트 '${projectKey}'(repo \`${repo}\`)에 작업(observed W task)이 ${n}건 반복적으로 모입니다 ` +
        `— PM 툴이 **단언한**(declared) 그룹이라 강한 신호입니다.\n\n` +
        `- 근거: ${evidence}\n` +
        `- 출처: 규칙 증류 \`project-cluster\`(측정가능 신호 — declared 프로젝트 W 수). 본문 의미는 미검증(규칙판 한계).\n` +
        `- 다음: 이 클러스터가 기록할 가치가 있으면 확정(confirm)·본문 보강, 아니면 반려(reject)하세요.`,
      // 프로젝트는 도메인 슬러그가 아니므로 domain_key 는 비움(약결합). evidence/본문에 project_key 보존.
      domain_key: null,
      domain_repo: null,
      evidence,
      source_ref: sourceRef("project-cluster", seed),
    };
  });
}

// 규칙 레지스트리 — 추가는 여기 한 줄. 각 규칙은 파라미터를 받아 후보 배열을 반환.
//  repos(선택): 주면 해당 repo 의 매핑만 본다(per-repo 증류·테스트 격리). 생략 = 전체 repo.
export async function runRules(params: {
  minWorkPerDomain: number; minWorkPerProject: number; repos?: string[];
}): Promise<DistillCandidate[]> {
  const [a, b] = await Promise.all([
    ruleDomainWorkload(params.minWorkPerDomain, params.repos),
    ruleProjectCluster(params.minWorkPerProject, params.repos),
  ]);
  // 안정 정렬(rule, seed) — 캡 적용·재실행 결과를 결정론으로 만든다(같은 입력→같은 캡 컷).
  return [...a, ...b].sort((x, y) => (x.rule + x.seed).localeCompare(y.rule + y.seed));
}

// ── 후보 적재(멱등) — INSERT … ON CONFLICT(name) DO UPDATE. confidence='ai'·lifecycle='active'·distill source_ref. ──
//  멱등: 같은 name(=같은 rule:seed)은 재실행 시 신규 0, 본문/evidence/title 만 최신화(updated_at 갱신 → TTL 시계 리셋).
//  ⚠ 큐레이션 보호: 이미 사람이 손댄 후보(confidence='human' = confirm, 또는 lifecycle<>'active' = reject)는
//   **덮어쓰지 않는다**(WHERE 가드) — 사람의 결정을 규칙이 되돌리지 못하게 한다(재후보화 억제의 핵심).
async function upsertCandidate(c: DistillCandidate): Promise<"created" | "refreshed" | "skipped"> {
  // 기존 행 상태 확인(사람 손길 보호).
  const ex = (await itemsPool.query(
    `SELECT confidence, lifecycle, source_ref FROM knowledge_unit WHERE name=$1`, [c.name],
  )).rows[0] as { confidence?: string; lifecycle?: string; source_ref?: string } | undefined;

  if (ex) {
    // 사람이 confirm(human) 또는 reject(active 아님) 했으면 그대로 둔다(재후보화 금지).
    const humanTouched = ex.confidence === "human" || ex.lifecycle !== "active";
    if (humanTouched) return "skipped";
    // 동명 큐레이션물(distill 아닌 ai)과 충돌하면 보호(덮지 않음 — 우연한 슬러그 충돌 방어).
    if (ex.source_ref && !ex.source_ref.startsWith(DISTILL_SOURCE_PREFIX)) return "skipped";
  }

  await itemsPool.query(
    `INSERT INTO knowledge_unit(
        name, kind, title, body_md, domain_key, domain_repo,
        lifecycle, confidence, source_ref, author, updated_at, updated_by)
      VALUES($1,$2,$3,$4,$5,$6,'active','ai',$7,'distill:rules',now(),'distill:rules')
     ON CONFLICT (name) DO UPDATE SET
        kind=EXCLUDED.kind, title=EXCLUDED.title, body_md=EXCLUDED.body_md,
        domain_key=EXCLUDED.domain_key, domain_repo=EXCLUDED.domain_repo,
        lifecycle='active', confidence='ai', source_ref=EXCLUDED.source_ref,
        version=knowledge_unit.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by
      -- 멱등·보호: distill 후보이고 아직 사람이 안 건드린 경우에만 갱신(human/reject 는 위에서 이미 skip).
      WHERE knowledge_unit.confidence='ai' AND knowledge_unit.lifecycle='active'`,
    [c.name, c.kind, c.title, c.body_md, c.domain_key, c.domain_repo, c.source_ref],
  );

  // evidence 는 본문에 이미 포함. (조인테이블에 별도 적재 안 함 — 후보 단위는 domain_key 약결합으로 충분.)
  return ex ? "refreshed" : "created";
}

// ── TTL 만료 — 미검토(ai·active·distill source_ref) 후보 중 updated_at 이 ttlDays 보다 오래된 것을 superseded 로. ──
//  '미검토' = confidence 여전히 'ai'(human 으로 승격 안 됨) AND lifecycle='active'(reject 안 됨). 사람이 손대면
//  confidence 나 lifecycle 이 바뀌므로 자연 제외된다. runDistill 은 이 함수를 **upsert 후**에 부르므로, 이번 실행에서
//  rules 가 여전히 산출한 시드(살아있는 작업영역)는 갓 updated_at=now() 라 절대 안 걸린다(= 살아있는 시드 보호).
//  만료되는 건 'rules 가 더는 안 내는 dead 시드 + ttlDays 동안 미검토' 뿐이다. 반환 = 만료된 name 목록.
export async function expireStale(ttlDays: number, dry: boolean, repos?: string[]): Promise<string[]> {
  // repos 스코프: seed=repo/key 라 source_ref 에 repo 슬러그가 들어있다 → repo 별 만료 격리(테스트 안전).
  //  source_ref 형식 'distill:<rule>:<repo>/<key>' 에서 ':<repo>/' 부분 매칭. 생략 = 전체 distill 후보.
  const params: unknown[] = [DISTILL_SOURCE_PREFIX + "%", String(ttlDays)];
  let repoClause = "";
  if (repos && repos.length) {
    const likes = repos.map((r) => { params.push(`%:${r}/%`); return `source_ref LIKE $${params.length}`; });
    repoClause = ` AND (${likes.join(" OR ")})`;
  }
  const sel = (await itemsPool.query(
    `SELECT name FROM knowledge_unit
      WHERE confidence='ai' AND lifecycle='active'
        AND source_ref LIKE $1
        AND updated_at < now() - ($2 || ' days')::interval${repoClause}
      ORDER BY name`,
    params,
  )).rows.map((r) => r.name as string);

  if (!dry && sel.length) {
    await itemsPool.query(
      `UPDATE knowledge_unit SET lifecycle='superseded', version=version+1, updated_at=now(), updated_by='distill:ttl'
        WHERE name = ANY($1)`,
      [sel],
    );
  }
  return sel;
}

// ── 메인 실행 — 규칙 → 캡 → 멱등 적재 → TTL 만료. dry 면 DB 미쓰기(분류·카운트만). ──
export async function runDistill(opts: {
  dry?: boolean;
  ttlDays?: number;
  cap?: number;
  minWorkPerDomain?: number;
  minWorkPerProject?: number;
  repos?: string[];   // 선택: per-repo 증류·테스트 격리(생략=전체 repo)
} = {}): Promise<DistillReport> {
  const dry = !!opts.dry;
  const ttlDays = opts.ttlDays ?? DISTILL_DEFAULTS.ttlDays;
  const cap = opts.cap ?? DISTILL_DEFAULTS.cap;
  const minWorkPerDomain = opts.minWorkPerDomain ?? DISTILL_DEFAULTS.minWorkPerDomain;
  const minWorkPerProject = opts.minWorkPerProject ?? DISTILL_DEFAULTS.minWorkPerProject;
  const repos = opts.repos;

  const candidates = await runRules({ minWorkPerDomain, minWorkPerProject, repos });

  let created = 0, refreshed = 0, cappedOut = 0;
  if (!dry) {
    // 캡: 신규 생성만 센다(기존 후보 갱신은 캡과 무관 — 멱등 유지). 신규가 cap 에 도달하면 이후 신규는 cappedOut.
    for (const c of candidates) {
      if (created >= cap) {
        // 이미 존재하는지 확인 — 존재하면 갱신(캡 무관), 신규면 캡 초과로 건너뜀.
        const exists = (await itemsPool.query(`SELECT 1 FROM knowledge_unit WHERE name=$1`, [c.name])).rowCount;
        if (exists) { const r = await upsertCandidate(c); if (r === "refreshed") refreshed++; }
        else cappedOut++;
        continue;
      }
      const r = await upsertCandidate(c);
      if (r === "created") created++;
      else if (r === "refreshed") refreshed++;
      // skipped(사람 손길 보호)는 created/refreshed 아님 — 캡에도 안 셈.
    }
  } else {
    // dry: 캡 초과분 추정만(신규 여부는 현 DB 기준 — name 존재 조회).
    let wouldCreate = 0;
    for (const c of candidates) {
      const exists = (await itemsPool.query(`SELECT 1 FROM knowledge_unit WHERE name=$1`, [c.name])).rowCount;
      if (exists) refreshed++;
      else { if (wouldCreate >= cap) cappedOut++; else { wouldCreate++; created++; } }
    }
  }

  // ── TTL 만료는 **적재(upsert) 후**에 한다 — 순서가 살아있는 시드 보호의 핵심. ──
  //  rules 가 여전히 산출하는 시드(=활동이 계속되는 작업영역)는 위 upsert 가 updated_at=now() 로 갱신했으므로
  //  TTL 창에 안 걸린다. 반대로 rules 가 더는 산출하지 않는 후보(=활동이 사라진 dead 시드)는 upsert 가 안 건드려
  //  updated_at 이 옛날 그대로 → ttlDays 경과 시 여기서 superseded. 즉 '미검토 + 신호 소멸'만 만료된다.
  const expiredNames = await expireStale(ttlDays, dry, repos);

  return { dry, ttlDays, cap, candidates, created, refreshed, cappedOut, expired: expiredNames.length, expiredNames };
}

// ── confirm — 사람이 후보를 승인: confidence ai→human 승격 + distill source_ref 해제(=인덱스 진입). ──
//  CLI/검토 통합용. distill 후보가 아니면 거부(엉뚱한 단위 승격 방지). reject 는 기존 ctx_set_lifecycle 사용.
export async function confirmCandidate(name: string, actor = "distill:confirm"): Promise<boolean> {
  const ex = (await itemsPool.query(
    `SELECT source_ref, confidence FROM knowledge_unit WHERE name=$1`, [name],
  )).rows[0] as { source_ref?: string; confidence?: string } | undefined;
  if (!ex) throw new Error(`후보 없음: ${name}`);
  if (!ex.source_ref || !ex.source_ref.startsWith(DISTILL_SOURCE_PREFIX)) {
    throw new Error(`'${name}' 은 증류 후보가 아닙니다(source_ref 가 distill: 아님)`);
  }
  // human 승격 + distill 마커 해제(source_ref=NULL) → buildKnowledgeIndex 의 distill 제외에서 벗어나 인덱스 진입.
  await itemsPool.query(
    `UPDATE knowledge_unit SET confidence='human', source_ref=NULL,
       version=version+1, updated_at=now(), updated_by=$2 WHERE name=$1`,
    [name, actor],
  );
  return true;
}
