// 하네스에 등록하는 lively stdio 서버(`lively mcp` · `lively mcp-local`)의 실행 형태 — 순수 함수만 둔다.
//
//  Windows 는 심(lively.cmd) 대신 node.exe 로 lively.mjs 를 바로 띄운다. 보안 솔루션이 cmd.exe·배치 실행을 막는
//  PC 에서는 심이 «'lively.cmd' 프로그램을 실행하지 못했습니다. 액세스가 거부되었습니다» 로 못 뜨고, 그 심을 가리키는
//  MCP 도 함께 죽는다(2026-11-05, 배치 실행 차단 윈도우 노트북). node.exe 는 같은 PC 에서 설치기가 이미 실행했다.
//  ⚠ kit/cli/lively.mjs 의 livelyStdioLaunch 와 같은 규칙이다 — CLI 는 훅 폴더를 정적 import 하지 않는다
//   (부트스트랩이 CLI 만 새로 받는 순간 옛 훅 폴더와 짝이 맞지 않아 CLI 가 통째로 못 뜬다). 두 곳은 같은 표로 시험한다.
//  기존 등록의 교정(correctStdioEntry)은 self-update 만 쓴다 — CLI 의 `lively update` 는 지웠다 다시 등록한다.

/** 절대경로 node.exe 인가 — 드라이브 경로(C:\ · C:/)나 UNC 경로만 받는다. 맨몸 `node` 는 아니다. */
export function isAbsWinNodeExe(p) {
  const s = String(p || "");
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(s) && /[\\/]node\.exe$/i.test(s);
}

/**
 * 등록할 stdio 서버 한 항목. win 이고 nodeExe 가 절대경로 node.exe 면 node 직결, 아니면 종전대로 심.
 * @returns {{ type: "stdio", command: string, args: string[], env: {} }}
 */
export function livelyStdioEntry({ win, shim, nodeExe, cliPath, sub }) {
  if (win && isAbsWinNodeExe(nodeExe)) return { type: "stdio", command: nodeExe, args: [cliPath, sub], env: {} };
  return { type: "stdio", command: shim, args: [sub], env: {} };
}

// Windows 경로는 대소문자·구분자가 섞여 저장될 수 있어 둘 다 정규화해 비교한다.
const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();

/**
 * 이미 등록된 항목이 «우리가 심은 심 직결형» 인가 — 이것만 node 직결로 옮긴다(사람이 손댄 항목은 건드리지 않는다).
 */
export function isOurShimEntry(cur, shim, sub) {
  if (!cur || typeof cur !== "object" || cur.type !== "stdio") return false;
  return norm(cur.command) === norm(shim) && Array.isArray(cur.args) && cur.args.length === 1 && cur.args[0] === sub;
}

/**
 * 이미 등록된 항목이 «우리가 심은 node 직결형인데 그 node.exe 가 사라진» 꼴인가.
 *  node 직결은 설치 때 node 의 절대경로를 굽는다 — 버전이 경로에 든 자리(번들 런타임 node-vX-win-*·volta·fnm 등)면
 *  그 경로가 지워지는 순간 MCP 가 죽는데, 모양이 심 직결형이 아니라 isOurShimEntry 로는 영영 교정 대상이 아니다.
 *  args 가 정확히 [우리 lively.mjs, sub] 일 때만 우리 것으로 본다(사람이 바꾼 항목은 건드리지 않는다).
 *  exists 는 호출자가 준다 — 이 파일은 순수 함수만 둔다(시험은 가짜를 넣는다).
 */
export function isOurDeadNodeEntry(cur, cliPath, sub, exists) {
  if (!cur || typeof cur !== "object" || cur.type !== "stdio" || !isAbsWinNodeExe(cur.command)) return false;
  if (!Array.isArray(cur.args) || cur.args.length !== 2 || norm(cur.args[0]) !== norm(cliPath) || cur.args[1] !== sub) return false;
  return !exists(cur.command);
}

/**
 * 이미 등록된 lively stdio 항목을 지금의 실행 형태(want — livelyStdioEntry 결과)로 교정한다. 교정할 게 없으면 null.
 *  교정 대상 = 우리가 심은 심 직결형(from "shim") · node.exe 가 사라진 node 직결형(from "dead-node") 둘뿐.
 *  바꾸는 건 command·args 뿐이다 — env·timeout·disabled 처럼 사람이 붙인 다른 필드는 그대로 둔다(그건 멤버 값이다).
 *  살아 있는 node 를 가리키는 항목은 지금 node 와 달라도 건드리지 않는다(실행마다 node 가 달라 오가는 일을 막는다).
 * @returns {{ entry: object, from: "shim" | "dead-node" } | null}
 */
export function correctStdioEntry(cur, want, { shim, cliPath, sub, exists }) {
  if (!want || want.type !== "stdio") return null;
  const from = isOurShimEntry(cur, shim, sub) ? "shim" : isOurDeadNodeEntry(cur, cliPath, sub, exists) ? "dead-node" : null;
  if (!from) return null;
  if (cur.command === want.command && JSON.stringify(cur.args) === JSON.stringify(want.args)) return null;   // 이미 그 꼴(멱등)
  return { entry: { ...cur, command: want.command, args: [...want.args] }, from };
}
