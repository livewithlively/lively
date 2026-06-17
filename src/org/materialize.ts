// DB → 임시 디렉토리 materialize — 발행 시에만 org-content(DB)를 generator 가 기대하는 파일 트리로 굳힌다.
// 이렇게 하면 검증된 file-based generator(build-context.mjs)를 한 줄도 고치지 않고 재사용한다(D: 진실원천=DB,
// git/파일은 발행 순간의 임시 산물). generate() 규약(build-context.mjs:80-173):
//   - 필수: org/org-defaults.md (없으면 generator 가 종료) → 비어 있으면 최소 본문을 채운다.
//   - 선택: org/managed-policy.md, memory/MEMORY.md(+ 링크된 memory/*.md, orgHas 가드로 누락은 스킵).
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrgProfile, getSection, listMembers, listMemory } from "./store.js";

export interface Materialized {
  dir: string;
  orgName: string;
  cleanup: () => Promise<void>;
}

// 메모리 인덱스(MEMORY.md) 생성 — 전 메모리의 제목·요약을 **비-링크** 텍스트로. **전문은 `memory_get name=X`** 로 pull.
//  비-링크인 이유: generator collectArtifactFiles 가 `](name.md)` 링크를 따라 본문을 디스크에 복사하므로, 링크를
//  없애 follow 를 원천 차단(본문 비배포 보장). cap=최신 MAX 건(네이티브 200줄 아날로그), 초과분은 memory_search.
export function buildMemoryIndex(rows: { name: string; title: string | null; body_md: string; updated_at: string | Date | null }[]): string {
  const MAX = 100;
  // updated_at 은 pg 드라이버가 **Date** 로 반환(타입은 string|null 이지만 런타임 Date). 문자열 가정(localeCompare) 금지 —
  //  타임스탬프(number)로 비교해 Date/string/null 모두 안전(이걸 어기면 preview/install 생성이 500 으로 터진다).
  const ts = (u: string | Date | null): number => { const d = u ? new Date(u).getTime() : 0; return Number.isFinite(d) ? d : 0; };
  const sorted = [...rows].sort((a, b) => ts(b.updated_at) - ts(a.updated_at)).slice(0, MAX);
  const lines = ["# Memory Index", "(제목·요약만. 전문은 `memory_get name=<name>`, 검색은 `memory_search`)", ""];
  for (const m of sorted) {
    const title = m.title?.trim() || m.name;
    const firstLine = (m.body_md.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^#+\s*/, "").slice(0, 80);
    lines.push(`- ${title}${firstLine ? " — " + firstLine : ""}  · memory_get name=${m.name}`);
  }
  if (rows.length > MAX) lines.push(`- … 외 ${rows.length - MAX}건 (memory_search 로 검색)`);
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

  // memory/MEMORY.md — 인덱스(제목·요약)만 발행. **본문 파일은 디스크에 안 쓴다** — 본문은 memory_search(게이트웨이
  //  pull)로 가져온다. 인덱스가 비-링크라 generator 의 본문 follow 도 안 걸림 → 본문 비배포 보장.
  const memory = await listMemory();
  if (memory.length) {
    await writeFile(join(dir, "memory", "MEMORY.md"), buildMemoryIndex(memory));
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
