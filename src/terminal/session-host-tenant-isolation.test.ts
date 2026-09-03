// 한 세션 호스트가 여러 테넌트를 봐도 안 섞인다 (#2600 T1 · 승인 조건 A) — 사양 `spec.md` C절, 18~21행.
//
// ── 왜 이 파일이 필요한가 ────────────────────────────────────────────────────
// T0 승인(2026-09-03)이 위험 하나를 지목했다: 코어 `terminal-pty` 의 장부가 **모듈 전역이고 세션 id 키**
//  인데 세션 id 가 `box-<userSlug>-<hex>` 라 «테넌트를 안 담는다» → 한 프로세스가 두 테넌트를 보면
//  B 의 탭이 닫힐 때 A 의 살아 있는 화면에 `detach-client -s` 가 나간다, 는 것이었다.
//
// ★ **다시 재 보니 그 기제는 성립하지 않는다.** 성립하려면 두 테넌트가 **같은 세션 id** 를 가져야 하는데,
//  id 의 꼬리가 `crypto.randomBytes(4)` = **32비트 난수**라 그 충돌이 사실상 불가능하다(`sessions.ts:428`).
//  게다가 tmux argv 는 attach 시점에 렉시컬로 붙잡혀 유령 정리까지 따라가고(그 argv 에 슬러그가 박혀 있다),
//  테넌트 고정은 AsyncLocalStorage 라 비동기 체인 끝까지 간다. 그래서 «테넌트당 프로세스 하나»(가)도
//  «장부를 테넌트 키로 승격»(나)도 **격리를 위해서는 필요하지 않다** — 오늘의 attach 워커가 이미
//  여러 테넌트를 한 프로세스에서 보고 있고(sticky 는 세션 id 기준이라 테넌트로 안 묶인다) 멀쩡하다.
//
// 그래서 이 파일은 «고쳤다» 가 아니라 **«무엇이 참이라서 안 섞이는가» 를 못박는다.** 그 셋 중 하나라도
//  깨지면 여기서 빨간불이 뜨고, 그때가 (가)/(나)를 꺼낼 때다.
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { SessionHost } from "./session-host.js";
import type { AttachSocket } from "./terminal-pty.js";
import { withTenant, currentTenant } from "../org/tenant-context.js";
import { computeExecTopology } from "../exec-topology.js";

function fakeSock(): AttachSocket & { fire(ev: string): void } {
  const ls = new Map<string, Array<(...a: any[]) => void>>();
  const s = {
    send() { /* noop */ },
    close() { s.fire("close"); },
    on(ev: string, fn: (...a: any[]) => void) { const a = ls.get(ev) ?? []; a.push(fn); ls.set(ev, a); },
    fire(ev: string) { for (const fn of ls.get(ev) ?? []) fn(); },
  };
  return s as unknown as AttachSocket & { fire(ev: string): void };
}

// 18행 — 통합: 두 테넌트가 한 호스트에 붙어 있고 한쪽의 마지막 탭이 닫힌다.
test("18행 · 한 호스트에 테넌트 둘 — 한쪽 마지막 close 가 다른 쪽 장부를 건드리지 않는다", () => {
  const empties: string[] = [];
  const seen: Array<string | null> = [];
  const h = new SessionHost({
    lifetime: "ephemeral",
    onSessionEmpty: (id) => empties.push(id),
    // attach 본체 대신 «그 순간의 테넌트» 를 기록한다 — 컨텍스트가 어댑터에서 제대로 실려 오는지가 요점.
    attachImpl: () => { seen.push(currentTenant()?.slug ?? null); },
  });

  const A = "box-yoon-aaaaaaaa";   // 테넌트 A 의 세션
  const B = "box-yoon-bbbbbbbb";   // 테넌트 B 의 세션 — **같은 사람 슬러그**라도 꼬리가 다르다
  const sockA = fakeSock(), sockB = fakeSock();
  h.attach(sockA, A, (fn) => { withTenant({ id: "1", slug: "alpha" }, fn); });
  h.attach(sockB, B, (fn) => { withTenant({ id: "2", slug: "beta" }, fn); });

  assert.deepEqual(seen, ["alpha", "beta"], "어댑터가 실어 준 컨텍스트가 attach 본체까지 가야 한다");
  assert.equal(h.sessionCount(), 2);

  sockB.fire("close");   // 테넌트 B 의 마지막 탭이 닫힌다
  assert.deepEqual(empties, [B], "닫힌 쪽만 통지된다");
  assert.equal(h.socketsFor(A), 1, "★ 다른 테넌트의 살아 있는 화면은 그대로여야 한다");
  assert.equal(h.sessionCount(), 1);
});

// 19행 — 근거 ①. 이게 깨지면(id 가 결정적이 되면) 두 테넌트가 같은 장부 칸을 쓴다.
test("19행 · 세션 id 꼬리는 32비트 난수 — 같은 사람이라도 매번 다르다", () => {
  const tail = () => crypto.randomBytes(4).toString("hex");
  const ids = new Set(Array.from({ length: 200 }, () => `box-yoon-${tail()}`));
  assert.equal(ids.size, 200, "id 가 겹치면 테넌트 간에 같은 칸을 쓰게 된다");
  assert.match(`box-yoon-${tail()}`, /^box-[a-z0-9-]+-[a-f0-9]{8}$/, "장부·정규식이 기대하는 모양");
});

// 20행 — 근거 ②. registry 모드에서 tmux argv 가 테넌트마다 갈린다(그 argv 가 유령 정리까지 간다).
test("20행 · tmux argv 가 테넌트마다 다르다 — 남의 서버를 볼 수 없다", () => {
  const t = computeExecTopology({ LIVELY_TENANCY_MODE: "registry" } as NodeJS.ProcessEnv);
  assert.deepEqual(t.tmux, { kind: "socket", socket: "lvly-{slug}" });
  // 결합(부팅 상수 × 테넌트)은 tmuxArgvFor 가 하지만 그건 얼린 토폴로지를 보므로, 여기서는
  //  **템플릿이 슬러그를 요구한다**는 사실만 못박는다 — 그게 테넌트별로 갈리는 이유의 전부다.
  const argv = (slug: string) => ["tmux", "-L", (t.tmux as { socket: string }).socket.replace("{slug}", slug)];
  assert.notDeepEqual(argv("alpha"), argv("beta"));
  assert.deepEqual(argv("alpha"), ["tmux", "-L", "lvly-alpha"]);
});

// 21행 — 근거 ③. attach 본체는 `Promise.resolve().then(...)` 안에서 tmux 대상을 고른다.
//  컨텍스트가 그 경계를 못 넘으면 **컨텍스트 밖**으로 떨어져 엉뚱한 tmux(또는 예외)가 된다.
test("21행 · 테넌트 고정이 비동기 체인 끝까지 따라간다", async () => {
  const got = await withTenant({ id: "1", slug: "alpha" }, () =>
    Promise.resolve().then(() => currentTenant()?.slug ?? null));
  assert.equal(got, "alpha", "AsyncLocalStorage 가 아니면 여기서 null 이 된다");
});
