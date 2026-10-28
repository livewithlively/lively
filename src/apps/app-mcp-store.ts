// 앱이 선언한 MCP 도구(#5050 앱 v2-40)의 DB 읽기 — 도구 목록을 짤 앱(가벼운 칸만) · 공개 판의 선언 · 이름 겹침 검사.
//  ★ 이 읽기는 MCP 요청마다 돈다(무상태 /mcp 는 tools/call 도 서버를 새로 굽는다 — boot/mcp-transport.ts). 그래서 매니페스트 전체가 아니라
//   mcp_tools 칸 하나만 읽고, 그 칸이 있는 앱(+ 공개 판을 따로 보는 앱)만 고른다. 대부분의 워크스페이스는 앞 쿼리 하나로 끝난다(0행).
//  워크스페이스 격리는 행 격리 정책이 한다(org_app · org_app_version · org_tool — 이 함수들의 SQL 은 tenant_id 를 적지 않는다).
import { itemsPool } from "../db/client.js";
import { HttpError } from "../http-error.js";
import type { AppVisibility } from "../org/store/apps.js";
import { appMcpToolsOf } from "./app-mcp-tools.js";

/** 도구 목록 판정에 쓰는 앱 칸(org_app 의 부분) + 설치된 판의 mcp_tools. */
export interface McpToolAppRow {
  id: string;
  title: string;
  source: unknown;
  visibility: AppVisibility;
  owner_member: string | null;
  draft_by: string | null;
  published_version_no: number | null;
  content_hash: string | null;
  current_version_no: number | null;
  mcp_tools: unknown;
}

/**
 * 켜져 있고(active · enabled) 설치된 판이 mcp_tools 를 선언했거나, 공개 판을 따로 보는 사람이 있는(초안이 걸린 공개) 앱. 설치 순서(오래된 것 먼저) —
 *  이름이 겹치면(설치 검사를 동시에 지난 두 앱 · 그 뒤에 생긴 조직 도구) 먼저 등록된 쪽이 이긴다(mcp/app-declared-tools.ts).
 */
export async function listMcpToolApps(): Promise<McpToolAppRow[]> {
  const r = await itemsPool.query(
    `SELECT id, title, source, visibility, owner_member, draft_by, published_version_no, content_hash, current_version_no,
            manifest->'mcp_tools' AS mcp_tools
       FROM org_app
      WHERE status='active' AND enabled
        AND (manifest ? 'mcp_tools' OR (visibility='all' AND draft_by IS NOT NULL AND published_version_no IS NOT NULL))
      ORDER BY installed_at, id`);
  return r.rows.map((x) => ({
    id: String(x.id), title: String(x.title ?? ""), source: x.source, visibility: x.visibility === "me" ? "me" : "all",
    owner_member: x.owner_member ?? null, draft_by: x.draft_by ?? null,
    published_version_no: x.published_version_no == null ? null : Number(x.published_version_no),
    content_hash: x.content_hash ?? null, current_version_no: x.current_version_no == null ? null : Number(x.current_version_no),
    mcp_tools: x.mcp_tools ?? null,
  }));
}

/** 공개 판의 선언(이름표 · 내용 지문 · mcp_tools) — 키 = 앱 id. 공개 판 행이 없는 앱은 빠진다(부르는 쪽이 설치된 상태로 본다 — app-view.ts viewAppFor 와 같다). */
export async function listPublishedMcpTools(appIds: readonly string[]): Promise<Map<string, { title: string; content_hash: string | null; mcp_tools: unknown }>> {
  const out = new Map<string, { title: string; content_hash: string | null; mcp_tools: unknown }>();
  if (!appIds.length) return out;
  const r = await itemsPool.query(
    `SELECT v.app_id, v.content_hash, v.manifest->>'title' AS title, v.manifest->'mcp_tools' AS mcp_tools
       FROM org_app a JOIN org_app_version v ON v.app_id = a.id AND v.version_no = a.published_version_no
      WHERE a.id = ANY($1::text[])`, [[...appIds]]);
  for (const x of r.rows) out.set(String(x.app_id), { title: String(x.title ?? ""), content_hash: x.content_hash ?? null, mcp_tools: x.mcp_tools ?? null });
  return out;
}

/**
 * 이 앱이 쓰려는 도구 이름 가운데 이미 쓰이는 것 — 다른 앱(상태 무관 · 설치된 판과 공개 판 둘 다 — 공개 판을 보는 사람에게는 그 판의 도구가 선다)과
 *  조직 도구(org_tool — 빌트인 토글 행은 빌트인 이름을 가리키는 것이라 뺀다. 빌트인 이름은 app-mcp-tools 가 따로 막는다).
 */
export async function takenMcpToolNames(appId: string, names: readonly string[]): Promise<string[]> {
  if (!names.length) return [];
  const arr = (col: string): string => `CASE WHEN jsonb_typeof(${col}->'mcp_tools') = 'array' THEN ${col}->'mcp_tools' ELSE '[]'::jsonb END`;
  const r = await itemsPool.query(
    `SELECT DISTINCT n FROM (
        SELECT jsonb_array_elements(${arr("manifest")})->>'name' AS n FROM org_app WHERE id <> $1
        UNION ALL
        SELECT jsonb_array_elements(${arr("v.manifest")})->>'name' FROM org_app a
          JOIN org_app_version v ON v.app_id = a.id AND v.version_no = a.published_version_no WHERE a.id <> $1
        UNION ALL
        SELECT name FROM org_tool WHERE kind <> 'builtin'
      ) x WHERE n = ANY($2::text[]) ORDER BY n`, [appId, [...names]]);
  return r.rows.map((x) => String(x.n));
}

/**
 * 설치 · 판 저장 때의 이름 겹침 검사(409). 앱 이름을 밝히지 않는다 — 겹친 앱이 남의 «나만 보는 앱» 일 수 있다(그런 앱은 없는 앱과 같다 · visibility.ts).
 *  ⚠ 설치 락은 앱마다라, 다른 두 앱이 같은 이름으로 동시에 이 검사를 지날 수 있다 — 그때는 도구 목록이 먼저 설치된 앱의 것을 올린다(listMcpToolApps 순서).
 */
export async function assertMcpToolNamesFree(appId: string, manifest: unknown): Promise<void> {
  const names = appMcpToolsOf(manifest).map((d) => d.name);
  const taken = await takenMcpToolNames(appId, names);
  if (taken.length) {
    throw new HttpError(409, `도구 이름 ${taken.map((n) => `'${n}'`).join(" · ")} 은(는) 이 워크스페이스의 다른 앱이나 도구가 이미 씁니다 — mcp_tools 의 name 을 바꿔 다시 저장하세요`);
  }
}
