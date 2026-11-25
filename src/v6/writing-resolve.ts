// 서술 형식 위반 중 «글에 없는 사실이 있어야 고칠 수 있다» 던 규칙을 사람 없이 풀기 위한 결정적 정리.
//
// local_path 는 홈 디렉터리 접두를 $HOME 으로 바꾸면 가리키는 곳은 같고 개인 계정 이름만 빠진다 — 결정적이라 서버가 한다.
// 순수 함수다(DB 없음).

// ── 홈 경로 ──
// 탐지(writing-lint LOCAL_PATH_RE)와 같은 경계를 쓴다 — 앞에 글자·경로 문자가 붙은 «/Users/» 는 API·URL·저장소 경로다.
//  /home/<계정>/ 은 바꾸지 않는다: 서버의 서비스 계정 경로(/home/ec2-user/app)인 경우가 많고, 그때 계정 이름은 사실이다.
//  ~/ 도 바꾸지 않는다 — 탐지가 위반으로 보지 않는 관례 표기이고, ssh_config·gitconfig 처럼 셸 밖에서는 $HOME 과 같은 뜻이 아니다.
const MAC_HOME_RE = /(?<![\w.~\/:$%-])\/Users\/(?!Shared\/)[A-Za-z0-9._-]+(?=\/)/g;
const WIN_HOME_RE = /(?<![A-Za-z])[A-Za-z]:\\Users\\(?!(?:Public|Default|All Users)\\)[^\\\r\n<>:"|?*]+(?=\\)/g;

/** 개인 홈 디렉터리 접두를 $HOME(Windows 는 %USERPROFILE%)으로 바꾼다. 멱등이다. 가리키는 경로는 그대로다. */
export function normalizeHomePaths(s: string): string {
  return s
    .replace(MAC_HOME_RE, "$HOME")
    .replace(WIN_HOME_RE, "%USERPROFILE%");
}

/** normalizeHomePaths 가 바꿀 자리 수. */
export function countHomePaths(s: string): number {
  return (s.match(MAC_HOME_RE) ?? []).length + (s.match(WIN_HOME_RE) ?? []).length;
}
