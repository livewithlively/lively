// delivery ▸ git-credentials — 본인(me/*)·게이트웨이(org/*) git 자격 등록·조회·삭제(#540/#1077).
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { memberOsStatus } from "../../terminal/terminal-sessions.js";
import {
  GATEWAY_OWNER, memberOwner, listGitCredentialsPublic, setSshCredential, setHttpsCredential, deleteGitCredential, generateSshKeypair,
  type GitCredentialPublic
} from "../../org/credentials/git-credential-store.js";
// #1077 등록 직후 홈 즉시 반영 — materialize(홈 쓰기) + 그 멤버의 격리 계정 해소(ready·provisioned·osUser).
import { materializeMemberGit } from "../../org/credentials/git-credential-materialize-gateway.js";   // #2165 — DB 를 타는 조각은 게이트웨이 모듈에
import { secretsEnabled } from "../../org/credentials/secret-box.js";
import { actorOf, restOnly, restRead, str } from "./shared.js";

// git 자격 등록(#540) 입력 파싱·적용 — self(me/*)·gateway(org/*) 공용. SSH 는 박스가 키페어 생성(개인키 박스밖 유출 없음),
//  HTTPS 는 토큰. 시크릿은 secret-box 봉투 암호화로 DB 저장(secretsEnabled 아니면 503 — 평문 저장 금지).
const GIT_HOST_RE = /^[a-z0-9.-]{1,253}$/;
function parseGitHost(input: Record<string, unknown>): string {
  const raw = (input.host === undefined || input.host === null || String(input.host).trim() === "") ? "github.com" : String(input.host).trim().toLowerCase();
  if (!GIT_HOST_RE.test(raw)) throw new HttpError(400, "git 호스트명 형식이 올바르지 않습니다 (예: github.com)");
  return raw;
}
async function applyGitCredential(owner: string, input: Record<string, unknown>, actor: string): Promise<{ credential: GitCredentialPublic; public_key?: string }> {
  if (!secretsEnabled()) throw new HttpError(503, "CONNECTOR_SECRET_KEY 가 설정되지 않아 자격을 저장할 수 없습니다 — 관리자에게 게이트웨이 env(CONNECTOR_SECRET_KEY) 설정을 요청하세요.");
  const host = parseGitHost(input);
  const kind = str(input.kind, "kind", 10).trim();
  const label = input.label === undefined || input.label === null ? null : str(input.label, "label", 200).trim();
  if (kind === "ssh") {
    // SSH: 박스가 ed25519 키페어 생성 — 개인키는 DB(암호화)에만, 공개키만 반환·저장(사용자가 GitHub 에 등록).
    const kp = await generateSshKeypair(`${owner}@lively-box`);
    const credential = await setSshCredential(owner, host, { publicKey: kp.publicKey, privateKey: kp.privateKey, label }, actor);
    return { credential, public_key: kp.publicKey };
  }
  if (kind === "https") {
    const token = str(input.token, "token", 4000);
    if (!token.trim()) throw new HttpError(400, "HTTPS 토큰이 필요합니다");
    const username = input.username === undefined || input.username === null ? null : str(input.username, "username", 200).trim();
    const credential = await setHttpsCredential(owner, host, { username, token, label }, actor);
    return { credential };
  }
  throw new HttpError(400, "kind 는 ssh|https 여야 합니다");
}

// 등록·삭제 직후 그 멤버의 격리 홈에 즉시 반영(#1077). materialize 는 세션이 아니라 **홈**(~/.ssh·~/.lively)에 쓰고
//  그 멤버의 모든 세션이 같은 홈을 보므로, 이미 열려 있는 세션에서도 다음 git 호출부터 바로 먹는다(재접속 불요).
//  createSession 에도 같은 호출이 있다(세션 시작 시 최신 DB 상태로 재생성) — 여기는 세션이 떠 있는 동안의 변경을 메운다.
//  best-effort: 격리 미준비(비-Linux 개발박스 등)·미프로비저닝 멤버면 조용히 건너뛴다. 실패해도 DB 등록 자체는 성립하고
//  다음 세션에서 어차피 반영되므로, 여기서 던져 등록을 실패로 만들지 않는다.
//  evenIfEmpty: 삭제 경로에서만 true — 마지막 자격을 지웠을 때도 홈에 뿌려둔 키를 거두기 위해서다(자격 0건이면
//  materialize 가 기본적으로 no-op 이라, 안 주면 "지웠는데 홈에선 계속 쓸 수 있는" 상태가 남는다).
async function syncMemberGitHome(memberId: string, evenIfEmpty = false): Promise<void> {
  try {
    const st = await memberOsStatus(memberId);
    if (!st.ready || !st.provisioned) return;
    await materializeMemberGit(st.osUser, memberId, { evenIfEmpty });
  } catch (e) {
    console.warn(`[git-credential] 홈 즉시 반영 실패(${memberId}) — 등록은 성립, 다음 세션에서 반영됨:`, (e as Error)?.message ?? e);
  }
}

export const gitCredentialCapabilities: Capability[] = [
  // ── git 자격(#540) — 레포 클론·세션 git 용 SSH/HTTPS 자격. 본인 자가등록(me/*, 인증만) + 게이트웨이 머신계정(org/*, admin). ──
  //  provision 클론은 요청 멤버 자격(없으면 gateway)을 주입, 세션 안 git 은 멤버 자격을 멤버 홈에 materialize(Slice 2).
  //  #1077: me_* 를 MCP 에도 노출(mcp=true) + 등록·삭제 직후 즉시 materialize.
  //   그 전엔 웹 UI 가 유일한 표면이라, 세션 안에서 클론이 막힌 사람은 브라우저로 나가 등록하고 **세션을 새로 떠야** 했다
  //   (materialize 가 createSession 에만 있었으므로). 그 왕복 때문에 실사용에선 셸 `ssh-keygen` 으로 홈에 키를 직접
  //   만드는 우회가 나왔고 — 되긴 되지만 자격이 DB 밖이라 관리탭·회수·재프로비저닝 복원에서 전부 빠졌다.
  //   → 에이전트가 세션 안에서 대행하고 그 자리에서 반영되게 한다. input 스키마는 #923 규약(helper 통째전달은 손선언).
  restRead("me_git_credential_get", "내 git 인증 조회",
    "현재 로그인한 구성원의 등록된 git 자격(호스트·종류·SSH 공개키·존재 플래그)을 반환한다 — 시크릿(개인키·토큰)은 절대 반환하지 않는다.",
    [{ method: "GET", paths: ["/api/ui/me/git-credential"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      return { credentials: await listGitCredentialsPublic(memberOwner(userId)), encryption_ready: secretsEnabled() };
    }, true),
  restRead("me_git_credential_set", "내 git 인증 등록",
    "본인 git 자격을 등록한다. kind=ssh 면 박스가 키페어를 생성해 공개키를 반환(개인키는 박스밖 유출 없음), kind=https 면 토큰을 저장. host 기본 github.com. " +
    "격리 박스면 등록 즉시 내 홈에 반영되어 이미 열려 있는 세션에서도 바로 쓰인다 — ⚠ kind=ssh 는 새 키페어라, 반환된 공개키를 그 호스트(GitHub·GitLab) 계정에 등록해야 인증이 선다.",
    [{ method: "POST", paths: ["/api/ui/me/git-credential"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const res = await applyGitCredential(memberOwner(userId), input, actorOf(user));
      await syncMemberGitHome(userId);
      return res;
    }, true, {
      // 필드는 applyGitCredential/parseGitHost 가 읽는다(핸들러가 input 을 통째로 넘김) — 거기 바뀌면 여기도 같이(#923 규약4).
      kind: z.enum(["ssh", "https"]).describe("ssh=박스가 ed25519 키페어 생성·공개키 반환(개인키는 박스 밖으로 안 나감) / https=토큰 저장"),
      host: z.string().optional().describe("git 호스트(기본 github.com) — 예: git.example.com"),
      label: z.string().optional().describe("자격 라벨(메모용)"),
      token: z.string().optional().describe("kind=https 일 때 필수 — 개인 액세스 토큰(봉투 암호화 저장)"),
      username: z.string().optional().describe("kind=https 일 때 사용자명(선택)"),
    }),
  restRead("me_git_credential_delete", "내 git 인증 삭제",
    "본인 git 자격을 삭제한다(host 지정, 기본 github.com). 격리 박스면 내 홈의 그 자격도 즉시 회수된다.",
    [{ method: "POST", paths: ["/api/ui/me/git-credential/delete"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const deleted = await deleteGitCredential(memberOwner(userId), parseGitHost(input));
      await syncMemberGitHome(userId, true); // 마지막 한 건을 지운 경우까지 홈에서 거둔다
      return { deleted };
    }, true, {
      host: z.string().optional().describe("삭제할 자격의 git 호스트(기본 github.com) — parseGitHost 가 읽는다"),
    }),
  restOnly("org_git_credential_get", "게이트웨이 git 계정 조회",
    "게이트웨이(조직 머신 계정) git 자격을 조회한다 — provision 클론에서 멤버 자격이 없을 때 폴백으로 쓰인다. 시크릿은 반환하지 않는다.",
    [{ method: "GET", paths: ["/api/ui/org/git-credential"], parse: () => ({}) }],
    async (_input: unknown, _user: LivelyUser) => ({ credentials: await listGitCredentialsPublic(GATEWAY_OWNER), encryption_ready: secretsEnabled() })),
  restOnly("org_git_credential_set", "게이트웨이 git 계정 등록",
    "게이트웨이(조직 머신 계정) git 자격을 등록한다. kind=ssh 면 박스가 키페어 생성·공개키 반환, kind=https 면 토큰 저장.",
    [{ method: "POST", paths: ["/api/ui/org/git-credential"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => applyGitCredential(GATEWAY_OWNER, input, actorOf(user)), {
      // 필드는 applyGitCredential/parseGitHost 가 읽는다(핸들러가 input 을 통째로 넘김) — 거기 바뀌면 여기도 같이.
      kind: z.enum(["ssh", "https"]).describe("ssh=박스가 ed25519 키페어 생성·공개키 반환(개인키는 박스 밖으로 안 나감) / https=토큰 저장"),
      host: z.string().optional().describe("git 호스트(기본 github.com)"),
      label: z.string().optional().describe("자격 라벨(메모용)"),
      token: z.string().optional().describe("kind=https 일 때 필수 — 개인 액세스 토큰(봉투 암호화 저장)"),
      username: z.string().optional().describe("kind=https 일 때 사용자명(선택)"),
    }),
  restOnly("org_git_credential_delete", "게이트웨이 git 계정 삭제",
    "게이트웨이 git 자격을 삭제한다(host 지정, 기본 github.com).",
    [{ method: "POST", paths: ["/api/ui/org/git-credential/delete"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, _user: LivelyUser) => ({ deleted: await deleteGitCredential(GATEWAY_OWNER, parseGitHost(input)) }), {
      host: z.string().optional().describe("삭제할 자격의 git 호스트(기본 github.com) — parseGitHost 가 읽는다"),
    }),
];
