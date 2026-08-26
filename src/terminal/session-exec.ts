// 세션 컨테이너 경계 — **그 세션의 실행 환경 안에서** 명령을 돌린다 (#2055 P3). 순수 조립.
//
//  ── 왜 멤버 경계(memberSpawnArgv)로는 안 되나 ──
//  매니지드에서 `LIVELY_MEMBER_EXEC` 중계는 **tmux 컨테이너**로 들어간다(테넌트 공용, 파일 op 용).
//  거기서 codex app-server 를 띄우면 두 가지가 깨진다(둘 다 실측 2026-08-26, lvly-box):
//   ① 격리 — 그 컨테이너는 테넌트의 **모든 멤버**가 공유한다. 에이전트가 남의 홈에 닿는다.
//   ② 자격 — 그 exec 의 uid 는 이미지 passwd 에 없어 `HOME=/` 이다. codex 가 `~/.codex/auth.json` 을
//      못 찾아 미로그인으로 뜬다(`docker exec … echo $HOME` → `/`).
//  세션 컨테이너(`lvly-s-<slug>-<sessionId>`)에는 `-e HOME=<멤버홈>` 이 박혀 있고 멤버·세션 단위로 갈린다.
//  그래서 **대화 런타임만** 이 경계를 쓴다 — 파일 op 는 종전 그대로(그건 tmux 컨테이너가 맞다).
//
//  ── 왜 되나(길이 이미 있다) ──
//  브로커 화이트리스트에 `POST /containers/<이름>/exec` + `/exec/<id>/start`(HTTP Upgrade hijack,
//  **양방향 raw**)가 이미 있고, 채널 허브도 클라이언트 포트에서 Upgrade 를 바이트 그대로 흘린다
//  (터미널 PTY 가 그 길로 다닌다). 컨테이너 이름은 세션 id 에서 결정론적으로 나온다.
//
//  ⚠ app-server 는 그 컨테이너의 **127.0.0.1** 에만 붙는다. 테넌트 네트워크에 포트를 열지 않는다 —
//   `codex app-server --listen ws://` 에는 인증 옵션이 없어(0.149.1 실측), 열면 같은 테넌트의 다른
//   멤버가 남의 codex 를 조종할 수 있다.
import { tenantSlug } from "./catalog.js";

/**
 * (순수) 이 배포가 세션 경계 중계를 쓰나. 값이 없으면 셀프호스트 — 호출자가 로컬에서 직접 띄운다.
 *  ⚠ **호출 시점에 읽는다**(memberExecArgv 와 같은 이유 — 모듈 로드 시점 고정은 부팅 순서·테스트에서 깨진다).
 */
export function sessionExecConfigured(): boolean {
  return !!(process.env.LIVELY_SESSION_EXEC || "").trim();
}

/**
 * (순수) 중계 프로그램 argv. `{slug}` 는 요청 컨텍스트의 테넌트로 치환한다.
 *  ⚠ 슬러그가 없으면 **던진다**. 기본값으로 접으면 남의 테넌트 컨테이너에 exec 하게 된다(fail-closed).
 */
export function sessionExecArgv(): string[] {
  const raw = (process.env.LIVELY_SESSION_EXEC || "").trim();
  if (!raw) return [];
  if (!raw.includes("{slug}")) return raw.split(/\s+/);
  const slug = tenantSlug();
  if (!slug) throw new Error("세션 경계 중계에 테넌트 컨텍스트가 필요합니다 — 컨텍스트 밖에서 호출됐습니다");
  return raw.replace("{slug}", slug).split(/\s+/);
}

/** 세션 id 형식 — 중계에 넘기기 전에 여기서 막는다(컨테이너 이름의 재료가 된다). */
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * (순수 — 테스트 seam) 그 세션의 컨테이너 안에서 argv 를 돌릴 **전체 명령**.
 *  계약: `<중계> <sessionId> -- <argv…>` (memberSpawnArgv 와 같은 모양 — 두 번째 자리만 다르다).
 *  중계가 설정 안 됐으면 빈 배열 — 호출자가 "이 배포는 로컬" 로 읽고 직접 띄운다.
 */
export function sessionSpawnArgv(sessionId: string, argv: string[]): string[] {
  const relay = sessionExecConfigured() ? sessionExecArgv() : [];
  if (!relay.length) return [];
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`세션 id 형식 오류: ${sessionId}`);
  return [...relay, sessionId, "--", ...argv];
}
