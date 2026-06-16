import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope } from "../context.js";
import { getMemory, upsertMemory, searchMemory } from "../org/store.js";
import { listDomainsApi } from "../domainmap/core/queries.js";

// 팀 공유 메모리(org_memory) MCP 표면 — "맥락 없는 세션도 한 콜로 공유메모리 업로드".
// 진실원천=items DB(org_memory). 발행 시 visibility='member' 만 멤버에 배포(materialize/publish 필터),
//  'internal' 은 게이트웨이 pull 전용(memory_search). 도메인 귀속은 domainmap(repo='productivity') 약결합.
const DEFAULT_DOMAIN_REPO = "productivity"; // 제품 자신의 도메인맵 repo (repo='lively'=구제품 앱 — 무관)

// 슬러그 생성 — title/note 에서 ASCII kebab. 한글/특수문자뿐이면 'mem-<hash>' 폴백. STRICT_SLUG 준수.
function toSlug(seed: string): string {
  const base = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (base && /^[a-z0-9]/.test(base)) return base;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return "mem-" + h.toString(36);
}

// 도메인 자동분류(휴리스틱 v1) — note+title 토큰과 도메인 key/name/description 토큰 겹침 점수. 명확한 단독
//  1위만 채택(애매하면 null → '도메인 지정 권장' 안내). domainmap 다운/오류는 fail-open(null). LLM 분류는 후속.
async function classifyDomain(text: string, repo: string): Promise<{ key: string; score: number } | null> {
  let domains: Awaited<ReturnType<typeof listDomainsApi>>;
  try { domains = await listDomainsApi(repo); } catch { return null; }
  if (!domains.length) return null;
  const hay = text.toLowerCase();
  const scored = domains.map((d) => {
    const kw = new Set<string>();
    for (const part of [d.key, d.name, d.description ?? ""].join(" ").split(/[^a-z0-9가-힣]+/i)) {
      const t = part.toLowerCase();
      if (t.length >= 2) kw.add(t);
    }
    let score = 0;
    for (const t of kw) if (hay.includes(t)) score += t.length >= 4 ? 2 : 1; // 긴 토큰 가중
    return { key: d.key, score };
  }).sort((a, b) => b.score - a.score);
  const [top, second] = scored;
  // 단독 우위(2위 대비 +3 이상) + 최소 임계(4) — 약한/동률 매치는 미분류로.
  if (top && top.score >= 4 && (!second || top.score >= second.score + 3)) return top;
  return null;
}

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    "memory_save",
    {
      title: "팀 공유 메모리에 저장",
      description:
        "팀 공유 메모리(조직 정설 지식)에 한 콜로 저장한다. domain 생략 시 도메인맵으로 자동분류. " +
        "visibility=internal(기본): 멤버에 배포 안 됨, 게이트웨이 memory_search 로만 조회. " +
        "visibility=member: 다음 발행 때 전 구성원에 배포(admin 권한 필요). name 생략 시 제목/본문에서 자동 생성.",
      inputSchema: {
        note: z.string().min(1).max(40000).describe("저장할 지식 본문(markdown)"),
        title: z.string().max(200).optional().describe("제목(인덱스/검색 표시용)"),
        domain: z.string().max(100).optional().describe("도메인 슬러그(생략 시 자동분류). domain_list 로 확인 가능"),
        visibility: z.enum(["internal"]).optional().describe("internal 만 지원(멤버 미배포). member(전원 배포)는 웹 관리 전용"),
        name: z.string().max(64).optional().describe("메모리 식별자(생략 시 자동 생성). 같은 name 재지정 시 갱신"),
      },
    },
    async ({ note, title, domain, visibility, name }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "memory");
      // 보안: MCP 저장은 internal 전용(멤버 미배포). member(전 구성원 매세션 주입)는 에이전트/토큰이 fleet 컨텍스트를
      //  주입하는 통로가 되지 않게 웹 관리(admin·web.ts mw 가 정적토큰 거부=B5)로만 허용. zod 가 'internal' 만 받지만
      //  방어적으로 한 번 더 막는다.
      const vis: "member" | "internal" = visibility === undefined ? "internal" : visibility;
      if (vis !== "internal") {
        throw new Error("memory_save 는 internal 메모리만 저장합니다. member(전 구성원 배포)는 웹 관리 화면에서 발행하세요.");
      }

      // 도메인: 지정되면 존재 검증(fail-open), 생략되면 자동분류.
      const repo = DEFAULT_DOMAIN_REPO;
      let domainKey: string | null = null;
      let domainNote = "";
      if (domain) {
        // domainmap 가용 시에만 존재 검증(다운=fail-open, 약결합 슬러그라 저장은 진행). 메시지 매칭 대신 결과로 분기.
        let domains: Awaited<ReturnType<typeof listDomainsApi>> | null = null;
        try { domains = await listDomainsApi(repo); } catch { domains = null; }
        if (domains && domains.length && !domains.some((d) => d.key === domain)) {
          throw new Error(`도메인 '${domain}' 없음(repo=${repo}). domain_list 로 확인하세요.`);
        }
        domainKey = domain;
      } else {
        const c = await classifyDomain(`${title ?? ""} ${note}`, repo);
        if (c) { domainKey = c.key; domainNote = ` (자동분류 → ${c.key})`; }
        else domainNote = " (도메인 미분류 — 정확히 하려면 domain 인자 지정 권장)";
      }

      // 이름: 주어지면 검증·갱신(upsert), 아니면 생성(충돌 시 -2.. 부여, 덮어쓰기 방지).
      let memName: string;
      if (name) {
        memName = name.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(memName)) {
          throw new Error("name 은 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다");
        }
        // 보안: 명시 name 으로 기존 **member** 메모리를 덮어쓰면 본문 변조 + member→internal 강등으로 발행에서
        //  사라진다(fleet 회수). member 메모리 수정은 admin/웹 전용 — 에이전트(memory scope)는 거부. internal 갱신은 허용.
        const existing = await getMemory(memName);
        if (existing && existing.visibility === "member") {
          throw new Error(`'${memName}' 은 member(전원 배포) 메모리입니다 — 에이전트가 덮어쓸 수 없습니다(웹 관리에서 수정하세요).`);
        }
      } else {
        const baseSlug = toSlug(title || note);
        memName = baseSlug;
        // 빈 슬롯을 찾을 때까지(getMemory=null) 증가. 소진 시 침묵 덮어쓰기 대신 throw.
        for (let i = 2; await getMemory(memName); i++) {
          if (i >= 1000) throw new Error("메모리 이름 자동생성 실패(동일 슬러그 과다) — name 인자로 직접 지정하세요");
          memName = `${baseSlug}-${i}`;
        }
      }

      const saved = await upsertMemory({
        name: memName,
        title: title ?? null,
        body_md: note,
        in_index: false, // 에이전트 생성은 기본 비인덱스(멤버 MEMORY.md 인덱스 승급은 admin 이 웹에서)
        visibility: vis,
        domain_key: domainKey,
        domain_repo: domainKey ? repo : null,
      }, user.userId, "mcp");

      const reach = vis === "internal"
        ? "internal — 멤버에 배포되지 않습니다(게이트웨이 memory_search 로만 조회)."
        : "member — 다음 발행 때 전 구성원에 배포됩니다.";
      return {
        content: [{
          type: "text",
          text: `✓ 메모리 저장: ${saved.name} [${saved.visibility}]${domainKey ? ` · 도메인 ${domainKey}` : ""}${domainNote}\n${reach}`,
        }],
      };
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "팀 공유 메모리 검색",
      description: "팀 공유 메모리를 제목/본문 텍스트로 검색한다(internal·member 모두 조회 가능). domain/visibility 로 필터.",
      inputSchema: {
        query: z.string().min(1).describe("검색어(제목·본문 부분일치)"),
        domain: z.string().optional().describe("도메인 슬러그로 필터"),
        visibility: z.enum(["member", "internal", "all"]).default("all").describe("가시성 필터(기본 all)"),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, domain, visibility, limit }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "memory");
      const rows = await searchMemory({ query, visibility, domainKey: domain ?? null, limit });
      if (!rows.length) return { content: [{ type: "text", text: `메모리 검색 결과 없음: "${query}"` }] };
      const text = rows.map((r) =>
        `### ${r.title ?? r.name} [${r.visibility}]${r.domain_key ? ` · ${r.domain_key}` : ""} (${r.name})\n${r.snippet}`,
      ).join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );
}
