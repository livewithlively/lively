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

const execFileAsync = promisify(execFile);

// OS 계정 이름 = box_<slug>. slug 는 terminal-sessions.userSlug 와 **동일 규칙**(호출자가 계산해 넘김 — 순환 import 회피).
//  userSlug 산출물은 [a-z0-9-]{1,24} 라 box_<slug> 는 아래 SAFE_OS_USER 를 항상 만족한다.
export const OS_USER_PREFIX = "box_";
const SAFE_OS_USER = /^box_[a-z0-9-]+$/;
export function osUsername(slug: string): string { return `${OS_USER_PREFIX}${slug}`; }

// 격리 모드: 'os'(구성원별 OS 유저) | 'off'(기존 단일 유저). **기본 off** — opt-in·무회귀.
//  엄격 비교(=== 'os')라 오타·레거시 값은 안전하게 off 로 떨어진다.
export function isolationMode(): "os" | "off" {
  return process.env.LIVELY_MEMBER_ISOLATION === "os" ? "os" : "off";
}

// 게이트웨이가 sudoers 로 그 멤버 계정에서 실행하도록 허용된 **고정 wrapper**(root 소유·멤버 비쓰기).
//  sudoers 의 Cmnd 경로와 **문자열이 일치**해야 한다(불변식). 배포가 /opt/lively/libexec/box-spawn 로 설치.
export const BOX_SPAWN = process.env.LIVELY_BOX_SPAWN || "/opt/lively/libexec/box-spawn";

// 하네스/셸 argv 를 그 멤버 OS 계정으로 내리는 drop-priv 래핑(**순수** — 테스트 대상).
//  결과: ["sudo","-n","-u",osUser,"--",BOX_SPAWN, ...argv]  (argv 빈 배열=셸 세션이면 wrapper 가 로그인 셸 실행).
//  -n: 비대화(NOPASSWD 라 프롬프트 없음 — 행 방지). '--': sudo 옵션 종료(뒤 토큰이 옵션으로 안 새게).
//  argv(하네스명·플래그)는 호출부에서 이미 화이트리스트(HARNESSES·SAFE_VALUE_RE)라 셸 인젝션 표면 없음.
export function wrapAsMember(osUser: string, argv: string[]): string[] {
  return ["sudo", "-n", "-u", osUser, "--", BOX_SPAWN, ...argv];
}

// OS 유저 존재 확인(= 프로비저닝됨). Linux: `id -u <user>` 성공. 실패/미존재/비Linux(맥 등) → false(공유 폴백).
//  execFile(셸 미경유) + 형식 가드 → 인젝션 불가. 세션 생성당 1회(가벼움).
export async function osUserExists(osUser: string): Promise<boolean> {
  if (!SAFE_OS_USER.test(osUser)) return false;
  try { await execFileAsync("id", ["-u", osUser], { timeout: 4000 }); return true; }
  catch { return false; }
}

// 세션 격리 게이트 — 켜졌고(os) 그 멤버 OS 유저가 존재하면 osUser 를 반환, 아니면 null(→ 기존 동작 폴백).
//  createSession 이 이 값으로 분기: non-null 이면 wrapAsMember, null 이면 종전(#346 CLAUDE_CONFIG_DIR) 경로.
export async function resolveMemberOsUser(slug: string): Promise<string | null> {
  if (isolationMode() !== "os") return null;
  const osUser = osUsername(slug);
  return (await osUserExists(osUser)) ? osUser : null;
}
