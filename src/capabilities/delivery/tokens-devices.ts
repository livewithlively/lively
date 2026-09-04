// delivery ▸ tokens-devices — 접속 열쇠(auth_token) 목록·발급·회수 + CLI 디바이스 로그인 승인(#880)
//  + 세션 SSO 브리지 코드 발급(#1454 S1).
import type { Capability, CapabilityCtx } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import { SCOPES_ALLOWED, DANGEROUS_SCOPES, type Scope } from "../scopes.js";
import type { LivelyUser } from "../../context.js";
import { getMember, mintToken, listTokens, revokeToken, mintSessionCode } from "../../org/store.js";
import { resolveTokenHandle, MIN_HANDLE_LEN, TOKEN_HASH_LEN } from "../../org/store/tokens.js";
import { hasCredential, verifyOwnPassword } from "../../auth/local-accounts.js";
import { lookupDeviceAuth, approveDeviceAuth, denyDeviceAuth, checkDeviceRate } from "../../org/auth/device-auth.js";
import {
  listClients as listOAuthClients, saveClient as saveOAuthClient, disableClient as disableOAuthClient,
} from "../../org/store/oauth.js";
import { isAcceptableRedirectUri } from "../../org/auth/oauth-clients.js";
import { sha256Hex } from "../../org/auth/grant-util.js";
import { actorOf, restOnly, restRead, slug, str } from "./shared.js";

export const tokensReadCapabilities: Capability[] = [
  restOnly("org_tokens", "접속 열쇠 목록",
    "관리탭 [구성원 권한 관리] — 발급된 접속 열쇠(auth_token) 목록. **평문 토큰은 복원 불가**(해시만 저장) — 여기 나오는 token_hash 가 " +
    "org_token_revoke 의 회수 핸들이다. 발급은 org_token_mint.",
    [{ method: "GET", paths: ["/api/ui/org/tokens"], parse: () => ({}) }],
    async () => ({ tokens: await listTokens() })),
];

export const tokenMintCapabilities: Capability[] = [
  // ── 토큰 발급/회수 ──
  restOnly("org_token_mint", "구성원 토큰 발급",
    "구성원용 bearer 토큰을 발급한다(평문은 1회만 반환). curl 설치 한 줄에 이 토큰을 박는다.",
    [{ method: "POST", paths: ["/api/ui/org/token"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = slug(input.userId ?? input.memberId, "userId");
      const memberId = input.memberId === undefined ? userId : slug(input.memberId, "memberId");
      // scope 미지정 시 구성원에 설정된 권한을 기본값으로(구성원 메뉴의 권한이 토큰 권한의 진실원천).
      let rawScopes: unknown[];
      if (Array.isArray(input.scopes) && input.scopes.length) rawScopes = input.scopes;
      else { const mem = await getMember(memberId); rawScopes = mem?.scopes?.length ? mem.scopes : ["items", "context", "memory"]; }
      const scopes = rawScopes.map((s) => str(s, "scopes[]", 20));
      for (const s of scopes) if (!SCOPES_ALLOWED.has(s)) throw new HttpError(400, `허용되지 않은 scope: ${s}`);
      const { token, tokenHash } = await mintToken({
        userId,
        scopes,
        label: input.label === undefined ? null : str(input.label, "label", 200).trim(),
        memberId,
      }, actorOf(user), "web");
      // tokenHash 는 **자르지 않는다**(#2646) — 이 값이 org_token_revoke 의 회수 핸들이고, 이름이 같으면
      //  값도 호환돼야 한다. 종전엔 12자로 잘라 줬는데 회수는 64자 exact match 라, 발급이 준 값을 그대로
      //  넣는 가장 자연스러운 사용이 **정확히 안 되는 조합**이었다. 해시는 비밀이 아니다(org_tokens 도 전량 노출).
      return { token, tokenHash, userId, scopes }; // 평문 token 은 이 응답에서만
    }, {
      userId: z.string().optional().describe("토큰 주인 멤버 id(생략 시 memberId)"),
      memberId: z.string().optional().describe("연결할 멤버 id — 유효권한=intersection(토큰scope, 멤버 LIVE scope)"),
      scopes: z.array(z.string()).optional().describe("토큰 scope(생략 시 멤버 scope): items|context|memory|db|code|admin|runtime"),
      label: z.string().optional().describe("토큰 라벨(용도 메모)"),
    }),

  // ── 세션 SSO 브리지 코드 발급(#1454 S1) — 컨트롤플레인이 테넌트 자동 로그인용 1회용 코드를 만든다. ──
  //  브라우저가 GET /api/ui/session/exchange?code= 로 교환하면 그 멤버의 웹 세션 쿠키가 심긴다(web.ts).
  //  org_token_mint 와 같은 성격의 자격 발급이라 여기 동거하되, **MCP 로는 열지 않는다**(mcp:false) —
  //  이 창구의 소비자는 컨트롤플레인 서버(REST)뿐이고, 에이전트가 임의 멤버의 로그인 코드를 뽑을 이유가 없다.
  //  (scope=admin + web.ts B5 게이트가 정적 토큰을 거부하므로 회수 가능한 자격으로만 발급된다.)
  {
    name: "org_session_mint",
    title: "구성원 세션 코드 발급",
    description:
      "구성원의 웹 자동 로그인용 1회용 코드를 발급한다(평문은 이 응답에서만 — 저장은 sha256). TTL 60초·1회용. " +
      "브라우저를 GET /api/ui/session/exchange?code=<code> 로 보내면 세션 쿠키를 심고 /ui/ 로 리다이렉트한다.",
    scope: "admin",
    // #1403 input 규약 — mcp:false 여도 parse 산출(memberId)을 선언한다(device_lookup 과 동일 관례).
    input: { memberId: z.string().describe("세션을 만들 대상 멤버 id(kind=human·active 만)") },
    expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/org/session-mint"], parse: (req) => req.body ?? {} }] },
    handler: async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const memberId = slug(input.memberId, "memberId");
      // 대상 검증 — 세션은 사람 본인 행위(auth/sessions.ts)라 human·active 에게만 발급한다.
      //  agent/system 멤버의 웹 세션은 존재 자체가 버그고, 비활성 멤버는 교환 시점에도 다시 걸러진다(이중 방어).
      const mem = await getMember(memberId);
      if (!mem) throw new HttpError(404, `구성원을 찾을 수 없습니다: ${memberId}`);
      if (mem.kind !== "human") throw new HttpError(400, "세션 코드는 kind=human 구성원에게만 발급할 수 있습니다");
      if (mem.state !== "active") throw new HttpError(400, "비활성 구성원에게는 세션 코드를 발급할 수 없습니다");
      const { code, expiresAt } = await mintSessionCode(memberId, actorOf(user), ctx?.source ?? "web");
      return { code, memberId, expires_at: expiresAt.toISOString() }; // 평문 code 는 이 응답에서만
    },
  },

  // ── 본인 토큰 자가발급(설치 탭) — 인증된 구성원이 자기 토큰을 만든다. admin 불요. ──
  // userId 는 principal 에서 강제(타인 발급 불가), scope 는 본인 member.scopes(없으면 현재 scope) — 상승 불가.
  restRead("org_token_mint_self", "본인 토큰 발급",
    "현재 로그인한 구성원이 본인 설치 토큰을 발급한다(설치/재설치용). userId·scope 는 principal 로 고정. includeControlPlane=true 면 관리 권한(admin/runtime)도 싣는다 — 상한은 멤버 LIVE scope ∩ 제시 토큰(증폭 불가).",
    [{ method: "POST", paths: ["/api/ui/org/token/self"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      // 자가발급은 회수 가능한 DB 토큰만 만든다 — 회수 불가한 정적 토큰으로는 금지(킬스위치 세탁 방지).
      //  (scope-null capability 라 web.ts 의 B3/B5 게이트가 안 걸린다 → 여기서 직접 차단.)
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 자가발급할 수 없습니다 — 관리자에게 발급을 요청하세요");
      const mem = await getMember(userId);
      const presented = Array.isArray(user.scopes) ? user.scopes : [];
      const base = mem?.scopes?.length ? mem.scopes : presented;
      // 설치용 토큰 — 기본은 admin/runtime 제외(최소권한). #632: 로컬 세션 에이전트가 관리 기능(MCP org_*)을 쓰려면
      //  includeControlPlane opt-in 시 admin/runtime 도 싣는다 — 중앙박스 프로비저닝 opt-in(#549)의 self-mint 대응.
      //  상한은 언제나 멤버 LIVE scope ∩ 제시 토큰(presented): 둘 다 가진 scope 만 실려 증폭 불가.
      //  멤버 강등 시 verifyDbToken 이 매 호출 intersection 으로 즉시 무효(회수의 진짜 지점 = 멤버 scope). 발급은 감사에 남는다.
      const includeControlPlane = input?.includeControlPlane === true;
      const scopes = base.filter((s) => SCOPES_ALLOWED.has(s) && presented.includes(s)
        && (includeControlPlane || !DANGEROUS_SCOPES.has(s as Scope)));
      const withControlPlane = scopes.some((s) => DANGEROUS_SCOPES.has(s as Scope));
      const { token } = await mintToken(
        { userId, scopes, label: (mem?.display_name || userId) + (withControlPlane ? " (self +admin)" : " (self)"), memberId: userId },
        actorOf(user), "web-self");
      return { token, scopes, userId };
    }),
];

export const deviceAuthCapabilities: Capability[] = [
  // ── CLI 디바이스 로그인 승인 (#880) — 브라우저에서 CLI 를 승인한다. lookup/approve/deny. ──
  //  ⚠ 정적 토큰 금지(회수불가 → self-mint 세탁 방지, delivery token/self 와 동형). 세션·회수가능 db 토큰만.
  //  scope-null capability 라 web.ts B3/B5 게이트가 안 걸린다 → 여기서 tokenSource·rate-limit 직접 강제.
  restRead("device_lookup", "디바이스 승인 대기 조회",
    "user_code 로 승인 대기 중인 CLI 로그인 요청을 조회한다(승인 화면 표시용). pending·미만료만.",
    [{ method: "GET", paths: ["/api/ui/cli/device/lookup"], parse: (req) => ({ code: (req.query?.code ?? "") }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 승인할 수 없습니다");
      if (!checkDeviceRate(user.userId)) throw new HttpError(429, "요청이 너무 잦습니다 — 잠시 후 다시 시도하세요");
      const r = await lookupDeviceAuth(String(input.code ?? ""));
      if (!r) throw new HttpError(404, "해당 코드의 대기 중인 로그인이 없습니다(만료됐거나 잘못된 코드).");
      return r;
    },
    false, { code: z.string() }),   // mcp:false 여도 parse 산출을 선언(#1403 — types.ts input 규약)

  restRead("device_approve", "디바이스 로그인 승인",
    "브라우저에서 CLI 로그인을 승인한다. member_id·scope 는 principal 강제. include_control_plane=true(관리권한 포함)는 비밀번호 재확인(step-up) 필요.",
    [{ method: "POST", paths: ["/api/ui/cli/device/approve"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 승인할 수 없습니다");
      if (!checkDeviceRate(user.userId)) throw new HttpError(429, "요청이 너무 잦습니다 — 잠시 후 다시 시도하세요");
      const userCode = str(input.user_code, "user_code", 20);
      const includeControlPlane = input.include_control_plane === true;
      // step-up: control-plane 을 실제로 실을 수 있는 멤버(위험 scope 보유)만 비밀번호 재확인. 비번 없는 멤버
      //  (프로비저닝·향후 SSO)는 세션 자체가 신선도 증거 → 통과(비번을 유일 게이트로 두면 잠김, 설계 R2-F3).
      const memberScopes = Array.isArray(user.scopes) ? user.scopes : [];
      const hasDangerous = memberScopes.some((s) => DANGEROUS_SCOPES.has(s as Scope));
      if (includeControlPlane && hasDangerous && await hasCredential(user.userId)) {
        const pw = typeof input.password === "string" ? input.password : "";
        if (!pw || !(await verifyOwnPassword(user.userId, pw))) {
          throw new HttpError(403, "관리 권한 포함 승인은 비밀번호 재확인이 필요합니다.");
        }
      }
      const ok = await approveDeviceAuth(userCode, user.userId, memberScopes, includeControlPlane);
      if (!ok) throw new HttpError(410, "이미 처리됐거나 만료된 코드입니다.");
      return { ok: true };
    }),

  restRead("device_deny", "디바이스 로그인 거부",
    "브라우저에서 CLI 로그인 요청을 거부한다.",
    [{ method: "POST", paths: ["/api/ui/cli/device/deny"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 거부할 수 없습니다");
      if (!checkDeviceRate(user.userId)) throw new HttpError(429, "요청이 너무 잦습니다 — 잠시 후 다시 시도하세요");
      await denyDeviceAuth(str(input.user_code, "user_code", 20));
      return { ok: true };
    }),
];

// ── OAuth 클라이언트 사전등록(#1473 T2) — 'static' 경로. ──
//  CIMD(ChatGPT)·DCR(claude.ai)는 클라이언트가 스스로 등록하지만, Gemini Enterprise 처럼 **관리자가 미리 받은
//  client_id/secret 을 손으로 넣는** 표면이 있다. 그 표면을 위한 창구다.
//  발급 자격이라 scope=admin(정적 토큰은 web.ts B5 게이트가 이미 거부 — 회수 가능한 자격으로만 등록된다).
export const oauthClientCapabilities: Capability[] = [
  restOnly("org_oauth_clients", "OAuth 클라이언트 목록",
    "이 게이트웨이에 등록된 OAuth 클라이언트(cimd 자동캐시 · dcr 동적등록 · static 사전등록) 목록. " +
    "**클라이언트 시크릿은 복원 불가**(해시만 저장) — has_secret 로 존재 여부만 보인다. 끄려면 org_oauth_client_disable.",
    [{ method: "GET", paths: ["/api/ui/org/oauth/clients"], parse: () => ({}) }],
    async () => ({ clients: await listOAuthClients() })),

  restOnly("org_oauth_client_upsert", "OAuth 클라이언트 사전등록",
    "관리자가 OAuth 클라이언트를 직접 등록한다(kind=static). Gemini Enterprise 처럼 client_id/secret 을 손으로 넣는 " +
    "표면용. clientSecret 을 주면 그 값의 해시를 저장하고(평문 보관 안 함), 생략하면 공개 클라이언트로 등록된다. " +
    "redirectUris 는 https 또는 loopback 만 허용(오픈 리다이렉터 방지).",
    [{ method: "POST", paths: ["/api/ui/org/oauth/client"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const clientId = str(input.clientId, "clientId", 200).trim();
      if (!clientId) throw new HttpError(400, "clientId 가 필요합니다");
      const rawUris = Array.isArray(input.redirectUris) ? input.redirectUris : [];
      const redirectUris = rawUris.map((u) => str(u, "redirectUris[]", 500).trim()).filter(Boolean);
      if (!redirectUris.length) throw new HttpError(400, "redirectUris 가 1개 이상 필요합니다");
      for (const u of redirectUris) {
        if (!isAcceptableRedirectUri(u)) throw new HttpError(400, `허용되지 않은 redirect_uri: ${u} (https 또는 loopback 만)`);
      }
      const secret = input.clientSecret === undefined ? null : str(input.clientSecret, "clientSecret", 512);
      await saveOAuthClient({
        clientId, kind: "static",
        clientName: input.clientName === undefined ? null : str(input.clientName, "clientName", 200).trim(),
        clientSecretHash: secret ? sha256Hex(secret) : null,
        redirectUris,
        tokenEndpointAuthMethod: secret ? "client_secret_post" : "none",
        metadata: { redirect_uris: redirectUris },
        actor: actorOf(user),
      });
      return { ok: true, clientId, hasSecret: Boolean(secret) };
    }, {
      clientId: z.string().describe("클라이언트 ID(상대 표면이 발급했거나 우리가 정한 값)"),
      redirectUris: z.array(z.string()).describe("허용할 redirect_uri 목록 — https 또는 loopback 만"),
      clientName: z.string().optional().describe("동의 화면에 표시할 이름"),
      clientSecret: z.string().optional().describe("클라이언트 시크릿(평문). 저장은 sha256 해시만 — 생략 시 공개 클라이언트"),
    }),

  restOnly("org_oauth_client_disable", "OAuth 클라이언트 해제",
    "클라이언트를 즉시 비활성화하고 그 클라이언트로 발급된 액세스·리프레시 토큰을 전부 회수한다(게이트웨이 재시작 불요).",
    [{ method: "POST", paths: ["/api/ui/org/oauth/client/disable"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const clientId = str(input.clientId, "clientId", 200).trim();
      if (!clientId) throw new HttpError(400, "clientId 가 필요합니다");
      const disabled = await disableOAuthClient(clientId, actorOf(user));
      return { ok: true, clientId, disabled }; // disabled=false = 이미 꺼져 있었음(토큰 회수는 그래도 수행)
    }, {
      clientId: z.string().describe("비활성화할 클라이언트 ID"),
    }),
];

export const tokenRevokeCapabilities: Capability[] = [
  restOnly("org_token_revoke", "접속 토큰 해제",
    "토큰을 즉시 무효화한다(게이트웨이 재시작 불요). 핸들은 org_token_mint 가 돌려준 tokenHash 또는 org_tokens 의 " +
    "token_hash 를 그대로 넣는다 — 앞자리(12자 이상)도 **그것이 가리키는 토큰이 하나뿐일 때** 받는다. " +
    "**없는 토큰이면 404 다**(성공이라 답하지 않는다). 이미 회수돼 있었으면 성공이되 revoked=false 로 구분해 답한다.",
    [{ method: "POST", paths: ["/api/ui/org/token/revoke"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      // #2646 — 종전엔 64자 exact match 하나뿐이었고, 안 맞아도 {ok:true} 였다. 그래서 발급이 준 12자 핸들로
      //  회수하면 **성공을 답하면서 토큰은 살아 있었다**(실측 2026-09-04). 이제 핸들을 먼저 풀고,
      //  실제로 무엇이 일어났는지를 그대로 돌려준다.
      // 길이 상한은 넉넉히 두고 판정은 classifyTokenHandle 한 곳에서 한다 — str 의 상한을 64 로 조이면
      //  사람이 화면에서 복사해 붙인 **공백 낀 64자**가 정규화되기도 전에 400 으로 튕긴다.
      const handle = str(input.tokenHash, "tokenHash", 200);
      const resolved = await resolveTokenHandle(handle);
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") {
          throw new HttpError(409, `앞자리 '${handle.trim()}' 에 토큰 ${resolved.matches}개가 걸립니다 — 더 긴 핸들(또는 전체 해시)로 지정하세요`);
        }
        if (resolved.reason === "not-found") throw new HttpError(404, `그런 토큰이 없습니다: ${handle.trim()}`);
        if (resolved.reason === "too-short") throw new HttpError(400, `tokenHash 가 너무 짧습니다 — ${MIN_HANDLE_LEN}자 이상(또는 전체 ${TOKEN_HASH_LEN}자 해시)이어야 합니다`);
        if (resolved.reason === "too-long") throw new HttpError(400, `tokenHash 가 너무 깁니다 — 최대 ${TOKEN_HASH_LEN}자(sha256 hex)입니다`);
        if (resolved.reason === "empty") throw new HttpError(400, "tokenHash 가 필요합니다");
        throw new HttpError(400, "tokenHash 는 16진수 문자열(sha256 hex)이어야 합니다 — 평문 토큰(lvk_…)이 아닙니다");
      }
      const outcome = await revokeToken(resolved.tokenHash, actorOf(user), "web");
      // resolve 와 revoke 사이에 그 행이 사라졌다(경합). 아무것도 안 죽였으니 성공이라 말하지 않는다.
      if (outcome === "not-found") throw new HttpError(404, `그런 토큰이 없습니다: ${handle.trim()}`);
      return { ok: true, tokenHash: resolved.tokenHash, revoked: outcome === "revoked", alreadyRevoked: outcome === "already-revoked" };
    }, {
      tokenHash: z.string().describe("회수할 토큰의 해시 — org_token_mint 응답의 tokenHash 또는 org_tokens 의 token_hash. 앞자리 12자 이상이면 유일할 때만 풀린다(평문 토큰 lvk_… 이 아니다)"),
    }),
];
