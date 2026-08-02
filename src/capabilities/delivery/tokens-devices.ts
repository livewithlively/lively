// delivery ▸ tokens-devices — 접속 열쇠(auth_token) 목록·발급·회수 + CLI 디바이스 로그인 승인(#880).
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import { SCOPES_ALLOWED, DANGEROUS_SCOPES, type Scope } from "../scopes.js";
import type { LivelyUser } from "../../context.js";
import { getMember, mintToken, listTokens, revokeToken } from "../../org/store.js";
import { hasCredential, verifyOwnPassword } from "../../auth/local-accounts.js";
import { lookupDeviceAuth, approveDeviceAuth, denyDeviceAuth, checkDeviceRate } from "../../org/auth/device-auth.js";
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
      return { token, tokenHash: tokenHash.slice(0, 12), userId, scopes }; // 평문 token 은 이 응답에서만
    }, {
      userId: z.string().optional().describe("토큰 주인 멤버 id(생략 시 memberId)"),
      memberId: z.string().optional().describe("연결할 멤버 id — 유효권한=intersection(토큰scope, 멤버 LIVE scope)"),
      scopes: z.array(z.string()).optional().describe("토큰 scope(생략 시 멤버 scope): items|context|memory|db|code|admin|runtime"),
      label: z.string().optional().describe("토큰 라벨(용도 메모)"),
    }),

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

export const tokenRevokeCapabilities: Capability[] = [
  restOnly("org_token_revoke", "접속 토큰 해제",
    "토큰을 즉시 무효화한다(게이트웨이 재시작 불요).",
    [{ method: "POST", paths: ["/api/ui/org/token/revoke"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      // 전체 해시를 받는다(목록은 prefix 만 노출하므로 회수는 발급 시 받은 전체 해시 또는 별도 조회 필요).
      const hash = str(input.tokenHash, "tokenHash", 64).trim();
      await revokeToken(hash, actorOf(user), "web");
      return { ok: true };
    }, {
      tokenHash: z.string().describe("회수할 토큰의 **전체 해시** — 목록(org_overview)은 prefix 만 노출하므로 발급 시 받은 전체 해시가 필요하다"),
    }),
];
