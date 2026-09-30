// codex 훅 신뢰를 세션이 뜨기 **전에** 심는다 (#4135 후속) — 판정·조립은 codex-hook-trust.ts(순수), 여기는 배선.
//
//  ── 왜 세션 만들기 전인가 ──
//  «Hooks need review» 는 codex 가 **시작할 때** 띄운다. 세션 안에서 도는 훅으로는 그 창을 앞지를 수 없다
//  (그 창을 통과 못 하면 훅 자체가 안 돈다 — 닭과 달걀). 그래서 폴더 신뢰(ensureFolderTrusted)와 같은 자리,
//  같은 파일 접근 seam(TrustIo)으로 여기서 한다.
//
//  ── 왜 매번 안 묻나 ──
//  묻는 값은 app-server 한 번 띄우기다(실측 ~2초). 훅 묶음이 그대로면 답도 그대로이므로, 관리 블록의 지문을
//  `<CODEX_HOME>/.lively-hook-trust` 에 남기고 같으면 건너뛴다 — 킷이 훅을 바꾼 세션에서만 한 번 돈다.
//
//  ⚠ 비치명이다 — 실패해도 세션은 뜬다(그때는 종전대로 사람이 그 창에 답한다).
import { createHash } from "node:crypto";
import path from "node:path";
import type { TrustIo } from "./harness-trust.js";
import { hookBlockFingerprint, planCodexHookTrustPatch, type CodexHookRow } from "./codex-hook-trust.js";

/** 지문 파일 — 이 묶음은 이미 물어봤다는 표식. 사람이 읽을 일이 없어 홈 아래 점 파일로 둔다. */
export const HOOK_TRUST_STAMP = ".lively-hook-trust";

/**
 * `hooks/list` 를 한 번 부르는 셸 한 줄 (순수) — app-server 는 **줄바꿈 구분 JSON**을 stdin 으로 받는다.
 *
 *  ⚠ `initialize` 뒤에 `initialized` 알림을 보내야 다른 메서드가 열린다(codex-app-server.ts 계약).
 *   그래서 한 번에 다 쏟지 않고 사이를 띄운다 — 그러지 않으면 아무 답도 안 온다(실측 2026-09-25).
 *  ⚠ 마지막 sleep 뒤 stdin 이 닫히면 서버가 끝난다(실측). 그래서 따로 죽일 필요가 없다.
 */
export function hooksListCmd(codexHome: string, bin = "codex"): string {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "lively", title: "Lively", version: "1" } } });
  const ready = JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} });
  const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: {} });
  const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  return `(printf '%s\\n' ${q(init)}; sleep 1; printf '%s\\n%s\\n' ${q(ready)} ${q(list)}; sleep 3) | CODEX_HOME=${q(codexHome)} ${bin} app-server 2>/dev/null`;
}

/**
 * `hooks/list` 응답(줄바꿈 구분 JSON)에서 훅 줄만 추린다 (순수).
 *  모양(실측 0.157.0): `{"id":2,"result":{"data":[{"cwd":"…","hooks":[{key,currentHash,sourcePath,command,trustStatus,…}]}]}}`
 *  ⚠ 못 읽는 줄은 **조용히 버린다** — 서버는 알림(승인·상태)도 같은 통로로 흘린다.
 */
export function parseHooksList(stdout: string): CodexHookRow[] {
  const out: CodexHookRow[] = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m || m.id !== 2 || !m.result) continue;
    for (const g of Array.isArray(m.result.data) ? m.result.data : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (!h || typeof h.key !== "string") continue;
        out.push({
          key: String(h.key), currentHash: String(h.currentHash ?? ""), sourcePath: String(h.sourcePath ?? ""),
          command: String(h.command ?? ""), trustStatus: h.trustStatus ? String(h.trustStatus) : undefined,
        });
      }
    }
  }
  return out;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * 우리가 심은 훅을 신뢰로 표시한다. **비치명** — 못 하면 false 를 돌려주고 세션은 그대로 뜬다.
 *
 * @param sh 그 멤버로 셸 한 줄을 돌려 stdout 을 주는 함수(격리면 중계, 아니면 로컬).
 * @returns 파일을 실제로 고쳤으면 true
 */
export async function ensureCodexHooksTrusted(o: {
  io: TrustIo; configFile: string; codexHome: string; sh: (cmd: string) => Promise<string>; bin?: string;
}): Promise<boolean> {
  try {
    const current = await o.io.read(o.configFile);
    if (!current || !current.trim()) return false;              // 설정이 아직 없다 — 심을 훅도 없다
    const fp = hookBlockFingerprint(current, sha);
    if (!fp) return false;                                      // 훅이 하나도 없다 — 물어볼 것이 없다
    const stamp = path.join(o.codexHome, HOOK_TRUST_STAMP);
    const prev = (await o.io.read(stamp).catch(() => null)) ?? "";
    if (prev.trim() === fp) return false;                       // 같은 묶음을 이미 물어봤다 — app-server 를 띄우지 않는다
    const rows = parseHooksList(await o.sh(hooksListCmd(o.codexHome, o.bin)));
    const patch = planCodexHookTrustPatch(current, rows, o.configFile);
    if (patch.write) await o.io.write(o.configFile, patch.text);
    //  ⚠ 지문은 **물어본 사실**을 남기는 것이다 — 고칠 게 없었어도(이미 신뢰됨) 남긴다. 안 그러면 매번 다시 띄운다.
    await o.io.write(stamp, `${fp}\n`);
    return patch.write;
  } catch {
    return false;   // 신뢰를 못 심었다고 세션을 막지 않는다 — 그때는 종전대로 사람이 그 창에 답한다
  }
}
