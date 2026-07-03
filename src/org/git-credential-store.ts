// git 자격 스토어(#540) — 레포 클론·세션 git 용 SSH/HTTPS 자격을 DB에 저장·조회.
//  시크릿(개인키·토큰)은 secret-box(CONNECTOR_SECRET_KEY, #541 공용) 봉투 암호화로만 저장, 공개키는 평문.
//  owner = 'gateway'(조직 머신 계정) | 'member:<id>'(개별 사용자).
//  - 게이트웨이 provision 클론: resolveGitSecret(memberId, host) = 멤버 자격 우선, 없으면 gateway 폴백.
//  - 세션 안 git: 멤버 자격을 멤버 홈에 materialize(별도 모듈, Slice 2).
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { itemsPool } from "../items/store.js";
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
     ON CONFLICT (owner,host) DO UPDATE SET
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
  const token = String(input.token || "");
  if (!token) throw new Error("HTTPS 토큰이 필요합니다");
  const enc = encryptSecret(token);
  const user = input.username ? String(input.username).trim() : null;
  await itemsPool.query(
    `INSERT INTO git_credential(owner,host,kind,ssh_public_key,ssh_private_key_enc,https_username,https_token_enc,label,updated_at,updated_by)
       VALUES($1,$2,'https',NULL,NULL,$3,$4,$5,now(),$6)
     ON CONFLICT (owner,host) DO UPDATE SET
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
export async function resolveGitSecret(memberId: string | null | undefined, host: string): Promise<GitCredentialSecret | null> {
  const h = normalizeHost(host);
  if (memberId) {
    const mine = await getGitSecret(memberOwner(memberId), h);
    if (mine) return mine;
  }
  return getGitSecret(GATEWAY_OWNER, h);
}

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
