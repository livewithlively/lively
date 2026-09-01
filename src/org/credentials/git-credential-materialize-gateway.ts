// 멤버 git 자격을 홈에 반영/회수하는 **게이트웨이 전용** 조각 (#2165 에서 분리).
//
// 왜 갈랐나: 이 함수만 DB 를 탄다(`listGitCredentialsPublic`·`getGitSecret`·`memberOwner`). 종전엔 순수/fs 인
//  형제들(`ensureGitSafeDirectory`·`buildSshConfigBlock`…)과 한 모듈에 있었고, `terminal/sessions.ts` 가 그
//  형제를 쓰느라 이 모듈을 import 하면서 **자격 금고·GitHub App·OAuth 브로커가 노드 에이전트 번들에 실렸다.**
//  노드엔 DB 가 없어 이 함수는 애초에 실패하고 호출부가 `.catch` 로 넘어갔다 — 즉 **노드에선 죽은 코드인데
//  무게만 실어 나르고 있었다.**
//
// 세션 시작 경로는 이제 이걸 직접 부르지 않고 `sessions/gateway-capabilities.ts` 를 통해 부른다
//  (게이트웨이가 부팅 때 등록 · 노드엔 등록이 없어 그냥 건너뛴다).
import { listGitCredentialsPublic, getGitSecret, memberOwner } from "./git-credential-store.js";
import { memberSh } from "../../terminal/terminal-member-fs.js";
import { safeHost, buildSshConfigBlock, buildGitCredLines } from "./git-credential-materialize.js";

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
