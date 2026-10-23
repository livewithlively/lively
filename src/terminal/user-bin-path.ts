// 셀프호스트 게이트웨이의 실행 경로(PATH)에 «그 사용자 몫 프로그램 폴더» 를 잇는다 (#4970) — 순수. 부팅 적용은 boot/user-bin-path.ts.
//
//  왜: 셀프호스트 설치기(deploy/linux/provision.sh)는 claude 를 게이트웨이 사용자 홈에 **네이티브로** 깐다(~/.local/bin — #1023 자기 갱신).
//   그런데 서비스 PATH(deploy/lib/common.sh 의 @PATH@)에는 그 폴더가 없었다. tmux 는 서버를 띄운 프로세스의 PATH 로만 명령을
//   찾으므로(terminal/sessions.ts #869 머리말) 이 게이트웨이가 띄운 세션은 claude 를 못 찾고, 화면 안 로그인(ai-login-run)과
//   설치 확인(profiles.runAtSeat)도 «claude 없음» 으로 끝난다.
//   실측 2026-10-23 위시스트 박스: claude 는 /home/lively/.local/bin 에만 있고, 게이트웨이 PATH 로는 `command -v claude` 가 실패했다.
//  · 세션 계약(deploy/linux/session-env.sh ②)이 세션에 주는 폴더와 같은 셋이다.
//  · **뒤에** 붙인다 — 시스템에 같은 이름이 있으면 그것이 그대로 이긴다(종전 해소 결과를 바꾸지 않는다).
//  · 있는 폴더만 · 이미 들어 있으면 다시 넣지 않는다 · 원래 문자열은 손대지 않는다(빈 칸 `::` 의 뜻까지 그대로).
import path from "node:path";

/** 세션 계약(session-env.sh ②)과 같은 순서 — 홈 아래 상대 경로. */
export const USER_BIN_DIRS: readonly string[] = [".local/bin", ".npm-global/bin", ".lively/bin"];

/** (순수) PATH 뒤에 home 의 사용자 몫 폴더를 잇는다 — 있는 폴더만, 겹치지 않게. 붙일 게 없으면 입력 그대로. */
export function withUserBinDirs(pathVar: string | undefined, home: string, isDir: (p: string) => boolean): string {
  const base = String(pathVar ?? "");
  if (!home) return base;
  const have = new Set(base.split(":"));
  const add: string[] = [];
  for (const rel of USER_BIN_DIRS) {
    const dir = path.posix.join(home, rel);
    if (have.has(dir) || !isDir(dir)) continue;
    add.push(dir); have.add(dir);
  }
  if (!add.length) return base;
  return base ? `${base}:${add.join(":")}` : add.join(":");
}
