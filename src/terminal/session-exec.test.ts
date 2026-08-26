// 세션 경계 조립 계약 (#2055 P3) — **순수**(프로세스·컨테이너 없음).
//
//  ── 왜 이 표가 필요한가 (실측 2026-08-26, lvly-box) ──
//  이 조립이 틀리면 증상이 **보안 문제**로 나온다: 멤버 경계(LIVELY_MEMBER_EXEC)로 보내면 codex 가
//  **tmux 컨테이너**에서 도는데, 거기는 그 테넌트의 **모든 멤버가 공유**하고 `HOME=/` 이라 자격도 못 찾는다.
//  둘 다 조용한 실패다 — 대화는 되는 것처럼 보이고 경계만 사라진다. 그래서 조립을 문자열로 못박는다.
import assert from "node:assert/strict";
import { sessionExecArgv, sessionExecConfigured, sessionSpawnArgv } from "./session-exec.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const withEnv = (env: Record<string, string | undefined>, fn: () => void): void => {
  const keep: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { keep[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { fn(); } finally { for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
};

t("A1 중계가 없으면 빈 배열 — 호출자가 '이 배포는 로컬'로 읽는다(셀프호스트 무회귀)", () => {
  withEnv({ LIVELY_SESSION_EXEC: undefined }, () => {
    assert.equal(sessionExecConfigured(), false);
    assert.deepEqual(sessionSpawnArgv("box-yoon-1", ["node", "-e", "1"]), []);
  });
});

t("★ A2 조립 계약 — `<중계> <sessionId> -- <argv…>`(멤버 경계와 같은 모양, 두 번째 자리만 다르다)", () => {
  withEnv({ LIVELY_SESSION_EXEC: "node /opt/lively/libexec/session-exec-relay.cjs acme" }, () => {
    assert.deepEqual(
      sessionSpawnArgv("box-yoon-1", ["sh", "-c", "echo hi"]),
      ["node", "/opt/lively/libexec/session-exec-relay.cjs", "acme", "box-yoon-1", "--", "sh", "-c", "echo hi"],
    );
  });
});

t("★ A3 {slug} 치환에 테넌트 컨텍스트가 없으면 **던진다** — 기본값으로 접으면 남의 테넌트에 exec 한다", () => {
  withEnv({ LIVELY_SESSION_EXEC: "node relay.cjs {slug}" }, () => {
    assert.throws(() => sessionExecArgv(), /테넌트 컨텍스트/);
  });
});

t("★ A4 세션 id 형식을 여기서 막는다 — 컨테이너 이름의 재료다(주입 차단)", () => {
  withEnv({ LIVELY_SESSION_EXEC: "node relay.cjs acme" }, () => {
    for (const bad of ["../other", "a b", "", "x;rm -rf /", "sess/../..", "-flag"]) {
      assert.throws(() => sessionSpawnArgv(bad, ["sh"]), /세션 id 형식 오류/, `통과하면 안 된다: ${bad}`);
    }
    assert.ok(sessionSpawnArgv("box-yoon-4b6ca04d", ["sh"]).length, "정상 id 는 통과한다");
  });
});

t("A5 중계 문자열에 {slug} 가 없으면 그대로 쓴다(테넌트 고정 배포)", () => {
  withEnv({ LIVELY_SESSION_EXEC: "  /usr/bin/relay --fixed  " }, () => {
    assert.deepEqual(sessionExecArgv(), ["/usr/bin/relay", "--fixed"]);
  });
});

t("A6 값을 **호출 시점에** 읽는다 — 모듈 로드 시점 고정은 부팅 순서·테스트에서 깨진다", () => {
  withEnv({ LIVELY_SESSION_EXEC: undefined }, () => assert.equal(sessionExecConfigured(), false));
  withEnv({ LIVELY_SESSION_EXEC: "x" }, () => assert.equal(sessionExecConfigured(), true));
});

console.log(`\n${pass} passed`);
