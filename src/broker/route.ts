// 게이트웨이-측 브로커 라우팅(#746 T4, ①) — 멤버 요청을 그 멤버의 브로커 프로세스로 라우팅.
//  lazy 보장: 소켓이 살아있으면 즉시, 아니면 spawner 로 기동(첫 호출에 자동 — '명시적 트리거 불요', 사용자 Q2).
//  spawn 은 기존 격리 특권경로 재사용(sudo -n -u broker_<slug> -- box-spawn), install-isolation ②(broker 그룹·sudoers·provision) 전제.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { BOX_SPAWN } from "../terminal-isolation.js";
import { brokerCall, type BrokerResponse } from "./client.js";

const SOCK_DIR = process.env.LIVELY_BROKER_SOCK_DIR || "/run/lively-broker";
export const BROKER_USER_PREFIX = "broker_";
export function brokerUser(slug: string): string { return `${BROKER_USER_PREFIX}${slug}`; }
export function brokerSocketPath(slug: string): string { return `${SOCK_DIR}/${slug}.sock`; }

// per-broker 인증 토큰(#746 리뷰 blocking#2) — 크로스-멤버 차단. token(slug)=HMAC(key, slug), key=HKDF(CONNECTOR_SECRET_KEY).
//  게이트웨이만 key 를 알아 임의 slug 토큰 계산 가능. 브로커는 자기 토큰(env LIVELY_BROKER_AUTH)만 알고 검증 → 같은 소켓 그룹이라도
//  broker_A(멤버 RCE 포함)는 broker_B 토큰을 위조 못 함(key 없음). 결정론 유도라 게이트웨이 재시작에도 일관.
function brokerAuthKey(): Buffer {
  const raw = process.env.CONNECTOR_SECRET_KEY?.trim();
  if (!raw) throw new Error("CONNECTOR_SECRET_KEY 미설정 — 브로커 인증 토큰 유도 불가");
  const ikm = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : crypto.createHash("sha256").update(raw, "utf8").digest();
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from("lively-broker-auth-v1"), 32));
}
export function brokerAuthToken(slug: string): string {
  return crypto.createHmac("sha256", brokerAuthKey()).update(slug).digest("base64url");
}

// 프로덕션 spawn argv — 게이트웨이가 잠긴 sudo 로 broker_<slug> 로 브로커 기동(box-spawn 재사용, box_members 와 동형·runas 그룹제한).
export function brokerSpawnArgv(slug: string, entry: string): string[] {
  return ["sudo", "-n", "-u", brokerUser(slug), "--", BOX_SPAWN, "node", entry];
}

export type Spawner = (slug: string) => void | Promise<void>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ping(slug: string, timeoutMs = 1200): Promise<boolean> {
  try { return (await brokerCall(brokerSocketPath(slug), { op: "ping" }, timeoutMs, brokerAuthToken(slug))).ok === true; }
  catch { return false; }
}

// lazy 보장 — 살아있으면 즉시, 아니면 기동 후 소켓 뜰 때까지 폴링. 첫 호출에 자동 기동(명시적 트리거 불요).
export async function ensureBroker(slug: string, spawner: Spawner, timeoutMs = 6000): Promise<string> {
  if (await ping(slug)) return brokerSocketPath(slug);
  await spawner(slug);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await ping(slug, 800)) return brokerSocketPath(slug); await sleep(200); }
  throw new Error(`브로커 기동 실패(소켓 미응답): ${slug}`);
}

// 라우팅 — 멤버 브로커 보장 후 요청 포워딩(exec/mcp). 게이트웨이 capability 가 호출.
export async function routeToBroker(slug: string, req: unknown, spawner: Spawner): Promise<BrokerResponse> {
  return brokerCall(await ensureBroker(slug, spawner), req, undefined, brokerAuthToken(slug));
}

// 멤버↔브로커 공유 작업 베이스 — provision 이 /srv/lively/member-work/<slug>(box_<slug>:m_<slug> 2770)로 만든다.
//  멤버는 여기서 편집, 브로커는 여기서 git/terraform 실행(멤버 홈 700 크레덴셜 격벽과 별개).
const MEMBER_WORK_BASE = process.env.LIVELY_MEMBER_WORK_BASE || "/srv/lively/member-work";
export function brokerWorkroot(slug: string): string { return `${MEMBER_WORK_BASE}/${slug}`; }

export interface BrokerSpawnOpts {
  entry: string;                 // 브로커 진입 js(world-readable 앱경로, 예 /opt/context-ontology/dist/broker/index.js)
  allowedTools?: string[];       // 실행 허용 도구(기본 broker 기본목록)
  internalHosts?: string[];      // mcp-forward 내부 host 허용(SSRF)
}

// 기본 spawner(프로덕션) — detached child(sudo -n -u broker_<slug> -- box-spawn node entry). 실패는 ensureBroker 폴링이 처리.
//  env(LIVELY_BROKER_*)는 sudoers env_keep 로 box-spawn 통과 → 브로커가 config 수신(비밀 아님: 소켓·workroot·툴목록).
export function defaultBrokerSpawner(opts: BrokerSpawnOpts): Spawner {
  return (slug: string) => {
    const argv = brokerSpawnArgv(slug, opts.entry);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LIVELY_BROKER_MEMBER: slug,
      LIVELY_BROKER_SOCKET: brokerSocketPath(slug),
      LIVELY_BROKER_WORKROOT: brokerWorkroot(slug),
      LIVELY_BROKER_ENTRY: opts.entry,
      LIVELY_BROKER_AUTH: brokerAuthToken(slug), // per-broker 인증 토큰 — 브로커가 요청 검증(크로스-멤버 차단, 리뷰#2)
    };
    if (opts.allowedTools?.length) env.LIVELY_BROKER_ALLOWED_TOOLS = opts.allowedTools.join(",");
    if (opts.internalHosts?.length) env.LIVELY_BROKER_INTERNAL_HOSTS = opts.internalHosts.join(",");
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env });
    child.unref();
  };
}
