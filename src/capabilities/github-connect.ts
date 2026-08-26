// GitHub 연결 창구(#1881 G5) — [GitHub 연결] 버튼이 부르는 자리.
//
//  왜 별도 파일인가: GitHub 은 `org_mcp_server` 행이 없다(도구 면을 REST 로 내렸다 — G4). 그래서 MCP 서버 목록에서
//  [연결]을 누르는 일반 경로를 못 탄다. 노션 공개 통합이 먼저 같은 처지였고(notion-connect.ts) 같은 모양으로 둔다.
//
//  이 파일은 **창구만** 연다 — 인가 URL 을 만들고 상태를 답한다. 교환·저장은 브로커(oauth-broker)의 일이고,
//  installation token 을 찍는 것은 쓰기 직전의 일이다(github-app.ts). 경계를 섞지 않는다.
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { githubAppReady, startGithubAppConsent, saveGithubAppCredentials } from "../org/credentials/oauth-broker.js";
import { listSecretsByKindPublic } from "../org/credentials/member-secret-store.js";
import { GITHUB_INSTALL_KIND } from "../org/credentials/github-app.js";
import { GATEWAY_OWNER, memberOwner } from "../org/credentials/git-credential-store.js";

/** 이 조직·이 사람의 GitHub 연결 상태 — 화면이 [연결]을 그릴지 [연결됨]을 그릴지 정하는 값. */
async function githubConnectState(memberId: string): Promise<Record<string, unknown>> {
  const ready = await githubAppReady();
  //  ⚠ kind 로 묻는 함수는 listSecretsByKindPublic 이다. listMemberSecretsPublic 은 **owner** 를 받는데
  //   둘 다 string 이라 컴파일러가 잡아 주지 않는다 — 처음엔 kind 를 owner 자리에 넣어서 connected·installations 가
  //   **항상 비어** 있었다(실호출로만 드러났다: app_ready=true 인데 connected=false 가 영원히 유지된다).
  const [pats, installsAll] = await Promise.all([
    listSecretsByKindPublic("github_pat"),
    listSecretsByKindPublic(GITHUB_INSTALL_KIND),
  ]);
  const mine = pats.find((s) => s.owner === memberOwner(memberId));
  const installs = installsAll.filter((s) => s.owner === GATEWAY_OWNER);
  return {
    //  관리자가 앱 자격을 넣어 뒀는가 — 이게 false 면 구성원이 [연결]을 눌러도 시작조차 못 한다.
    //  ⚠ client 묶음 행(scope_key=oauth:client)은 HIDDEN_SCOPE_KEYS 라 목록 조회에 **일부러** 안 보인다.
    //   그래서 "행이 있나"로는 판정할 수 없고, 실제로 읽어 보는 githubAppReady() 가 유일한 진실이다.
    app_ready: ready,
    connected: !!mine?.has_secret,
    // 붙여넣기 PAT 인지 OAuth 연결인지 — 같은 슬롯을 쓰므로 meta 로만 구분된다(둘 다 도구는 정상 동작).
    connected_via: mine?.has_secret ? (mine.meta && Object.keys(mine.meta).some((k) => k === "expires_at" || k === "token_type") ? "oauth" : "token") : null,
    installations: installs.map((s) => ({ installation_id: s.scope_key, connected_by: (s.meta as Record<string, unknown> | undefined)?.connected_by ?? null })),
  };
}

const orgGithubConnectStatus: Capability = {
  name: "org_github_connect_status", title: "GitHub 연결 상태",
  description:
    "이 조직에 라이블리 GitHub App 자격이 등록됐는지(app_ready)와 내 계정이 연결됐는지(connected), 설치된 곳 목록을 돌려준다. " +
    "connected_via 는 'oauth'(연결 버튼) 또는 'token'(PAT 붙여넣기) — 둘 다 도구는 같은 슬롯을 쓰므로 정상 동작한다. " +
    "app_ready 가 false 면 관리자가 앱 자격을 먼저 넣어야 한다(kind github_app, scope_key oauth:client).",
  scope: "items", input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/github/connect"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    return githubConnectState(user.userId);
  },
};

const orgGithubConnect: Capability = {
  name: "org_github_connect", title: "GitHub 연결 시작",
  description:
    "GitHub App 설치·인가를 시작한다 — 반환된 authorization_url 의 GitHub 화면에서 **어느 저장소를 줄지 고르고** [허용]하면 " +
    "① 내 계정 토큰(이슈·PR 도구가 쓴다) ② 설치 정보(그 저장소들을 clone 할 수 있는 근거)가 함께 저장된다. " +
    "그 선택 화면이 곧 접근 범위 선언이라 따로 권한을 고를 필요가 없다. 이미 설치한 사람은 GitHub 이 인가 단계로 바로 넘긴다.",
  scope: "items", input: {},
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/github/connect"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    try {
      const c = await startGithubAppConsent(user.userId);
      return {
        ok: true, authorization_url: c.authorizationUrl,
        message: "이 URL 의 GitHub 화면에서 연결할 저장소를 고르고 허용하세요 — 완료되면 자동으로 저장됩니다.",
      };
    } catch (err) {
      // 앱 미등록은 사용자 잘못이 아니다 — 관리자가 할 일을 그대로 말해 준다(막다른 에러로 두지 않는다).
      throw new HttpError(409, (err as Error).message);
    }
  },
};

const orgGithubAppRegister: Capability = {
  name: "org_github_app_register", title: "라이블리 GitHub App 자격 등록(관리자)",
  description:
    "GitHub App 의 Client ID/Secret(+App ID·slug)을 조직 금고에 넣는다. 이걸 넣어야 구성원이 [GitHub 연결]을 쓸 수 있다. " +
    "private_key(PEM)는 installation token(=clone 자격)을 찍는 데 쓰이며 별도 행(scope_key=app:key)에 들어간다 — " +
    "매니지드는 이 키를 테넌트에 두지 않고 컨트롤플레인이 대신 찍는다. " +
    "⚠ 값은 저장 후 다시 볼 수 없다(등록 여부만 보인다).",
  scope: "admin",
  input: {
    client_id: z.string().describe("GitHub App 의 Client ID(Iv1.… 또는 Iv23…)"),
    client_secret: z.string().describe("GitHub App 의 Client secret — 생성 직후 한 번만 보인다"),
    app_id: z.string().optional().describe("App ID(숫자) — installation token 을 찍을 때 필요"),
    app_slug: z.string().optional().describe("앱 URL 의 slug(github.com/apps/<slug>) — 설치 화면으로 보낼 때 쓴다"),
    private_key: z.string().optional().describe("Private key PEM 전문(-----BEGIN … -----END) — clone 자격 발급용"),
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/github/app"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const clientId = str(i.client_id), clientSecret = str(i.client_secret);
    if (!clientId || !clientSecret) throw new HttpError(400, "client_id 와 client_secret 은 필수입니다");
    const pem = str(i.private_key);
    if (pem && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
      // 파일 경로나 잘린 값을 넣는 실수가 흔하다 — 저장은 되고 발급만 실패하면 원인을 찾기 어렵다.
      throw new HttpError(400, "private_key 는 PEM 전문이어야 합니다(-----BEGIN … PRIVATE KEY----- 로 시작).");
    }
    await saveGithubAppCredentials({
      clientId, clientSecret, appId: str(i.app_id) || null, appSlug: str(i.app_slug) || null,
      privateKeyPem: pem || null, actor: user.userId,
    });
    return { ok: true, client_registered: true, private_key_registered: !!pem, app_slug: str(i.app_slug) || null };
  },
};

export const githubConnectCapabilities: Capability[] = [orgGithubConnectStatus, orgGithubConnect, orgGithubAppRegister];
