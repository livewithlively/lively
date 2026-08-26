// 수집기의 구글 토큰 출처 해소(#1881 G3) — 붙여넣기 대신 **금고**에서 자격을 꺼내 쓴다.
//
//  왜: 지금 gmail·gdrive 수집기는 `client_id` + `client_secret` + `refresh_token` **3칸을 손으로** 채우게 한다.
//  가이드가 대놓고 "OAuth Playground 로 refresh token 발급"이다 — 슬랙 봇토큰과 같은 등급의 장벽이고, 구글은
//  거기에 GCP 콘솔까지 얹힌다. [Google 연결] 한 번이면 그 세 값이 이미 금고에 있으므로 복사할 이유가 없다.
//
//  ★ 슬랙·노션과 다른 점 — **액세스 토큰을 돌려주지 않는다.** 구글 액세스 토큰은 1시간짜리라 커넥터가 캐시해 두면
//  곧 죽는다. 대신 `google-auth.ts` 가 이미 갖고 있는 교환·만료캐시 경로에 **같은 3칸을 채워 넣는다** —
//  즉 `googleAccessToken()` 은 한 글자도 바뀌지 않고, 값의 출처만 붙여넣기에서 금고로 옮긴다.
//
//  `org_collector.config.token_source` 의 값이 출처다:
//    · `member:<id>` — 그 구성원이 [Google 연결]로 저장한 자격. "팀 자료로 모으기"를 켠 관리자의 것.
//    · 비움 — 종전대로(붙여넣기 칸·env). 무회귀.
//  출처를 **명시했으면 그 출처만** 쓴다 — 금고에 없다고 붙여넣기 값으로 조용히 떨어지면 "연결한 사람이 나갔는데
//  옛 토큰으로 계속 긁는" 꼴이 된다. 없으면 비워서 커넥터가 "연결 없음" 으로 분명히 실패하게 둔다.
import { getMemberSecret, memberOwner, GATEWAY_OWNER, CLIENT_SCOPE } from "./member-secret-store.js";
import { GOOGLE_KIND, GOOGLE_LEGACY_KINDS } from "./google-oauth.js";

/** 커넥터 config 에 그대로 얹히는 3칸. 하나라도 비면 googleAccessToken 이 "자격 미설정" 으로 던진다. */
export interface GoogleTokenResolution {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  warning?: string;
}

/**
 * 수집기 system → 그 사람이 예전에 서비스별로 붙였을 수 있는 구 kind(#1652 이전 구조).
 *  통합 슬롯을 **먼저** 보고, 없으면 이 구 슬롯을 본다(도구 면의 별칭과 같은 방향 — 무회귀).
 */
const LEGACY_KIND_BY_SYSTEM: Record<string, string> = {
  gmail: "google_gmail_oauth",
  gdrive: "google_drive_oauth",
};

/** 이 system 이 구글 수집기인가(=이 해소를 태울 대상인가). */
export function isGoogleCollectorSystem(system: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_KIND_BY_SYSTEM, system);
}

/** 이 system 이 볼 금고 kind 우선순위. 통합 우선, 그다음 그 서비스의 구 kind. */
export function googleKindsFor(system: string): string[] {
  const legacy = LEGACY_KIND_BY_SYSTEM[system];
  return legacy ? [GOOGLE_KIND, legacy] : [GOOGLE_KIND];
}

/** 금고 조회를 주입받는 순수 해소 — 테스트가 DB 없이 표의 행을 전부 돈다. */
export interface GoogleVaultReader {
  /** kinds 를 **순서대로** 훑어 처음 잡히는 슬롯. refresh_token 이 없으면 null 로 담아 온다(그 사실이 진단이다). */
  memberOAuth(memberId: string, kinds: readonly string[]): Promise<{ kind: string; refresh_token: string | null } | null>;
  /** 그 kind 의 조직 OAuth 클라이언트(gateway 소유 oauth:client 슬롯). */
  oauthClient(kind: string): Promise<{ client_id: string; client_secret: string } | null>;
}

const RECONNECT = "— [외부 앱 연결 ▸ Google] 에서 다시 연결하거나 다른 관리자로 바꾸세요";

export async function resolveGoogleTokenSource(
  source: string | undefined, system: string, vault: GoogleVaultReader,
): Promise<GoogleTokenResolution | null> {
  const s = String(source ?? "").trim();
  if (!s) return null; // 미지정 = 종전 경로(붙여넣기)
  if (!s.startsWith("member:")) {
    return { warning: `알 수 없는 token_source '${s}' — member:<구성원 id> 여야 합니다` };
  }
  const id = s.slice("member:".length).trim();
  if (!id) return { warning: "token_source 'member:' 뒤에 구성원 id 가 없습니다" };

  const hit = await vault.memberOAuth(id, googleKindsFor(system));
  if (!hit) return { warning: `구성원 '${id}' 의 Google 연결이 없습니다 ${RECONNECT}` };

  // ⚠ 갱신 토큰 없음 = 이미 죽은 연결이다. 구글은 access_type=offline 동의에서만 refresh_token 을 준다
  //  (#1652: 그 픽스 이전에 붙인 사람들이 여기 해당한다). 조용히 넘기면 1시간 뒤 커서가 동결된 채 '성공'으로 보인다.
  if (!hit.refresh_token) {
    return { warning: `구성원 '${id}' 의 Google 연결에 갱신 토큰이 없습니다 — 오래된 방식으로 연결된 계정입니다 ${RECONNECT}` };
  }

  const client = await vault.oauthClient(hit.kind);
  if (!client) {
    return { warning: `Google OAuth 클라이언트(kind ${hit.kind})가 등록되지 않았습니다 — 관리자가 Client ID/Secret 을 조직 자격에 넣어야 합니다` };
  }
  return { client_id: client.client_id, client_secret: client.client_secret, refresh_token: hit.refresh_token };
}

/**
 * ★ 조직 OAuth 클라이언트도 **구 kind 를 승계한다**(2026-08-26 실측이 만든 수정).
 *
 *  멤버 토큰에는 별칭을 걸어 뒀는데(google-oauth.ts GOOGLE_LEGACY_KINDS) 게이트웨이 소유 client 슬롯에는
 *  안 걸려 있었다. 그래서 **#1652 시절에 붙여 둔 조직**(client 가 `google_drive_oauth/oauth:client` 에 있다)은
 *  · 도구·수집은 멀쩡히 도는데(그 경로는 잡힌 kind 로 client 를 찾는다)
 *  · `googleReady()` 만 false 가 되어 [Google 연결]·[권한 넓히기]가 **작동하지 않는다.**
 *  게다가 화면은 "연결됨"이라 client 입력 폼도 안 내밀어서 **빠져나갈 길이 없는 상태**가 된다(dev 실측).
 *
 *  순서: 통합 kind 가 먼저다 — 새로 넣은 client 가 낡은 것을 이긴다.
 */
export const GOOGLE_CLIENT_KINDS: readonly string[] = [GOOGLE_KIND, ...GOOGLE_LEGACY_KINDS];

export async function resolveGoogleOAuthClient(
  vault: Pick<GoogleVaultReader, "oauthClient">,
): Promise<{ kind: string; client_id: string; client_secret: string } | null> {
  for (const kind of GOOGLE_CLIENT_KINDS) {
    const c = await vault.oauthClient(kind);
    if (c) return { kind, ...c };
  }
  return null;
}

/** 실제 금고 리더 — 커넥터 설정 해소(config.ts)가 쓴다. */
export const googleVaultReader: GoogleVaultReader = {
  async memberOAuth(memberId, kinds) {
    for (const kind of kinds) {
      const r = await getMemberSecret(memberOwner(memberId), kind, "").catch(() => null);
      if (!r?.secret) continue;
      let refresh: string | null = null;
      try {
        const t = JSON.parse(r.secret) as { refresh_token?: unknown };
        refresh = typeof t.refresh_token === "string" && t.refresh_token ? t.refresh_token : null;
      } catch { refresh = null; }
      return { kind, refresh_token: refresh }; // 슬롯이 잡혔으면 여기서 끝 — 갱신 토큰 유무는 호출자가 진단한다
    }
    return null;
  },
  async oauthClient(kind) {
    const r = await getMemberSecret(GATEWAY_OWNER, kind, CLIENT_SCOPE).catch(() => null);
    if (!r?.secret) return null;
    try {
      const ci = JSON.parse(r.secret) as { client_id?: unknown; client_secret?: unknown };
      return typeof ci.client_id === "string" && ci.client_id && typeof ci.client_secret === "string" && ci.client_secret
        ? { client_id: ci.client_id, client_secret: ci.client_secret }
        : null;
    } catch { return null; }
  },
};
