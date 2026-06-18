// DB → 임시 디렉토리 materialize — 발행 시에만 org-content(DB)를 generator 가 기대하는 파일 트리로 굳힌다.
// 이렇게 하면 검증된 file-based generator(build-context.mjs)를 한 줄도 고치지 않고 재사용한다(D: 진실원천=DB,
// git/파일은 발행 순간의 임시 산물). generate() 규약(build-context.mjs:80-173):
//   - 필수: org/org-defaults.md (없으면 generator 가 종료) → 비어 있으면 최소 본문을 채운다.
//   - 선택: org/managed-policy.md, memory/MEMORY.md(+ 링크된 memory/*.md, orgHas 가드로 누락은 스킵).
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrgProfile, getSection, listMembers } from "./store.js";
import { listKnowledge, kindsByInjectionMode, type KnowledgeUnit } from "./knowledge.js";
import { redactString } from "./redact.js";

export interface Materialized {
  dir: string;
  orgName: string;
  cleanup: () => Promise<void>;
}

// 항상-주입 인덱스에 포함하는 'recalled' kind 정책의 **단일 출처는 kind_registry**(injection_mode='recalled').
//  P-V3-2(하드코딩 제거): 정책 상수를 kind_registry 조회로 대체 — recalledKindsForIndex() 가 라이브로 읽는다(non-stale).
//  R=enforced(전문 주입), W=query 는 인덱스에서 제외(registry 가 권위). V4-P2a: 본질 4종 R/K/H/W — recalled=K/H.
// 아래 상수는 **DB 미가용 폴백 + 순수함수 테스트용 기본값**일 뿐(레지스트리가 빈/미초기화일 때만 사용). 순서 K→H.
const FALLBACK_RECALLED_KINDS: { kind: string; label: string }[] = [
  { kind: "K", label: "Knowledge" },
  { kind: "H", label: "How-to" },
];

// 라이브 정책 — kind_registry.injection_mode='recalled' 행을 sort 순으로(non-stale). 빈 결과면 폴백.
//  DB 오류는 폴백으로 흡수(fail-open — 인덱스 생성이 정책 조회 실패로 500 나면 안 됨).
export async function recalledKindsForIndex(): Promise<{ kind: string; label: string }[]> {
  try {
    const rows = await kindsByInjectionMode("recalled");
    return rows.length ? rows : FALLBACK_RECALLED_KINDS;
  } catch {
    return FALLBACK_RECALLED_KINDS;
  }
}

const PER_KIND_CAP = 50; // kind 당 상한(섹션 폭주 방지). 전체 cap 100 과 함께 작동.
const TOTAL_CAP = 100;   // 전체 인덱스 줄 상한(네이티브 200줄 아날로그).

// updated_at/as_of 는 pg 드라이버가 **Date** 로 반환(타입은 string|null 이지만 런타임 Date). 문자열 가정(localeCompare) 금지 —
//  타임스탬프(number)로 비교해 Date/string/null 모두 안전(이걸 어기면 preview/install 생성이 500 으로 터진다).
const ts = (u: string | Date | null): number => { const d = u ? new Date(u).getTime() : 0; return Number.isFinite(d) ? d : 0; };

// freshness — updated_at(없으면 as_of) 기준 상대시간. 시간차는 |now - then| 절대값 비교만(Date.now() 1회).
//  ts() 패턴 유지(Date/string/null 안전). 미래 ts/0 은 '방금'.
function freshness(u: KnowledgeUnit, now: number): string {
  const t = ts(u.updated_at) || ts(u.as_of);
  if (!t) return "방금";
  const diff = Math.abs(now - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

// 항상-주입 지식 인덱스(MEMORY.md) — recalled kind(K/D/F/H)만 kind별 섹션으로. 제목·요약·freshness 를 **비-링크** 텍스트로.
//  전문은 `ctx_cat name=X`, 검색은 `ctx_grep` 로 pull. 비-링크인 이유: generator collectArtifactFiles 가 `](name.md)`
//  링크를 따라 본문을 디스크에 복사하므로, 링크를 없애 follow 를 원천 차단(본문 비배포 보장).
//  입력은 listKnowledge({lifecycle:"active"}) 전체 — 여기서 recalled kind 필터·섹션화한다(단일 소스).
// H1-b 시크릿 출력게이트(v3 P-V3-1): 이 인덱스가 **항상-주입**(SessionStart 훅·정적 context.md·preview·web learn)의
//  단일 소스이므로, 제목/요약에 평문 시크릿이 섞이면 컨텍스트로 유출된다. 쓰기경로(ctx_save/org section)는
//  assertNoHardSecrets 로 hard-block 하지만, 그 게이트 도입(06-16) 전 적재된 레거시 유닛은 통과하지 못했다.
//  서빙 경로에서 throw(=컨텍스트 전면 거부)는 과해서, 여기서는 redactString 으로 **마스킹**한다(defense-in-depth,
//  fail-open 보존). 제목/요약 각 라인을 emit 직전 redactString 통과 — 단일 choke-point 가 정적·라이브·web 모두 덮는다.
//  recalledKinds 인자(섹션 정책)는 호출자가 kind_registry 에서 읽어 넘긴다(non-stale). 생략 시 폴백 상수 —
//  순수함수 단위테스트(DB 불요)는 인자 없이 호출해 결정적으로 검증한다.
export function buildKnowledgeIndex(
  units: KnowledgeUnit[],
  recalledKinds: { kind: string; label: string }[] = FALLBACK_RECALLED_KINDS,
): string {
  const now = Date.now(); // freshness 기준점 — 1회만(아래 절대값 비교에만 사용).
  const lines = [
    "# Knowledge Index",
    "(제목·요약만. 전문은 `ctx_cat name=<name>`, 검색은 `ctx_grep`)",
    "",
  ];
  let emitted = 0; // 전체 cap 누계.
  for (const { kind, label } of recalledKinds) {
    // lifecycle!='active' 제외(호출자가 active 만 넘기더라도 방어적으로 한 번 더 거른다).
    // H2(P-V3-3a): confidence='observed'(커넥터 수집물) 는 **주입 인덱스에서 영구 제외** — 큐레이션된
    //  지식(ai/rule/human)만 항상-주입 인덱스에 노출한다. 수집물은 query 시 ctx_grep 로만 도달(인덱스 비주입 불변식).
    //  recalled kind(K/D/F/H)는 보통 저작물이라 observed 가 거의 없지만, 흡수 후 observed K/D 가 생겨도 인덱스 비주입을 보장.
    // H4(P-V3-6): **증류 후보**(source_ref 가 'distill:' 접두)도 주입 인덱스에서 제외 — 규칙판이 활동에서 자동
    //  추출한 미검토 K/D 후보는 검토 큐(confidence='ai')엔 뜨지만 항상-주입엔 안 들어간다('승인 시 인덱스 진입').
    //  사람이 confirm 하면 confidence='human'·source_ref=NULL 로 승격되어 이 제외에서 벗어나 인덱스로 진입한다.
    const rows = units.filter(
      (u) =>
        u.kind === kind &&
        u.lifecycle === "active" &&
        u.confidence !== "observed" &&
        !(u.source_ref ?? "").startsWith("distill:"),
    );
    if (!rows.length) continue;
    // 섹션 내 updated_at DESC(없으면 as_of), Date-안전.
    const sorted = [...rows].sort((a, b) => (ts(b.updated_at) || ts(b.as_of)) - (ts(a.updated_at) || ts(a.as_of)));
    const room = Math.max(0, TOTAL_CAP - emitted);
    const take = Math.min(sorted.length, PER_KIND_CAP, room);
    lines.push(`## ${label} (${kind})`);
    for (const u of sorted.slice(0, take)) {
      const title = u.title?.trim() || u.name;
      const firstLine = (u.body_md.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^#+\s*/, "").slice(0, 80);
      // H1-b: title/요약은 사용자/레거시 유래 자유텍스트 → emit 직전 시크릿 마스킹(name/freshness 는 서버 생성·무위험).
      lines.push(`- ${redactString(title)}${firstLine ? " — " + redactString(firstLine) : ""}  · ctx_cat name=${u.name}  · ${freshness(u, now)}`);
    }
    emitted += take;
    const hidden = sorted.length - take; // per-kind 캡 또는 전체 cap 으로 잘린 분.
    if (hidden > 0) lines.push(`- … 외 ${hidden}건 (ctx_grep 로 검색)`);
    lines.push("");
  }
  // 트레일링 빈 줄 제거 후 단일 개행 종결(기존 출력 관례).
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

  // memory/MEMORY.md — 인덱스(제목·요약·freshness)만 발행. **본문 파일은 디스크에 안 쓴다** — 본문은 ctx_cat(게이트웨이
  //  pull)로 가져온다. 인덱스가 비-링크라 generator 의 본문 follow 도 안 걸림 → 본문 비배포 보장.
  //  recalled kind(K/D/F/H) active 만 buildKnowledgeIndex 가 섹션화(단일 소스 — previewMemberContext 와 공유).
  const knowledge = await listKnowledge({ lifecycle: "active" });
  if (knowledge.length) {
    const recalled = await recalledKindsForIndex(); // kind_registry 정책(non-stale) — 하드코딩 제거
    await writeFile(join(dir, "memory", "MEMORY.md"), buildKnowledgeIndex(knowledge, recalled));
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
