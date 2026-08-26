// 피그마 수집기 토큰 출처 해소(#1881 F5) — token_source="org" | "member:<id>" 를 금고의 figma_token 슬롯으로 푼다.
//  slack-token-source.ts · notion-token-source.ts 와 같은 분업: 순수 해소(주입 가능한 리더) + 실제 금고 리더.
//  실패는 조용히 넘기지 않고 warning 으로 말한다 — token 이 비면 커넥터가 "연결 없음"으로 분명히 실패한다
//  (커서 동결, 옛 토큰으로 계속 긁지 않음).
//
// ⚠ 피그마가 슬랙·노션과 다른 점: 여기 담기는 것은 OAuth 토큰이 아니라 **개인 액세스 토큰(PAT, figd_…)** 이다.
//  라이블리 공개 OAuth 앱(F3)은 Figma 심사가 필요해 런칭 경로 밖이고, 게다가 공개 앱은 파일 열거 엔드포인트를
//  쓸 수 없다("The projects endpoints cannot be used with public OAuth apps"). PAT 는 그 제약을 받지 않으므로
//  **팀 전체를 훑는 수집은 당분간 PAT 로만 성립한다.** 공개 앱이 준비되면 이 축에 출처 하나가 더 붙는다.
import { getMemberSecret, listSecretsByKindPublic, GATEWAY_OWNER } from "./member-secret-store.js";

/** CRED_KINDS 의 슬롯 이름 — 관리탭 자격 금고·개인 로그인 화면이 쓰는 그 kind. */
export const FIGMA_TOKEN_KIND = "figma_token";

export interface FigmaTokenResolution { token?: string; warning?: string }

/** 금고 조회를 주입받는 순수 해소 — 테스트가 DB 없이 표의 행을 전부 돈다. */
export interface FigmaVaultReader {
  /** figma_token 슬롯 전부. owner = "gateway" | "member:<id>" · token = 저장된 PAT(부재·복호화 실패는 null). */
  tokens(): Promise<Array<{ owner: string; token: string | null }>>;
}

const CONNECT = "— [내 설정 ▸ 외부 서비스 관리 ▸ Figma]에서 개인 액세스 토큰을 저장하세요";

export async function resolveFigmaTokenSource(
  source: string | undefined, vault: FigmaVaultReader,
): Promise<FigmaTokenResolution | null> {
  const s = String(source ?? "").trim();
  if (!s) return null; // 미지정 = 종전 경로(수집기 폼에 직접 붙여넣은 토큰)
  const isOrg = s === "org";
  const isMember = s.startsWith("member:") && s.slice(7).trim().length > 0;
  if (!isOrg && !isMember) {
    return { warning: `알 수 없는 token_source '${s}' — org 또는 member:<구성원 id> 여야 합니다` };
  }
  const want = isOrg ? GATEWAY_OWNER : `member:${s.slice(7).trim()}`;
  const all = await vault.tokens();
  const pick = all.filter((t) => t.owner === want);
  if (pick.length === 0) {
    return { warning: isOrg
      ? `조직 공용 Figma 토큰이 없습니다 — 관리탭 ▸ 자격 금고에 figma_token 을 등록하거나 token_source 를 member:<구성원 id> 로 바꾸세요`
      : `${want} 의 Figma 토큰이 없습니다 ${CONNECT}` };
  }
  const tok = pick[0].token;
  if (!tok) return { warning: `Figma 토큰을 읽지 못했습니다(${want}) ${CONNECT}` };
  return { token: tok };
}

/** 실제 금고 리더 — 커넥터 설정 해소(connectors/config.ts)가 쓴다. */
export const figmaVaultReader: FigmaVaultReader = {
  async tokens() {
    const rows = await listSecretsByKindPublic(FIGMA_TOKEN_KIND).catch(() => []);
    const out: Array<{ owner: string; token: string | null }> = [];
    for (const row of rows) {
      if (!row.has_secret) continue;
      const r = await getMemberSecret(row.owner, FIGMA_TOKEN_KIND, row.scope_key).catch(() => null);
      // 피그마 PAT 는 JSON 블롭이 아니라 평문 토큰(figd_…) 이다 — 노션(access_token 파싱)과 다르다.
      out.push({ owner: row.owner, token: r?.secret ? String(r.secret) : null });
    }
    return out;
  },
};
