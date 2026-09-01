// 멤버 홈 codex 설치 배선 락 — codex 세션이 npm 전역 자동업데이트 EACCES 로 즉시 종료되던 문제(2026-08-27)의
//  회귀 가드. claude 의 #1023(네이티브 self-update 홈 설치)과 **같은 원인·같은 처방의 codex 판**이다.
//
//  왜 락이 필요한가: 이 배선은 조각이 4곳에 흩어져 있고(헬퍼 · libexec 설치 · 프로비저닝 호출 · 기존 멤버
//   백필), 하나라도 빠지면 **증상이 "codex 로그인이 만료된 것처럼" 보인다**(라이블리 안내가 로그인 만료를
//   먼저 말한다). 그래서 오진으로 시간을 태우기 쉬워, 네 조각의 존재를 코드로 못박는다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), "utf8");
const helper = read("install-codex-user.sh");
const provision = read("provision-member.sh");
const refresh = read("refresh-member-kits.sh");
const isolation = read("linux", "install-isolation.sh");
//  PATH 정본은 session-env.sh 다 — #2258 이동 2(a08cb18f)로 box-spawn 이 손으로 적던 신원·PATH·로케일이
//   이 한 벌로 모였다. 여기를 봐야 세 표면(box-spawn·매니지드·노드)이 실제로 쓰는 순서를 잠근다.
const sessionEnv = read("linux", "session-env.sh");

// 주석이 아닌 실제 명령 라인만 — 설명 주석의 명령어 언급에 오탐되지 않게(provision-member-order 와 같은 규약).
const codeLines = (src) => src.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#"));
const inCode = (src, re) => codeLines(src).some((l) => re.test(l));

// ── ① 헬퍼: prefix 를 멤버 홈으로 돌리고 그 자리에 설치한다 ──────────────────────
//  이게 처방의 핵심이다 — codex 자동 업데이트는 `npm install -g` 이므로 **npm prefix 가 멤버 쓰기 가능**
//  해야 성공한다. 설치만 홈에 하고 prefix 를 /usr 로 두면 다음 자동 업데이트가 다시 EACCES 로 죽는다.
assert.ok(/\.npm-global/.test(helper), "헬퍼는 멤버 홈 prefix(~/.npm-global)를 쓴다");
assert.ok(inCode(helper, /prefix=/), "헬퍼는 npmrc 에 prefix 를 설정한다(설치 위치만 바꾸면 자동 업뎃이 다시 /usr 로 간다)");
assert.ok(inCode(helper, /npm install -g/), "헬퍼는 npm 전역 설치로 codex 를 깐다");
// 비파괴: 이미 prefix 가 있으면 존중해야 한다(멤버가 의도한 설정을 덮지 않는다).
assert.ok(/grep -qE '\^\[\[:space:\]\]\*prefix/.test(helper), "기존 prefix 가 있으면 npmrc 를 건드리지 않는다(비파괴)");
// 멱등·안전 규약(install-claude-user 와 동일) — 매 update.sh 마다 전 멤버에 호출되므로 어느 것도 빠지면 안 된다.
assert.ok(inCode(helper, /\[ -x "\$CODEX_BIN" \] && exit 0/), "이미 설치됐으면 조용히 스킵(멱등)");
// 판정은 **실효 prefix**(npm config get prefix) 기준이어야 한다 — 고정 경로로 판정하면 커스텀 prefix 멤버에서
//  ①성공에도 실패 로그 ②매 update.sh 마다 수백MB 재설치 반복 ③PATH 밖이라 증상 미해소 가 한꺼번에 난다.
assert.ok(inCode(helper, /npm config get prefix/), "설치·스킵 판정을 실효 prefix 로 한다(고정 경로 판정 금지)");
// npmrc 보정이 바이너리 스킵보다 **앞**이어야 한다 — 바이너리는 있는데 prefix 는 없는 부분 상태가
//  영구 고착되면(스킵이 먼저면) 자동 업데이트가 계속 EACCES 로 죽는다.
{
  const hl = helper.split(/\r?\n/);
  const iPrefixFix = hl.findIndex((l) => /prefix=%s/.test(l));
  const iBinSkip = hl.findIndex((l) => /\[ -x "\$CODEX_BIN" \] && exit 0/.test(l));
  assert.ok(iPrefixFix >= 0 && iBinSkip >= 0, "npmrc 보정·바이너리 스킵 라인 존재");
  assert.ok(iPrefixFix < iBinSkip, "npmrc prefix 보정이 바이너리 존재 스킵보다 앞(부분 상태 자가치유)");
}
assert.ok(inCode(helper, /OFFLINE:-0.*= 1.*exit 0|\[ "\$\{OFFLINE:-0\}" = "1" \] && exit 0/), "OFFLINE 이면 스킵");
assert.ok(/^exit 0$/m.test(helper), "실패해도 exit 0 — 프로비저닝·업뎃을 막지 않는다(best-effort)");
assert.ok(inCode(helper, /runuser -u "\$U"/), "설치 쓰기는 멤버 uid 로 한다(root 로 깔면 또 멤버가 못 고친다)");

// ── ② PATH: 멤버 소유 bin 이 시스템보다 먼저여야 홈 codex 가 실제로 쓰인다 ────────
//  이 순서가 뒤집히면 홈에 깔아도 /usr/bin/codex(스테일·자동업뎃 실패)가 계속 실행된다.
//  ⚠ export PATH 라인이 **둘**이다(상속 PATH 를 이어받는 경로와 아닌 경로) — 하나만 보면 나머지 경로에서
//   순서가 뒤집혀도 초록이다. 전부 단언한다.
const pathLines = codeLines(sessionEnv).filter((l) => /export PATH=/.test(l));
assert.ok(pathLines.length > 0, "session-env.sh 에 PATH export 존재");
for (const pathLine of pathLines) {
  const iNpmGlobal = pathLine.indexOf(".npm-global/bin");
  const iUsrBin = pathLine.indexOf("/usr/bin");
  assert.ok(iNpmGlobal >= 0, `session-env.sh PATH 에 ~/.npm-global/bin 이 있어야 한다(멤버 npm 전역 자리): ${pathLine.trim()}`);
  assert.ok(iNpmGlobal < iUsrBin, `~/.npm-global/bin 은 /usr/bin 보다 앞이어야 한다(스테일 시스템 codex 를 가린다): ${pathLine.trim()}`);
}

// ── ③ libexec 설치 · ④ 프로비저닝 호출 · ⑤ 기존 멤버 백필 ────────────────────────
assert.ok(inCode(isolation, /install-codex-user\.sh".*libexec\/install-codex-user/),
  "install-isolation.sh 가 헬퍼를 libexec 에 설치한다(프로비저닝이 그 본을 쓴다)");
assert.ok(inCode(provision, /bash "\$CODEX_HELPER" "\$OSUSER"/), "provision-member.sh 가 새 멤버에 헬퍼를 호출한다");
assert.ok(inCode(provision, /CODEX_HELPER=.*libexec\/install-codex-user/),
  "repo sibling 이 없으면 libexec 본으로 폴백한다(배포본에서도 동작)");
assert.ok(inCode(refresh, /install-codex-user\.sh" "\$u"/),
  "refresh-member-kits.sh 가 **이미 프로비저닝된** 멤버에도 백필한다 — 첫 세션 게이트로는 재프로비저닝되지 않는다");
// ⚠ 호출 존재만 보면 부족하다 — 백필을 `[ -d "$h/.lively/hooks" ] || continue` 게이트 **뒤로** 옮기면
//  kit 미설치 멤버가 조용히 빠진다(하네스는 세션 진입 수단이라 kit 유무와 무관하게 필요). 위치를 락한다.
{
  const rl = refresh.split(/\r?\n/);
  const iBackfill = rl.findIndex((l) => /install-codex-user\.sh" "\$u"/.test(l));
  const iKitGate = rl.findIndex((l) => /\[ -d "\$h\/\.lively\/hooks" \] \|\| continue/.test(l));
  assert.ok(iBackfill >= 0 && iKitGate >= 0, "백필 호출·kit 게이트 라인 존재");
  assert.ok(iBackfill < iKitGate, "codex 백필은 kit 설치 게이트(continue)보다 앞 — kit 미설치 멤버도 대상");
}

// ── ⑥ 키트 배선: codex 도 lively 자산(config.toml·AGENTS.md)을 받아야 한다 ────────
//  홈 설치만 하면 codex 는 뜨지만 lively MCP·훅이 없어 조직 맥락이 안 붙는다(#524 갭의 codex 판).
assert.ok(inCode(provision, /user-install\.mjs.*--harness claude,codex/),
  "멤버 키트가 claude 와 codex 를 함께 배선한다(codex 만 빠지면 세션은 뜨나 lively 미연동)");

console.log("member-codex-install.test OK — 헬퍼(prefix+설치·멱등·비파괴) · PATH 우선순위 · libexec · 프로비저닝 · 백필 · 키트 배선");
