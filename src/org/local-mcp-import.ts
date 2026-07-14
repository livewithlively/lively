// 로컬 하네스 MCP 설정 → 라이블리 vault 이관 분류(#746). 순수함수(I/O 없음 — CLI deploy/import-local-mcp.mjs 가 소비, 테스트 가능).
//  정책(external-mcp-auth-matrix-746): 정적 토큰(header/env)만 값 이관 가능. OAuth 는 refresh 가 발급 client 에 묶여(RFC6749)
//  라이블리 client 로 못 옮김 → [연결] 재수행. stdio 는 게이트웨이 프록시 대상 아님(멤버 브로커 별도).

export interface LocalMcpClassified {
  name: string;
  transport: "http" | "stdio" | "unknown";
  url?: string;
  importable: boolean;        // 정적 토큰 보유 http → vault 업로드 가능
  tokenHeader?: string;       // 정적 토큰이 담긴 헤더 이름(http)
  tokenEnv?: string;          // 정적 토큰이 담긴 env 이름(주로 stdio)
  oauthLikely: boolean;       // http url 인데 정적 토큰 없음 → OAuth 로 추정(재연결 대상)
  action: "upload" | "reconnect" | "broker" | "skip";
  note: string;
}

// 시크릿으로 볼 헤더/ENV 이름 패턴(값이 비어있지 않아야 채택).
const SECRET_HEADER = /^(authorization|private-token|x-[\w-]*token|x-api-key|[\w-]*api[_-]?key|x-figma-token|apikey)$/i;
const SECRET_ENV = /(token|secret|api[_-]?key|password|\bpat\b)/i;

function firstSecretKey(obj: unknown, re: RegExp): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (re.test(k) && String(v ?? "").trim()) return k;
  }
  return undefined;
}

// claude.json 류(mcpServers 맵) 를 받아 서버별로 분류. 토큰 '값'은 반환하지 않는다(키 이름만) — 값 추출은 CLI 가 업로드 직전에만.
export function classifyLocalMcp(config: unknown): LocalMcpClassified[] {
  const servers = (config && typeof config === "object" && (config as Record<string, unknown>).mcpServers) || {};
  const out: LocalMcpClassified[] = [];
  for (const [name, sRaw] of Object.entries(servers as Record<string, unknown>)) {
    const s = (sRaw && typeof sRaw === "object" ? sRaw : {}) as Record<string, unknown>;
    const url = typeof s.url === "string" ? s.url : undefined;
    const transport: LocalMcpClassified["transport"] = url ? "http" : (typeof s.command === "string" ? "stdio" : "unknown");
    const tokenHeader = firstSecretKey(s.headers, SECRET_HEADER);
    const tokenEnv = firstSecretKey(s.env, SECRET_ENV);
    const importable = transport === "http" && !!tokenHeader;      // http + 정적 헤더 토큰만 값 이관
    const oauthLikely = transport === "http" && !tokenHeader;      // http 인데 정적 토큰 없음 → OAuth 추정
    let action: LocalMcpClassified["action"]; let note: string;
    if (importable) { action = "upload"; note = `정적 토큰(${tokenHeader}) → vault 업로드 + proxy(bearer) 등록`; }
    else if (oauthLikely) { action = "reconnect"; note = "OAuth 추정 — 라이블리에서 [연결] 재수행(refresh 는 발급 client 에 묶여 이관 불가)"; }
    else if (transport === "stdio") { action = tokenEnv ? "broker" : "broker"; note = `stdio 로컬 실행${tokenEnv ? `(env ${tokenEnv})` : ""} — 게이트웨이 프록시 아님, 멤버 브로커 경유(별도)`; }
    else { action = "skip"; note = "분류 불가(url/command 없음)"; }
    out.push({ name, transport, url, importable, tokenHeader, tokenEnv, oauthLikely, action, note });
  }
  return out;
}

// import 로 만들 vault kind — 사용자 커스텀 MCP 라 카탈로그 kind 와 겹치지 않게 imported_ 접두 + slug.
export function importedKind(name: string): string {
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `imported_${slug || "mcp"}`;
}
