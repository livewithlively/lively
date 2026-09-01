// 분리 프로세스 모델 계약 (#2055) — **순수 계산만** 본다(프로세스·소켓 없음).
//
//  왜 이 표가 필요한가: 1차 구현은 app-server 를 게이트웨이의 stdio 자식으로 띄웠고, 그래서 게이트웨이가
//  재기동되는 순간 **돌던 턴이 통째로 유실**됐다(실측 2026-08-26 dev: 프롬프트 18:23:46 → stage-sync 재기동
//  18:24:38 → 답 영영 없음). 여기서 지키는 것은 그 재발을 막는 성질들이다.
import assert from "node:assert/strict";
import { detachedStartSh, PORT_BASE, PORT_SPAN, sessionPort } from "./codex-app-server-daemon.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("★ R1 포트는 세션 id 에서 결정론적으로 나온다 — 레지스트리 없이 재접속한다", () => {
  const a = sessionPort("box-yoon-b3fb7b29");
  const b = sessionPort("box-yoon-b3fb7b29");
  assert.equal(a, b, "게이트웨이가 재기동돼도 같은 세션이면 같은 포트를 다시 계산해야 한다");
});

t("R2 다른 세션은 (거의) 다른 포트 — 같은 포트에 두 서버가 서면 대화가 섞인다", () => {
  const ports = new Set(["s1", "s2", "s3", "box-yoon-1", "box-yoon-2"].map((s) => sessionPort(s)));
  assert.equal(ports.size, 5);
});

t("R3 포트는 정해진 대역 안이다(사용자 서비스 대역 침범 금지)", () => {
  for (const s of ["a", "b", "긴-세션-id-한글", "box-yoon-b3fb7b29"]) {
    const p = sessionPort(s);
    assert.ok(p >= PORT_BASE && p < PORT_BASE + PORT_SPAN, `${s} → ${p}`);
  }
});

t("R4 nth 로 옆칸으로 민다(충돌 회피) — 대역은 그대로", () => {
  const p0 = sessionPort("s1"), p1 = sessionPort("s1", 1);
  assert.equal(p1, PORT_BASE + ((p0 - PORT_BASE + 1) % PORT_SPAN));
});

t("★ S1 컨테이너 기동 한 줄은 nohup 으로 **떼어 놓는다** — 중계 셸이 끝나도 서버가 남아야 한다", () => {
  const sh = detachedStartSh(39123, "$HOME/.codex/x.log");
  assert.match(sh, /nohup /, "nohup 없이는 중계가 끝날 때 서버가 같이 죽는다");
  assert.match(sh, /&\s*$/m, "백그라운드로 띄운다");
  assert.match(sh, /--listen ws:\/\/127\.0\.0\.1:39123/, "ws 리스너로 띄운다(stdio 는 부모 수명에 묶인다)");
});

t("★ S2 이미 살아 있으면 두 번 띄우지 않는다 — 서버 둘이 같은 스레드를 노리면 writer 충돌이다", () => {
  const sh = detachedStartSh(39123, "/tmp/x.log");
  assert.match(sh, /already/, "이미 있으면 already 로 끝낸다");
  const before = sh.indexOf("already");
  const after = sh.indexOf("nohup");
  assert.ok(before < after, "살아 있는지 확인이 기동보다 먼저여야 한다");
});

t("S3 codex 가 없으면 기동을 시도하지 않고 사유를 남긴다(조용한 실패 금지)", () => {
  const sh = detachedStartSh(39123, "/tmp/x.log");
  assert.match(sh, /command -v codex/);
  assert.match(sh, /exit 127/);
});

t("★ S5 로그 폴더를 보장한다 — 없으면 리다이렉트가 실패해 **서버가 아예 안 뜬다**", () => {
  const sh = detachedStartSh(39123, "$HOME/.codex/x.log");
  assert.match(sh, /mkdir -p "\$\(dirname /, "`~/.codex` 는 codex 를 한 번이라도 쓴 홈에만 있다");
  const mk = sh.indexOf("mkdir -p");
  const run = sh.indexOf("nohup");
  assert.ok(mk >= 0 && mk < run, "폴더 보장이 기동보다 먼저여야 한다");
});

t("★ S6 기동을 **확인해서** 말한다 — `&` 는 즉시 0 이라 그것만으론 아무것도 안 본 것이다", () => {
  const sh = detachedStartSh(39123, "/tmp/x.log");
  const started = sh.lastIndexOf("echo started");
  const probe = sh.lastIndexOf("s.on(\"connect\"");
  assert.ok(probe >= 0 && probe < started, "포트가 열린 것을 보고 started 를 말한다");
  assert.match(sh, /tail -n 5/, "실패하면 로그 꼬리를 진단으로 돌려준다");
  assert.match(sh, /exit 1/, "실패는 비-0 으로 나간다(호출자가 폴백할 수 있게)");
});

t("S4 로그를 남긴다 — 떼어 놓은 프로세스는 사후 진단이 유일한 창이다", () => {
  assert.match(detachedStartSh(39123, "$HOME/.codex/lively-app-server-s1.log"), /lively-app-server-s1\.log/);
});

console.log(`\n${pass} passed`);
