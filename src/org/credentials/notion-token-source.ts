// 노션 수집기 토큰 출처 해소(#1881 N3) — token_source="org[:workspace_id]" 를 금고의 notion_public 슬롯으로 푼다.
//  slack-token-source.ts 와 같은 분업: 순수 해소(주입 가능한 리더) + 실제 금고 리더. 실패는 조용히 넘기지 않고
//  warning 으로 말한다 — token 이 비면 커넥터가 "연결 없음"으로 분명히 실패한다(커서 동결, 옛 토큰으로 계속 긁지 않음).
import { getMemberSecret, listSecretsByKindPublic, GATEWAY_OWNER } from "./member-secret-store.js";
import { NOTION_PUBLIC_KIND } from "./notion-oauth.js";

export interface NotionTokenResolution { token?: string; warning?: string }

/** 금고 조회를 주입받는 순수 해소 — 테스트가 DB 없이 표의 행을 전부 돈다. */
export interface NotionVaultReader {
  /** gateway 소유 notion_public 슬롯 전부(workspace_id=scope_key). token=블롭의 access_token(파싱 실패는 null). */
  orgTokens(): Promise<Array<{ workspace_id: string; token: string | null }>>;
}

const RECONNECT = "— [외부 앱 연결 ▸ Notion ▸ 팀 자료로 모으기]에서 다시 연결하세요";

export async function resolveNotionTokenSource(source: string | undefined, vault: NotionVaultReader): Promise<NotionTokenResolution | null> {
  const s = String(source ?? "").trim();
  if (!s) return null; // 미지정 = 종전 경로(붙여넣기 토큰)
  if (s !== "org" && !s.startsWith("org:")) {
    return { warning: `알 수 없는 token_source '${s}' — org 또는 org:<workspace_id> 여야 합니다` };
  }
  const want = s.startsWith("org:") ? s.slice(4).trim() : "";
  const all = await vault.orgTokens();
  const pick = want ? all.filter((t) => t.workspace_id === want) : all;
  if (pick.length === 0) {
    return { warning: want
      ? `노션 워크스페이스 '${want}' 의 Lively 연결이 없습니다 ${RECONNECT}`
      : `노션 Lively 연결이 없습니다 ${RECONNECT}` };
  }
  if (pick.length > 1) {
    return { warning: `노션 워크스페이스가 ${pick.length}개 연결돼 있어 어느 쪽을 쓸지 모릅니다 — token_source 를 'org:<workspace_id>' 로 지목하세요(${pick.map((t) => t.workspace_id).join(", ")})` };
  }
  const tok = pick[0].token;
  if (!tok) return { warning: `노션 연결 토큰을 읽지 못했습니다(워크스페이스 ${pick[0].workspace_id}) ${RECONNECT}` };
  return { token: tok };
}

/** 실제 금고 리더 — 커넥터 설정 해소(config.ts)가 쓴다. */
export const notionVaultReader: NotionVaultReader = {
  async orgTokens() {
    const rows = await listSecretsByKindPublic(NOTION_PUBLIC_KIND).catch(() => []);
    const out: Array<{ workspace_id: string; token: string | null }> = [];
    for (const row of rows) {
      if (row.owner !== GATEWAY_OWNER || !row.has_secret) continue;
      const r = await getMemberSecret(GATEWAY_OWNER, NOTION_PUBLIC_KIND, row.scope_key).catch(() => null);
      let tok: string | null = null;
      if (r?.secret) {
        try { const t = JSON.parse(r.secret) as { access_token?: unknown }; tok = typeof t.access_token === "string" && t.access_token ? t.access_token : null; }
        catch { tok = null; }
      }
      out.push({ workspace_id: row.scope_key, token: tok });
    }
    return out;
  },
};
