// clone URL 순수 헬퍼 — DB·git 무접촉. (구 queries.ts 해체(#1313 R5)로 이 파일로 이동 — 원문 무변형.)

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
