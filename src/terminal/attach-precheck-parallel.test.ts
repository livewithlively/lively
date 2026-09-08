// #3656 (2026-09-08) — «attach 앞 직렬 중계» 를 줄인 구조가 되돌아가지 않게 잠근다(소스 스캔 — 이 레포의 구조 시험 관례).
//
//  실측(매니지드): 세션 컨테이너·tmux·claude 는 4초 만에 떴는데 브라우저의 화면(attach)은 36초 뒤에 붙었다. 그 사이에
//  선 것은 중계 왕복(허브 → 노드 브로커 → runsc exec)이었다 — 메타 GET 의 show-options 2회 + 업그레이드 핸들러의
//  has-session 1회 + set-option 3회가 **전부 직렬**이고, 그 왕복은 4% 확률로 3~20초를 먹는다(허브 파킹 소켓 무응답).
//  여기서 잠그는 것은 셋: ① canAttach·sessionGone 을 나란히 ② ensureSessionOpts 는 attach 를 막지 않는다 ③ 메타는
//  desired-state 가 있으면 tmux 에 묻지 않는다. 그리고 ④ 대화창이 가려진 동안 박스 세션 폴링을 촘촘히 하지 않는다
//  (한 폴이 노드의 runsc exec 이라 2vCPU 노드를 포화시켰다).
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

test("★ ① 업그레이드 핸들러는 canAttach 와 sessionGone 을 **나란히** 묻는다 — 직렬로 되돌아가면 잡는다", () => {
  const src = read("src/terminal/terminal-pty-upgrade.ts");
  const at = src.indexOf("const [ok, gone] = await Promise.all([");
  assert.ok(at > 0, "Promise.all 로 두 판정을 같이 묻는 자리가 없다");
  const block = src.slice(at, at + 240);
  assert.match(block, /canAttach\(id, tk\.userId\)\.catch\(\(\) => false\)/, "canAttach 가 그 묶음에 없다");
  assert.match(block, /sessionGone\(id\)\.catch\(\(\) => false\)/, "sessionGone 이 그 묶음에 없다");
  assert.doesNotMatch(src, /const ok = await canAttach\(/, "★ canAttach 를 먼저 기다리는 종전 직렬 구조가 돌아왔다");
  assert.doesNotMatch(src, /const gone = await sessionGone\(/, "★ sessionGone 을 따로 기다리는 종전 직렬 구조가 돌아왔다");
});

test("★ ② ensureSessionOpts 는 attach 를 막지 않는다 — await 금지(중계 왕복 셋이 직렬로 서던 자리)", () => {
  const src = read("src/terminal/terminal-pty-upgrade.ts");
  assert.match(src, /void ensureSessionOpts\(id\)\.catch\(/, "옵션 보장을 기다리지 않는 모양이 아니다");
  assert.doesNotMatch(src, /await ensureSessionOpts\(/, "★ 옵션 보장을 attach 앞에서 기다린다 — 중계 3왕복이 다시 직렬로 선다");
});

test("★ ③ 세션 메타 GET 은 desired-state 가 있으면 라벨·프로젝트를 tmux 에 묻지 않는다(행이 없을 때만 폴백)", () => {
  const src = read("src/terminal/routes.ts");
  const at = src.indexOf('app.get("/api/ui/terminal/sessions/:id",');
  const end = src.indexOf('app.get("/api/ui/terminal/sessions/:id/prompts"', at);
  assert.ok(at > 0 && end > at, "메타 핸들러 경계를 못 찾았다");
  const body = src.slice(at, end);
  assert.match(body, /st\?\.label \? Promise\.resolve\(st\.label\) : getSessionLabel\(/, "라벨이 DB 우선이 아니다");
  assert.match(body, /st\?\.project_id != null \? Promise\.resolve\(Number\(st\.project_id\) \|\| 0\) : getSessionProject\(/, "프로젝트가 DB 우선이 아니다");
});

test("★ ④ 대화창이 가려져 있으면(터미널 모드) 박스 세션 폴링은 유휴 주기 밑으로 내려가지 않고, 다시 열면 그 자리에서 따라잡는다", () => {
  const src = read("web/session-chat.ts");
  assert.match(src, /if \(mode === 'term' && src\.kind === 'box'\) ms = Math\.max\(ms, POLL_IDLE_MS\);/, "가려진 대화창의 폴링 완화가 없다");
  assert.match(src, /if \(m === 'chat'\) \{ view\.scrollToBottom\(\); view\.input\.focus\(\); pokePoll\(\); \}/, "대화창으로 돌아올 때 즉시 따라잡는 pokePoll 이 없다");
});
