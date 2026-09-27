// 세션 복제(#4135) — 순수 판정·입력 조립의 엣지 표.
import { strict as assert } from "node:assert";
import test from "node:test";
import type { SessionState } from "../sessions/session-state.js";
import { HARNESSES } from "./catalog.js";
import { NODE_OPS, NODE_BASELINE_OPS } from "../node/protocol.js";
import { SESSION_OPS } from "./session-ops.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_LABEL_MAX, forkInheritsTask, forkLabel, forkRefusal, forkSupported, sessionForkInput, type ForkFacts } from "./session-fork.js";

const CONV = "0199b1a2-1f3e-7c44-9c2a-3b0f5d6e7a8b";
const st = (over: Partial<SessionState> = {}): SessionState => ({
  id: "box-jang-aaaa1111", owner: "jang", label: "허브 위젯 손보기", harness: "claude",
  dir: "/work/project/4135", root_key: "shared", subpath: "project/4135", flags: { "--model": "fable", "--effort": "high" },
  auto_approve: true, invites: ["yoon"], project_id: 4135, project_src: "v6", app_id: null,
  read_only: false, incognito: false, write_vis: "open", restrict_read: false,
  created: 1, last_busy: null, last_seen: null, claude_session_id: CONV, transcript_path: null,
  exited_at: null, exit_reason: null, node_id: null,
  ...over,
});
const facts = (over: Partial<ForkFacts> = {}): ForkFacts => ({
  st: st(), me: "jang", convId: CONV, check: "unknown", nodeId: "", nodeOnline: false, nodeCanFork: false, ...over,
});

test("F1 하네스 표 — claude·codex 만 복제 argv 를 갖고, 모양은 실측한 그대로다", () => {
  const f = (k: string): string[] | undefined => HARNESSES.find((h) => h.key === k)?.forkArgv?.(CONV);
  assert.deepEqual(f("claude"), ["--resume", CONV, "--fork-session"]);
  assert.deepEqual(f("codex"), ["fork", CONV]);   // 서브커맨드 — bin 바로 뒤
  for (const k of ["opencode", "antigravity", "grok", "shell"]) assert.equal(f(k), undefined, `${k} 는 실증 전이라 비어 있어야 한다`);
  assert.equal(forkSupported("claude"), true);
  assert.equal(forkSupported("codex"), true);
  assert.equal(forkSupported("grok"), false);
  assert.equal(forkSupported(null), true, "하네스 미상 = claude(복원과 같은 기본)");
});

test("F2 노드 op — forkSession 은 선언한 노드에만 간다(v1 기준선 밖) · 세션 op 표에 있다", () => {
  assert.ok((NODE_OPS as readonly string[]).includes("forkSession"));
  assert.ok(!(NODE_BASELINE_OPS as readonly string[]).includes("forkSession"), "기준선에 넣으면 옛 노드가 못 하는 걸 한다고 주장한다");
  assert.ok((SESSION_OPS as readonly string[]).includes("forkSession"));
});

test("F3 이름 — 「(복제)」 꼬리 · 복제본의 복제는 번호가 오른다 · 이름 없는 세션은 이름 없이", () => {
  assert.equal(forkLabel("허브 위젯 손보기", "box-x"), "허브 위젯 손보기 (복제)");
  assert.equal(forkLabel("허브 위젯 손보기 (복제)", "box-x"), "허브 위젯 손보기 (복제 2)");
  assert.equal(forkLabel("허브 위젯 손보기 (복제 2)", "box-x"), "허브 위젯 손보기 (복제 3)");
  assert.equal(forkLabel("box-x", "box-x"), "");
  assert.equal(forkLabel("", "box-x"), "");
  assert.equal(forkLabel(null, "box-x"), "");
  const long = forkLabel("가".repeat(200), "box-x");
  assert.ok(long.length <= FORK_LABEL_MAX, "길이 상한");
  assert.ok(long.endsWith(" (복제)"), "꼬리는 잘리지 않는다");
});

test("F4 입력 — 작업 자리·프로젝트·AI·모델·권한을 그대로, fork 만 얹는다(첫 지시·이어받기·승계 없음)", () => {
  const input = sessionForkInput(st(), CONV);
  assert.deepEqual({
    label: input.label, rootKey: input.rootKey, subpath: input.subpath, harness: input.harness, flags: input.flags,
    projectId: input.projectId, projectSrc: input.projectSrc, autoApprove: input.autoApprove, invites: input.invites,
    readOnly: input.readOnly, incognito: input.incognito, writeVis: input.writeVis, restrictRead: input.restrictRead,
    fork: input.fork,
  }, {
    label: "허브 위젯 손보기 (복제)", rootKey: "shared", subpath: "project/4135", harness: "claude",
    flags: { "--model": "fable", "--effort": "high" },
    projectId: 4135, projectSrc: "v6", autoApprove: true, invites: ["yoon"],
    readOnly: false, incognito: false, writeVis: "open", restrictRead: false,
    fork: CONV,
  });
  assert.equal(input.initialPrompt, undefined);
  assert.equal(input.resume, undefined);
  assert.equal(input.resumePick, undefined);
  assert.equal(input.carryConv, undefined, "복제본은 원래 대화를 도는 세션이 아니다");
  assert.equal(input.appId, undefined);
});

test("F5 거절 표 — 확인된 것만 띄운다", () => {
  assert.equal(forkRefusal(facts()), null, "박스 세션 · 대화 id 있음 · 기록 확인 불가(unknown) = 띄운다");
  assert.equal(forkRefusal(facts({ check: "present" })), null);
  assert.equal(forkRefusal(facts({ st: null }))?.status, 409);
  assert.equal(forkRefusal(facts({ me: "yoon" }))?.status, 403, "남의 세션");
  assert.equal(forkRefusal(facts({ st: st({ app_id: "writer" }) }))?.status, 409, "앱 세션");
  assert.match(forkRefusal(facts({ st: st({ harness: "grok" }) }))?.message || "", /아직 복제할 수 없습니다/);
  assert.match(forkRefusal(facts({ convId: null }))?.message || "", /아직 복제할 대화가 없습니다/);
  assert.match(forkRefusal(facts({ convId: "a b;rm" }))?.message || "", /아직 복제할 대화가 없습니다/, "형식이 틀린 id 는 없는 것과 같다");
  assert.match(forkRefusal(facts({ check: "absent" }))?.message || "", /대화 기록을 찾지 못했습니다/);
});

test("F6 노드 세션 — 꺼져 있거나 op 를 선언하지 않았으면 보내지 않는다", () => {
  assert.match(forkRefusal(facts({ nodeId: "mac", nodeOnline: false, nodeCanFork: true }))?.message || "", /연결돼 있지 않아/);
  assert.match(forkRefusal(facts({ nodeId: "mac", nodeOnline: true, nodeCanFork: false }))?.message || "", /아직 세션 복제를 모릅니다/);
  assert.equal(forkRefusal(facts({ nodeId: "mac", nodeOnline: true, nodeCanFork: true })), null);
  // 남의 세션이면 노드 사정보다 그 말이 먼저다(고칠 수 없는 것부터)
  assert.equal(forkRefusal(facts({ me: "yoon", nodeId: "mac", nodeOnline: false }))?.status, 403);
});

test("F7 태스크 — 같은 프로젝트의 진행 중 태스크만 물려받는다(끝난 일을 복제로 다시 열지 않는다)", () => {
  assert.equal(forkInheritsTask({ id: 4159, status: "in_progress", project_id: 4135 }, 4135), true);
  assert.equal(forkInheritsTask({ id: 4159, status: "done", project_id: 4135 }, 4135), false);
  assert.equal(forkInheritsTask({ id: 4159, status: "todo", project_id: 4135 }, 4135), false);
  assert.equal(forkInheritsTask({ id: 4159, status: "in_progress", project_id: 9999 }, 4135), false, "다른 프로젝트의 태스크");
  assert.equal(forkInheritsTask(null, 4135), false);
  assert.equal(forkInheritsTask({ id: 4159, status: "in_progress", project_id: 4135 }, undefined), false);
});

// createSession 은 tmux 를 실제로 띄우는 함수라 여기서 부르지 않는다(실측은 PR 본문 — 두 하네스로 끝까지 돌렸다).
//  대신 **이 기능이 조용히 죽는 두 자리**를 글자로 못 박는다(리뷰 지적): ① fork 가 이어받기보다 앞서 argv 에 실리는가
//  ② fork 면 pane 이 셸인 모드(app-server · 대화 런타임)로 안 가는가 — 가면 argv 가 만들어지고도 실행되지 않는다.
test("F8 createSession — fork 는 이어받기보다 앞서고, pane 이 셸인 모드로 가지 않는다", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = [path.join(here, "sessions.ts"), path.join(here, "..", "..", "src", "terminal", "sessions.ts")].find((p) => fs.existsSync(p));
  assert.ok(file, "sessions.ts 원문을 찾지 못했다");
  const src = fs.readFileSync(file!, "utf8");
  const iFork = src.indexOf("if (input.fork) {");
  const iResume = src.indexOf("} else if (input.resume) {");
  assert.ok(iFork > 0 && iResume > iFork, "fork 분기가 resume 분기 앞에 있어야 한다");
  assert.ok(src.slice(iFork, iResume).includes("harness.forkArgv(input.fork)"), "fork 분기가 하네스의 복제 argv 를 싣는다");
  assert.ok(/const chatMode = \(input\.loginFor \|\| input\.fork\) \? "tmux"/.test(src), "fork 면 codex 도 터미널 TUI 로 뜬다");
  assert.ok(/const chatRuntime = !input\.loginFor && !input\.fork && /.test(src), "fork 면 대화 런타임으로 가지 않는다");
});
