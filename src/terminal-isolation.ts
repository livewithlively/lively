// 중앙 박스 — 구성원별 OS-유저 격리(#524). 세션의 셸/하네스를 그 멤버의 OS 계정(box_<slug>)으로
//  내려서(drop-priv) 자격증명(claude .credentials.json·lively 토큰 등)을 **커널 uid 경계**로 격리한다.
//  단일 OS 유저(ssm-user)에선 파일 권한 600 도 소유자가 같아 격벽이 안 된다 → 서로 다른 uid 만이 실질 격리.
//
//  메커니즘: 게이트웨이는 **비-root 서비스 유저**(lively)로 돌고, 잠긴 sudoers 로 **고정 wrapper 하나**만
//   그 멤버 계정으로 실행할 수 있다 —  sudo -n -u box_<slug> -- <wrapper> [harness...].
//   (setuid C 헬퍼 대신 sudo+wrapper: 커스텀 setuid 바이너리의 root-exploit 위험 회피 + arch-무관 prebuilt
//    릴리스에 컴파일 불요 + 표준·감사 용이. runas 를 box_members 그룹으로 제한 → 멤버 추가 시 sudoers 무수정.)
//
//  ⚠ Linux 전용. 기본 off(LIVELY_MEMBER_ISOLATION 미설정/≠os) → 기존 단일-유저 동작(무회귀·롤아웃 kill-switch).
//     'os' 로 켠 박스에서도, **프로비저닝된 멤버(box_<slug> 존재)만** 격리 적용 — 미프로비저닝=공유 폴백(#346 패턴 답습).
//     격리 시 CLAUDE_CONFIG_DIR 주입 불요: 멤버가 자기 $HOME/.claude 를 uid 로 네이티브 격리(#346 을 흡수).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

// OS 계정 이름 = box_<slug>. slug 는 terminal-sessions.userSlug 와 **동일 규칙**(호출자가 계산해 넘김 — 순환 import 회피).
//  userSlug 산출물은 [a-z0-9-]{1,24} 라 box_<slug> 는 아래 SAFE_OS_USER 를 항상 만족한다.
export const OS_USER_PREFIX = "box_";
const SAFE_OS_USER = /^box_[a-z0-9-]+$/;
export function osUsername(slug: string): string { return `${OS_USER_PREFIX}${slug}`; }

// 격리 활성 여부 — **secure-by-default**: 기본 활성. 실제 격리는 "인프라(box-spawn) 설치됨 AND 그 멤버 provision됨"
//  일 때만 일어나므로(resolveMemberOsUser), 미설치 박스·코드만 업데이트한 박스는 아무 변화 없이 공유 폴백(폴백-세이프).
//  ⚠ 그래서 "업데이트=코드"는 동작을 안 바꾸고, "install-isolation + provision=셋업"이 곧 활성 신호가 된다.
//  LIVELY_MEMBER_ISOLATION=off 면 하드 비활성(킬스위치 — 긴급 롤백). 그 외 값(unset 포함)은 활성.
export function isolationEnabled(): boolean {
  return process.env.LIVELY_MEMBER_ISOLATION !== "off";
}

// 게이트웨이가 sudoers 로 그 멤버 계정에서 실행하도록 허용된 **고정 wrapper**(root 소유·멤버 비쓰기).
//  sudoers 의 Cmnd 경로와 **문자열이 일치**해야 한다(불변식). 배포가 /opt/lively/libexec/box-spawn 로 설치.
export const BOX_SPAWN = process.env.LIVELY_BOX_SPAWN || "/opt/lively/libexec/box-spawn";

// 하네스/셸 argv 를 그 멤버 OS 계정으로 내리는 drop-priv 래핑(**순수** — 테스트 대상).
//  결과: ["sudo","-n","-u",osUser,"--",BOX_SPAWN, ("--cwd",cwd)?, ...argv]  (argv 빈 배열=셸 세션이면 wrapper 가 로그인 셸 실행).
//  cwd 를 주면 box-spawn 이 **멤버 uid 로 거기 cd** 한다(#524: tmux -c 는 게이트웨이 권한이라 멤버 700 홈 chdir 실패 → cwd 는 여기로).
//  -n: 비대화(NOPASSWD 라 프롬프트 없음 — 행 방지). '--': sudo 옵션 종료(뒤 토큰이 옵션으로 안 새게).
//  argv(하네스명·플래그)는 호출부에서 이미 화이트리스트(HARNESSES·SAFE_VALUE_RE)라 셸 인젝션 표면 없음.
export function wrapAsMember(osUser: string, argv: string[], cwd?: string): string[] {
  const pre = cwd ? ["--cwd", cwd] : [];
  return ["sudo", "-n", "-u", osUser, "--", BOX_SPAWN, ...pre, ...argv];
}

// OS 유저 존재 확인(= 프로비저닝됨). Linux: `id -u <user>` 성공. 실패/미존재/비Linux(맥 등) → false(공유 폴백).
//  execFile(셸 미경유) + 형식 가드 → 인젝션 불가. 세션 생성당 1회(가벼움).
export async function osUserExists(osUser: string): Promise<boolean> {
  if (!SAFE_OS_USER.test(osUser)) return false;
  try { await execFileAsync("id", ["-u", osUser], { timeout: 4000 }); return true; }
  catch { return false; }
}

// 세션 격리 게이트 — 활성 && 인프라 설치됨(box-spawn) && 그 멤버 OS 유저 존재 → osUser 반환, 아니면 null(→ 공유 폴백).
//  createSession 이 이 값으로 분기: non-null 이면 wrapAsMember, null 이면 종전(#346 CLAUDE_CONFIG_DIR) 경로.
//  3중 게이트라 secure-by-default 여도 미설치/미프로비저닝 박스는 폴백-세이프(무회귀). Linux 전용.
export async function resolveMemberOsUser(slug: string): Promise<string | null> {
  if (!isolationEnabled()) return null;               // 하드 킬스위치(=off)
  if (process.platform !== "linux") return null;      // 격리는 Linux 전용(맥 개발환경 등 폴백)
  if (!existsSync(BOX_SPAWN)) return null;             // 인프라 미설치(install-isolation 안 함) → 공유 폴백
  const osUser = osUsername(slug);
  return (await osUserExists(osUser)) ? osUser : null; // 멤버 미프로비저닝 → 공유 폴백
}

// 격리 인프라 준비됨? (활성 + Linux + box-spawn 설치). UI 상태 표시용 — 이게 true 여야 provision 이 의미있다.
export function isolationInfraReady(): boolean {
  return isolationEnabled() && process.platform === "linux" && existsSync(BOX_SPAWN);
}
