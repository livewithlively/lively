// GitHub clone 주소·레포 이름을 다루는 **순수 함수**만 모은 잎 모듈 (#2165).
//
// 왜 따로 있나 — 이 셋은 문자열만 판다(I/O·DB·자격 접근 0). 그런데 종전엔 `github-app-git.ts` 안에 살았고,
//  그 모듈은 설치토큰 발급·앱 서명·멤버 시크릿 금고·OAuth 브로커를 import 한다. 그래서 `project-provision` 이
//  **`githubRepoFullName` 하나**를 쓰는 것만으로 그 뭉치가 통째로 딸려왔고, `project-provision` 은 노드 에이전트
//  번들의 진입 경로에 있어 **자격 코드가 멤버 PC 로 배포되는 번들에 실렸다**(실측 2026-08-27: 이 한 간선이
//  침입 모듈 11개의 근원 — `org/credentials/{github-app,google-oauth,notion-oauth,slack-oauth,oauth-broker,
//  member-secret-store,…}`). 노드 에이전트의 'DB 없음' 계약을 지키려면 **가벼운 것은 가벼운 곳에 살아야 한다.**
//
// ⚠ 여기엔 import 를 넣지 마라. 하나라도 들어오면 이 파일이 다시 그 무게를 옮기는 통로가 된다.
//  (`scripts/node-agent-bundle-boundary.test.mjs` 가 이 모듈의 import 0 을 못박는다.)
/** 이 호스트가 GitHub App 경로를 탈 수 있는가 — GHES(자체호스팅)는 앱이 다르므로 여기서 다루지 않는다. */
export function isGithubAppHost(host: string): boolean {
  return String(host ?? "").toLowerCase() === "github.com";
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