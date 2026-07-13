// 게이트웨이-측 브로커 라우팅(#746 T4, ①) — 멤버 요청을 그 멤버의 브로커 프로세스로 라우팅.
//  lazy 보장: 소켓이 살아있으면 즉시, 아니면 spawner 로 기동(첫 호출에 자동 — '명시적 트리거 불요', 사용자 Q2).
//  spawn 은 기존 격리 특권경로 재사용(sudo -n -u broker_<slug> -- box-spawn), install-isolation ②(broker 그룹·sudoers·provision) 전제.
import { spawn } from "node:child_process";
import { BOX_SPAWN } from "../terminal-isolation.js";
import { brokerCall, type BrokerResponse } from "./client.js";

const SOCK_DIR = process.env.LIVELY_BROKER_SOCK_DIR || "/run/lively-broker";
export const BROKER_USER_PREFIX = "broker_";
export function brokerUser(slug: string): string { return `${BROKER_USER_PREFIX}${slug}`; }
export function brokerSocketPath(slug: string): string { return `${SOCK_DIR}/${slug}.sock`; }

// 프로덕션 spawn argv — 게이트웨이가 잠긴 sudo 로 broker_<slug> 로 브로커 기동(box-spawn 재사용, box_members 와 동형·runas 그룹제한).
export function brokerSpawnArgv(slug: string, entry: string): string[] {
  return ["sudo", "-n", "-u", brokerUser(slug), "--", BOX_SPAWN, "node", entry];
}

export type Spawner = (slug: string) => void | Promise<void>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ping(slug: string, timeoutMs = 1200): Promise<boolean> {
  try { return (await brokerCall(brokerSocketPath(slug), { op: "ping" }, timeoutMs)).ok === true; }
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
  return brokerCall(await ensureBroker(slug, spawner), req);
}

// 기본 spawner(프로덕션) — detached child(sudo→box-spawn→broker). 실패는 ensureBroker 폴링 타임아웃이 처리.
//  ⚠ env 는 box-spawn 이 통과시키는 LIVELY_BROKER_* 화이트리스트로 브로커에 전달(② install-isolation 에서 확정).
export function defaultBrokerSpawner(entry: string, extraEnv: Record<string, string> = {}): Spawner {
  return (slug: string) => {
    const argv = brokerSpawnArgv(slug, entry);
    const child = spawn(argv[0], argv.slice(1), {
      detached: true, stdio: "ignore",
      env: { ...process.env, ...extraEnv, LIVELY_BROKER_MEMBER: slug, LIVELY_BROKER_SOCKET: brokerSocketPath(slug) },
    });
    child.unref();
  };
}
