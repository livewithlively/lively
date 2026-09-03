// #2545 (3단계) — «새 세션은 자기 세션 컨테이너 안 tmux» 의 **배선**을 지킨다.
//
// 왜 소스 텍스트를 보나: 이 변경의 실패 모양은 판정 함수가 틀리는 것이 아니라 **순서가 틀리거나 아무도 안 부르는 것**이다.
//  생성 순서 역전(게이트웨이 DB 행 → 브로커 컨테이너 → 그 안에서 tmux)은 createSession 안의 줄 순서가 곧 사양이다.
//  순수 판정은 src/terminal/session-tmux.test.ts 가 잰다(2단계의 session-list-desired-fallback.test.mjs 와 같은 규율).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

{
  const src = read("src/terminal/sessions.ts");
  const i = src.indexOf("export async function createSession(");
  assert.ok(i > 0, "createSession 을 찾지 못했습니다");
  const blk = src.slice(i, src.indexOf("\n}\n", i));
  // ── 스위치는 한 번, 격리(osUser) 안에서만 ──
  const sw = blk.indexOf("tmuxInSessionContainer(");
  ok(sw > 0, "①-a createSession 이 tmuxInSessionContainer 로 새 경로를 판정한다");
  const branch = blk.indexOf("if (inside) {");
  ok(branch > sw, "①-b 새 경로 분기(if (inside))가 있다");
  const elseWrap = blk.indexOf("wrapAsMember(", branch);
  ok(elseWrap > branch, "①-c 셀프호스트 경로(wrapAsMember)는 그 분기의 else 로 남는다 — 매니지드의 옛 경로가 아니라 ensure 훅 없는 배포의 것(#2547)");
  // ── 순서: DB 행 → 컨테이너 → 판 명령(box-spawn) → new-session ──
  const up = blk.indexOf("upsertSessionState(", branch);
  const ens = blk.indexOf("ensureSessionContainerViaRelay(", branch);
  const pane = blk.indexOf("sessionPaneArgv(", branch);
  const ns = blk.indexOf("await tmux(args)", branch);
  ok(up > branch && up < elseWrap, "②-a 새 경로는 DB desired 행을 **먼저** 쓴다(장부가 처음부터 wanted 로 본다)");
  ok(ens > up && ens < elseWrap, "②-b 그 다음 브로커에 컨테이너를 확보한다(ensure 훅)");
  ok(pane > ens && pane < elseWrap, "②-c 판 명령은 box-spawn(sessionPaneArgv) — sudo·session-spawn 없음");
  ok(ns > pane, "②-d tmux new-session 은 컨테이너가 있은 뒤에야 나간다(닭과 달걀 해소)");
  // ── 실패 시 되돌린다 — 행만 남으면 화면에 유령 «중단됨» 이 뜬다 ──
  const rb = blk.slice(ens, ns);
  ok(/deleteSessionState\(id\)/.test(rb), "③-a ensure 실패 시 방금 쓴 desired 행을 지운다");
  ok(/HttpError\(503/.test(rb), "③-b ensure 실패는 503 — 조용한 옛 경로 폴백이 없다");
  const after = blk.slice(ns, ns + 600);
  ok(/if \(inside\)[^\n]*deleteSessionState\(id\)|inside[\s\S]{0,200}deleteSessionState\(id\)/.test(after), "③-c new-session 실패에도 행을 지운다");
  // ── 새 경로에서만 빠지는 env: 공유 빌드 캐시(경로가 세션 컨테이너에 없다) ──
  ok(/if \(!inside\)[\s\S]{0,400}sessionCacheEnv\(|sessionCacheEnv\([\s\S]{0,600}if \(!inside\)/.test(blk), "④ 공유 캐시 env 는 옛 경로에만 실린다(컨테이너엔 그 경로가 없다)");
  // ── DB 미러가 두 번 쓰이지 않는다 ──
  ok(/if \(input\.kind !== "managed" && !mirrored\)|!mirrored && input\.kind !== "managed"/.test(blk), "⑤ 뒤쪽 미러는 새 경로에서 건너뛴다(이미 썼다)");
}

{
  const allow = JSON.parse(read("scripts/node-agent-allowed-modules.json"));
  ok(allow.includes("dist/terminal/session-tmux.js"), "⑥ 새 모듈은 노드 번들 허용목록에 있다(sessions.ts 가 import 한다)");
}

console.log(`\n${pass} assertions passed`);
