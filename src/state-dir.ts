// 게이트웨이 런타임 쓰기의 단일 루트(#618) — 서비스 유저(예: lively)가 소유·쓰기 가능해야 하는 곳.
//  기본 = <cwd>/data (배포가 서비스 유저로 chown; notion-assets 등 기존 관례를 공식화). WorkingDirectory 루트 자체는
//  다른 uid(ssm-user) 소유일 수 있어 cwd-상대 'var/…' 같은 곳엔 서비스 유저가 mkdir 못 한다(=#606 스캐너 EACCES).
//  ⇒ 개별 기능은 cwd-상대·/home·/srv 리터럴을 직접 쓰지 말고 반드시 stateDir(...) 로만 런타임 경로를 만든다.
//  가드레일: state-dir.test.ts 가 헬퍼 밖의 그런 리터럴을 CI 에서 차단.
import path from "node:path";
import fsp from "node:fs/promises";
import { logger } from "./log.js";

// 런타임 상태 루트 — LIVELY_STATE_DIR 오버라이드, 기본은 <cwd>/data(서비스 유저 소유·배포/update.sh 보존).
export function stateRoot(): string {
  return path.resolve(process.env.LIVELY_STATE_DIR || path.join(process.cwd(), "data"));
}

// 런타임 경로 조립 — stateDir("repos"), stateDir("notion-assets") 처럼. 세그먼트는 신뢰 입력만(경로 컴포넌트).
export function stateDir(...segs: string[]): string {
  return path.join(stateRoot(), ...segs);
}

// 로그 루트(#813) — 서비스 유닛이 stdout/stderr 을 여기로 리다이렉트한다
//  (systemd `StandardOutput=append:<APP_DIR>/logs/gateway.log` · launchd `StandardOutPath`).
//  로그 재니터(src/log-janitor.ts)가 여기서 회전한다. LIVELY_LOG_DIR 로 오버라이드.
//  ※ data(stateRoot) 와 분리 — 배포가 logs/ 와 data/ 를 각각 소유·보존한다(deploy render_service_unit).
export function logRoot(): string {
  return path.resolve(process.env.LIVELY_LOG_DIR || path.join(process.cwd(), "logs"));
}

// 부팅 1회(멱등) — 루트 + 알려진 하위를 보장 + 실제 쓰기 프로브. 서비스 유저 소유라 성공해야 정상.
//  새 런타임 하위 디렉이 생기면 여기에 등록한다(= '경로 쓰기 가능성'을 보장하는 단일 지점).
//  ⚠ 정적 가드레일(state-dir.test.ts)이 놓친 오구성(예: STATE_DIR 이 타 uid 소유)을 부팅 때 **시끄럽게** 드러내는 방어선 —
//   조용한 EACCES(#606 스캐너처럼 매 tick 실패하고 아무도 모름)를 방지. 비치명(부팅은 계속)이되 root 실패는 error 로그.
const KNOWN_SUBDIRS = ["repos", "notion-assets"];
export async function ensureStateDirs(): Promise<void> {
  const root = stateRoot();
  try {
    await fsp.mkdir(root, { recursive: true });
    // 쓰기 프로브 — mkdir 성공이어도 실제 쓰기권한을 1회 확인(소유/모드 오구성 조기 발견).
    const probe = stateDir(".write-probe");
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe, { force: true });
  } catch (e) {
    logger.error({ err: e, dir: root, user: process.getuid?.() },
      "[state-dir] STATE_DIR 쓰기 불가 — 런타임 기능(도메인맵 스캐너·커넥터 자산 등)이 실패한다. " +
      "서비스 유저 소유·쓰기권한 확인(예: chown -R <svc-user> <STATE_DIR>) 또는 LIVELY_STATE_DIR 지정.");
    return; // 루트가 안 되면 하위도 안 됨 — 조기 반환(로그가 원인을 명시)
  }
  for (const s of KNOWN_SUBDIRS) {
    await fsp.mkdir(stateDir(s), { recursive: true })
      .catch((e) => logger.warn({ err: e, dir: stateDir(s) }, "[state-dir] 하위 ensure 실패(비치명)"));
  }
}
