// «상태 불명» 을 «살아 있음» 으로 접지 않는다 — 사람에게 보이는 자리에서만 (#3752 ④).
//
// 배경(실측 2026-09-08, #3688): 매니지드 세션 컨테이너 하나가 wedged 되자 브로커의 개별 `runsc state` 가
//  10초에 타임아웃했고, exec 중계는 503 `LVLY_STATE_UNKNOWN` 을 돌려줬다. 게이트웨이의 `sessionGone` 은
//  그 실패를 «gone 확답이 아니다» → `false`(살아 있음)로 접는다. 그래서:
//    GET  /api/ui/terminal/sessions/<id>  → 6.9초 뒤 {id,label,projectId} — restorable 신호가 통째로 없음
//    POST …/restore                        → 6.2초 뒤 {ok:true, already:true}
//  사람은 «응답이 없다» 로만 겪고 복원 게이트는 영영 안 열린다 — 그 샌드박스는 사람이 개입하기 전엔
//  스스로 돌아오지 않으므로 «잠시 뒤 다시» 의 잠시 뒤가 오지 않는다.
//
// ★ 고침의 모양: **판정을 바꾸지 않고 사실을 하나 더 낸다.** `sessionGone` 의 접기는 자동 경로에서 옳고
//  (#835·#2108·#3626 — 모름을 죽음으로 읽으면 살아 있는 세션이 복원으로 끌려간다), 사람에게 보이는 자리만
//  셋을 가른다. 그래서 이 파일이 지키는 것은 둘이다: ① verdict 가 «모름»(null)을 살린다 ② **구 계약은 그대로다**.

import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionGone, sessionGoneVerdict } from "./tmux-exec.js";
import { unknownStateMeta, type DeadSessionMeta } from "./session-meta.js";

const LIVE = "box-tester-11111111";
const tmp: string[] = [];
afterEach(() => { delete process.env.LIVELY_TMUX_EXEC; while (tmp.length) fs.rmSync(tmp.pop()!, { recursive: true, force: true }); });

/** tmux 를 흉내 내는 가짜 실행파일 — has-session 의 종료코드와 stderr 를 정한다. */
function fakeTmux(exit: number, stderr: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-unknown-"));
  tmp.push(dir);
  const bin = path.join(dir, "tmux.sh");
  const errFile = path.join(dir, "err.txt");
  fs.writeFileSync(errFile, stderr);
  //  ⚠ stderr 는 **파일로** 준다 — 스크립트에 문자열로 박으면 이스케이프가 글자 그대로 나가 판정 문구가 어긋난다
  //   (psmux-gone-verdict.test 의 같은 함정 주석 참조).
  fs.writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(errFile)} >&2\nexit ${exit}\n`, { mode: 0o755 });
  return bin;
}

//  실측 그대로의 중계 실패 — 브로커가 «못 봤다» 를 재시도 가능한 503 으로 답한 모양.
const RELAY_UNKNOWN = `503: {"message":"LVLY_STATE_UNKNOWN: lvly-s-lively-46e3-box-sangmin-yoon-bd84e598 — rc=124 timeout"}\n`;

test("[#3752-④ 엣지1] has-session 이 성공하면 살아있음(false)", async () => {
  process.env.LIVELY_TMUX_EXEC = fakeTmux(0, "");
  assert.equal(await sessionGoneVerdict(LIVE), false);
});

test("[#3752-④ 엣지2] tmux 가 «없다» 고 확답하면 true", async () => {
  process.env.LIVELY_TMUX_EXEC = fakeTmux(1, `can't find session: ${LIVE}\n`);
  assert.equal(await sessionGoneVerdict(LIVE), true);
});

test("[#3752-④ 엣지3] ★ 중계가 «상태 불명»(503)을 주면 **null** — «살아 있음» 이 아니다", async () => {
  process.env.LIVELY_TMUX_EXEC = fakeTmux(1, RELAY_UNKNOWN);
  const v = await sessionGoneVerdict(LIVE);
  assert.equal(v, null,
    "«못 봤다» 를 «살아 있다» 로 접으면 사람은 «응답이 없다» 로만 겪고 복원이 영영 안 열린다(#3688)");
});

test("[#3752-④ 엣지4] ★ 같은 입력에 구 `sessionGone` 은 **여전히 false** — 자동 경로 무회귀", async () => {
  //  급소. 여기를 함께 바꾸면 «모름» 이 «죽음» 이 되어, 상태 push 창(#2108)·갓 만든 세션(#3626)이 복원으로
  //  끌려가고 후보 0건 피커가 뜬다. 이번 변경은 **부르는 쪽이 고르게** 하는 것이지 판정을 뒤집는 게 아니다.
  process.env.LIVELY_TMUX_EXEC = fakeTmux(1, RELAY_UNKNOWN);
  assert.equal(await sessionGone(LIVE), false);
  //  그리고 확답일 때는 둘이 같은 말을 한다.
  process.env.LIVELY_TMUX_EXEC = fakeTmux(1, `can't find session: ${LIVE}\n`);
  assert.equal(await sessionGone(LIVE), true);
});

test("[#3752-④ 엣지5] 형식 밖 id 는 «끝남» 이 아니라 잘못된 요청(false) — 종전 그대로", async () => {
  assert.equal(await sessionGoneVerdict("not a session id"), false);
});

test("[#3752-④ 엣지9] ★ 상태 불명 메타는 복원을 **약속하지 않는다**(restorable 없음) — 권한·라벨은 승계", () => {
  const dead: DeadSessionMeta = {
    id: LIVE, label: "파일op 컨테이너 실체", projectId: 3668,
    restorable: true, canRestore: true, exitedByUser: false, oomKilled: false, harness: "claude",
  };
  const u = unknownStateMeta(dead);
  //  급소: 여기서 restorable 을 실으면 화면이 «되살릴 수 있어요» 라고 약속한 뒤 복원이 409 를 낸다 —
  //  이 코드베이스가 kind:"moved" 에서 이미 거부한 모양이다(session-meta.ts 머리말).
  assert.equal("restorable" in u, false, "확답이 없는데 복원을 약속했다");
  assert.equal(u.stateUnknown, true);
  //  화면이 [강제로 되살리기] 를 그릴 수 있으려면 «누가 누를 수 있나» 와 라벨은 그대로 와야 한다.
  assert.deepEqual([u.id, u.label, u.projectId, u.canRestore, u.harness],
    [LIVE, "파일op 컨테이너 실체", 3668, true, "claude"]);
});

/** 소스를 LF 로 정규화해 읽는다 — 배선 단언은 구조적 토큰만 본다(문구가 아니라). */
const srcOf = (rel: string): string =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

test("[#3752-④ 엣지10] ★ 배선 — 세션 메타 라우트가 verdict 로 세 갈래를 가른다", () => {
  const src = srcOf("../../src/terminal/routes.ts");
  assert.match(src, /const goneVerdict = await sessionGoneVerdict\(id\);/, "메타가 여전히 두 갈래 판정을 쓴다");
  assert.match(src, /if \(goneVerdict === null\) \{[\s\S]{0,400}?unknownStateMeta\(dead\.body\)/,
    "«모름» 갈래가 상태 불명 메타를 내지 않는다 — 사람이 그 사실을 못 본다");
  assert.match(src, /\} else if \(goneVerdict === true\) \{/, "«끝남» 확답 갈래가 종전 본문을 유지하지 않는다");
});

test("[#3752-④ 엣지11] ★ 배선 — 복원은 «모름» 에서 기본 409, 사람이 고르면(force) 진행", () => {
  const src = srcOf("../../src/terminal/routes.ts");
  //  ⚠ 순서가 계약이다: false(살아있음)면 already 로 끝나고, null 은 force 없이는 409 다.
  assert.match(src, /if \(goneVerdict === false\) \{ res\.json\(\{ ok: true, already: true, id \}\); return; \}/,
    "라이브 경합 방어(확답으로 살아있음 → already)가 사라졌다");
  assert.match(src, /if \(goneVerdict === null && !force\) \{[\s\S]{0,300}?HttpError\(409/,
    "«모름» 을 조용히 already 로 접거나, force 없이 강제 복원하고 있다");
  assert.match(src, /const force = req\.query\.force === "1"/, "사람의 선택을 받는 입구가 없다");
});

test("[#3752-④ 엣지11ᵇ] ★ 배선 — 화면의 [이어서 열기] 가 409 를 받으면 강제 복원을 제시한다", () => {
  //  종전엔 이 버튼이 already 를 받고 «잠시 뒤 다시 눌러 주세요» 만 반복했다 — 그 «잠시 뒤» 는 오지 않는다.
  const src = srcOf("../../web/session-chat.ts");
  assert.match(src, /pd\.forceRestore \? '\?force=1' : ''/, "사람이 고른 뒤에도 force 를 안 싣는다");
  assert.match(src, /e\?\.status === 409 && !pd\.forceRestore/, "409(상태 불명)를 다른 실패와 같이 다룬다");
  //  ⚠ 기본값으로 force 를 싣지 않는다 — 자동 경로가 옛 세션을 둘로 만들지 않게(#835).
  assert.doesNotMatch(src, /restore\?force=1`/, "force 가 기본 경로에 박혀 있다");
});
