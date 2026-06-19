// DB → 임시 디렉토리 materialize — 발행 시에만 org-content(DB)를 generator 가 기대하는 파일 트리로 굳힌다.
// 이렇게 하면 검증된 file-based generator(build-context.mjs)를 한 줄도 고치지 않고 재사용한다(D: 진실원천=DB,
// git/파일은 발행 순간의 임시 산물). generate() 규약(build-context.mjs:80-173):
//   - 필수: org/org-defaults.md (없으면 generator 가 종료) → 비어 있으면 최소 본문을 채운다.
//   - 선택: org/managed-policy.md, memory/MEMORY.md(+ 링크된 memory/*.md, orgHas 가드로 누락은 스킵).
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrgProfile, getSection, listMembers } from "./store.js";
import { listKnowledge, type KnowledgeUnit } from "./knowledge.js";
import { redactString } from "./redact.js";
import { logger } from "../log.js";

export interface Materialized {
  dir: string;
  orgName: string;
  cleanup: () => Promise<void>;
}

// ════════ V4-P3 주입 재설계 ════════
// v3 까지의 주입 = recalled-kind(K/H) 제목·요약 리스트 + 중요도 캡 + observed 제외 + distill 제외.
// v4 결정(plan §F·§J): **주입 = 검색(retrieval)**. 정적 랭킹/중요도/제목리스트 폐기.
//   (a) R(규칙) **전문 항상 주입**(enforced — 맥락무관 강제).
//   (b) **area 지도** — 전 area(space+key+name+active 유닛수)를 *작고 완전하게* 나열. 에이전트는 이 지도로
//       어떤 주제가 있는지 알고, 일에 맞춰 `area+검색`(ctx_grep/memory_search/ctx_ls domain=)으로 그때 소환한다.
//   (c) **쓰기 가이드** — 언제/어디/무엇/분류/외부 를 헤더에 안내(지속지식이 생기면 in-flow 로 ctx_save).
// 제거: PER_KIND_CAP/TOTAL_CAP(중요도 캡)·recalled-kind 제목 리스트·observed 인덱스제외 필터·distill source_ref 제외절.
//   → K/H/W 는 정적 주입하지 않는다(area 지도로 발견·검색으로 소환). importance 축 없음(맥락 상대적).
//   → observed 는 '주입 결정 안 함'으로 의미전환(주입은 출처 아닌 kind/검색이 결정) — overview observed_count·
//     팀메모리 구분은 별도로 유지(P5 정합).
// redact 게이트(assertNoHardSecrets 쓰기경로 + redactString 서빙경로)는 v4 에서도 유지(defense-in-depth).

// area 지도 한 항목 — domain(dmPool)에서 space/key/name, knowledge_unit_domain(itemsPool)에서 active 유닛수.
export interface AreaMapEntry {
  space: string;          // 'product'(코드앵커 도메인) | 'business'(비즈니스 기능 vocab)
  key: string;            // domain_key(소환 시 domain= 인자)
  name: string;           // 사람용 표시명
  active_units: number;   // 이 area 에 매핑된 active knowledge_unit 수(state<>'rejected'). 발견용 메타.
}

// updated_at/as_of 는 pg 드라이버가 **Date** 로 반환(타입은 string|null 이지만 런타임 Date). 문자열 가정(localeCompare) 금지 —
//  타임스탬프(number)로 비교해 Date/string/null 모두 안전(이걸 어기면 preview/install 생성이 500 으로 터진다).
const ts = (u: string | Date | null): number => { const d = u ? new Date(u).getTime() : 0; return Number.isFinite(d) ? d : 0; };

// ── (라이브 헬퍼) R(규칙) 전문 — kind='R', lifecycle='active'. enforced 주입 대상. sort, name 순. ──
//  buildKnowledgeIndex 는 순수함수라 units 인자에서 R 을 직접 필터한다(아래). 이 헬퍼는 호출자 편의용(미사용 가능).

// ── (라이브 헬퍼) area 지도 — domainmap(space/key/name) + items(active 유닛수) 조인. 두 DB 라 메모리 조인. ──
//  fail-open: 어느 한 쪽이 죽어도 인덱스 생성이 500 나면 안 된다(빈 지도 반환 → 헤더만, 안내문은 유지).
export async function areaMapForIndex(): Promise<AreaMapEntry[]> {
  try {
    const { dmPool } = await import("../domainmap/db.js");
    const { itemsPool } = await import("../items/store.js");
    // (1) 전 area — merged 제외. V5 탈-repo: (space,key) 전역유니크라 repo 조인 없이 나열(business=repo_id NULL).
    const domRows = (await dmPool().query(
      `SELECT d.space, d.key, d.name, d.cross_cutting
         FROM domain d
        WHERE d.state <> 'merged'
        ORDER BY d.space, d.cross_cutting, d.key`,
    )).rows;
    // (2) active 유닛수/area — knowledge_unit_domain(active 매핑) ⋈ knowledge_unit(active). domain_key 단독 키(V5 탈-repo).
    const cntRows = (await itemsPool.query(
      `SELECT kud.domain_key, COUNT(DISTINCT ku.name)::int AS n
         FROM knowledge_unit_domain kud
         JOIN knowledge_unit ku ON ku.name = kud.name
        WHERE ku.lifecycle = 'active' AND kud.state <> 'rejected'
          AND kud.domain_key IS NOT NULL
        GROUP BY kud.domain_key`,
    )).rows;
    const cnt = new Map<string, number>();
    for (const r of cntRows) cnt.set(r.domain_key as string, Number(r.n) || 0);
    return domRows.map((d) => ({
      space: (d.space as string) ?? "product",
      key: d.key as string,
      name: (d.name as string) ?? (d.key as string),
      active_units: cnt.get(d.key as string) ?? 0,
    }));
  } catch (err) {
    logger.warn({ err }, "area 지도 조회 실패 — 빈 지도로 폴백(인덱스는 R 전문·가이드만)");
    return [];
  }
}

// ── 쓰기 가이드 블록(plan §J) — 주입 헤더에 항상 박는다. *언제·어디·무엇·분류·외부* 한 곳. ──
//  단일 출처: 이 상수가 주입(buildKnowledgeIndex)·미리보기·발행물·웹 learn 의 가이드 문구를 결정한다(non-stale).
//  비-링크 텍스트(generator collectArtifactFiles 의 `](name.md)` follow 차단 불변식 유지).
export const WRITE_GUIDE_BLOCK = [
  "## 지식 쓰기 가이드",
  "지속될 지식이 생기면(연구·결정·설계·런북) **그 자리에서(in-flow)** 기록한다 — 나중에 몰아서가 아니라.",
  "- **어디:** 조직 지식의 유일한 집은 ku(`ctx_save`로 전문 직접 기록). 레포에 `.md` 파일을 새로 만들거나 포인터만 남기지 않는다.",
  "- **무엇:** 요약·링크가 아니라 **전문**을 담는다(나중의 나/동료가 그것만 읽고 일할 수 있게).",
  "- **분류(판단):** `kind` = R(강제규칙·페르소나)·K(지식·산출물)·H(절차·런북)·W(과업). `area` = 위 area 지도의 (space, key) 로 `domain=` 지정.",
  "- **외부(클릭업·노션·코드):** 원본은 외부 소유 → 미러(observed)로 둔다. 복제하지 말고, 거기서 얻은 **파생 인사이트만** 별도 K 로 저작한다.",
].join("\n");

// ── 항상-주입 지식 인덱스(MEMORY.md) — v4: R 전문 + area 지도 + 쓰기 가이드. ──
//  입력 units = listKnowledge({lifecycle:"active"}) 전체. 여기서 R 만 전문으로 추려 주입하고, K/H/W 는 정적
//  주입하지 않는다(area 지도로 발견·검색 소환). 비-링크 텍스트(본문 follow 차단 불변식 유지 — generator 가
//  `](name.md)` 링크를 디스크로 복사하지 않게).
// H1-b 시크릿 출력게이트(v3 P-V3-1): 이 인덱스가 **항상-주입**(SessionStart 훅·정적 context.md·preview·web learn)의
//  단일 소스이므로 평문 시크릿이 섞이면 컨텍스트로 유출된다. 쓰기경로(ctx_save/org section)는 assertNoHardSecrets
//  로 hard-block 하지만, 그 게이트 도입(06-16) 전 적재된 레거시 유닛은 통과하지 못했다. 서빙 경로에서 throw(컨텍스트
//  전면 거부)는 과해서, 여기서는 R 전문·area 표시명을 emit 직전 redactString 으로 **마스킹**한다(defense-in-depth,
//  fail-open 보존). 단일 choke-point 가 정적·라이브·web 을 모두 덮는다.
// areaMap 인자는 호출자가 areaMapForIndex() 로 라이브 조회해 넘긴다(non-stale·두 DB 조인). 생략 시 빈 지도 —
//  순수함수 단위테스트(DB 불요)는 인자 없이/명시 지도로 호출해 결정적으로 검증한다.
export function buildKnowledgeIndex(
  units: KnowledgeUnit[],
  areaMap: AreaMapEntry[] = [],
): string {
  const lines = [
    "# Knowledge Index",
    "(공유 조직 지식. **강제규칙은 아래 전문**이 항상 적용된다. 그 외 지식·절차·작업은 area 지도로 발견해 " +
      "`ctx_grep`/`memory_search`/`ctx_cat name=<name>` 로 그때 소환한다.)",
    "",
  ];

  // ── (a) R(규칙) 전문 — enforced. lifecycle='active' 인 kind='R' 만, sort→name 순으로 전문 주입. ──
  //  방어적 lifecycle 재확인(호출자가 active 만 넘기더라도). title 헤더 + 본문 전문(redact). 비-링크.
  const rules = units
    .filter((u) => u.kind === "R" && u.lifecycle === "active")
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
  if (rules.length) {
    lines.push("## 강제 규칙 (R · 항상 적용)", "");
    for (const u of rules) {
      const title = (u.title?.trim() || u.name);
      lines.push(`### ${redactString(title)}`);
      const body = redactString(u.body_md ?? "").trim();
      if (body) lines.push(body);
      lines.push("");
    }
  }

  // ── (b) area 지도 — 전 area 를 space 별로 작게·완전하게. 발견용(소환은 검색). active 0 인 area 도 *완전성*을 ──
  //  위해 나열한다(주제 존재 자체가 정보 — 빈 area 는 검색해도 안 나옴을 알 수 있음). space 헤더 → 'key — name (N)'.
  if (areaMap.length) {
    lines.push("## area 지도 (주제 — 검색으로 소환)",
      "일과 관련된 area 가 보이면 `domain=<key>` 로 검색(`ctx_grep`/`ctx_ls`/`memory_search`)해 해당 지식·절차를 그때 가져온다.",
      "");
    // space 안정 정렬: product → business 순(나머지는 알파벳). 이미 areaMapForIndex 가 space, key 정렬해 옴.
    const order = (s: string): number => (s === "product" ? 0 : s === "business" ? 1 : 2);
    const spaces = [...new Set(areaMap.map((a) => a.space))].sort((x, y) => order(x) - order(y) || x.localeCompare(y));
    for (const sp of spaces) {
      const inSpace = areaMap.filter((a) => a.space === sp);
      lines.push(`### ${redactString(sp)}`);
      for (const a of inSpace) {
        const n = a.active_units > 0 ? ` (${a.active_units})` : "";
        lines.push(`- ${redactString(a.key)} — ${redactString(a.name)}${n}`);
      }
      lines.push("");
    }
  }

  // ── (c) 쓰기 가이드 — 단일 상수 블록(WRITE_GUIDE_BLOCK). 항상 박는다. ──
  lines.push(WRITE_GUIDE_BLOCK);
  lines.push("");

  // 트레일링 빈 줄 제거 후 단일 개행 종결(기존 출력 관례 — WYSIWYG byte-identical 유지).
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

// YAML 스칼라 안전화 — load-bindings 미니 파서는 "..."/'...' 인용 스칼라를 받지만 \" 언이스케이프는 안 한다.
//  따라서 개행/따옴표를 제거 후 큰따옴표로 감싼다(인젝션·줄깨짐 방지). 빈 값 → "".
const yv = (s: string | undefined | null): string => '"' + String(s ?? "").replace(/[\r\n"]+/g, " ").trim() + '"';

// 구성원 frontmatter — load-bindings 미니 파서가 읽는 고정 스키마(identities 객체 리스트). 값은 전부 인용(안전).
function memberFrontmatter(m: {
  id: string; kind: string; display_name: string | null;
  identities: { system: string; external_id: string; email?: string; instance?: string; display_name?: string }[];
}): string {
  const out = ["---", `id: ${yv(m.id)}`, `kind: ${yv(m.kind)}`, `display_name: ${yv(m.display_name ?? m.id)}`];
  if (m.identities.length) {
    out.push("identities:");
    for (const idn of m.identities) {
      out.push(`  - system: ${yv(idn.system)}`);
      out.push(`    external_id: ${yv(idn.external_id)}`);
      if (idn.email) out.push(`    email: ${yv(idn.email)}`);
      if (idn.instance) out.push(`    instance: ${yv(idn.instance)}`);
      if (idn.display_name) out.push(`    display_name: ${yv(idn.display_name)}`);
    }
  }
  out.push("---", "");
  return out.join("\n");
}

export async function materializeOrgContent(): Promise<Materialized> {
  const dir = await mkdtemp(join(tmpdir(), "lively-org-"));
  const profile = await getOrgProfile();
  const orgName = profile.display_name?.trim() || profile.name?.trim() || "조직";

  await mkdir(join(dir, "org"), { recursive: true });
  await mkdir(join(dir, "members"), { recursive: true });
  await mkdir(join(dir, "memory"), { recursive: true });

  // org/org-defaults.md — 필수. generator 의 strip()(frontmatter/HTML주석 제거) 후 빈 본문이면
  //  AGENTS.md 가 거의 빈 채로 발행되므로, '의미 있는 본문'이 남는지(strip 후 비어있지 않은지)로 판정.
  const stripMd = (md: string): string =>
    md.replace(/^<!--[\s\S]*?-->\s*/, "").replace(/^---[\s\S]*?---\s*/, "").trim();
  const defaults = await getSection("org-defaults");
  const defaultsBody = defaults?.body_md && stripMd(defaults.body_md)
    ? defaults.body_md
    : `# ${orgName} 공통 컨텍스트\n\n(아직 작성되지 않음 — 관리 UI에서 회사 맥락·페르소나·업무방식을 채우세요.)\n`;
  await writeFile(join(dir, "org", "org-defaults.md"), defaultsBody);

  // org/managed-policy.md — 선택.
  const policy = await getSection("managed-policy");
  if (policy?.body_md?.trim()) {
    await writeFile(join(dir, "org", "managed-policy.md"), policy.body_md);
  }

  // memory/MEMORY.md — v4 인덱스(R 전문 + area 지도 + 쓰기 가이드)만 발행. **본문 파일은 디스크에 안 쓴다** —
  //  K/H/W 본문은 ctx_cat(게이트웨이 pull)로 가져온다. 인덱스가 비-링크라 generator 의 본문 follow 도 안 걸림.
  //  buildKnowledgeIndex 가 단일 소스(previewMemberContext 와 공유) — area 지도는 라이브 조회(areaMapForIndex).
  const knowledge = await listKnowledge({ lifecycle: "active" });
  const areaMap = await areaMapForIndex();
  // R 전문이 있거나(규칙) area 지도가 있으면 인덱스 발행(쓰기 가이드는 항상 동반). 둘 다 없어도 가이드는 의미가
  //  있으나, 완전 빈 DB 에선 인덱스를 생략한다(기존 관례 — knowledge.length 가드).
  if (knowledge.length || areaMap.length) {
    await writeFile(join(dir, "memory", "MEMORY.md"), buildKnowledgeIndex(knowledge, areaMap));
  }

  // members/_template.md — 개인 레이어 견본(발행물에 복사됨). 실제 멤버 파일도 함께 쓰되(게이트웨이 신원용)
  //  publish 는 _template 만 아티팩트에 포함하고 실제 멤버 파일은 제외한다(프라이버시).
  await writeFile(join(dir, "members", "_template.md"),
    "# 개인 레이어 (members/local.md 로 복사해 채우세요)\n\n- 역할:\n- 호칭/말투 선호:\n- 담당 영역:\n");
  for (const m of await listMembers()) {
    if (m.state !== "active") continue;
    const body = (m.body_md ?? "").trim();
    await writeFile(join(dir, "members", `${m.id}.md`),
      memberFrontmatter(m) + (body ? body + "\n" : ""));
  }

  return {
    dir,
    orgName,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
