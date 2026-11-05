// 하네스에 등록하는 lively stdio 서버(`lively mcp` · `lively mcp-local`)의 실행 형태 — 순수 함수만 둔다.
//
//  Windows 는 심(lively.cmd) 대신 node.exe 로 lively.mjs 를 바로 띄운다. 보안 솔루션이 cmd.exe·배치 실행을 막는
//  PC 에서는 심이 «'lively.cmd' 프로그램을 실행하지 못했습니다. 액세스가 거부되었습니다» 로 못 뜨고, 그 심을 가리키는
//  MCP 도 함께 죽는다(2026-11-05, 배치 실행 차단 윈도우 노트북). node.exe 는 같은 PC 에서 설치기가 이미 실행했다.
//  ⚠ kit/cli/lively.mjs 의 livelyStdioLaunch 와 같은 규칙이다 — CLI 는 훅 폴더를 정적 import 하지 않는다
//   (부트스트랩이 CLI 만 새로 받는 순간 옛 훅 폴더와 짝이 맞지 않아 CLI 가 통째로 못 뜬다). 두 곳은 같은 표로 시험한다.

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

/**
 * 이미 등록된 항목이 «우리가 심은 심 직결형» 인가 — 이것만 node 직결로 옮긴다(사람이 손댄 항목은 건드리지 않는다).
 * Windows 경로는 대소문자·구분자가 섞여 저장될 수 있어 둘 다 정규화해 비교한다.
 */
export function isOurShimEntry(cur, shim, sub) {
  if (!cur || typeof cur !== "object" || cur.type !== "stdio") return false;
  const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  return norm(cur.command) === norm(shim) && Array.isArray(cur.args) && cur.args.length === 1 && cur.args[0] === sub;
}
