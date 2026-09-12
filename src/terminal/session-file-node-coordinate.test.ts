// #3870 — **박스(중앙) 세션에 붙은 «세션 호스트» 좌표는 파일 op 에서도 릴레이 지시가 아니다.**
//
// ── 무엇이 고장나 있었나 ─────────────────────────────────────────────────────
// 세션 화면 안 터미널은 파일 API 를 부를 때 목록 행의 좌표를 그대로 싣는다(`&node=<id>`, terminal.ts sUrl).
//  선언된 세션 호스트가 상주하면 그 테넌트의 **중앙 세션 행에도** 좌표가 붙는다(nodeSessionsFor) — 그래서
//  매니지드 세션의 업로드·목록이 전부 노드 릴레이로 샜다. 세션 호스트의 노드 프로세스는 그 세션을 볼 수 없다
//  (세션은 컨테이너 안에 산다) → `fsWrite` 가 던지고, rest-util 의 catch-all 이 그것을 500 `internal_error`
//  로 덮어 화면엔 «업로드 실패 — internal_error» 만 떴다.
//
// 2026-09-12 실측(세션 box-wonjoon-jang-d3a3e7e3 @ sesshost-lively-46e3-i-0a9831a1d88d435be):
//   `?node=<sesshost>` → PUT /file **500 internal_error** · POST /mkdir **500** · GET /ls **404 「디렉터리 없음」**
//   `?node=` 없음      → PUT /file **200** `{"path":"/work/shared/project/3625/uploads/…"}` · GET /ls **200**
//
// ── 왜 구조를 잠그나 ─────────────────────────────────────────────────────────
// 판정 규칙 자체(선언 기반 fail-closed)는 `self-node.ts` 의 순수함수 시험이 이미 진다. 여기서 지키는 것은
//  **그 규칙을 이 라우트가 부르는가** 다 — #3745 가 세션 DELETE 에 같은 판정을 넣을 때 파일 op 를 빠뜨린 것이
//  이 결함의 전부였고, 같은 누락이 다시 날 수 있는 자리가 정확히 여기다.
//  ⚠ caps(`fsLs`/`fsWrite`)는 이 축을 못 가른다 — 세션 호스트도 같은 에이전트 번들이라 광고는 참이다.
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

/** 파일 op 의 좌표 판정 함수 본문만 — 같은 파일의 다른 코드가 우연히 조건을 만족시켜 통과하지 않게. */
function nodeForBody(): string {
  const src = read("src/terminal/terminal-files.ts");
  const at = src.indexOf("async function nodeFor(req: express.Request)");
  assert.ok(at > 0, "nodeFor 를 찾지 못했다(모양이 바뀌었으면 이 시험을 먼저 고칠 것)");
  const end = src.indexOf("const NODE_FS_CHUNK", at);
  assert.ok(end > at, "nodeFor 의 끝을 찾지 못했다");
  return src.slice(at, end);
}

test("★★ A1 파일 op 가 «박스 세션 + 세션 호스트» 좌표를 접는다 — 매니지드 업로드가 500 이던 자리", () => {
  const body = nodeForBody();
  assert.match(body, /sameTmuxCoordinate\(/,
    "★세션 호스트 좌표 접기가 없다 — 호스트가 상주하는 동안 매니지드 세션 업로드가 다시 500 internal_error 가 된다");
  assert.match(body, /isSessionHost:\s*isSessionHostNode/,
    "★선언 판정을 레지스트리에 묻지 않는다 — 아무 노드나 «세션 호스트» 로 접으면 멤버 PC 노드의 파일이 이 박스에서 찾아진다");
  assert.match(body, /const boxRow = isBoxSessionRow\(desired\)/,
    "★박스 세션 판정을 인라인으로 다시 썼다 — «행이 있고 노드가 없다» 가 두 벌로 갈리면 한쪽이 뒤처진다");
});

test("★★ A2 좌표를 셀프 노드 판정 **단독**으로 정하지 않는다(종전 화석)", () => {
  const body = nodeForBody();
  assert.doesNotMatch(body, /relayNodeId\(\s*req\.query\.node as string \| undefined,\s*isSelfNode\s*\)/,
    "★셀프 노드만 접는 종전 구조가 되살아났다 — 세션 호스트 좌표가 다시 릴레이 지시로 쓰인다");
});

test("★★ A3 노드 릴레이 업로드가 **절대경로**로 답한다 — 그 값이 입력창에 꽂히기 때문", () => {
  const src = read("src/terminal/terminal-files.ts");
  const at = src.indexOf('app.put("/api/ui/terminal/sessions/:id/file"');
  assert.ok(at > 0, "업로드 PUT 라우트를 찾지 못했다");
  const body = src.slice(at, at + 2600);
  assert.doesNotMatch(body, /res\.json\(\{ ok: true, path: rel \}\)/,
    "★상대경로로 답한다 — 에이전트 cwd 가 세션 루트와 다르면 «파일이 없다» 가 된다(로컬 분기는 절대경로를 준다)");
  assert.match(body, /nodeRpc<\{ path\?: string \}>/,
    "★노드가 돌려주는 경로를 읽지 않는다 — agent.ts fsWrite 는 이미 절대경로를 준다");
});

// ── 맥(NFD) 한글 파일명 ──────────────────────────────────────────────────────
// 맥 파일시스템은 파일명을 **NFD** 로 들고 있어 `file.name` 이 자모(U+1100~U+11FF)로 온다. 드롭 업로드의
//  허용집합 `가-힣` 은 **완성형 음절**(U+AC00~U+D7A3)이라 그 자모가 한 글자도 안 맞는다 → 이름이 통째로 밑줄.
//  실측(세션 3625 의 uploads/): `경진대회 참가신청서-라이블리-3.html` 이 `________…-_________-3.html` 로 앉았다.
//  ⚠ 시험이 규칙을 **복제하지 않는다** — 실제 소스의 정규식 리터럴을 꺼내 그것에 묻는다(두 벌로 갈리지 않게).
function dropNameRule(): { re: RegExp; normalizes: boolean } {
  const src = read("web/standalone/terminal.ts");
  const line = src.split("\n").find((l) => l.includes("let name = (file.name"));
  assert.ok(line, "dropFileToAgent 의 파일명 줄을 찾지 못했다");
  const m = line!.match(/replace\((\/\[\^[^/]*\/g)\s*,/);
  assert.ok(m, `파일명 허용집합 정규식을 못 읽었다: ${line}`);
  const body = m![1]!.slice(1, -2);            // /…/g → 알맹이
  return { re: new RegExp(body, "g"), normalizes: line!.includes(".normalize('NFC')") };
}

test("★★ A4 맥(NFD) 한글 파일명이 밑줄로 뭉개지지 않는다", () => {
  const { re, normalizes } = dropNameRule();
  const nfc = "경진대회 참가신청서-라이블리-3.html";
  assert.ok(normalizes,
    "★드롭 업로드가 파일명을 NFC 로 합치지 않는다 — 맥에서 끌어온 한글 파일이 전부 밑줄 이름으로 앉는다");
  // 규칙 자체의 성질: 자모(NFD)는 허용집합에 없고, 합치면(NFC) 살아남는다.
  assert.ok(nfc.normalize("NFD").replace(re, "_").startsWith("_"),
    "허용집합이 NFD 자모를 이미 받는다면 이 시험의 전제가 바뀐 것이다 — 규칙을 다시 읽을 것");
  const out = nfc.normalize("NFC").replace(re, "_");
  assert.ok(/경진대회/.test(out), `★NFC 로 합쳐도 한글이 살아남지 않는다: ${out}`);
});
