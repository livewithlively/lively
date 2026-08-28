// 평문 토큰 출처 해소(#2247) — token_source="org" | "member:<id>" 를 금고의 **평문 토큰 kind**(pk_… · figd_… 처럼
//  JSON 묶음이 아닌 값) 슬롯으로 푼다. figma-token-source.ts 가 하던 일을 kind 만 바꿔 다시 쓰는 것이라 여기로 일반화했다
//  — 다섯 앱을 붙이며 같은 40줄을 앱마다 복붙하면 실패 문장이 앱마다 조금씩 달라지고 한 곳의 버그가 다른 곳에 남는다.
//  분업은 같다: 순수 해소(주입 가능한 리더) + 실제 금고 리더. 실패는 조용히 넘기지 않고 warning 으로 말한다
//  (토큰이 비면 커넥터가 "연결 없음"으로 분명히 실패한다 — 커서 동결, 옛 토큰으로 계속 긁지 않음).
import { getMemberSecret, listSecretsByKindPublic, GATEWAY_OWNER } from "./member-secret-store.js";

export interface PlainTokenResolution { token?: string; warning?: string }

/** 금고 조회를 주입받는 순수 해소 — 테스트가 DB 없이 표의 행을 전부 돈다. */
export interface PlainVaultReader {
  /** 그 kind 슬롯 전부. owner = "gateway" | "member:<id>" · token = 저장된 평문 토큰(부재·복호화 실패는 null). */
  tokens(): Promise<Array<{ owner: string; token: string | null }>>;
}

export interface PlainTokenKindSpec {
  /** CRED_KINDS 의 슬롯 이름(예 clickup_token). */
  kind: string;
  /** 사람이 읽는 앱 이름(예 ClickUp). */
  label: string;
  /** 구성원이 토큰을 저장하는 화면 — 실패 문장 끝에 붙는다. */
  connectHint: string;
}

export async function resolvePlainTokenSource(
  source: string | undefined, vault: PlainVaultReader, spec: PlainTokenKindSpec,
): Promise<PlainTokenResolution | null> {
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
      ? `조직 공용 ${spec.label} 토큰이 없습니다 — 관리탭 ▸ 자격 금고에 ${spec.kind} 을 등록하거나 token_source 를 member:<구성원 id> 로 바꾸세요`
      : `${want} 의 ${spec.label} 토큰이 없습니다 — ${spec.connectHint}` };
  }
  const tok = pick[0].token;
  if (!tok) return { warning: `${spec.label} 토큰을 읽지 못했습니다(${want}) — ${spec.connectHint}` };
  return { token: tok };
}

/** 실제 금고 리더 — 커넥터 설정 해소(connectors/config.ts)가 kind 별로 하나씩 만든다. */
export function plainVaultReader(kind: string): PlainVaultReader {
  return {
    async tokens() {
      const rows = await listSecretsByKindPublic(kind).catch(() => []);
      const out: Array<{ owner: string; token: string | null }> = [];
      for (const row of rows) {
        if (!row.has_secret) continue;
        const r = await getMemberSecret(row.owner, kind, row.scope_key).catch(() => null);
        out.push({ owner: row.owner, token: r?.secret ? String(r.secret) : null });
      }
      return out;
    },
  };
}

/** ClickUp — 개인 API 토큰(pk_…). #2247 에서 수집기가 금고의 첫 소비처가 됐다(그전엔 폼에만 있던 죽은 슬롯). */
export const CLICKUP_TOKEN_KIND = "clickup_token";
export const CLICKUP_TOKEN_SPEC: PlainTokenKindSpec = {
  kind: CLICKUP_TOKEN_KIND, label: "ClickUp",
  connectHint: "[외부 앱 연결 ▸ ClickUp]에서 API 토큰을 저장하세요",
};
