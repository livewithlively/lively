// GitHub App 설치 → clone 자격 (#1881 G8)
//
//  이 조각이 없으면 [GitHub 연결]은 반쪽이다. 연결은 되는데(도구는 돌고 레포 목록도 나온다) 정작 **clone 이
//  안 된다** — clone 은 git_credential(SSH 키 또는 HTTPS 토큰)을 보는데 연결자에겐 그게 없기 때문이다.
//  그래서 사용자는 "연결했는데 왜 코드를 못 가져오지?" 를 만나고, 결국 PAT 을 발급하거나 SSH 키를 등록하게 된다.
//  없애려던 두 벽이 그대로 돌아온다.
//
//  해법은 **저장이 아니라 발급**이다. installation access token 은 1시간짜리라 금고에 넣으면 한 시간 뒤 전부
//  죽는다(그래서 G5 는 저장하지 않았다). 대신 clone 직전에 App JWT 로 찍어서 그 자리에서 쓴다 —
//  resolveGitSecret 이 그 값을 돌려주면 호출부(project-provision·repo-refresh·domainmap)는 한 글자도 안 바뀐다.
//
//  ⚠ 이 토큰은 **선택한 레포에만** 통한다. 설치 화면에서 고르지 않은 레포는 같은 토큰으로도 404 다 —
//   그게 "레포 선택기가 곧 접근 범위 선언" 의 실제 작동이고, 우리가 원한 성질이다.
import { logger } from "../../log.js";
import { listSecretsByKindPublic } from "./member-secret-store.js";
import { loadGithubAppSigner } from "./oauth-broker.js";
import { GITHUB_INSTALL_KIND, mintInstallationToken } from "./github-app.js";
import { gatewaySsrfFetch } from "./oauth-broker.js";

/** clone 자격의 모양 — git-credential-store 의 GitCredentialSecret 과 같은 형태(그쪽이 이 값을 그대로 쓴다). */
export interface AppGitSecret {
  owner: string; host: string; kind: "https";
  ssh_public_key: null; ssh_private_key: null;
  https_username: string; https_token: string;
}

/** 이 호스트가 GitHub App 경로를 탈 수 있는가 — GHES(자체호스팅)는 앱이 다르므로 여기서 다루지 않는다. */
export function isGithubAppHost(host: string): boolean {
  return String(host ?? "").toLowerCase() === "github.com";
}

/**
 * 지금 조직에 등록된 설치 id 목록(최근 순).
 *  보통 하나지만, 개인 계정과 조직에 각각 설치하면 둘이 된다 — 그때는 레포가 어느 설치에 속하는지 모르므로
 *  차례로 시도한다(아래 githubAppGitSecret).
 */
export async function listInstallationIds(): Promise<string[]> {
  const rows = await listSecretsByKindPublic(GITHUB_INSTALL_KIND).catch(() => []);
  return rows
    .filter((r) => r.has_secret && /^\d+$/.test(r.scope_key))
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .map((r) => r.scope_key);
}

/**
 * clone 주소 → `owner/repo`. 토큰을 그 레포로 좁히는 데 쓴다(못 뽑으면 null — 설치 전체 토큰으로 떨어진다).
 *  https·ssh 두 형식을 받는다. github.com 이 아니면 null(이 경로는 github.com 전용).
 */
export function githubRepoFullName(gitUrl: string | null | undefined): string | null {
  const raw = String(gitUrl ?? "").trim();
  if (!raw) return null;
  let host = "", path = "";
  if (/^https?:\/\//i.test(raw)) {
    //  ⚠ URL 파서를 쓴다 — 자격이 박힌 주소(https://user:token@github.com/o/r.git)가 실제로 있고
    //   (sanitizeCloneUrl 이 그걸 걷는다), 정규식으로 host 를 잡으면 'user' 를 호스트로 오인한다.
    try { const u = new URL(raw); host = u.hostname; path = u.pathname; } catch { return null; }
  } else {
    const m = raw.match(/^(?:ssh:\/\/)?(?:[^@]+@)([^:/]+)[:/](.+)$/);
    if (!m) return null;
    host = m[1]; path = m[2];
  }
  if (host.toLowerCase() !== "github.com") return null;
  //  끝 슬래시를 먼저, 그다음 .git — 순서를 바꾸면 `o/r.git/` 에서 .git 이 남는다(#1881 G9 에서 겪은 것과 같은 함정).
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return /^[^/\s]+\/[^/\s]+$/.test(clean) ? clean : null;
}

/**
 * `owner/repo` → 토큰을 좁힐 때 상류에 넘길 이름 배열.
 *  ⚠ GitHub 의 `repositories` 파라미터는 **저장소 이름만** 받는다(`lively-infra`) — full name 을 넣으면
 *   422 로 거부된다(2026-08-26 실호출: 좁히지 않으면 성공, 좁히면 전부 실패했다). 소유자는 installation 이
 *   이미 알고 있으므로 이름만으로 충분하다. 좁힐 수 없으면 undefined → 설치 전체 토큰(동작은 한다).
 */
export function repoScopeNames(repoFullName: string | null | undefined): string[] | undefined {
  const s = String(repoFullName ?? "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(s)) return undefined;
  const name = s.split("/")[1];
  return name ? [name] : undefined;
}

/**
 * GitHub App 설치로 clone 자격을 만든다(없으면 null — 호출자는 종전 경로로 떨어진다).
 *  repoFullName(owner/repo)을 주면 **그 레포로 좁힌 토큰**을 받는다. 좁히면 두 가지가 좋아진다:
 *   ① 최소권한 — clone 하나 때문에 설치 전체 권한을 들고 다니지 않는다.
 *   ② 설치가 여럿일 때 **어느 설치가 그 레포를 갖고 있는지 상류가 판정해 준다**(없으면 422) — 우리가 추측하지 않는다.
 */
export async function githubAppGitSecret(host: string, repoFullName?: string | null): Promise<AppGitSecret | null> {
  if (!isGithubAppHost(host)) return null;
  const signer = await loadGithubAppSigner().catch(() => null);
  if (!signer) return null;   // 매니지드는 private key 가 CP 에만 있다 — 그쪽은 CP 프록시가 찍는다(G7)
  const ids = await listInstallationIds();
  if (!ids.length) return null;

  const repo = String(repoFullName ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const scoped = repoScopeNames(repo);
  const fetchFn = await gatewaySsrfFetch();

  for (const installationId of ids) {
    try {
      const t = await mintInstallationToken({
        appId: signer.appId, privateKeyPem: signer.privateKeyPem, installationId,
        ...(scoped ? { repositories: scoped } : {}), fetchFn,
      });
      return {
        owner: "gateway", host: "github.com", kind: "https",
        ssh_public_key: null, ssh_private_key: null,
        https_username: "x-access-token", https_token: t.token,
      };
    } catch (err) {
      //  설치가 여럿일 때 '이 설치엔 그 레포가 없다'는 정상적인 탈락이다 — 다음 설치를 본다.
      //  전부 실패하면 null 을 돌려주고, 호출자는 자격 없이 시도한다(공개 레포는 그대로 클론된다).
      logger.debug({ installationId, repo: repo || null, err: (err as Error)?.message },
        "github app installation token 발급 실패 — 다음 설치 시도");
    }
  }
  return null;
}
