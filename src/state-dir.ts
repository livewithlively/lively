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

// 부팅 1회(멱등) — 루트 + 알려진 하위를 보장. 서비스 유저 소유라 mkdir 가능. 실패는 비치명(경고만; 개별 기능이 각자 처리).
//  새 런타임 하위 디렉이 생기면 여기에 등록한다(= '경로 쓰기 가능성'을 보장하는 단일 지점).
const KNOWN_SUBDIRS = ["repos", "notion-assets"];
export async function ensureStateDirs(): Promise<void> {
  for (const d of [stateRoot(), ...KNOWN_SUBDIRS.map((s) => stateDir(s))]) {
    try {
      await fsp.mkdir(d, { recursive: true });
    } catch (e) {
      logger.warn({ err: e, dir: d }, "[state-dir] ensure 실패(비치명) — 서비스 유저 쓰기권한 확인 필요");
    }
  }
}
