// 이 배포가 그 AI 를 띄울 수 있나(설치) — 처음 설정 «AI 연결» 이 고를 AI 를 서버가 정한다 (#4970). 게이트웨이 전용.
//
//  ⚠ 노드 에이전트 번들 밖에 둔다 — profiles.ts 는 노드 번들에 실리고 노드는 «DB 없음» 이 계약이라(scripts/node-agent-allowed-modules.json),
//   거기에 기대 새 모듈(user-bin-path)을 끌어들이지 않는다. 이 파일은 라우트(routes.ts)만 부른다.
import { HARNESSES } from "./catalog.js";
import { sessionExecConfigured } from "./session-exec.js";
import { execTopology } from "../exec-topology.js";   // #4067 — 세션 이미지의 하네스 목록
import { USER_BIN_DIRS } from "./user-bin-path.js";   // 셀프호스트 설치 확인이 그 홈의 사용자 몫 폴더도 본다
import { runAtGatewaySeat } from "./profiles.js";     // runAtSeat 의 처방(stdin 닫기 · 상한 · 윈도우 모름) 그대로
import { existsSync } from "node:fs";
import { isolationInfraReady } from "./terminal-isolation.js";

/**
 * (#4970) 이 배포가 그 AI 를 **띄울 수 있나**(설치) — 처음 설정 «AI 연결» 이 고를 수 있는 AI 만 보이게 쓴다(/api/ui/me/ai-accounts 의 installed).
 *  로그인은 묻지 않는다 — 그건 aiAccountStatus·aiLoginCheck 의 일이다.
 *  · 세션 경계 중계가 있는 배포(매니지드) — 세션 이미지 목록이 답이다(listedHarnessInstalled 머리말: 설치는 이미지의 성질). 프로브 하네스(agy)도
 *    같다 — 설치를 묻는 데 자리(세션 컨테이너)를 띄울 까닭이 없다. 목록이 없으면 모름(null) — 게이트웨이 자기 자리를 보면 거짓 «미설치» 다
 *    (aiLoginCheck ① 머리말).
 *  · 셀프호스트 — 세션이 뜰 자리(이 박스)에서 본다. PATH 로 찾고, 못 찾으면 그 홈의 사용자 몫 폴더(user-bin-path)를 직접 본다 — 부팅이
 *    PATH 를 잇지만(boot/user-bin-path) 이 확인이 그 하나에 기대지 않게.
 *  · 셀프호스트 **격리 박스** — 클로드·챗GPT 는 게이트웨이가 아니라 **구성원마다** 깐다(provision-member 가 libexec 의 설치 도우미로 그 사람
 *    홈에). 그래서 게이트웨이 자리엔 없어도 도우미가 있으면 «띄울 수 있음» 이다(#4970 — 위시스트 격리 켜기). 제미나이·그록은 박스 전체
 *    (/usr/local/bin — deploy/install-harness-clis.sh)라 게이트웨이 자리에서 그대로 보인다.
 *  같은 답을 잠깐 기억한다(목록 화면이 여러 번 부른다). 모름(null — 셸이 상한까지 매달렸다)은 **더 짧게** 기억한다: 안 기억하면 매달리는
 *   박스에서 목록 조회가 부를 때마다 상한(25초)만큼 늘어지고, 길게 기억하면 고쳐진 뒤에도 한참 모름으로 남는다(격리 리뷰 2026-10-23).
 */
export interface InstalledDeps {
  relayed: () => boolean;
  listed: () => readonly string[] | null;
  run: (line: string) => Promise<boolean | null>;
  now: () => number;
  memo: Map<string, { at: number; v: boolean | null }>;
  /** 격리 박스에서 그 하네스를 구성원마다 까는 도우미가 있나(있으면 설치로 친다). */
  memberInstaller: (key: string) => boolean;
}
/** 격리 박스가 구성원마다 까는 하네스와 그 도우미(install-isolation.sh 가 libexec 에 둔다). */
export const MEMBER_INSTALLERS: Readonly<Record<string, string>> = Object.freeze({
  claude: "/opt/lively/libexec/install-claude-user",
  codex: "/opt/lively/libexec/install-codex-user",
});
/**
 * (순수) 구성원 몫 설치 도우미가 «설치됨» 으로 칠 만한가 — 격리 박스이고 그 하네스의 도우미가 있을 때만.
 *  ⚠ 근사다: 도우미는 best-effort 라 OFFLINE·네트워크 실패에도 0 으로 끝난다 — 그 구성원 홈에 실제로 없을 수 있다. 그때 로그인은
 *   «<하네스> 없음» 으로 말한다(막다른 길은 아니다). 정확히 재려면 그 사람 자리에서 물어야 하는데, 목록 조회마다 그럴 수는 없다.
 */
export function memberInstallerPresent(key: string, infraReady: boolean, exists: (p: string) => boolean): boolean {
  const helper = MEMBER_INSTALLERS[key];
  return !!helper && infraReady && exists(helper);
}
export const INSTALLED_TTL_MS = 60_000;
/** 모름(null)을 기억하는 시간 — 답(true/false)보다 짧게. */
export const INSTALLED_UNKNOWN_TTL_MS = 10_000;
/** (순수) 셀프호스트 설치 확인 한 줄 — PATH 해소, 아니면 홈의 사용자 몫 폴더에 실행 파일이 있나. bin 은 카탈로그 상수다(사람 입력 없음). */
export function installedCheckLine(bin: string): string {
  return [`command -v "${bin}" >/dev/null 2>&1`, ...USER_BIN_DIRS.map((d) => `[ -x "$HOME/${d}/${bin}" ]`)].join(" || ");
}
const realInstalledDeps: InstalledDeps = {
  relayed: () => sessionExecConfigured(),
  listed: () => execTopology().sessionHarnesses,
  run: (line) => runAtGatewaySeat(line),
  now: () => Date.now(),
  memo: new Map(),
  memberInstaller: (key) => memberInstallerPresent(key, isolationInfraReady(), existsSync),
};
export async function harnessInstalled(key: string, deps: InstalledDeps = realInstalledDeps): Promise<boolean | null> {
  const h = HARNESSES.find((x) => x.key === key);
  if (!h || !h.bin) return null;
  if (deps.relayed()) {
    const listed = deps.listed();
    return listed ? listed.includes(key) : null;
  }
  if (deps.memberInstaller(key)) return true;
  const hit = deps.memo.get(key);
  if (hit && deps.now() - hit.at < (hit.v === null ? INSTALLED_UNKNOWN_TTL_MS : INSTALLED_TTL_MS)) return hit.v;
  const v = await deps.run(installedCheckLine(h.bin));
  deps.memo.set(key, { at: deps.now(), v });
  return v;
}
