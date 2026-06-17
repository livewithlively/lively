import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope } from "../context.js";
import { getMemory, upsertMemory, searchMemory } from "../org/store.js";
import { listDomainsApi } from "../domainmap/core/queries.js";

// 조직 공유 메모리(org_memory) MCP 표면 — 하네스 네이티브 메모리를 조직이 공유(에이전트 생산·소비, 단일 풀).
// 진실원천=items DB(org_memory). 인덱스(제목·요약)는 발행 시 항상-주입 컨텍스트로, 본문은 memory_search pull.
//  도메인 귀속은 domainmap(repo='productivity') 약결합. (member/internal 분리는 2026-06-17 폐기 — 과설계.)
// 공유 blast-radius 는 감사(org_content_audit)+주기적 prune+kill-switch(LIVELY_OFF)로 관리(per-memory 권한 아님).
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
      title: "공유 메모리에 저장",
      description:
        "조직 공유 메모리에 한 콜로 저장한다(에이전트가 생산·소비하는 단일 풀). domain 생략 시 도메인맵으로 자동분류. " +
        "name 생략 시 제목/본문에서 자동 생성, 같은 name 재지정 시 갱신. 제목·요약은 인덱스로 공유되고 본문은 memory_search 로 조회된다.",
      inputSchema: {
        note: z.string().min(1).max(40000).describe("저장할 지식 본문(markdown)"),
        title: z.string().max(200).optional().describe("제목(인덱스/검색 표시용)"),
        domain: z.string().max(100).optional().describe("도메인 슬러그(생략 시 자동분류). domain_list 로 확인 가능"),
        name: z.string().max(64).optional().describe("메모리 식별자(생략 시 자동 생성). 같은 name 재지정 시 갱신"),
      },
    },
    async ({ note, title, domain, name }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "memory");

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

      // 이름: 주어지면 그 name 으로 갱신(upsert), 아니면 생성(자동생성끼리 충돌 시 -2.. 부여).
      let memName: string;
      if (name) {
        memName = name.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(memName)) {
          throw new Error("name 은 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다");
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
        domain_key: domainKey,
        domain_repo: domainKey ? repo : null,
      }, user.userId, "mcp");

      return {
        content: [{
          type: "text",
          text: `✓ 메모리 저장: ${saved.name}${domainKey ? ` · 도메인 ${domainKey}` : ""}${domainNote}\n인덱스로 공유됨(전문은 memory_get name=${saved.name}, 검색은 memory_search).`,
        }],
      };
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "공유 메모리 검색",
      description: "조직 공유 메모리를 제목/본문 텍스트로 검색한다. 결과는 **스니펫(잘림)** — 전문은 결과의 name 으로 `memory_get` 호출.",
      inputSchema: {
        query: z.string().min(1).describe("검색어(제목·본문 부분일치)"),
        domain: z.string().optional().describe("도메인 슬러그로 필터"),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, domain, limit }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "memory");
      const rows = await searchMemory({ query, domainKey: domain ?? null, limit });
      if (!rows.length) return { content: [{ type: "text", text: `메모리 검색 결과 없음: "${query}"` }] };
      const text = rows.map((r) =>
        `### ${r.title ?? r.name}${r.domain_key ? ` · ${r.domain_key}` : ""} (${r.name})\n${r.snippet}\n…전문: memory_get name=${r.name}`,
      ).join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "memory_get",
    {
      title: "공유 메모리 전문 조회",
      description: "공유 메모리의 **전문(full body)** 을 name 으로 가져온다(memory_search 스니펫 잘림 없이). 인덱스·memory_search 에서 얻은 name 으로 호출.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("메모리 식별자(name) — 인덱스/검색 결과의 name"),
      },
    },
    async ({ name }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "memory");
      const m = await getMemory(name.trim().toLowerCase());
      if (!m) return { content: [{ type: "text", text: `메모리 없음: '${name}' (name 확인 — 인덱스/memory_search 결과의 name)` }] };
      const head = `# ${m.title ?? m.name}${m.domain_key ? ` (도메인: ${m.domain_key})` : ""}  ·  ${m.name}`;
      return { content: [{ type: "text", text: `${head}\n\n${m.body_md}` }] };
    },
  );
}
