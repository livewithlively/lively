// 로컬 도구용 git 자격 리스의 판정 — **DB 를 안 타는 순수 함수**(시험이 그대로 부른다).
//
// 왜 있나: 로컬 도구(lively_local_repo_worktree · lively_local_repo_pin · `lively repo`)는 등록된 레포를 그 컴퓨터에 받아
//  읽게 해 준다. 그런데 종전엔 그 컴퓨터에 이미 깔린 git 자격(ssh 키 · credential helper)에만 기댔다 — git 을 한 번도
//  설정하지 않은 사람(비개발자)은 라이블리에 토큰을 등록해 두고도 사설 레포를 받지 못했다(받는 git 이 사용자 이름을
//  물으며 멈췄다). 그래서 본인이 등록한 HTTPS 토큰을 **그 사람의 로컬 도구에게만** 내준다.
//
// 내주는 것과 안 내주는 것:
//  · 내준다 — 부른 사람 **본인**의 HTTPS 토큰. 조직(게이트웨이) 자격은 안 내준다: 정책은 leaseGitSecretForNode 의
//    member 갈래 그대로다(개인 머신에 조직 공용 키를 보내면 권한 상승이고 회수할 수 없다, #905 C4).
//  · 안 내준다 — SSH 개인키. `me_git_credential_set {kind:"ssh"}` 는 «개인키는 박스 밖으로 나가지 않는다» 고 약속한다.
//  · 안 내준다 — 등록 주소가 http(s) 가 아닌 레포(ssh 등)의 토큰. 쓸 데가 없는 시크릿은 밖으로 내보내지 않는다.
//    (평문 http 주소로 등록된 레포는 내준다 — 게이트웨이도 그 주소로 클론할 때 같은 토큰을 같은 길로 보낸다. 새로 생기는 노출이 아니다.)
//  · 어디에 쓸 토큰인지(origin = 등록 주소의 scheme://host[:port])를 함께 준다. 로컬 도구는 git 이 실제로 닿을 원격이 그 자리와
//    **글자 그대로 같을 때만** 토큰을 건다 — 호스트 이름만 같고 scheme · 포트가 다른 자리(https 로 등록했는데 로컬 원격은 http 등)로
//    토큰이 나가지 않게.
//
// 누가 부를 수 있나(localGitLeaseDenial): 회수할 수 있는 접속 열쇠(DB 토큰)로 온 **구성원 본인**뿐이다.
//  · 웹 로그인 세션(쿠키) 거절 — 브라우저 화면이 토큰 평문을 받을 길을 만들지 않는다(화면 스크립트 결함 하나가 곧 토큰 유출이 된다).
//  · 앱 토큰 · 앱 서버가 실어 온 사람 신원 · 도구 상한이 실린 작업 토큰 · OAuth 클라이언트 토큰 거절 — 사람을 대리하는
//    주체가 그 사람의 git 토큰을 꺼내 가면 동의 범위를 넘는다.
//  · 정적 토큰 거절 — 회수할 수 없는 열쇠가 다른 시크릿으로 바뀌어 나가면 끊을 방법이 없다.
//  ⚠ 알고 받아들인 것: 구성원의 접속 열쇠를 쥔 것(그 사람 세션의 AI 포함)은 이 REST 를 직접 불러 그 사람의 토큰을 읽을 수 있다.
//   MCP 도구로 내놓지 않는 것은 «AI 가 고를 도구가 아니다» 는 뜻이지 경계가 아니다. 박스에서는 같은 토큰이 이미 그 사람 홈에 평문으로
//   내려가 있어(git-credential-materialize) 새 등급의 노출이 아니고, 내준 사실은 감사 로그에 남는다.
import type { LivelyUser } from "../../context.js";
import type { GitCredentialSecret } from "./git-credential-store.js";   // 타입 전용 — 런타임 간선 아님

/** 리스를 거절할 까닭(한 줄) — 허용이면 null. */
export function localGitLeaseDenial(user: LivelyUser | undefined | null): string | null {
  if (!user?.userId) return "인증이 필요합니다";
  if (user.appId || user.appServer || user.toolCeiling != null) return "앱 · 작업 토큰으로는 git 자격을 받을 수 없습니다";
  if (user.oauthClientId) return "외부 클라이언트(OAuth) 토큰으로는 git 자격을 받을 수 없습니다";
  if (user.tokenSource !== "db") {
    return user.tokenSource === "session"
      ? "웹 로그인 세션으로는 git 자격을 받을 수 없습니다 — 이 길은 로컬 도구(접속 열쇠) 전용입니다"
      : "회수할 수 없는 정적 토큰으로는 git 자격을 받을 수 없습니다";
  }
  return null;
}

/** 로컬 도구가 받는 모양 — credential 이 null 이면 reason 이 까닭이다(로컬 도구가 그 까닭으로 안내를 고른다). */
export type LocalGitLeaseReason = "repo-unregistered" | "not-https-url" | "no-credential" | "ssh-credential";
export interface LocalGitLease {
  host: string | null;
  /** 토큰을 쓸 자리 — 등록 주소의 scheme://host[:port](소문자 · 기본 포트 생략). 로컬 도구가 git 의 원격과 대조한다. */
  origin: string | null;
  credential: { kind: "https"; username: string; token: string } | null;
  reason: LocalGitLeaseReason | null;
}

/** 등록 주소가 http(s) 인가 — 토큰은 그 주소로만 쓰인다. 자격이 박힌 주소(https://token@host/…)도 https 다. */
export function isHttpsGitUrl(gitUrl: unknown): boolean {
  return gitOriginOf(gitUrl) !== null;
}

/** 등록 주소 → scheme://host[:port](박힌 자격 · 경로 제외). http(s) 가 아니거나 못 읽으면 null. 로컬 도구(httpRemoteOf)와 같은 규칙. */
export function gitOriginOf(gitUrl: unknown): string | null {
  let u: URL;
  try { u = new URL(String(gitUrl ?? "").trim()); } catch { return null; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname) return null;
  return `${u.protocol}//${u.host}`;
}

/**
 * 레지스트리 주소 + (정책을 이미 통과한) 본인 자격 → 로컬 도구에 내줄 것.
 *  secret 은 leaseGitSecretForNode(…, "member") 의 결과여야 한다 — 이 함수는 조직 폴백을 막지 않는다(막는 자리는 그 관문 하나다).
 */
export function localGitLeaseOf(gitUrl: string | null | undefined, host: string | null, secret: GitCredentialSecret | null | undefined): LocalGitLease {
  if (!gitUrl || !host) return { host: null, origin: null, credential: null, reason: "repo-unregistered" };
  const origin = gitOriginOf(gitUrl);
  if (!origin) return { host, origin: null, credential: null, reason: "not-https-url" };
  if (!secret) return { host, origin, credential: null, reason: "no-credential" };
  if (secret.kind !== "https" || !secret.https_token) return { host, origin, credential: null, reason: "ssh-credential" };
  return { host, origin, credential: { kind: "https", username: secret.https_username || "x-access-token", token: secret.https_token }, reason: null };
}
