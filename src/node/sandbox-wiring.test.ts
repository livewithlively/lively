// 맥락 잡 샌드박스의 **배선** (#4012 T3 L2) — 소스를 읽어 못박는다. 사양 spec-sandbox-core 의 W 행.
//
//  왜 소스인가: 스케줄러·위탁 도구는 DB·노드 레지스트리에 묶여 단위로 돌리기 어렵고, 이 배선의 고장은 조용하다 —
//   분기 하나가 빠지면 샌드박스 판 폴더를 멤버 경계로 읽어 «영원히 실행 중» 이 되거나(감시), 판을 tmux 로 죽이려다
//   아무것도 안 하거나(취소), 맥락 잡이 다시 멤버 PC 로 샌다(경로). 판정 자체는 sandbox-task.test 가 잰다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const SCHED = src("src/node/task-scheduler.ts");
const DELEGATE = src("src/capabilities/delegate.ts");
const STORE = src("src/node/task-store.ts");
const SCHEMA = src("src/org/schema/sessions-infra.ts");
const REAPER = src("src/node/failed-session-reaper.ts");
const fn = (s: string, name: string): string => {
  const i = s.search(new RegExp(`(async function|function) ${name}\\b`));
  assert.ok(i >= 0, `함수 없음: ${name}`);
  const j = s.indexOf("\n}\n", i);
  return s.slice(i, j < 0 ? undefined : j);
};

// W1 경로 — 후보는 schedulingRoute 가 정하고, 맥락 잡이면 원격을 안 본다.
{
  const f = fn(SCHED, "candidatesFor");
  assert.match(f, /schedulingRoute\(sandboxAvailable\(\), isContextJob\(t\)\)/, "W1 경로 판정");
  assert.match(f, /route\.central === "sandbox"/, "W1 샌드박스 후보");
  assert.match(f, /route\.central === "tmux" && CAP_CENTRAL > 0/, "W1 종전 중앙은 tmux 경로일 때만");
  //  ⚠ indexOf 가 -1 이면 «앞에 있다» 가 거짓으로 참이 된다(첫 판이 그렇게 헛돌았다 — 변이 L12). 존재부터 본다.
  const cut = f.indexOf("if (!route.remotes) return");
  assert.ok(cut >= 0, "W1 원격 차단 줄이 있다");
  assert.ok(cut < f.indexOf("schedulableRemotes()"), "W1 ★ 원격 순회 **전에** 끊는다");
  assert.match(f, /capacity: CAP_SANDBOX/, "W1 샌드박스 용량");
  assert.doesNotMatch(f.slice(f.indexOf('route.central === "sandbox"'), f.indexOf('route.central === "tmux"')), /nodeHarnesses\(null\)/,
    "W1 샌드박스 하네스는 기준선을 합치지 않는다(없는 걸 있다고 하지 않는다)");
}

// W2 배정 — node_pref 무시 · 자격 없으면 즉시 실패 · busy 는 배압.
{
  const f = fn(SCHED, "assignOne");
  assert.match(f, /matchNode\(sandboxJob \? \{ \.\.\.t, node_pref: null \} : t, nodes\)/, "W2 맥락 잡은 고정 노드를 따르지 않는다");
  const gate = f.slice(f.indexOf("if (!env)"), f.indexOf("spawnSandboxTask("));
  assert.match(gate, /markFinished\(t\.id, false/, "W2 자격 없음 → 접수에서 실패로 닫는다");
  assert.match(gate, /code: "no_credential"/, "W2 코드");
  assert.match(f, /e instanceof SandboxBusyError\) return \{ assigned: false, code: "capacity"/, "W2 busy 는 배압");
  assert.match(f, /attempt: t\.attempt \+ 1/, "W2 회차는 markRunning 이 올릴 값");
  assert.ok(f.indexOf("spawnSandboxTask(") < f.indexOf("spawnTaskSession("), "W2 샌드박스 분기가 tmux 분기보다 먼저");
}

// W3 감시·멈춤·회수·종결·도구 — 샌드박스 폴더로 가른다.
{
  assert.match(fn(SCHED, "progressBytes"), /isSandboxTaskDir\(dir\) \? null : await requesterOsUser/, "W3 진행 바이트는 직접 읽기");
  assert.match(fn(SCHED, "killTaskAnywhere"), /isSandboxTaskDir\(t\.task_dir\)\) return stopSandboxTask/, "W3 멈춤은 op");
  const reap = fn(SCHED, "reapKill");
  assert.match(reap, /reapSandboxTask\(String\(t\.task_dir\), false\)/, "W3 회수는 치우기");
  assert.match(reap, /revokeSessionHookToken/, "W3 회수기가 토큰도 회수(취소 경로)");
  const fin = fn(SCHED, "finish");
  assert.match(fin, /reapSandboxTask\(String\(t\.task_dir\), !ok\)/, "W3 실패 판은 폴더를 남긴다");
  assert.match(fin, /revokeSessionHookToken\(t\.session_id\)/, "W3 종결 때 토큰 회수");
  const watch = fn(SCHED, "watchRunning");
  assert.match(watch, /isSandboxTaskDir\(t\.task_dir\)\s*\?\s*await checkSandboxTask/, "W3 감시는 종료 줄 판정");
  assert.match(DELEGATE, /isSandboxTaskDir\(t\.task_dir\)\) \{\s*[^}]*tailTask\(t\.task_dir, from, null\)/, "W3 로그 tail 은 직접 읽기");
  assert.match(DELEGATE, /isSandboxTaskDir\(t\.task_dir\)\) await stopSandboxTask/, "W3 취소는 op 멈춤");
  assert.match(REAPER, /SELECT id, node_id, session_id, requester, task_dir, finished_at/, "W3 회수기가 폴더 좌표를 읽는다");
}

// W4 표지 — 기본 제공 맥락 잡이 싣고, 스토어가 쓴다.
{
  const distill = src("src/scheduler/actions/distill.ts");
  const classify = src("src/scheduler/actions/classify.ts");
  const manage = src("src/scheduler/actions/manage.ts");
  const agent = src("src/scheduler/actions/agent.ts");
  const mapb = src("src/scheduler/actions/map-bootstrap.ts");
  assert.equal((distill.match(/execProfile: "context"/g) ?? []).length, 1, "W4 증류");
  assert.equal((classify.match(/execProfile: "context"/g) ?? []).length, 2, "W4 분류(레인·단일)");
  assert.match(manage, /execProfile: o\.repo \? null : "context"/, "W4 관리 — 레포 없는 판만");
  assert.doesNotMatch(agent + mapb, /execProfile/, "W4 사용자 에이전트·레포 부트스트랩은 맥락 잡이 아니다");
  assert.match(src("src/scheduler/actions/_headless.ts"), /execProfile: o\.execProfile \?\? null/, "W4 접수가 넘긴다");
  assert.match(STORE, /\.\.\.\(execProfile \? \["exec_profile"\] : \[\]\)/, "W4 스토어가 칼럼을 쓴다");
}

// W5 스키마.
assert.match(SCHEMA, /ALTER TABLE org_task ADD COLUMN IF NOT EXISTS exec_profile TEXT/, "W5");

console.log("✓ sandbox-wiring — 경로·배정·감시·멈춤·회수·도구·표지·스키마 배선 (W1~W5)");
