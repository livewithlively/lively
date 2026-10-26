// #5043 — 원격 PC 노드의 ⑥ 판정(localJobVerdicts)은 session-reaper resolveJobVerdicts 의 **첫 단계와 같은 답**을 내야 한다.
//  노드 번들에 DB 를 안 끌고 가려고 판정을 session-rss 로 옮겼다 — 옮긴 자리가 다른 답을 내면 매니지드와 원격 PC 의 «작업 중» 이 갈린다
//  (원격 PC 에서 `nohup … &` 로 띄운 서버가 30분 만에 죽거나, 반대로 아무 세션도 안 꺼진다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { localJobVerdicts, type ProcEntry } from "./session-rss.js";
import { resolveJobVerdicts } from "./session-reaper.js";

/** 세션 셋: box-job(하네스가 띄운 zsh 작업) · box-idle(작업 없음) · box-gone(pane pid 가 표에 없음) — box-nopane 은 pane 목록에 없다. */
function fixture() {
  const t = new Map<number, ProcEntry>([
    [10, { ppid: 1, rssKb: 900, name: "sh", pgid: 10, tpgid: 11 }],
    [11, { ppid: 10, rssKb: 300_000, name: "claude", pgid: 11, tpgid: 11 }],
    [12, { ppid: 11, rssKb: 30_000, name: "node", pgid: 11, tpgid: 11 }],     // MCP — 작업 아님
    [20, { ppid: 11, rssKb: 1_200, name: "zsh", pgid: 20, tpgid: -1 }],       // 작업
    [50, { ppid: 1, rssKb: 900, name: "sh", pgid: 50, tpgid: 51 }],
    [51, { ppid: 50, rssKb: 200_000, name: "claude", pgid: 51, tpgid: 51 }],
  ]);
  const panes = new Map([["box-job", [10]], ["box-idle", [50]], ["box-gone", [999]]]);
  return { t, view: { ok: true, panes } };
}
const ids = new Set(["box-job", "box-idle", "box-gone", "box-nopane"]);
const sets = (v: { jobs: ReadonlySet<string>; unknown: ReadonlySet<string> }) => ({ jobs: [...v.jobs].sort(), unknown: [...v.unknown].sort() });

test("J1 작업 있음 · 작업 없음 · 판정 불가(pane 이 표에 없음 · pane 이 안 보임)를 가른다", () => {
  const { t, view } = fixture();
  assert.deepEqual(sets(localJobVerdicts(ids, view, t)), { jobs: ["box-job"], unknown: ["box-gone", "box-nopane"] });
});
test("J2 못 봤으면(pane 목록 실패 · 프로세스 표가 빔) 전부 판정 불가 — «작업 없음» 으로 접지 않는다", () => {
  const { t, view } = fixture();
  assert.deepEqual(sets(localJobVerdicts(ids, { ok: false, panes: view.panes }, t)), { jobs: [], unknown: [...ids].sort() });
  assert.deepEqual(sets(localJobVerdicts(ids, view, new Map())), { jobs: [], unknown: [...ids].sort() });
  assert.deepEqual(sets(localJobVerdicts(new Set(), view, t)), { jobs: [], unknown: [] });
});
test("J3 ★ 셀프호스트(컨테이너 프로브 없음)의 resolveJobVerdicts 와 같은 답 — 같은 표 · 같은 판별자", async () => {
  const { t, view } = fixture();
  const reaper = await resolveJobVerdicts(ids, view, t, async () => new Map());
  assert.deepEqual(sets(localJobVerdicts(ids, view, t)), sets(reaper));
  const reaperBlind = await resolveJobVerdicts(ids, view, new Map(), async () => new Map());
  assert.deepEqual(sets(localJobVerdicts(ids, view, new Map())), sets(reaperBlind));
});
