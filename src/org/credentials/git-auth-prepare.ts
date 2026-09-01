// git 호스트·자격주입 헬퍼 — **DB 도 자격 금고도 건드리지 않는 잎 모듈** (#606 에서 만들려던 것, #2165 에서 실제로 잎이 됨).
//
// 왜 여기 있나: 이 넷은 문자열 파싱과 임시파일(fs)만 쓴다. 그런데 종전엔 `git-credential-store.ts` 안에 살았고,
//  그 모듈은 `db/client.js`(itemsPool)와 `github-app-git.js`(설치토큰 발급·앱 서명·시크릿 금고·OAuth 브로커)를
//  import 한다. `project-provision.ts` 가 clone 을 하려고 `hostOf`/`prepareGitAuth` 를 쓰는 것만으로 그 전부가
//  딸려왔고, `project-provision` 은 **노드 에이전트 번들의 진입 경로**라 그 코드가 멤버 PC 로 나갔다.
//
// ⚠ 노드엔 DB 가 없다. `project-provision.ts:268` 이 이미 그렇게 적어 뒀다 —
//  «🔴 노드엔 DB 가 없다 … 여기서 getRepo/resolveGitSecret 을 쓰면 안 된다». **런타임은 그 규칙을 지켰지만
//  static import 가 계약을 배신하고 있었다.** 그래서 '노드가 쓰는 것'과 '게이트웨이만 쓰는 것'을 모듈로 가른다.
//
// ⚠ 이 파일엔 `node:` 빌트인 말고는 import 를 넣지 마라(타입 전용 import 은 tsc 가 지운다 — 런타임 간선이 아니다).
//  `scripts/node-agent-bundle-boundary.test.mjs` 가 그것을 못박는다.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitCredentialSecret } from "./git-credential-store.js";   // 타입 전용 — 런타임 간선 아님

// ── git 호스트/자격주입 헬퍼 — provision(project-provision.ts)·도메인맵 스캐너(domainmap/git-pull.ts·webhook.ts)가 공유.
//  provision 이 갖고 있던 것을 이 leaf 모듈로 올려(#606) 스캐너 clone/fetch 도 동일 자격주입을 쓰게 한다. project-provision 은
//  하위호환 위해 re-export 한다. ──

// git 호스트 추출 — 자격을 어느 호스트에 매칭할지(github.com 등). scp-식(user@host:path)·URL 둘 다.
export function hostOf(gitUrl: unknown): string | null {
  const s = String(gitUrl ?? "").trim();
  if (!s) return null;
  const scp = s.match(/^[\w.-]+@([\w.-]+):/); // user@host:path (임베드 시크릿 없음)
  if (scp) return scp[1].toLowerCase();
  try { return new URL(s).hostname.toLowerCase(); } catch { return null; }
}

// 클론/fetch 실패 메시지가 '인증' 계열인지 — 그렇다면 막연한 실패 대신 자격 등록을 안내(#522). (순수)
//  git 은 영문 stderr 를 낸다: HTTPS 무자격/오자격·SSH publickey 거부·private 레포 은닉(not found) 등을 폭넓게 포착.
export function isAuthError(err: unknown): boolean {
  const s = String(err ?? "");
  return /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)|HTTP Basic: Access denied|Invalid username or (token|password)|could not read from remote repository|repository (?:'[^']*' )?not found|could not be found|Access denied|403 Forbidden|401 Unauthorized/i.test(s);
}

// git 실패의 '안전한' 한 줄 요약 — 스캔 요약/로그 관측성용(#606). 원격 URL·토큰은 절대 안 싣는다:
//  fs 오류(mkdir EACCES 등)는 코드·syscall·로컬경로(시크릿 아님)를, git stderr 는 첫 줄에서 URL/scp·자격을 스크럽해 남긴다.
export function describeGitError(err: unknown, gitUrl?: string | null): string {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown; killed?: boolean; signal?: unknown; syscall?: unknown; path?: unknown };
  if (e?.killed || e?.signal === "SIGKILL" || e?.signal === "SIGTERM") return "timeout";
  // fs/spawn 레벨(mkdir·spawn 등): code 가 문자열(EACCES/ENOENT…)이고 syscall 있음 — 로컬경로만 노출(원격 URL 아님).
  if (typeof e?.code === "string" && e?.syscall) {
    return `${e.code} (${e.syscall}${e.path ? " " + String(e.path) : ""})`.slice(0, 200);
  }
  let s = String(e?.stderr || e?.message || err || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  if (gitUrl) s = s.split(String(gitUrl)).join("<repo>");            // 등록된 실제 git_url 제거(https 토큰 포함 가능)
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")               // scheme://… (자격 포함 가능)
       .replace(/[\w.-]+@[\w.-]+:\S*/g, "<url>");                     // scp 형 user@host:path
  return s.trim().slice(0, 200) || "unknown";
}

// 자격 주입 준비(#540) — 게이트웨이/멤버 자격을 그 git 호출에만 주입.
//  SSH: 개인키를 임시 700 디렉에 600 으로 쓰고 GIT_SSH_COMMAND -i. HTTPS: GIT_ASKPASS 스크립트 + 토큰.
//  둘 다 호출 뒤 cleanup 으로 즉시 삭제(디스크에 시크릿 잔존 최소화). 자격 없으면 no-op(앰비언트 폴백).
export interface GitAuth { env?: Record<string, string>; cleanup: () => Promise<void>; }
export async function prepareGitAuth(secret: GitCredentialSecret | null): Promise<GitAuth> {
  const noop: GitAuth = { cleanup: async () => { /* */ } };
  if (!secret) return noop;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-gitauth-"));
  await fsp.chmod(dir, 0o700).catch(() => { /* */ });
  const cleanup = async () => { await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* */ }); };
  try {
    if (secret.kind === "ssh" && secret.ssh_private_key) {
      const keyFile = path.join(dir, "id");
      const key = secret.ssh_private_key.endsWith("\n") ? secret.ssh_private_key : secret.ssh_private_key + "\n";
      await fsp.writeFile(keyFile, key, { mode: 0o600 });
      await fsp.chmod(keyFile, 0o600).catch(() => { /* */ });
      const known = path.join(dir, "known_hosts");
      // IdentitiesOnly=yes → 주입 키만(에이전트/기본키 무시). accept-new → 첫 접속 호스트키 자동수락(무인).
      const sshCmd = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${known} -o BatchMode=yes`;
      return { env: { GIT_SSH_COMMAND: sshCmd, GIT_TERMINAL_PROMPT: "0" }, cleanup };
    }
    if (secret.kind === "https" && secret.https_token) {
      const askpass = path.join(dir, "askpass.sh");
      // git 이 Username/Password 를 물으면 $1 프롬프트로 분기(대소문자 무관). 시크릿은 env 로만 전달(argv·로그 노출 없음).
      const script = "#!/bin/sh\ncase \"$1\" in\n*[Uu]sername*) printf '%s' \"$GIT_CRED_USER\" ;;\n*) printf '%s' \"$GIT_CRED_PASS\" ;;\nesac\n";
      await fsp.writeFile(askpass, script, { mode: 0o700 });
      await fsp.chmod(askpass, 0o700).catch(() => { /* */ });
      return {
        env: {
          GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0",
          GIT_CRED_USER: secret.https_username || "x-access-token",
          GIT_CRED_PASS: secret.https_token,
        },
        cleanup,
      };
    }
    await cleanup();
    return noop;
  } catch (e) {
    await cleanup();
    throw e;
  }
}