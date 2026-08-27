// git 자격 스토어(#540) — 레포 클론·세션 git 용 SSH/HTTPS 자격을 DB에 저장·조회.
//  시크릿(개인키·토큰)은 secret-box(CONNECTOR_SECRET_KEY, #541 공용) 봉투 암호화로만 저장, 공개키는 평문.
//  owner = 'gateway'(조직 머신 계정) | 'member:<id>'(개별 사용자).
//  - 게이트웨이 provision 클론: resolveGitSecret(memberId, host) = 멤버 자격 우선, 없으면 gateway 폴백.
//  - 세션 안 git: 멤버 자격을 멤버 홈에 materialize(별도 모듈, Slice 2).
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { itemsPool } from "../../db/client.js";
import { encryptSecret, decryptSecret } from "./secret-box.js";

export const GATEWAY_OWNER = "gateway";
export type GitCredKind = "ssh" | "https";
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/; // git 호스트명(github.com 등) — 경로/인젝션 표면 없음

export function memberOwner(memberId: string): string { return `member:${memberId}`; }
export function normalizeHost(host: unknown): string {
  const h = String(host ?? "").trim().toLowerCase() || "github.com";
  if (!HOST_RE.test(h)) throw new Error(`git 호스트명 형식 오류: ${h}`);
  return h;
}

// 웹 노출용(시크릿 없음) — 공개키·존재 플래그만.
export interface GitCredentialPublic {
  owner: string; host: string; kind: GitCredKind;
  ssh_public_key: string | null;
  https_username: string | null;
  has_ssh_private: boolean;
  has_https_token: boolean;
  label: string | null;
  created_at: string | null; updated_at: string | null; updated_by: string | null; last_used_at: string | null;
}
// 내부용(복호 포함) — provision 주입·materialize 만 사용. 절대 응답 body 로 내보내지 않는다.
export interface GitCredentialSecret {
  owner: string; host: string; kind: GitCredKind;
  ssh_public_key: string | null; ssh_private_key: string | null;
  https_username: string | null; https_token: string | null;
}

function toPublic(r: any): GitCredentialPublic {
  return {
    owner: r.owner, host: r.host, kind: r.kind,
    ssh_public_key: r.ssh_public_key ?? null,
    https_username: r.https_username ?? null,
    has_ssh_private: !!r.ssh_private_key_enc,
    has_https_token: !!r.https_token_enc,
    label: r.label ?? null,
    created_at: r.created_at ?? null, updated_at: r.updated_at ?? null,
    updated_by: r.updated_by ?? null, last_used_at: r.last_used_at ?? null,
  };
}

export async function getGitCredentialPublic(owner: string, host: string): Promise<GitCredentialPublic | null> {
  const h = normalizeHost(host);
  const r = await itemsPool.query("SELECT * FROM git_credential WHERE owner=$1 AND host=$2", [owner, h]);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

export async function listGitCredentialsPublic(owner: string): Promise<GitCredentialPublic[]> {
  const r = await itemsPool.query("SELECT * FROM git_credential WHERE owner=$1 ORDER BY host", [owner]);
  return r.rows.map(toPublic);
}

// SSH 자격 upsert — publicKey 평문, privateKey 봉투 암호화. kind='ssh'.
export async function setSshCredential(
  owner: string, host: unknown, input: { publicKey: string; privateKey: string; label?: string | null }, actor: string,
): Promise<GitCredentialPublic> {
  const h = normalizeHost(host);
  const pub = String(input.publicKey || "").trim();
  const priv = String(input.privateKey || "");
  if (!pub || !priv) throw new Error("SSH 공개키·개인키가 모두 필요합니다");
  const enc = encryptSecret(priv);
  await itemsPool.query(
    `INSERT INTO git_credential(owner,host,kind,ssh_public_key,ssh_private_key_enc,https_username,https_token_enc,label,updated_at,updated_by)
       VALUES($1,$2,'ssh',$3,$4,NULL,NULL,$5,now(),$6)
     ON CONFLICT (tenant_id, owner,host) DO UPDATE SET
       kind='ssh', ssh_public_key=EXCLUDED.ssh_public_key, ssh_private_key_enc=EXCLUDED.ssh_private_key_enc,
       https_username=NULL, https_token_enc=NULL, label=EXCLUDED.label, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [owner, h, pub, enc, input.label ?? null, actor],
  );
  return (await getGitCredentialPublic(owner, h))!;
}

// HTTPS 자격 upsert — username 평문(선택), token 봉투 암호화. kind='https'.
export async function setHttpsCredential(
  owner: string, host: unknown, input: { username?: string | null; token: string; label?: string | null }, actor: string,
): Promise<GitCredentialPublic> {
  const h = normalizeHost(host);
  // ⚠ trim 필수 — 복붙한 PAT 엔 꼬리 개행/앞 공백이 딸려온다. 이 토큰은 GIT_ASKPASS 스크립트가
  //  printf '%s' "$GIT_CRED_PASS" 로 git 에 '그대로' 넘긴다 — HTTP 헤더(undici 가 값을 정규화해줌)와 달리
  //  아무도 안 고쳐주므로, 개행 한 칸이 그대로 비밀번호에 실려 나가 클론이 인증 실패한다. 시크릿은 비노출이라
  //  "토큰은 맞는데 왜 인증 실패" 로 시간을 태운다(#825 진단 중 발견 — member_secret 도 같이 고침).
  const token = String(input.token || "").trim();
  if (!token) throw new Error("HTTPS 토큰이 필요합니다");
  const enc = encryptSecret(token);
  const user = input.username ? String(input.username).trim() : null;
  await itemsPool.query(
    `INSERT INTO git_credential(owner,host,kind,ssh_public_key,ssh_private_key_enc,https_username,https_token_enc,label,updated_at,updated_by)
       VALUES($1,$2,'https',NULL,NULL,$3,$4,$5,now(),$6)
     ON CONFLICT (tenant_id, owner,host) DO UPDATE SET
       kind='https', ssh_public_key=NULL, ssh_private_key_enc=NULL,
       https_username=EXCLUDED.https_username, https_token_enc=EXCLUDED.https_token_enc,
       label=EXCLUDED.label, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [owner, h, user, enc, input.label ?? null, actor],
  );
  return (await getGitCredentialPublic(owner, h))!;
}

export async function deleteGitCredential(owner: string, host: unknown): Promise<boolean> {
  const h = normalizeHost(host);
  const r = await itemsPool.query("DELETE FROM git_credential WHERE owner=$1 AND host=$2", [owner, h]);
  return (r.rowCount ?? 0) > 0;
}

// 내부 — 복호 포함 조회(주입·materialize 전용). last_used_at 갱신(best-effort).
export async function getGitSecret(owner: string, host: string): Promise<GitCredentialSecret | null> {
  const h = normalizeHost(host);
  const r = await itemsPool.query("SELECT * FROM git_credential WHERE owner=$1 AND host=$2", [owner, h]);
  const row = r.rows[0];
  if (!row) return null;
  itemsPool.query("UPDATE git_credential SET last_used_at=now() WHERE owner=$1 AND host=$2", [owner, h]).catch(() => {});
  return {
    owner: row.owner, host: row.host, kind: row.kind,
    ssh_public_key: row.ssh_public_key ?? null,
    ssh_private_key: row.ssh_private_key_enc ? decryptSecret(row.ssh_private_key_enc) : null,
    https_username: row.https_username ?? null,
    https_token: row.https_token_enc ? decryptSecret(row.https_token_enc) : null,
  };
}

// provision 클론 주입용 — 요청 멤버 자격 우선, 없으면 게이트웨이 머신 자격 폴백, 둘 다 없으면 null(앰비언트).
//  ⚠ **게이트웨이 프로세스 안에서 클론할 때 전용**이다. 조직 공용 자격으로 폴백하므로, 이 결과를 다른 머신으로
//   내보내면 안 된다 — 원격 노드로 보낼 자격은 아래 leaseGitSecretForNode 를 써라(#905 C4).
export async function resolveGitSecret(
  memberId: string | null | undefined, host: string,
  //  repoFullName(owner/repo) — GitHub App 폴백이 토큰을 그 레포로 좁히는 데 쓴다(#1881 G8). 없어도 동작한다.
  opts?: { repoFullName?: string | null },
): Promise<GitCredentialSecret | null> {
  const h = normalizeHost(host);
  if (memberId) {
    const mine = await getGitSecret(memberOwner(memberId), h);
    if (mine) return mine;
  }
  const gw = await getGitSecret(GATEWAY_OWNER, h);
  if (gw) return gw;
  //  ── 등록된 git 자격이 하나도 없을 때만 여기까지 온다(#1881 G8) ──
  //  [GitHub 연결]만 한 사람에겐 SSH 키도 HTTPS 토큰도 없다. 그런데 설치는 있으므로 그 자리에서 installation
  //  token 을 찍어 쓴다 — 저장하지 않는다(1시간 만료라 저장하면 한 시간 뒤 전부 죽는다).
  //  ⚠ 기존 자격이 있으면 여기 오지 않는다: 이 폴백은 종전 동작을 **덮지 않는다**(무회귀).
  const { githubAppGitSecret } = await import("./github-app-git.js");
  return (await githubAppGitSecret(h, opts?.repoFullName).catch(() => null)) as GitCredentialSecret | null;
}

// 🔴 **원격 노드로 내보낼** git 자격(#905 C4) — 노드 종류가 신뢰경계를 가른다. 조직 폴백은 여기서만 판정한다.
//  · member 노드 = **멤버 개인 노트북** → 본인 자격만. 조직 공용 키를 개인 머신에 보내면 그 머신 주인이 조직
//    전체 레포 권한을 쥔다 — 권한 상승이고 한 번 나간 키는 회수할 수 없다. (선례: 하네스 자격 리스도
//    getMemberSecret(t.requester) 로 본인 것만 싣는다 — node/task-scheduler.ts.)
//  · worker 노드 = **조직이 세운 공용 실행기**(admin 만 등록) → 조직 자격 폴백 허용(2026-07-19 윤상민 결정).
//    개인 머신이 아니라 조직이 소유·통제하는 인프라라, 게이트웨이 안에서 클론하는 것과 신뢰경계가 같다.
//  null 이면 자격 없이 보낸다 → 공개 레포는 클론되고, 비공개면 노드의 git 이 인증 실패를 정확한 사유로 보고한다.
//  ⚠ 이 함수가 노드로 나가는 자격의 **유일한 관문**이다 — 호출자(스케줄러·라우트)가 GATEWAY_OWNER 를 직접
//   집으면 이 정책을 우회한다. 그래서 org-fallback 결정을 이 한 곳에 가둔다(스케줄러는 이 함수만 부른다).
export async function leaseGitSecretForNode(
  requesterId: string, host: string, nodeKind: "member" | "worker",
): Promise<GitCredentialSecret | null> {
  const h = normalizeHost(host);
  if (requesterId) {
    const mine = await getGitSecret(memberOwner(requesterId), h);
    if (mine) return mine;
  }
  return nodeKind === "worker" ? getGitSecret(GATEWAY_OWNER, h) : null;
}

// ── git 호스트/자격주입 헬퍼는 잎 모듈로 옮겼다(#2165 — git-auth-prepare.ts). 기존 import 경로 보존용 re-export.
//  ⚠ 새 호출부는 `git-auth-prepare.js` 를 직접 import 하라 — 이 모듈을 거치면 DB(itemsPool)·GitHub App 자격이 함께 딸려온다.
export { hostOf, isAuthError, describeGitError, prepareGitAuth, type GitAuth } from "./git-auth-prepare.js";

// ── SSH 키페어 생성(ed25519) — 박스가 생성하고 개인키는 박스 밖으로 안 나간다(공개키만 반환·저장).
//  Node crypto 는 OpenSSH 개인키 포맷 export 를 못 하므로 ssh-keygen 바이너리를 쓴다(박스에 존재).
//  임시 파일은 게이트웨이 홈 밑 700 디렉에 만들고 즉시 삭제.
export async function generateSshKeypair(comment: string): Promise<{ publicKey: string; privateKey: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-ssh-"));
  try {
    await fsp.chmod(dir, 0o700).catch(() => {});
    const keyPath = path.join(dir, "id_ed25519");
    const safeComment = String(comment || "lively").replace(/[^A-Za-z0-9._@-]/g, "-").slice(0, 64) || "lively";
    await new Promise<void>((resolve, reject) => {
      const p = spawn("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", safeComment, "-f", keyPath], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => { err += d; });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ssh-keygen 실패: " + err.trim()))));
    });
    const [privateKey, publicKey] = await Promise.all([
      fsp.readFile(keyPath, "utf8"),
      fsp.readFile(keyPath + ".pub", "utf8"),
    ]);
    return { publicKey: publicKey.trim(), privateKey };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
