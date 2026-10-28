// 앱이 선언한 MCP 도구(#5050 앱 v2-40)의 DB 읽기 — 도구 목록을 짤 앱(가벼운 칸만 · 공개 판의 선언까지 한 번에) · 이름 겹침 검사 · 이름 잠금.
//  ★ 목록 읽기는 MCP 요청마다 돈다(무상태 /mcp 는 tools/call 도 서버를 새로 굽는다 — boot/mcp-transport.ts). 그래서 매니페스트 전체가 아니라
//   mcp_tools 칸만 읽고, 설치된 판이나 (초안이 걸린 공개 앱의) 공개 판이 그 칸을 가진 앱만 고른다 — 쿼리 하나. 선언한 앱이 없으면 0행이다.
//   실행기가 하나도 없는 코어는 이 쿼리조차 부르지 않는다(mcp/app-declared-tools.ts).
//  워크스페이스 격리는 행 격리 정책이 한다(org_app · org_app_version · org_tool — 이 함수들의 SQL 은 tenant_id 를 적지 않는다).
import { itemsPool } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { withAppInstallLock, type AppVisibility } from "../org/store/apps.js";
import { appMcpToolsOf } from "./app-mcp-decl.js";

/** 도구 목록 판정에 쓰는 앱 칸(org_app 의 부분) + 설치된 판의 mcp_tools + 공개 판의 이름표 · mcp_tools. */
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
  /** 초안이 걸린 공개 앱의 공개 판(판 행) — 그 밖의 앱이거나 판 행이 없으면(불변식 위반) null. */
  published: { title: string; mcp_tools: unknown } | null;
}

/**
 * 켜져 있고(active · enabled) 설치된 판이나 공개 판이 mcp_tools 를 선언한 앱. 설치 순서(오래된 것 먼저) — 이름이 겹치면(설치 검사 밖에서 생긴
 *  이름 · 그 뒤에 생긴 조직 도구) 먼저 등록된 쪽이 이긴다(mcp/app-declared-tools.ts).
 */
export async function listMcpToolApps(): Promise<McpToolAppRow[]> {
  const r = await itemsPool.query(
    `SELECT a.id, a.title, a.source, a.visibility, a.owner_member, a.draft_by, a.published_version_no, a.content_hash, a.current_version_no,
            a.manifest->'mcp_tools' AS mcp_tools,
            v.version_no AS pub_no, v.manifest->>'title' AS pub_title, v.manifest->'mcp_tools' AS pub_mcp_tools
       FROM org_app a
       LEFT JOIN org_app_version v
         ON a.visibility = 'all' AND a.draft_by IS NOT NULL AND v.app_id = a.id AND v.version_no = a.published_version_no
      WHERE a.status = 'active' AND a.enabled
        AND (a.manifest ? 'mcp_tools' OR v.manifest ? 'mcp_tools')
      ORDER BY a.installed_at, a.id`);
  return r.rows.map((x) => ({
    id: String(x.id), title: String(x.title ?? ""), source: x.source, visibility: x.visibility === "me" ? "me" : "all",
    owner_member: x.owner_member ?? null, draft_by: x.draft_by ?? null,
    published_version_no: x.published_version_no == null ? null : Number(x.published_version_no),
    content_hash: x.content_hash ?? null, current_version_no: x.current_version_no == null ? null : Number(x.current_version_no),
    mcp_tools: x.mcp_tools ?? null,
    published: x.pub_no == null ? null : { title: String(x.pub_title ?? ""), mcp_tools: x.pub_mcp_tools ?? null },
  }));
}

/**
 * 이 이름들 가운데 이미 쓰이는 것 — 앱의 mcp_tools(상태 무관 · 설치된 판과 공개 판 둘 다 — 공개 판을 보는 사람에게는 그 판의 도구가 선다)와,
 *  orgTools 면 조직 도구(org_tool — 빌트인 토글 행은 빌트인 이름을 가리키는 것이라 뺀다. 빌트인 이름은 app-mcp-decl 이 따로 막는다).
 *  exceptApp — 저장하는 그 앱 자신(제 이름은 겹침이 아니다).
 */
export async function takenMcpToolNames(names: readonly string[], opts: { exceptApp?: string; orgTools?: boolean } = {}): Promise<string[]> {
  if (!names.length) return [];
  const arr = (col: string): string => `CASE WHEN jsonb_typeof(${col}->'mcp_tools') = 'array' THEN ${col}->'mcp_tools' ELSE '[]'::jsonb END`;
  const r = await itemsPool.query(
    `SELECT DISTINCT n FROM (
        SELECT jsonb_array_elements(${arr("manifest")})->>'name' AS n FROM org_app WHERE id IS DISTINCT FROM $1::text
        UNION ALL
        SELECT jsonb_array_elements(${arr("v.manifest")})->>'name' FROM org_app a
          JOIN org_app_version v ON v.app_id = a.id AND v.version_no = a.published_version_no WHERE a.id IS DISTINCT FROM $1::text
        UNION ALL
        SELECT name FROM org_tool WHERE $3::boolean AND kind <> 'builtin'
      ) x WHERE n = ANY($2::text[]) ORDER BY n`, [opts.exceptApp ?? null, [...names], opts.orgTools !== false]);
  return r.rows.map((x) => String(x.n));
}

/**
 * 설치 · 판 저장 때의 이름 겹침 검사(409). 앱 이름을 밝히지 않는다 — 겹친 앱이 남의 «나만 보는 앱» 일 수 있다(그런 앱은 없는 앱과 같다 · visibility.ts).
 *  검사와 설치는 withMcpToolNamesLock 안에서 이어 돈다(설치 코어 install-run.ts) — 다른 두 앱이 같은 이름으로 동시에 지나가지 못한다.
 */
export async function assertMcpToolNamesFree(appId: string, manifest: unknown): Promise<void> {
  const taken = await takenMcpToolNames(appMcpToolsOf(manifest).map((d) => d.name), { exceptApp: appId });
  if (taken.length) {
    throw new HttpError(409, `도구 이름 ${taken.map((n) => `'${n}'`).join(" · ")} 은(는) 이 워크스페이스의 다른 앱이나 도구가 이미 씁니다 — mcp_tools 의 name 을 바꿔 다시 저장하세요`);
  }
}

/**
 * 워크스페이스의 «도구 이름 자리» 잠금 — mcp_tools 를 선언한 앱의 이름 검사부터 설치가 끝날 때까지 쥔다. 설치 락(앱마다) 위에 한 겹 더 —
 *  앱 id 꼴(소문자 · 하이픈)에 없는 밑줄 이름이라 어떤 앱의 락과도 겹치지 않는다. 잡는 순서는 늘 앱 락 → 이 락이다(교착 없음).
 */
export const MCP_TOOL_NAMES_LOCK = "__mcp_tool_names__";
export function withMcpToolNamesLock<T>(fn: () => Promise<T>): Promise<T> {
  return withAppInstallLock(MCP_TOOL_NAMES_LOCK, fn);
}
