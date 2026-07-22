// git 자격 materialize(#540, Slice 2) — DB에 저장된 멤버 git 자격을 그 멤버의 격리 홈(box_<slug>, 700)에 뿌려
//  세션 안 shell/Claude 의 git 이 **그 멤버 자격으로** 되게 한다(provision 클론은 게이트웨이가 주입, 여기는 세션-내부용).
//  게이트웨이(lively)는 멤버 700 홈에 직접 못 쓰므로 memberSh(멤버 uid, 시크릿은 stdin)로 쓴다. Linux 격리 전용.
//  호출: createSession 격리 분기에서 best-effort(실패해도 세션 생성 안 막음). 멱등(매 세션 최신 DB 상태로 재생성).
import { listGitCredentialsPublic, getGitSecret, memberOwner } from "./git-credential-store.js";
import { memberSh } from "../terminal-member-fs.js";

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
//  · 값 = 블랭킷 '*'. 처음엔 스코프 'PROJECT_SHARED_BASE/*'(디렉터리 접두사)를 썼으나 **어니스트 실박스 git 2.34.1 이 '/*'
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

// 멤버의 등록 자격(SSH/HTTPS)을 홈에 반영. 등록 자격이 없으면 기본 no-op(쓰기 안 함).
//  evenIfEmpty(#1077): 자격이 0건이어도 아래 ①③④(우리가 뿌린 것 회수)를 끝까지 돌린다. **회수 경로 전용**이다 —
//   자격 삭제(me_git_credential_delete)는 "홈에 뿌려둔 키도 함께 거둔다"가 계약인데, 마지막 한 건을 지우면
//   pubs 가 비어 early return 에 걸려 홈의 id_lively_* 가 남았다(= 지웠는데 계속 쓸 수 있는 상태). 오프보딩·회수가
//   이 자격 모델의 핵심 명분이라 그 구멍은 그냥 둘 수 없다.
//  세션 시작(createSession) 경로는 기본값 그대로 no-op 을 유지한다 — 자격을 한 번도 등록 안 한 멤버의 홈은
//   건드리지 않는다는 보수성(#524 격리 정신)이 거기선 여전히 옳고, 매 세션 불필요한 memberSh 왕복도 없다.
export async function materializeMemberGit(osUser: string, memberId: string, opts: { evenIfEmpty?: boolean } = {}): Promise<void> {
  const owner = memberOwner(memberId);
  const pubs = await listGitCredentialsPublic(owner);
  if (!pubs.length && !opts.evenIfEmpty) return; // 등록 자격 없음 → 손대지 않음(과쓰기 방지)

  const secrets = (await Promise.all(pubs.map((p) => getGitSecret(owner, p.host)))).filter((s): s is NonNullable<typeof s> => !!s);
  const ssh = secrets.filter((s) => s.kind === "ssh" && s.ssh_private_key);
  const https = secrets.filter((s) => s.kind === "https" && s.https_token);

  // ① 스테일 lively 키 제거(삭제/호스트변경 반영) — 우리가 관리하는 id_lively_* 만.
  await memberSh(osUser, 'rm -f "$HOME"/.ssh/id_lively_* 2>/dev/null || true');

  // ② SSH 개인키·공개키 파일(멤버 uid·600/644) — 시크릿은 stdin.
  for (const s of ssh) {
    const fn = `id_lively_${safeHost(s.host)}`;
    await memberSh(osUser, `umask 077; mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; cat > "$HOME/.ssh/${fn}"; chmod 600 "$HOME/.ssh/${fn}"`, s.ssh_private_key!);
    if (s.ssh_public_key) {
      await memberSh(osUser, `cat > "$HOME/.ssh/${fn}.pub"; chmod 644 "$HOME/.ssh/${fn}.pub"`, s.ssh_public_key);
    }
  }

  // ③ ~/.ssh/config 의 lively-managed 블록(마커 구분 replace — 그 외 사용자 config 보존). Host→IdentityFile·IdentitiesOnly.
  {
    // 기존 블록 제거 후 새 블록 append(GNU sed — Linux 격리 전용). ssh 자격이 하나도 없으면 블록만 비우고 끝.
    await memberSh(
      osUser,
      'umask 077; mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; f="$HOME/.ssh/config"; ' +
      '[ -f "$f" ] && sed -i "/# >>> lively-managed git/,/# <<< lively-managed git/d" "$f"; ' +
      'cat >> "$f"; chmod 600 "$f"',
      ssh.length ? buildSshConfigBlock(ssh.map((s) => s.host)) : "",
    );
  }

  // ④ HTTPS 자격 — ~/.lively/git-credentials(600) + credential.helper=store(그 파일). 시크릿은 stdin.
  //  자격이 없어도 파일을 비워 재생성(스테일 토큰 제거). helper 설정은 무해(빈 파일이면 매칭 없음).
  {
    const lines = buildGitCredLines(https.map((s) => ({ host: s.host, https_username: s.https_username, https_token: s.https_token! })));
    await memberSh(
      osUser,
      'umask 077; mkdir -p "$HOME/.lively"; chmod 700 "$HOME/.lively"; ' +
      'cat > "$HOME/.lively/git-credentials"; chmod 600 "$HOME/.lively/git-credentials"; ' +
      'git config --global credential.helper "store --file=$HOME/.lively/git-credentials"',
      lines,
    );
  }
}
