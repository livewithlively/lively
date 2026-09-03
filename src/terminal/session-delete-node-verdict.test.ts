// #2636 — **노드 세션의 생사는 그 노드에 묻는다.** 게이트웨이 로컬 tmux 는 그 질문에 답할 자격이 없다.
//
// ── 왜 이 파일이 있나 ───────────────────────────────────────────────────────
// 세션 DELETE 라우트는 좌표를 **화면이 준 `?node=` 만** 봤다. 그런데 그 좌표를 안 싣는 호출이 실제로
//  있었다 — 대시보드 '내 AI 세션' 위젯. 그 목록엔 `nodeSessionsFor` 로 **노드 세션이 병합돼 온다**.
//  좌표가 없으면 요청은 중앙 경로로 흘렀고, 거기서 `sessionGone`(= 게이트웨이 로컬 tmux `has-session`)이
//  생사를 판정했다.
//
// T0 실측(2026-09-04, 셀프호스트 게이트웨이 = 맥미니 · 노드 3대 연결):
//
//   실제 노드 세션 id 6개 전부 → exit 1 `can't find session`
//     box-yoon-1cb1042c · 40e8494e · 641ea705 · b2b52a3f  (haruui-macbookair — **살아 있는 세션**)
//     box-yoon-a3a09fd1 (hammurabi) · box-yoon-c084341e (win-e2e-1541)
//   대조군 box-yoon-f140fea5(중앙 세션) → exit 0
//
//  `isSessionGoneError` 가 그 문구를 확답으로 매치하므로 **살아 있는 노드 세션이 언제나 「없다」로
//  판정됐다.** → 노드에 묻지도 않고 desired-state 행만 지운 뒤 «종료했어요» 로 끝난다(세션은 그 컴퓨터에
//  그대로 = 누수). → 행이 사라진 다음 호출은 `ownerMeta` 가 null 이 되어 **403 「본인 세션이 아닙니다」**.
//  두 방향은 별개 결함이 아니라 **한 결함의 1차·2차 증상**이다.
//
// ── 잠그는 명제 ─────────────────────────────────────────────────────────────
// 고침은 판정을 중앙 경로에 옮겨 심는 것이 아니라 **좌표를 되찾는 것**이다 — 좌표만 있으면 그 세션은
//  이미 옳은 분기(노드 릴레이 · `gone` op 의 3값 확답 계약)로 흘러간다. 판정을 중앙에 새로 심으면 같은
//  규율이 두 벌로 갈리고, 그게 #2622 가 회수기만 고치고 이 라우트를 남긴 그 모양이다.
//
// 그래서 이 파일은 **행위가 아니라 구조**를 잠근다(행위 표는 self-node 쪽 순수함수 시험이 진다):
//   B1 DELETE 라우트가 좌표를 세 출처로 되찾는다(요청 · desired-state · 레지스트리 스냅샷)
//   B2 좌표 판정이 `sessionGone` 호출보다 **앞선다** — 로컬 tmux 를 먼저 묻는 구조로 못 돌아간다
//   B3 좌표를 `req.query.node` **단독**으로 정하지 않는다(종전 화석)
//   B4 대시보드 위젯 두 곳이 `?node=` 를 싣는다 — 좌표를 아는 쪽이 말해 준다(서버 되찾기와 이중 방어)
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) { if (existsSync(path.join(d, "package.json"))) return d; d = path.dirname(d); }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const read = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");

/** 세션 DELETE 핸들러 본문만 — 같은 파일의 다른 라우트가 우연히 조건을 만족시켜 통과하는 것을 막는다. */
function deleteRouteBody(): string {
  const src = read("src/terminal/routes.ts");
  const at = src.indexOf('app.delete("/api/ui/terminal/sessions/:id"');
  assert.ok(at > 0, "세션 DELETE 라우트를 찾지 못했다(라우트 모양이 바뀌었으면 이 시험을 먼저 고칠 것)");
  const end = src.indexOf("function registerRestoreReportRoutes", at);
  assert.ok(end > at, "DELETE 라우트의 끝을 찾지 못했다");
  return src.slice(at, end);
}

test("★★ B1 DELETE 라우트는 좌표를 세 출처로 되찾는다 — 화면이 안 줘도 서버가 안다", () => {
  const body = deleteRouteBody();
  assert.match(body, /sessionRelayNodeId\(/,
    "★좌표 되찾기가 없다 — 화면이 준 좌표만 보는 구조로 되돌아갔다(노드 세션이 로컬 tmux 로 판정된다)");
  assert.match(body, /desired:\s*desired\?\.node_id/,
    "★desired-state 의 좌표를 안 본다 — 좌표를 안 싣는 화면의 요청이 다시 중앙 경로로 샌다");
  assert.match(body, /snapshot:\s*nodeOfSession\(/,
    "★레지스트리 스냅샷 좌표를 안 본다 — 행이 없는 옛 노드 세션의 좌표를 잃는다");
});

test("★★ B2 좌표를 먼저 정한 뒤에야 로컬 tmux 를 묻는다 — 노드 세션은 그 자리에 닿지 않는다", () => {
  const body = deleteRouteBody();
  const coordAt = body.indexOf("sessionRelayNodeId(");
  assert.ok(coordAt > 0, "좌표 판정이 없다");
  // `sessionGone` 이 이 라우트에 남아 있는 것 자체는 옳다 — **중앙 세션**의 생사는 로컬 tmux 가 정본이다.
  //  잠그는 것은 순서다: 좌표를 정하기 전에 물으면 노드 세션이 그 답에 걸린다.
  const goneAt = body.indexOf("sessionGone(");
  if (goneAt > 0) {
    assert.ok(coordAt < goneAt,
      "★로컬 tmux 판정(sessionGone)이 좌표 판정보다 앞이다 — 노드 세션이 게이트웨이 tmux 로 판정된다");
  }
});

test("★★ B3 좌표를 `?node=` 단독으로 정하지 않는다(종전 화석)", () => {
  const body = deleteRouteBody();
  assert.doesNotMatch(body, /const nodeId = relayNodeId\(req\.query\.node/,
    "★화면이 준 좌표만 보는 종전 구조가 되살아났다 — #2636 의 누수가 그대로 돌아온다");
});

test("★★ B4 대시보드 '내 AI 세션' 위젯이 좌표를 싣는다 — 그 목록엔 노드 세션이 병합돼 온다", () => {
  for (const rel of ["web/dash/widget-sessions.ts", "web/dash/widget-sessions-popovers.ts"]) {
    const src = read(rel);
    const lines = src.split("\n").filter((l) => l.includes("terminal/sessions/") && l.includes("method: 'DELETE'"));
    assert.ok(lines.length > 0,
      `${rel} 의 세션 DELETE 호출을 찾지 못했다 — 호출 모양이 바뀌었으면 이 시험을 먼저 고칠 것`);
    for (const l of lines) {
      assert.ok(l.includes("?node="),
        `★${rel} 의 DELETE 가 좌표(?node=) 없이 나간다 — 그 컴퓨터의 세션이 안 죽는데 «종료했어요» 가 뜬다:\n    ${l.trim()}`);
    }
  }
});
