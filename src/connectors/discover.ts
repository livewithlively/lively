// 커넥터 스코프 발견(#586) — 저장된 토큰으로 소스의 '고를 수 있는 것들'을 조회해 관리탭 픽커에 준다.
//   id 복붙(어렵고 실수 잦음 — #551 실사용에서 검증됨) 대신 드롭다운/체크박스 선택.
//   · notion:  통합에 공유된 페이지·데이터베이스 → root_pages 옵션. ⚠ 공유 직후엔 search 인덱싱 지연으로
//              목록이 비거나 늦게 뜰 수 있음(노션 공식) — note 로 표면화.
//   · clickup: Space → List 계층 → include/exclude/container 리스트 옵션.
//   그 외 소스는 옵션 없음(빈 fields) — 폼은 텍스트 입력으로 동작(기존과 동일).
import { resolveConnectorConfig } from "./config.js";
import { getTeam, listSpaces, listSpaceLists, listFolders } from "./clickup.js";

export interface ScopeOption { id: string; label: string; kind: string }
export interface DiscoverResult { fields: Record<string, ScopeOption[]>; note?: string }

export async function discoverConnectorScope(system: string): Promise<DiscoverResult> {
  if (system === "notion") return discoverNotion();
  if (system === "clickup") return discoverClickup();
  return { fields: {}, note: "이 커넥터는 목록 조회를 지원하지 않습니다 — 값을 직접 입력하세요." };
}

// ── notion — 통합이 보는 페이지/DB 나열(search). 최대 300건(픽커 용도 — 전체 싱크 범위는 공유가 정의). ──
async function discoverNotion(): Promise<DiscoverResult> {
  const cfg = await resolveConnectorConfig("notion");
  if (!cfg.token) throw new Error("Notion 토큰을 먼저 저장하세요 — 저장된 토큰으로 목록을 조회합니다.");
  const version = cfg.api_version || "2025-09-03";

  const call = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Notion-Version": version, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json() as Promise<Record<string, unknown>>;
  };

  const options: ScopeOption[] = [];
  const seen = new Set<string>();
  // 페이지 — 최상위(workspace 직속)를 앞에, 나머지는 뒤에(픽커 가독성).
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const d = await call({ filter: { property: "object", value: "page" }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const ru of (d.results as unknown[]) ?? []) {
      const r = ru as Record<string, unknown>;
      if (r.object !== "page" || typeof r.id !== "string" || seen.has(r.id)) continue;
      seen.add(r.id);
      const props = (r.properties ?? {}) as Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
      const title = Object.values(props).find((p) => p?.type === "title")?.title?.map((t) => t.plain_text ?? "").join("").trim();
      const parent = (r.parent ?? {}) as { type?: string };
      options.push({ id: r.id, label: title || "(제목 없음)", kind: parent.type === "workspace" ? "root_page" : "page" });
    }
    cursor = d.has_more && typeof d.next_cursor === "string" ? d.next_cursor : undefined;
    if (!cursor) break;
  }
  // 데이터베이스(2025-09+: data_source 검색 → 소유 database) — 루트로 DB 를 고르는 경우.
  try {
    const d = await call({ filter: { property: "object", value: "data_source" }, page_size: 100 });
    for (const ru of (d.results as unknown[]) ?? []) {
      const r = ru as Record<string, unknown>;
      const dbId = ((r.database_parent ?? r.parent ?? {}) as { database_id?: string }).database_id;
      if (!dbId || seen.has(dbId)) continue;
      seen.add(dbId);
      const title = ((r.title as Array<{ plain_text?: string }>) ?? []).map((t) => t.plain_text ?? "").join("").trim();
      options.push({ id: dbId, label: title || "(제목 없는 데이터베이스)", kind: "database" });
    }
  } catch { /* 구버전 API 강제 등 — 페이지만으로 진행 */ }

  options.sort((a, b) => (a.kind === "root_page" ? 0 : 1) - (b.kind === "root_page" ? 0 : 1) || a.label.localeCompare(b.label));
  return {
    // root_pages(포함)·exclude_pages(제외) 둘 다 같은 '통합이 보는 항목' 목록에서 고른다(클릭업 include/exclude 관례와 동일).
    fields: { root_pages: options, exclude_pages: options },
    note: options.length
      ? "통합에 공유된 항목입니다. 비워두면 공유된 전체가 싱크 범위입니다."
      : "목록이 비어 있습니다 — ① 노션에서 페이지 ⋯ ▸ 연결에 이 통합을 추가했는지 확인 ② 방금 연결했다면 노션 search 인덱싱 지연일 수 있으니 몇 분 뒤 다시 시도(그 사이엔 페이지 URL 을 직접 붙여넣어도 됩니다).",
  };
}

// ── clickup — Space ▸ (Folder ▸) List 나열 → 리스트 계열 필드 공용 옵션. ──
async function discoverClickup(): Promise<DiscoverResult> {
  const cfg = await resolveConnectorConfig("clickup");
  if (!cfg.api_token) throw new Error("ClickUp 토큰을 먼저 저장하세요 — 저장된 토큰으로 목록을 조회합니다.");
  const team = await getTeam();
  const options: ScopeOption[] = [];
  const spaces = await listSpaces(team.id).catch(() => []);
  for (const space of spaces) {
    const spaceName = (space as { name?: string }).name ?? "Space";
    try {
      for (const l of await listSpaceLists(String((space as { id: string }).id))) {
        const lr = l as { id: string; name?: string };
        options.push({ id: String(lr.id), label: `${spaceName} / ${lr.name ?? lr.id}`, kind: "list" });
      }
    } catch { /* space 단위 실패 — 다음 space */ }
    try {
      for (const f of await listFolders(String((space as { id: string }).id))) {
        const fr = f as { name?: string; lists?: Array<{ id: string; name?: string }> };
        for (const l of fr.lists ?? []) {
          options.push({ id: String(l.id), label: `${spaceName} / ${fr.name ?? "폴더"} / ${l.name ?? l.id}`, kind: "list" });
        }
      }
    } catch { /* 폴더 실패 — 다음 */ }
  }
  const fields: Record<string, ScopeOption[]> = {
    include_list_ids: options, exclude_list_ids: options, container_list_id: options,
  };
  return { fields, note: options.length ? undefined : "리스트가 없거나 토큰 권한이 부족합니다." };
}
