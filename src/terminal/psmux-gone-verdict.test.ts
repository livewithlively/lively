// psmux(윈도우 노드)의 '세션이 끝났나' 판정 — **«말이 없다»를 «없다는 말»로 읽지 않는다** (#3569).
//
// 왜 이 파일이 따로 있나: 판정이 `TMUX_BIN` 이 psmux 인지에 걸려 있는데 그 값은 **모듈 로드 때** 굳는다.
//  그래서 import 보다 먼저 env 를 세우려면 동적 import 가 필요하고, 그건 파일 단위로 격리돼야 한다.
//
// 배경(실측 2026-09-07, hammurabi · psmux.exe):
//   psmux list-sessions -F "#{session_name}"  → exit 0 · 세션명 한 줄씩
//   psmux has-session   -t <없는 id>          → exit 1 · stderr 빈 문자열
//  즉 psmux 의 exit 1 + 빈 stderr 에는 «없는 세션»과 «다른 이유로 실패»가 같은 모양으로 들어 있다.
//  종전엔 그걸 곧바로 «죽음의 확답»으로 승격해, **갓 만들어 아직 등록 전인 살아 있는 세션**까지 죽었다고 답했다
//  (그 오답 → 화면 부팅 게이트가 복원 실행 → 이어받을 대화가 없어 `claude --resume` 후보 0건 피커).
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TMUX_BIN = "/fake/bin/psmux";                 // ⚠ import 보다 먼저 — 아래 동적 import 가 이 값을 굳힌다
const { sessionGone } = await import("./tmux-exec.js");

const LIVE = "box-tester-11111111";
const tmp: string[] = [];
afterEach(() => { delete process.env.LIVELY_TMUX_EXEC; while (tmp.length) fs.rmSync(tmp.pop()!, { recursive: true, force: true }); });

/** psmux 를 흉내 내는 가짜 실행파일. listBody=null 이면 list-sessions 도 조용히 exit 1(=목록조차 못 봄). */
function fakePsmux(listBody: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psmux-verdict-"));
  tmp.push(dir);
  const bin = path.join(dir, "psmux.sh");
  const listFile = path.join(dir, "list.txt");
  //  ⚠ 목록은 **파일로** 준다 — 스크립트에 문자열로 박으면 `printf '%s'` 가 개행 이스케이프를 글자 그대로 찍어
  //   목록 전체가 한 줄로 뭉친다(이 픽스처를 처음 쓸 때 실제로 그렇게 틀렸고, 그러면 E1 이 엉뚱한 이유로 빨간불이다).
  const listCase = listBody === null
    ? '  list-sessions) exit 1 ;;\n'                       // 조용한 실패(stderr 없음)
    : `  list-sessions) cat ${JSON.stringify(listFile)}; exit 0 ;;\n`;
  if (listBody !== null) fs.writeFileSync(listFile, listBody);
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in\n  has-session) exit 1 ;;\n' + listCase + 'esac\nexit 1\n', { mode: 0o755 });
  return bin;
}

// ★ 이 파일의 이유 — 고치기 전 코드는 여기서 true(죽었다)를 답했다.
test("E1 has-session 이 조용히 exit 1 이어도, 목록에 있으면 **살아 있다**", async () => {
  process.env.LIVELY_TMUX_EXEC = fakePsmux(`${LIVE}\nbox-tester-22222222\n`);
  assert.equal(await sessionGone(LIVE), false,
    "목록이 그 세션을 보여 주는데 죽었다고 답하면, 화면이 살아 있는 세션을 복원으로 몰아 빈 피커를 띄운다(#3569)");
});

test("E2 목록에 없으면 죽음 확답", async () => {
  process.env.LIVELY_TMUX_EXEC = fakePsmux("box-tester-22222222\n");
  assert.equal(await sessionGone(LIVE), true);
});

test("E3 목록이 비었으면(세션 0개) 죽음 확답", async () => {
  process.env.LIVELY_TMUX_EXEC = fakePsmux("");
  assert.equal(await sessionGone(LIVE), true);
});

// #1791 무회귀 — 목록조차 못 보면 종전 판정(gone)을 유지한다. 안 그러면 윈도우의 죽은 세션이 영영 복원·삭제 불가가 된다.
test("E4 목록조차 못 보면 종전 판정(죽음)을 유지한다 — #1791 무회귀", async () => {
  process.env.LIVELY_TMUX_EXEC = fakePsmux(null);
  assert.equal(await sessionGone(LIVE), true);
});

test("E5 has-session 이 성공하면 목록을 묻지 않고 살아 있다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psmux-verdict-"));
  tmp.push(dir);
  const bin = path.join(dir, "psmux.sh");
  //  list-sessions 를 부르면 그 자체가 실패다 — has-session 성공 뒤엔 되물을 이유가 없다.
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in\n  has-session) exit 0 ;;\nesac\necho "되물으면 안 된다" >&2\nexit 9\n', { mode: 0o755 });
  process.env.LIVELY_TMUX_EXEC = bin;
  assert.equal(await sessionGone(LIVE), false);
});

test("E6 세션 id 형식이 틀리면 '종료'가 아니라 잘못된 요청 — tmux 를 부르지 않는다", async () => {
  process.env.LIVELY_TMUX_EXEC = fakePsmux("");
  assert.equal(await sessionGone("not a session id"), false);
});
