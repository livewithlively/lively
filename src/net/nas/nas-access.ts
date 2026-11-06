// NAS 접속 자격 해소 — 서버 주소는 관리자 칸, 로그인은 구성원 본인 칸에서만 읽는다.
//
//  · 서버: org_credential(owner=gateway) kind=nas_ftp_server, meta {host, port}. 구성원 칸은 보지 않는다 —
//    구성원이 주소를 정할 수 있으면 게이트웨이를 사설망 아무 곳에나 붙이는 통로(SSRF)가 된다.
//  · 로그인: 구성원 본인 칸 kind=nas_ftp, secret=FTP 비밀번호, meta {username}. 통합(게이트웨이) 폴백 없음 —
//    남의 계정이나 공용 계정으로 열리면 «본인 권한 범위 안에서만 본다»는 이 기능의 전제가 깨진다.
import { getMemberSecret, resolveMemberSecret, GATEWAY_OWNER } from "../../org/credentials/member-secret-store.js";
import { FtpSession, FtpError } from "../ftp/ftp-client.js";
import { encodeRawPath } from "../ftp/ftp-list.js";
import { NasIndexCache, INDEX_MAX_CONCURRENT_BUILDS } from "./nas-index.js";
import { currentTenant } from "../../org/tenant-context.js";

export const NAS_SERVER_KIND = "nas_ftp_server";
export const NAS_LOGIN_KIND = "nas_ftp";

export class NasConfigError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "NasConfigError"; }
}

export interface NasServer { host: string; port: number }
export interface NasLogin { username: string; password: string }

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function resolveNasServer(): Promise<NasServer> {
  const row = await getMemberSecret(GATEWAY_OWNER, NAS_SERVER_KIND, "");
  const meta = (row?.meta ?? {}) as { host?: unknown; port?: unknown };
  const host = typeof meta.host === "string" ? meta.host.trim() : "";
  const port = meta.port === undefined ? 21 : Number(meta.port);
  if (!row || !host) throw new NasConfigError(`NAS 서버가 설정되지 않았습니다 — 관리자가 org_credential(kind=${NAS_SERVER_KIND}, meta {host, port})을 등록해야 합니다`, 503);
  if (!HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NasConfigError(`NAS 서버 설정(${NAS_SERVER_KIND})의 host·port 형식이 맞지 않습니다`, 503);
  }
  return { host, port };
}

export async function resolveNasLogin(memberId: string): Promise<NasLogin> {
  const row = await resolveMemberSecret(memberId, NAS_LOGIN_KIND, { allowFallback: false });
  const username = typeof row?.meta?.username === "string" ? (row.meta.username as string).trim() : "";
  if (!row || !row.secret || !username) {
    throw new NasConfigError(
      `내 NAS 계정이 등록되지 않았습니다 — me_credential_set {kind:"${NAS_LOGIN_KIND}", secret:"<FTP 비밀번호>", meta:{username:"<FTP 아이디>"}} 로 본인 FTP 계정을 등록하세요`,
      404,
    );
  }
  if (!USER_RE.test(username)) throw new NasConfigError("NAS 아이디 형식이 맞지 않습니다(영문·숫자·._-)", 400);
  return { username, password: row.secret };
}

export async function openNasSession(memberId: string): Promise<{ session: FtpSession; username: string }> {
  const [server, login] = await Promise.all([resolveNasServer(), resolveNasLogin(memberId)]);
  const session = await FtpSession.connect({ host: server.host, port: server.port, user: login.username, password: login.password });
  return { session, username: login.username };
}

// ── 오류 분류 ────────────────────────────────────────────────────────────────────────────────

export interface NasErrorReply {
  status: number;
  /** AI 세션·사람에게 보여도 되는 고정 문구. 원문(소켓 오류의 사설 IP·포트, 서버 응답문, DNS 이름)은 담지 않는다. */
  message: string;
  /** 사람이 고칠 수 있는 예상된 거절(설정·자격·폴더) — 원문을 로그로 남기지 않는다. */
  expected: boolean;
}

/** 오류 → 내보낼 상태·문구. 도구 응답(nas-files)과 색인 상태(nasIndexCache 의 last_error)가 같은 분류를 쓴다. */
export function nasErrorReply(e: unknown): NasErrorReply {
  if (e instanceof NasConfigError) return { status: e.status, message: e.message, expected: true };
  if (e instanceof FtpError && e.code === 530) {
    return { status: 403, message: "NAS 로그인 실패 — 내 nas_ftp 자격의 아이디·비밀번호를 확인하세요(me_credential_set)", expected: true };
  }
  if (e instanceof FtpError && e.code === 550) return { status: 404, message: "NAS 에 그 폴더가 없거나 내 계정으로 열 수 없습니다", expected: true };
  return { status: 502, message: "NAS 에 접속하지 못했습니다 — 잠시 뒤 다시 시도하세요", expected: false };
}

/** 프로세스 하나에 하나 — 구성원별 파일명 색인. 실패는 분류 문구로만 남긴다(nasErrorReply). */
export const nasIndexCache = new NasIndexCache(Date.now, INDEX_MAX_CONCURRENT_BUILDS, (e) => nasErrorReply(e).message);

// 테넌트도 키에 넣는다 — 중앙 모드에서 구성원 id 공간이 테넌트마다 따로일 수 있다(같은 프로세스 캐시를 나눠 쓴다).
export const nasIndexKey = (memberId: string, username: string): string => `${currentTenant()?.id ?? "_"}\u0000${memberId}\u0000${username}`;

export const NAS_DOWNLOAD_PATH = "/api/ui/me/nas/file";

/** 사람이 브라우저에서 여는 내려받기 경로(게이트웨이 기준 상대). 절대 주소는 호출부가 붙인다. */
export function nasDownloadPath(raw: string): string {
  return `${NAS_DOWNLOAD_PATH}?p=${encodeRawPath(raw)}`;
}
