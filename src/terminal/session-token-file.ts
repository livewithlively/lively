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
//  ── HOME ── 노드 에이전트의 HOME(= 그 PC 에서 라이블리가 띄운 비격리 pane 의 HOME)이다. 격리 세션(멤버 홈)은 HOME 이 달라 이 파일을
//  못 보지만 그쪽은 멤버 키트가 env 로 이미 실었다(무회귀). 훅 쪽 자리 규칙(harness-registry sessionTokenFile)과 같아야 한다 — id 검사만
//  다르다: 여기는 박스 세션 id 형식(SESSION_ID_RE), 훅은 «경로에 안전한가»(어느 하네스든 LIVELY_SESSION_ID 를 그대로 받는다) — 둘 다 경로 조작을 막는다.
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

/** 살아 있지 않은 세션의 파일을 걷는다 — 노드가 3초마다 자기 세션 목록을 확답으로 얻은 뒤 부른다(kill 을 안 거치고 끝난 세션의 파일이
 *  디스크에 남지 않게 — 리뷰 지적). 세션 id 꼴이 아닌 이름은 건드리지 않는다. 돌려주는 값 = 지운 개수. 어떤 실패도 던지지 않는다. */
export async function sweepSessionTokenFiles(liveIds: ReadonlySet<string>, home = process.env.LIVELY_HOME || os.homedir()): Promise<number> {
  //  ★ **빈 목록으로는 아무것도 걷지 않는다** (#4135, 2026-09-28). «살아 있는 세션이 하나도 없다» 는 답은 tmux 가 잠깐 연결을
  //   못 받았을 때도 나온다(`isNoTmuxServer` 는 `error connecting` 도 서버 부재로 읽는다). 그 한 판에 신원 파일이 **전부** 지워지면
  //   게이트웨이는 «이미 실어 줬다» 고 알고 있어 다시 보내지 않았고, 그 세션들은 그 컴퓨터에 깔린 로그인으로 기록을 남겼다
  //   (실측: 맥미니의 원준 세션 10개 · 2026-09-25 21:41~21:51 사이 소실 · 21:52~54 에 list-sessions 실패 4건).
  //   세션이 정말 0개라면 남은 파일은 죽은 세션의 것이고, 그 토큰은 게이트웨이가 거둔다 — 파일이 남아도 쓸 수 없다.
  if (!liveIds.size) return 0;
  const dir = path.join(home, ".lively", "session-tokens");
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!SESSION_ID_RE.test(id) || liveIds.has(id)) continue;
    try { await fsp.rm(path.join(dir, name), { force: true }); removed++; } catch { /* 다음 판에 다시 */ }
  }
  return removed;
}

/** 신원 파일이 있는 세션 id 들 — readdir 한 번. 폴더가 없거나 못 읽으면 빈 집합(= «파일 없음» 이지 «모름» 이 아니다: 폴더는 첫 쓰기 때 생긴다). */
export async function sessionTokenFileIds(home = process.env.LIVELY_HOME || os.homedir()): Promise<Set<string>> {
  const out = new Set<string>();
  let names: string[];
  try { names = await fsp.readdir(path.join(home, ".lively", "session-tokens")); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (SESSION_ID_RE.test(id)) out.add(id);
  }
  return out;
}

/** pane env 출력(`tmux show-environment -t <id>`)에 세션 신원이 실려 있나 — 훅 토큰이든 MCP 토큰이든 하나라도. 순수. */
export function envCarriesSessionToken(showEnvironmentOut: string): boolean {
  return /^LIVELY_(?:MCP_)?TOKEN=\S/m.test(String(showEnvironmentOut || ""));
}

/**
 * 세션 하나가 **세션 신원을 갖고 있나** — 파일이 있거나 pane env 에 실려 떴거나. 순수.
 *  env 를 아직 못 물어본 세션은 `undefined`(모름) — 게이트웨이는 «모름» 에 다시 굽지 않는다(없다는 확답에만).
 */
export function sessionTokenPresence(hasFile: boolean, envKnown: boolean | undefined): boolean | undefined {
  if (hasFile || envKnown === true) return true;
  return envKnown === false ? false : undefined;
}
