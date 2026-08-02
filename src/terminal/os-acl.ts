// OS 레벨 공개범위 강제(#1291 v2, §4.7) — API 게이트만으로는 못 막는 구멍을 닫는다.
//
//  왜 필요한가: 중앙박스의 AI 세션은 **셸을 가진다.** 공유 루트는 `root:lively-shared 2775`, 프로젝트 폴더는 2770 이고
//  **모든 멤버 OS 계정이 lively-shared 그룹**이다(deploy/provision-member.sh). 그래서 API 를 아무리 잠가도
//  세션 안에서 `cat /srv/lively/shared/project/<잠긴id>/…` 한 줄이면 그냥 읽힌다 —
//  기획 원문의 "사람도, 그 사람의 AI 도 차단"이 문서상으로만 충족되는 상태였다.
//
//  왜 ACL 인가(그룹 방식 대신): 전용 그룹(`proj_<id>`)을 쓰려면 groupadd·usermod 가 전부 root 라
//  게이트웨이에 root wrapper + sudoers 를 새로 열어야 한다. 반면 **프로젝트 폴더는 게이트웨이(lively)가 직접 만들고
//  chmod 한다** — 소유자는 root 없이 setfacl 을 걸 수 있다(실측 확인). 게다가 ACL 은 open() 시점에 평가돼
//  **회수가 즉시 반영**된다. 보충그룹은 exec 시 프로세스 자격에 스냅샷돼, 그룹에서 빼도 이미 떠 있는 세션은
//  프로세스가 살아있는 한 계속 읽는다.
//
//  경계 — 이건 **덧대는 방어선**이지 대체재가 아니다:
//   · setfacl 이 없거나(패키지 미설치) 실패하면 **조용히 넘어간다**(로그만). 폴더 생성·배포가 깨지면 안 되고,
//     API 강제는 그대로 살아 있다. "OS 까지 막혔나"를 확인하려면 아래 aclAvailable() 로 물어라.
//   · 격리 OS 계정이 없는 배포(비격리 폴백 박스)에서는 애초에 막을 대상이 없다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../log.js";
import { memberOsUser } from "./terminal-sessions.js";

const exec = promisify(execFile);
const ACL_TIMEOUT_MS = 5_000;

let aclProbe: Promise<boolean> | null = null;
/** 이 박스에서 OS 강제가 가능한가(setfacl 존재). 한 번만 확인하고 기억한다. */
export function aclAvailable(): Promise<boolean> {
  if (!aclProbe) {
    aclProbe = exec("setfacl", ["--version"], { timeout: ACL_TIMEOUT_MS })
      .then(() => true)
      .catch(() => {
        logger.info("[vis-acl] setfacl 없음 — OS 레벨 강제를 건너뛴다(API 강제는 그대로). `apt-get install acl` 로 켤 수 있다.");
        return false;
      });
  }
  return aclProbe;
}

/** 멤버 id → OS 계정명. 규칙은 terminal-sessions 가 유일한 파생지다 — 여기서 다시 짜지 마라.
 *  (처음엔 이 파일이 손으로 재구현했다가 `_` 유지·트림 누락·비-ASCII 폴백에서 어긋났다. 그러면 아래
 *   restrictFolder 가 **그룹 접근만 걷고** 대상 멤버 ACL 은 없는 계정에 걸어 실패 → 잠긴 폴더에
 *   정작 대상이 못 들어가는데 API 는 보인다고 답하는, 가장 알아채기 어려운 형태로 깨진다.) */
export const osUserFor = memberOsUser;

/**
 * 폴더를 **잠근다** — 그룹(전 멤버)에게서 접근을 걷고, 대상 멤버에게만 개별 ACL 을 준다.
 *  traversal(x)만 통제하면 하위 전체가 닫힌다(경로 해석은 전 구간 x 가 필요하다) — 그래서 재귀하지 않는다.
 *  재귀(-R)를 쓰면 큰 폴더에서 오래 걸리고, 하위 파일의 개별 권한을 우리가 덮어써 버린다.
 */
export async function restrictFolder(absPath: string, audienceMemberIds: string[]): Promise<boolean> {
  if (!(await aclAvailable())) return false;
  try {
    // 그룹 접근 제거 = 이 폴더의 '전 멤버 공개'를 끈다. 게이트웨이(소유자)는 그대로 접근한다.
    await exec("setfacl", ["-m", "g:lively-shared:---", absPath], { timeout: ACL_TIMEOUT_MS });
    for (const m of audienceMemberIds) {
      const u = osUserFor(m);
      // 대상에겐 읽기+진입. 쓰기까지 필요한 건 세션이 만드는 파일인데 그건 폴더 소유·setgid 가 이미 처리한다.
      await exec("setfacl", ["-m", `u:${u}:rwx`, absPath], { timeout: ACL_TIMEOUT_MS })
        .catch((e) => logger.warn({ member: m, osUser: u, err: (e as Error)?.message },
          "[vis-acl] 대상 멤버 ACL 부여 실패 — 그 계정이 아직 프로비저닝 안 됐을 수 있다(API 강제는 유효)"));
    }
    logger.info({ path: absPath, audience: audienceMemberIds.length }, "[vis-acl] 폴더 잠금 적용");
    return true;
  } catch (e) {
    logger.warn({ path: absPath, err: (e as Error)?.message },
      "[vis-acl] 폴더 잠금 실패 — API 강제는 유효하지만 셸 경로는 열려 있다");
    return false;
  }
}

/** 폴더를 **연다** — 개별 ACL 을 걷고 그룹 접근을 되돌린다(잠그기 전 상태). */
export async function unrestrictFolder(absPath: string): Promise<boolean> {
  if (!(await aclAvailable())) return false;
  try {
    // -b 는 확장 ACL 을 통째로 지운다(기본 permission bits 는 남는다) → 2770 의 그룹 rwx 가 다시 유효해진다.
    await exec("setfacl", ["-b", absPath], { timeout: ACL_TIMEOUT_MS });
    logger.info({ path: absPath }, "[vis-acl] 폴더 잠금 해제");
    return true;
  } catch (e) {
    logger.warn({ path: absPath, err: (e as Error)?.message }, "[vis-acl] 잠금 해제 실패");
    return false;
  }
}
