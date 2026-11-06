// NAS 접속 자격 해소 — 서버 주소는 관리자 칸, 로그인은 구성원 본인 칸에서만 읽는다.
//
//  · 서버: org_credential(owner=gateway) kind=nas_ftp_server, meta {host, port}. 구성원 칸은 보지 않는다 —
//    구성원이 주소를 정할 수 있으면 게이트웨이를 사설망 아무 곳에나 붙이는 통로(SSRF)가 된다.
//  · 로그인: 구성원 본인 칸 kind=nas_ftp, secret=FTP 비밀번호, meta {username}. 통합(게이트웨이) 폴백 없음 —
//    남의 계정이나 공용 계정으로 열리면 «본인 권한 범위 안에서만 본다»는 이 기능의 전제가 깨진다.
//  · 매니지드(게이트웨이 하나가 여러 테넌트를 서빙)에서는 꺼 둔다. 주소를 정하는 «관리자»가 우리 고객이라,
//    켜 두면 고객이 우리 인프라 안쪽(클러스터 내부 이름 등)으로 TCP 를 열고 구성원 FTP 비밀번호를 평문으로 보내게 된다.
//  · 관리자가 정한 주소도 연결 전에 풀어서 막힌 대역(게이트웨이 자신·링크로컬·메타데이터 등)이면 붙지 않고,
//    푼 IP 로 연결을 고정한다(pinNasAddress).
import dns from "node:dns/promises";
import net from "node:net";
import { getMemberSecret, resolveMemberSecret, GATEWAY_OWNER } from "../../org/credentials/member-secret-store.js";
import { FtpSession, FtpError, type FtpConnectOpts } from "../ftp/ftp-client.js";
import { encodeRawPath } from "../ftp/ftp-list.js";
import { isBlockedIp } from "../ssrf.js";
import { NasIndexCache, INDEX_MAX_CONCURRENT_BUILDS } from "./nas-index.js";
import { currentTenant } from "../../org/tenant-context.js";
import { managedMode } from "../../org/tenancy/state.js";
import { logger } from "../../log.js";

export const NAS_SERVER_KIND = "nas_ftp_server";
export const NAS_LOGIN_KIND = "nas_ftp";

export class NasConfigError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "NasConfigError"; }
}

export interface NasServer { host: string; port: number }
export interface NasLogin { username: string; password: string }

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const NAS_MANAGED_OFF =
  "NAS 파일 도구(nas_find·nas_list·내려받기)는 자체 호스팅 게이트웨이에서만 쓸 수 있습니다 — 게이트웨이가 조직 NAS 에 직접 FTP 로 접속하는 기능이라 매니지드 워크스페이스에서는 꺼 두었습니다";

export async function resolveNasServer(): Promise<NasServer> {
  // 세 경로(nas_find·nas_list·내려받기)가 모두 서버 주소를 여기서만 얻으므로 매니지드 차단도 여기 둔다 — 새 경로도 이 문을 지나야 NAS 에 닿는다.
  if (managedMode()) throw new NasConfigError(NAS_MANAGED_OFF, 501);
  const row = await getMemberSecret(GATEWAY_OWNER, NAS_SERVER_KIND, "");
  const meta = (row?.meta ?? {}) as { host?: unknown; port?: unknown };
  const host = typeof meta.host === "string" ? meta.host.trim() : "";
  const port = meta.port === undefined ? 21 : Number(meta.port);
  if (!row || !host) {
    throw new NasConfigError(
      `NAS 서버가 설정되지 않았습니다 — 관리자가 org_credential(kind=${NAS_SERVER_KIND}, meta {host, port})을 등록해야 합니다. ` +
        "평문 FTP 라 비밀번호가 암호화 없이 오가므로 게이트웨이와 같은 사설망에 있는 NAS 만 등록하세요",
      503,
    );
  }
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

export interface NasAccess { server: NasServer; login: NasLogin }

/** 서버 → 내 로그인 순서로 푼다. 서버(매니지드 차단 포함)가 먼저라 꺼진 배포에서는 구성원 비밀번호를 복호하지 않는다. */
export async function resolveNasAccess(memberId: string): Promise<NasAccess> {
  const server = await resolveNasServer();
  const login = await resolveNasLogin(memberId);
  return { server, login };
}

// ── 연결 전 주소 가드 ─────────────────────────────────────────────────────────────────────────

const isRfc1918 = (ip: string): boolean => {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
};

/**
 * NAS 로 붙으면 안 되는 주소인가. ssrf.ts 의 isBlockedIp 에서 RFC1918 사설 대역만 연다 — 자체 호스팅 NAS 의 정상 자리다
 *  (isBlockedIp 는 http_proxy 용이라 사설 대역까지 막는다). 남는 것: loopback(게이트웨이 자신)·link-local(169.254.169.254
 *  메타데이터 포함)·unspecified·multicast·예약 대역·v4-mapped 로 감싼 그 주소들. CGNAT(100.64/10)·ULA(fc00::/7)도 막힌 채다 —
 *  그 안에 클라우드 메타데이터(100.100.100.200·fd00:ec2::254)가 있다.
 */
export function nasAddressBlocked(ip: string): boolean {
  return isBlockedIp(ip) && !isRfc1918(ip);
}

export type NasLookup = (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
const systemLookup: NasLookup = (host) => dns.lookup(host, { all: true, verbatim: true });

/**
 * NAS 이름을 한 번 풀어 연결할 IP 하나를 고른다. 막힌 대역의 답은 건너뛰고, 열리는 답이 없으면 설정 오류로 거절한다
 *  (응답 문구에 IP 는 싣지 않는다 — 관리자가 볼 수 있게 로그에만). IPv4 를 먼저 고른다 — 데이터 연결을 IPv4 전용 명령인
 *  PASV 로만 연다(ftp-client).
 */
export async function pinNasAddress(host: string, lookup: NasLookup = systemLookup): Promise<string> {
  const answers = await lookup(host);
  const open = answers.filter((a) => !nasAddressBlocked(a.address));
  const pick = open.find((a) => a.family === 4) ?? open[0];
  if (!pick) {
    logger.warn({ host, answers: answers.map((a) => a.address) }, "[nas] NAS 주소가 막힌 대역으로만 풀림");
    throw new NasConfigError(
      `NAS 서버 주소(${NAS_SERVER_KIND})가 게이트웨이 자신·링크로컬·멀티캐스트 같은 막힌 대역을 가리킵니다 — 관리자가 사설망 NAS 의 주소로 고쳐야 합니다`,
      503,
    );
  }
  return pick.address;
}

export interface NasConnectDeps {
  lookup?: NasLookup;
  connect?: (o: FtpConnectOpts) => Promise<FtpSession>;
}

/**
 * 주소 가드를 지나 고른 IP 로 붙는다. 이름으로 다시 붙으면 검사와 연결 사이에 DNS 답이 바뀔 수 있다(재바인딩).
 *  데이터 연결도 같은 IP 로 간다 — ftp-client 는 PASV 의 주소 대신 제어 연결의 host 로 데이터 연결을 연다.
 */
export async function connectNas(server: NasServer, login: NasLogin, deps: NasConnectDeps = {}): Promise<FtpSession> {
  const address = await pinNasAddress(server.host, deps.lookup);
  const connect = deps.connect ?? ((o: FtpConnectOpts) => FtpSession.connect(o));
  return connect({ host: address, port: server.port, user: login.username, password: login.password });
}

export async function openNasSession(memberId: string): Promise<{ session: FtpSession; username: string }> {
  const { server, login } = await resolveNasAccess(memberId);
  return { session: await connectNas(server, login), username: login.username };
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
// 서버(host:port)도 넣는다 — 관리자가 NAS 주소를 바꾸면 옛 서버의 색인을 내주지 않게.
export const nasIndexKey = (memberId: string, username: string, server: NasServer): string =>
  [currentTenant()?.id ?? "_", memberId, username, `${server.host}:${server.port}`].join("\u0000");

export const NAS_DOWNLOAD_PATH = "/api/ui/me/nas/file";

/** 사람이 브라우저에서 여는 내려받기 경로(게이트웨이 기준 상대). 절대 주소는 호출부가 붙인다. */
export function nasDownloadPath(raw: string): string {
  return `${NAS_DOWNLOAD_PATH}?p=${encodeRawPath(raw)}`;
}
