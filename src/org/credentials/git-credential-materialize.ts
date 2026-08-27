// git 자격 materialize(#540, Slice 2) — DB에 저장된 멤버 git 자격을 그 멤버의 격리 홈(box_<slug>, 700)에 뿌려
//  세션 안 shell/Claude 의 git 이 **그 멤버 자격으로** 되게 한다(provision 클론은 게이트웨이가 주입, 여기는 세션-내부용).
//  게이트웨이(lively)는 멤버 700 홈에 직접 못 쓰므로 memberSh(멤버 uid, 시크릿은 stdin)로 쓴다. Linux 격리 전용.
//  호출: createSession 격리 분기에서 best-effort(실패해도 세션 생성 안 막음). 멱등(매 세션 최신 DB 상태로 재생성).
import { memberSh } from "../../terminal/terminal-member-fs.js";

// 파일명 컴포넌트로 안전화(호스트는 이미 검증되지만 방어적: 영숫자만 남김 → 셸 인젝션·경로 표면 제거). (export=테스트용)
export const safeHost = (h: string): string => String(h).toLowerCase().replace(/[^a-z0-9]+/g, "_");
const encFor = (s: string): string => encodeURIComponent(s);          // git-credentials URL 컴포넌트 인코딩

// ~/.ssh/config 의 lively-managed 블록(마커 구분). 호스트별 IdentityFile·IdentitiesOnly. (export=테스트용·순수)
export function buildSshConfigBlock(hosts: string[]): string {
  return [
    "", "# >>> lively-managed git (#540) >>>",
    ...hosts.flatMap((h) => [
      `Host ${h}`,
      `  IdentityFile ~/.ssh/id_lively_${safeHost(h)}`,
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking accept-new",
    ]),
    "# <<< lively-managed git <<<", "",
  ].join("\n");
}

// ~/.lively/git-credentials 라인들 — https://<user>:<token>@<host>. user/token URL 인코딩(특수문자로 URL 안 깨지게). (export=테스트용·순수)
export function buildGitCredLines(https: Array<{ host: string; https_username: string | null; https_token: string }>): string {
  return https.map((s) => `https://${encFor(s.https_username || "x-access-token")}:${encFor(s.https_token)}@${s.host}`).join("\n");
}

// 격리 세션 dubious-ownership 해소(#522) — 게이트웨이(lively)가 클론한 공유 레포를 멤버(box_<slug>, 다른 uid)의 git 이
//  CVE-2022-24765(소유 uid ≠ 실행 uid) 로 거부하는 것을, 멤버 전역 gitconfig 의 safe.directory 로 연다. best-effort·멱등.
//  자격 유무와 무관하게 매 격리 세션에서 보장(materialize 와 별개 — 자격 없는 멤버도 게이트웨이-소유 공유 레포 git 을 쓴다).
//  · 값 = 블랭킷 '*'. 처음엔 스코프 'PROJECT_SHARED_BASE/*'(디렉터리 접두사)를 썼으나 **고객사 A 실박스 git 2.34.1 이 '/*'
//    접두사 글롭을 미지원**(그 기능은 후대 git) → 무효였다(2026-07-06 실측). '*' 는 git 2.35.2+(배포판 백포트 포함) 전부 지원 → 버전-견고.
//  · 보안: 멤버 자기 홈 gitconfig 에만 쓰이고 owner-uid 가드만 완화한다. #524 의 실제 경계(크레덴셜 격리 = 홈700·uid)와 무관하고,
//    planted-repo 공격면은 group-writable 공유 dir 이라 스코프 '/*' 였어도 못 막았으므로 '*' 로의 delta 는 미미.
//  · '*' 는 큰따옴표로 감싸 셸 글롭 확장 방지(git 이 리터럴 '*' 수신). Linux 격리 전용(memberSh).
export async function ensureGitSafeDirectory(osUser: string): Promise<void> {
  await memberSh(
    osUser,
    'git config --global --get-all safe.directory 2>/dev/null | grep -qxF "*" || git config --global --add safe.directory "*"',
  );
}
