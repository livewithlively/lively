// 본인 금고 칸의 **순수 판정** — 무엇을 어느 칸에 넣을 수 있는가(값은 여기 오지 않는다).
//
//  왜 떼어냈나: 본인 금고에 넣는 입구가 둘이다(me_credential_set · 리브 안전 입력칸). 규칙이 두 곳에 따로 있으면
//   한쪽만 고쳐지고, 관리자 전용 kind 같은 권한 경계가 다른 입구로 새어 나간다. 두 입구가 이 함수 하나를 부른다.
//   금고 저장소(member-secret-store.ts)의 형식 정규화도 같은 정규식을 쓴다.

export const KIND_RE = /^[a-z0-9_]{1,40}$/;
export const SCOPE_RE = /^[A-Za-z0-9._:-]{0,120}$/;

/**
 * 구성원이 **본인 칸**에 둘 수 없는 kind — 관리자가 통합/구성원 자격(org_credential_set)으로만 넣는다.
 *  aws_role_arn: 게이트웨이 공용 신원이 가정할 role 을 멤버가 지정하면 confused-deputy/권한상승이다.
 */
export const ADMIN_ONLY_KINDS: ReadonlySet<string> = new Set(["aws_role_arn"]);

/** 호스트 kind 한 줄 — 빈 scope 가 뜻이 있나(기본 칸) · 사람이 그 칸을 직접 등록하는 화면. */
export interface HostScopedKind { emptyOk: boolean; connect: string }

/**
 * scope_key 가 그 자격이 실려 나가는 **접속 호스트**인 kind — 칸을 고르는 쪽이 값이 갈 곳을 고른다.
 *  gitlab_pat       : GitLab 수집기의 접속 호스트가 그 칸의 scope_key 다(member-collect-apps.ts gitlab extraConfig ·
 *                     gitlab-token-source.ts resolveGitlabTokenSource). 레포 목록 조회도 scope_key 를 호스트로 모아 그 호스트로
 *                     토큰을 싣는다(repo-discover.ts candidateHosts → listGitlab). 빈 scope 는 기본 칸이다(gitlab.com).
 *  lively_workspace : 연결한 워크스페이스 주소가 meta.base_url 이 없으면 https://<scope_key> 다(linked-workspaces.ts metaToLink —
 *                     remoteCall 이 그 주소로 토큰을 싣는다). 빈 scope 는 주소 없는 연결이라 뜻이 없다.
 *  github_pat 은 아니다 — 토큰이 가는 곳은 수집기 설정의 host 와 github.com 뿐이고(connectors/config.ts · repo-discover.ts hostAuth),
 *   scope_key 는 칸 고르기에만 쓰인다(github-token-source.ts pickGithubSlot).
 *  ⚠ scope_key 로 접속하는 소비처가 새로 생기면 여기에 더한다 — 빠지면 리브 안전 입력칸이 AI 가 고른 호스트로 사람의 토큰을 보낸다.
 */
export const HOST_SCOPED_KINDS: ReadonlyMap<string, HostScopedKind> = new Map([
  ["gitlab_pat", { emptyOk: true, connect: "[외부 앱 연결 ▸ GitLab]" }],
  ["lively_workspace", { emptyOk: false, connect: "[팀 워크스페이스 연결]" }],
]);

export type SelfCredentialVerdict =
  | { ok: true; kind: string; scope_key: string }
  | { ok: false; reason: "no-kind" | "bad-kind" | "bad-scope" | "admin-only" };

/**
 * 본인 금고의 이 칸(kind·scope_key)에 넣어도 되는가. 통과하면 저장소가 쓸 모양(kind 소문자·trim, scope trim)을 돌려준다.
 *  ⚠ 관리자 전용 판정은 **정규화한 kind** 로 한다 — 원문으로 비교하면 앞뒤 공백 하나로 빠져나가고, 저장소는 trim 해서 그 칸에 넣는다.
 */
export function selfCredentialTargetVerdict(kindRaw: unknown, scopeRaw: unknown): SelfCredentialVerdict {
  const kind = String(kindRaw ?? "").trim().toLowerCase();
  if (!kind) return { ok: false, reason: "no-kind" };
  if (!KIND_RE.test(kind)) return { ok: false, reason: "bad-kind" };
  const scope = String(scopeRaw ?? "").trim();
  if (!SCOPE_RE.test(scope)) return { ok: false, reason: "bad-scope" };
  if (ADMIN_ONLY_KINDS.has(kind)) return { ok: false, reason: "admin-only" };
  return { ok: true, kind, scope_key: scope };
}
