// 레포 발견(#825) — 저장된 토큰으로 호스트가 가진 레포 목록을 조회해 관리탭 '레포 추가' 픽커에 준다.
//  커넥터 스코프 발견(#586, connectors/discover.ts)의 git 판이다: 같은 문제(식별자 복붙 — 어렵고 실수 잦음),
//  같은 해법(드롭다운), 같은 폴백(토큰 없거나 미지원 호스트면 빈 목록 + note → 폼은 텍스트 입력으로 그대로 동작).
//  드롭다운은 '제안' 이지 '제약' 이 아니다 — 목록에 없는 레포도 손으로 입력해 등록할 수 있어야 한다.
//
//  ⚠ 전송 자격 ≠ 조회 토큰. git_credential.kind='ssh' 면 REST API 인증이 불가능하다 — SSH 키를 받는 API 가
//   없고(GitHub·GitLab 모두 PAT/OAuth 만), deploy key 는 레포 1개 스코프라 '목록' 개념 자체가 성립하지 않는다.
//   그래서 조회 토큰을 두 곳에서 찾는다:
//    ① member_secret(kind=gitlab_pat|github_pat, scope_key=host) — API 전용 토큰. git 전송이 SSH 인 조직용.
//    ② git_credential(kind='https') 의 토큰 재사용 — 전송·조회를 한 토큰으로. GitLab·GitHub PAT 은 git-over-https
//       와 REST API 에 같은 토큰이 쓰인다(예: read_api + read_repository 를 함께 받은 봇 PAT).
//   둘 다 없으면(=SSH 뿐이면) 그 호스트는 빈 목록 + note. 이때도 폼은 텍스트 입력으로 계속 동작한다.
//
//  provider 판정은 호스트로 한다 — github.com → GitHub REST, 그 외 → GitLab REST(self-managed 도 문법 동일).
import { resolveMemberSecret, listMemberSecretsPublic } from "./credentials/member-secret-store.js";
import {
  GATEWAY_OWNER, memberOwner, listGitCredentialsPublic, resolveGitSecret, normalizeHost,
} from "./credentials/git-credential-store.js";

// 픽커 옵션 1건. name 은 '레포 이름' 프리필값 — repo 이름은 workspace/repos/<name> 경로 컴포넌트라
//  슬래시가 금지된다(REPO_NAME_RE, project-provision.ts). 그래서 GitLab 서브그룹 경로(group/sub/repo)는
//  name 에 못 담고 리프(repo)만 담는다 → 다른 서브그룹의 동명 레포와 충돌할 수 있으므로 UI 는 full_path 를
//  라벨로 보여주고 name 은 편집 가능하게 남긴다(충돌 시 사람이 구분자를 붙일 수 있게).
export interface RepoOption {
  host: string;
  name: string;
  full_path: string;
  clone_url: string | null;   // 이 호스트의 git 전송 자격에 맞는 주소 — 폼에 채울 값(아래 preferUrl).
  http_url: string | null;
  ssh_url: string | null;
  default_branch: string | null;
  private: boolean;
}
export interface RepoDiscoverResult { options: RepoOption[]; hosts: string[]; note?: string }

// 폼에 채울 clone 주소 — git 전송 자격이 SSH 면 SSH 주소를 쓴다. '목록은 API 토큰으로 조회하고 클론은 SSH 로'
//  하는 조합(HTTPS 가 막힌 셀프호스팅 GitLab 등)이 실제로 있어서, 조회 성공 = HTTPS 클론 가능 이 아니다.
//  자격이 없으면(앰비언트) HTTPS 를 기본으로 둔다.
export function preferUrl(o: { http_url: string | null; ssh_url: string | null }, transport: "ssh" | "https" | null): string | null {
  return transport === "ssh" ? (o.ssh_url ?? o.http_url) : (o.http_url ?? o.ssh_url);
}

const PAGE_SIZE = 100;
const MAX_PAGES = 3;          // 픽커 용도 상한 300건(선례 #586 과 동일). 잘리면 note 로 표면화 — 조용한 절단 금지.
const API_TIMEOUT_MS = 15_000;

async function apiJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 160);
    throw new Error(`${res.status}${body ? " " + body : ""}`);
  }
  return res.json();
}

// API 전용 토큰 해소 — ⚠ 두 스토어의 키 정규화가 다르다: git_credential.host 는 소문자 강제(normalizeHost)인데
//  member_secret.scope_key 는 대소문자를 보존한다(normalizeScopeKey 는 trim 만). 그래서 사람이 자격을 등록할 때
//  호스트를 'GitHub.com' 처럼 넣으면, 소문자 host 로 찾는 조회가 조용히 빗나가 "토큰 없음" 으로 빈 드롭다운이 뜬다
//  (호스트명은 DNS 상 대소문자 무시 — 사람이 틀린 게 아니다). 정확히 일치하는 키를 먼저 보고, 없으면 저장된
//  scope_key 중 소문자화가 일치하는 것을 찾아 그 원본 키로 해소한다.
//  allowFallback:true = 게이트웨이(조직 머신계정) 자격 폴백 허용 — member-secret-store 규약상 '비-PII read' 만
//  허용되는데, 레포 목록 조회가 정확히 그 경우다(PII 없음·읽기 전용).
async function apiToken(memberId: string | null | undefined, kind: string, host: string): Promise<string | null> {
  const direct = await resolveMemberSecret(memberId, kind, { scopeKey: host, allowFallback: true }).catch(() => null);
  if (direct?.secret) return direct.secret;
  for (const owner of ownersOf(memberId)) {
    const rows = await listMemberSecretsPublic(owner).catch(() => []);
    const hit = rows.find((r) => r.kind === kind && r.has_secret && r.scope_key !== host && r.scope_key.toLowerCase() === host);
    if (!hit) continue;
    const s = await resolveMemberSecret(memberId, kind, { scopeKey: hit.scope_key, allowFallback: true }).catch(() => null);
    if (s?.secret) return s.secret;
  }
  return null;
}

// 호스트 1개의 인증 상태 — 조회 토큰 + git 전송 방식(clone 주소를 SSH/HTTPS 중 뭘로 채울지 결정).
//  조회 토큰: API 전용 토큰(member → gateway 폴백) 우선, 없으면 git 전송 자격의 HTTPS 토큰 재사용.
async function hostAuth(
  memberId: string | null | undefined, host: string,
): Promise<{ token: string | null; transport: "ssh" | "https" | null }> {
  const git = await resolveGitSecret(memberId, host).catch(() => null);
  const apiKind = host === "github.com" ? "github_pat" : "gitlab_pat";
  const token = (await apiToken(memberId, apiKind, host)) || (git?.kind === "https" ? git.https_token : null) || null;
  return { token, transport: git?.kind ?? null };
}

// clone_url 은 호스트의 전송 방식을 알아야 정해지므로(preferUrl), 어댑터는 그 전 단계까지만 만든다.
type RawOption = Omit<RepoOption, "clone_url">;

// ── GitHub — GET /user/repos. 토큰이 볼 수 있는 레포(본인·협업자·조직원). GHE(self-hosted)는 /api/v3. ──
export async function listGithub(host: string, token: string): Promise<{ options: RawOption[]; truncated: boolean }> {
  const base = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const options: RawOption[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await apiJson(
      `${base}/user/repos?per_page=${PAGE_SIZE}&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`,
      headers,
    ) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const name = typeof r.name === "string" ? r.name : "";
      if (!name) continue;
      options.push({
        host,
        name,
        full_path: typeof r.full_name === "string" ? r.full_name : name,
        http_url: typeof r.clone_url === "string" ? r.clone_url : null,
        ssh_url: typeof r.ssh_url === "string" ? r.ssh_url : null,
        default_branch: typeof r.default_branch === "string" ? r.default_branch : null,
        private: r.private === true,
      });
    }
    if (rows.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { options, truncated };
}

// ── GitLab — GET /api/v4/projects. self-managed 도 문법 동일(호스트만 다름). ──
//  min_access_level=20(Reporter) 으로 조회한다 — membership=true 는 '멤버십' 기준이라 그룹으로 상속된 접근
//  (예: 그룹 Reporter 로 붙은 봇 계정)을 놓칠 수 있는 반면, min_access_level 은 상속을 포함한 '실효 접근권'
//  기준이다. 20=Reporter 는 GitLab 에서 코드 read/clone 이 가능한 최소 레벨이라, 목록 = 클론 가능한 것 이 된다.
export async function listGitlab(host: string, token: string): Promise<{ options: RawOption[]; truncated: boolean }> {
  const headers = { "PRIVATE-TOKEN": token };
  const options: RawOption[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await apiJson(
      `https://${host}/api/v4/projects?min_access_level=20&simple=true&order_by=path&sort=asc&per_page=${PAGE_SIZE}&page=${page}`,
      headers,
    ) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const full = typeof r.path_with_namespace === "string" ? r.path_with_namespace : "";
      // simple=true 응답에 path 가 있지만, 없더라도 full 의 리프로 복구(방어적 — 응답 형태 변화에 안 깨지게).
      const name = (typeof r.path === "string" && r.path) || full.split("/").pop() || "";
      if (!name) continue;
      options.push({
        host,
        name,
        full_path: full || name,
        http_url: typeof r.http_url_to_repo === "string" ? r.http_url_to_repo
          : (full ? `https://${host}/${full}.git` : null),
        ssh_url: typeof r.ssh_url_to_repo === "string" ? r.ssh_url_to_repo : null,
        default_branch: typeof r.default_branch === "string" ? r.default_branch : null,
        private: r.visibility !== "public",
      });
    }
    if (rows.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { options, truncated };
}

// 후보 호스트 = git 전송 자격(git_credential) ∪ 조회 토큰(member_secret 의 gitlab_pat·github_pat) 의 호스트.
//  둘 다 봐야 한다 — 전송 자격만 보면 'git 은 앰비언트로 클론되고 API 토큰만 등록한' 조직이 드롭다운을 영영 못 보고,
//  조회 토큰만 보면 'HTTPS git 자격 하나로 전송·조회를 다 하는' 조직(고객사 A wiki-bot PAT)을 놓친다.
//  member_secret 의 scope_key 가 호스트다(''=미지정이면 github_pat 만 github.com 으로 해석 — gitlab 은 추론 불가).
const API_KINDS = new Set(["gitlab_pat", "github_pat"]);
const ownersOf = (memberId: string | null | undefined): string[] =>
  (memberId ? [memberOwner(memberId), GATEWAY_OWNER] : [GATEWAY_OWNER]);

async function candidateHosts(memberId: string | null | undefined): Promise<string[]> {
  const owners = ownersOf(memberId);
  const [gitCreds, apiCreds] = await Promise.all([
    Promise.all(owners.map((o) => listGitCredentialsPublic(o).catch(() => []))),
    Promise.all(owners.map((o) => listMemberSecretsPublic(o).catch(() => []))),
  ]);
  const hosts = new Set<string>();
  for (const c of gitCreds.flat()) hosts.add(c.host);            // 이미 소문자(normalizeHost)
  for (const s of apiCreds.flat()) {
    if (!API_KINDS.has(s.kind) || !s.has_secret) continue;
    // scope_key 는 대소문자가 보존되므로 여기서 소문자로 정규화 — 호스트 후보를 한 표기로 모은다
    //  (안 하면 'GitHub.com' 과 'github.com' 이 서로 다른 호스트로 잡혀 같은 레포가 두 번 뜬다).
    const h = (s.scope_key || (s.kind === "github_pat" ? "github.com" : "")).toLowerCase();
    if (h) hosts.add(h);
  }
  return [...hosts].sort();
}

export async function discoverRepos(
  memberId: string | null | undefined, hostFilter?: string | null,
): Promise<RepoDiscoverResult> {
  const hosts = await candidateHosts(memberId);
  const targets = hostFilter ? [normalizeHost(hostFilter)] : hosts;
  if (targets.length === 0) {
    return {
      options: [], hosts,
      note: "등록된 git 자격이 없습니다 — [게이트웨이 git 계정] 또는 [내 프로필 ▸ git 인증]에 자격을 먼저 등록하세요. 그 전에도 git 주소를 직접 입력해 등록할 수 있습니다.",
    };
  }

  const options: RepoOption[] = [];
  const notes: string[] = [];
  // 호스트 단위 부분 실패 허용(선례 #586 clickup 과 동일) — 한 호스트가 죽어도 나머지는 나온다.
  for (const host of targets) {
    const { token, transport } = await hostAuth(memberId, host).catch(() => ({ token: null, transport: null }));
    if (!token) {
      const what = host === "github.com" ? "GitHub" : "GitLab";
      notes.push(`${host}: 목록 조회에 API 토큰이 필요합니다 — SSH 키로는 레포 목록 API 인증이 불가능합니다(SSH 키를 받는 REST API 가 없습니다). git 전송용 SSH 는 그대로 두고 [자격]에 ${what} 읽기 토큰(${host === "github.com" ? "Metadata read" : "read_api"})만 추가하면 목록이 뜹니다. 지금도 git 주소를 직접 입력하면 등록됩니다.`);
      continue;
    }
    try {
      const r = host === "github.com" || host.endsWith(".github.com")
        ? await listGithub(host, token)
        : await listGitlab(host, token);
      options.push(...r.options.map((o) => ({ ...o, clone_url: preferUrl(o, transport) })));
      if (r.truncated) notes.push(`${host}: 목록이 ${MAX_PAGES * PAGE_SIZE}건에서 잘렸습니다 — 안 보이면 git 주소를 직접 입력하세요.`);
      if (r.options.length === 0) notes.push(`${host}: 토큰이 볼 수 있는 레포가 없습니다 — 토큰 권한(GitLab: read_api / GitHub: repo·Metadata)과 그룹 접근 레벨(GitLab 은 Reporter 이상)을 확인하세요.`);
    } catch (e) {
      // 토큰·URL 은 절대 싣지 않는다 — 상태코드/본문 앞부분만(apiJson 이 이미 잘라둠).
      notes.push(`${host}: 조회 실패 — ${(e as Error).message}`);
    }
  }
  options.sort((a, b) => a.host.localeCompare(b.host) || a.full_path.localeCompare(b.full_path));
  return { options, hosts, note: notes.length ? notes.join("\n") : undefined };
}
