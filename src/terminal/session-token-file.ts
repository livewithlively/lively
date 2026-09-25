// terminal/session-token-file.ts — **세션 토큰 파일**(리프): 이미 떠 있는 세션에 게이트웨이가 나중에 구운 세션 스코프 자격을 심는 자리. (#4135)
//
//  ── 왜 ──
//  세션 훅·MCP 토큰(LIVELY_TOKEN·LIVELY_MCP_TOKEN)은 판(pane)을 띄울 때 env 로 한 번만 실린다. 살아 있는 프로세스의 env 는 못 바꾸므로,
//  토큰 없이 뜬 세션(이 변경 전의 모든 노드 세션)이나 게이트웨이가 자격을 다시 정한 세션에는 닿을 길이 없었다.
//  그래서 **파일**이 하나 더 있다: `<HOME>/.lively/session-tokens/<세션id>.json` = { hook, mcp }. 훅(kit/hooks — harness-registry
//  sessionTokenFromFile)과 MCP 프록시(kit/cli/lively-mcp-*)는 매 호출 이 파일을 **먼저** 보고, 없으면 종전 순서(env → 공유 파일)로 떨어진다.
//  파일이 env 보다 앞인 이유: env 는 띄울 때의 스냅샷이고 파일은 게이트웨이가 **그 뒤에** 정한 정본이다.
//  ── 누가 쓰나 ── 노드 에이전트가 게이트웨이의 `sessionTokens` op(session-ops.ts)를 받아 쓴다. 게이트웨이는 노드 스냅샷에서
//  토큰 없는 살아 있는 세션을 보면 그 주인 앞으로 구워 보낸다(node-session-token-backfill.ts). kill 때 파일을 지운다.
//  ── 노출면 ── env 주입과 같다(그 PC 사용자가 읽을 수 있다 — 0600). 공유 노드의 신뢰 전제는 node-session-preissue 머리말.
//  ⚠ 노드 에이전트 번들에 실린다 — node 내장만 문다.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_ID_RE } from "../org/auth/agent-identity.js";

export interface SessionTokens { hook: string | null; mcp: string | null }

/** 파일 자리 — 훅(kit/hooks/harness-registry sessionTokenFile)과 **같은 규칙**이어야 한다. `home` 은 그 세션의 훅이 보는 HOME. */
export function sessionTokenFilePath(id: string, home = process.env.LIVELY_HOME || os.homedir()): string | null {
  if (!SESSION_ID_RE.test(id)) return null;
  return path.join(home, ".lively", "session-tokens", `${id}.json`);
}

/** 심는다(원자적 — 임시 파일 뒤 rename · 0600 · 폴더 0700). 둘 다 null 이면 심지 않고 있던 파일을 지운다. 돌려주는 값 = 심었나. */
export async function writeSessionTokens(id: string, tokens: SessionTokens, home?: string): Promise<boolean> {
  const file = sessionTokenFilePath(id, home);
  if (!file) throw new Error(`세션 id 형식 오류: ${id}`);
  const hook = typeof tokens.hook === "string" && tokens.hook.trim() ? tokens.hook.trim() : null;
  const mcp = typeof tokens.mcp === "string" && tokens.mcp.trim() ? tokens.mcp.trim() : null;
  if (!hook && !mcp) { await fsp.rm(file, { force: true }); return false; }
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify({ hook, mcp, at: Date.now() }), { mode: 0o600 });
    await fsp.rename(tmp, file);
  } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => { /* 목적지는 무손상 */ }); throw e; }
  return true;
}

/** 세션이 죽었다 — 파일을 지운다(토큰 회수는 게이트웨이 몫). 없어도 조용하다. */
export async function removeSessionTokens(id: string, home?: string): Promise<void> {
  const file = sessionTokenFilePath(id, home);
  if (!file) return;
  await fsp.rm(file, { force: true }).catch(() => { /* 비치명 */ });
}
