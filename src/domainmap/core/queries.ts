// v6 드랍(2026-06-24): 구 domain-리더(overview/listRepos/listDomainsApi/listAllDomains/domainDetail/queue/
//  listDebts/listCodeApi/listEntitiesApi) 전부 제거 — domain 테이블 폐기·읽기 소비자는 v6 category 리더
//  (v6/domainmap-store.ts)로 cutover 완료. 골든리드 byte-compat 핀의 목적(구 #/domainmap 탭)도 함께 소멸.
//  남는 건 domain 무관 **순수 헬퍼 2종** — domainmap-store(v6 리더)가 재사용한다(DB·git 무접촉).

// git_url(자격증명 토큰이 박혀 있을 수 있음 — core/schema.ts 경고)에서 userinfo 를 벗긴 안전한 clone 주소.
//  파싱 불가 시 null(fail-closed — 시크릿 누출 금지). scp-식 ssh(git@host:path)는 시크릿 없음 → 그대로 통과.
export function sanitizeCloneUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (!s.includes("://") && /^[\w.-]+@[\w.-]+:/.test(s)) return s; // scp-식 ssh — 임베드 시크릿 없음
  try {
    const u = new URL(s);
    u.password = "";
    // ssh:// 계열의 username(예: git@)은 시크릿이 아니라 SSH 로그인 유저 → 보존한다(벗기면 로컬 유저로 접속해 인증 실패).
    //  http(s)·기타 스킴의 username 은 자격(PAT username 등)일 수 있어 계속 제거(fail-closed 유지).
    if (u.protocol !== "ssh:" && u.protocol !== "git+ssh:") u.username = "";
    return u.toString();
  } catch {
    return null; // 파싱 불가 → 노출 금지(잠재 시크릿 보유 문자열일 수 있음)
  }
}

// 구조층(detected_stack/code_unit/mapping)이 '낡았을 수 있음'을 소비자(인덱스·웹·에이전트)에게
// 알리는 freshness 신호. PURE·DB-무접촉·git-무접촉 — 이미 로드된 repo 행 메타(last_refreshed_sha/
//  last_scan_at)와 active code_unit 수만으로 판정. (never_refreshed=증분 미실행, empty=미스캔.)
export function computeFreshness(repoRow: any, activeCodeUnits: number): {
  stale: boolean; reason: string; last_refreshed_sha: string | null; last_scan_at: unknown;
} {
  const sha = repoRow.last_refreshed_sha ?? null;
  let reason: string;
  let stale: boolean;
  if (activeCodeUnits === 0) { reason = "empty"; stale = false; }
  else if (sha == null) { reason = "never_refreshed"; stale = true; }
  else { reason = "checkpoint"; stale = false; }
  return { stale, reason, last_refreshed_sha: sha, last_scan_at: repoRow.last_scan_at ?? null };
}
