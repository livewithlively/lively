// 노드 에이전트 번들의 **위치와 지문** — 게이트웨이가 서빙하는 바이트가 곧 버전이다(#905 C4 의 모델).
//  종전엔 이 계산이 node/routes.ts 안에 갇혀 있어 registry(WS 경로)가 못 썼다. 노드에게 "너 낡았다"를
//  알려주려면 hello 를 받는 자리에서도 같은 값이 필요하다(#1713) → 여기로 뺀다. 계산은 한 곳뿐이어야
//  판정이 갈리지 않는다("서빙본과 해시 대상이 갈리면 판정이 거짓이 된다" — routes.ts 원주석).
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_BUNDLE = path.join(REPO_ROOT, "dist", "node-agent", "agent.mjs");
export const AGENT_BUNDLE_ROOT = REPO_ROOT;

const TTL_MS = 60_000;   // 배포 때만 바뀌는데 노드 목록·hello 는 자주 온다
let cached: { v: string | null; at: number } | null = null;
export function servedAgentVersion(now: number = Date.now()): string | null {
  if (cached && now - cached.at < TTL_MS) return cached.v;
  let v: string | null = null;
  try { v = createHash("sha256").update(readFileSync(AGENT_BUNDLE)).digest("hex").slice(0, 12); }
  catch { v = null; }   // 번들 미빌드 — '모름'이지 '구버전'이 아니다(agentIsLatest 가 null 로 받는다)
  cached = { v, at: now };
  return v;
}
export const agentBundleExists = (): boolean => existsSync(AGENT_BUNDLE);
