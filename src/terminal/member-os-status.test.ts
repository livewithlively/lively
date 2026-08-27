// 순수 단위 체크(node:assert) — 구성원 OS 격리 로그인 판정(judgeMemberOs, #1471).
// 실행: npm run build && node dist/terminal/member-os-status.test.js
//
// 이 판정이 왜 '있음/없음' 두 갈래가 아니라 세 갈래여야 하는지가 이 파일의 전부다:
//  홈(/home/box_<slug>)과 OS 유저(/etc/passwd)의 수명이 갈리는 배포(컨테이너)가 있고, 그때
//  "확인할 수 없음"을 "로그인 안 함"으로 반올림하면 그 위에 얹힌 자동화가 조용히 안 켜진다.
import assert from "node:assert/strict";
import { judgeMemberOs, harnessHasCredential } from "./profiles.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("자격 있음 — 프로비저닝됨 + 자격파일 존재 → true(확실)", () => {
  assert.deepEqual(
    judgeMemberOs({ ready: true, provisioned: true, homeExists: true, credExists: true }),
    { loggedIn: true, orphanHome: false },
  );
});

t("자격 없음 — 프로비저닝됨 + 자격파일 없음 → false(확실히 미로그인)", () => {
  assert.deepEqual(
    judgeMemberOs({ ready: true, provisioned: true, homeExists: true, credExists: false }),
    { loggedIn: false, orphanHome: false },
  );
});

t("알 수 없음 — 홈은 있는데 OS 유저가 없음(고아 홈) → null + orphanHome", () => {
  // 실측(#1471): 매니지드 테넌트 컨테이너 재생성 → /home 은 영속 볼륨이라 살아남고 /etc/passwd 는 초기화.
  //  자격증명은 /home/box_yoon/.claude/.credentials.json 에 그대로 있었는데 box_yoon 유저가 없었다.
  assert.deepEqual(
    judgeMemberOs({ ready: true, provisioned: false, homeExists: true, credExists: false }),
    { loggedIn: null, orphanHome: true },
  );
});

t("확실히 미로그인 — 홈도 유저도 없음(그냥 미프로비저닝 멤버)", () => {
  assert.deepEqual(
    judgeMemberOs({ ready: true, provisioned: false, homeExists: false, credExists: false }),
    { loggedIn: false, orphanHome: false },
  );
});

t("격리 인프라 미준비(비-Linux·off·미설치)면 고아 판정 안 함 — 종전대로 false", () => {
  // ready=false 면 애초에 box_ 경로로 세션이 안 뜬다. 남은 홈 dir 을 '모름'으로 올리면
  //  격리를 끈 박스에서 영영 null 이 굳는다 → 그 축은 건드리지 않는다(무회귀).
  assert.deepEqual(
    judgeMemberOs({ ready: false, provisioned: false, homeExists: true, credExists: false }),
    { loggedIn: false, orphanHome: false },
  );
});

t("판정은 credExists 를 provisioned 일 때만 신뢰한다(미프로비저닝이면 무시)", () => {
  // 미프로비저닝인데 credExists=true 는 호출부가 만들 수 없는 조합이지만, 순수함수는 그래도 결정적이어야 한다.
  assert.equal(judgeMemberOs({ ready: true, provisioned: false, homeExists: true, credExists: true }).loggedIn, null);
  assert.equal(judgeMemberOs({ ready: true, provisioned: false, homeExists: false, credExists: true }).loggedIn, false);
});


// ── #2148 — 중계 배포(매니지드)에는 **멤버 OS 계정이 아예 없다** ────────────────────────────
//  중계는 테넌트 tmux 컨테이너로 나가고 그 안의 uid 는 테넌트다(member-exec-relay 머리말).
//  즉 provisioned 는 구조적으로 영원히 false 인데, 종전엔 그걸 자격 확인의 **전제**로 삼았다.
//  결과: app.lvly.io 에서 「AI 로그인한 구성원이 없음(T9 관문 미통과)」이 무한 반복되고
//  자율 파이프라인 가동 성공이 **누적 0건**이었다 — 자격 파일은 디스크에 멀쩡히 있었는데도.
//  (2026-08-27 실측: `~/.claude/.credentials.json` 509B 존재 · 중계로 `test -f` EXIT=0.)
//  → 확인을 **실제로 돌렸으면 그 답이 권위다.** passwd 항목 유무는 그걸 뒤집을 근거가 아니다.

t("★★ 중계로 자격을 확인했으면 provisioned 가 false 여도 로그인이다", () => {
  assert.deepEqual(
    judgeMemberOs({ ready: true, provisioned: false, homeExists: true, credExists: true, credChecked: true }),
    { loggedIn: true, orphanHome: false },
  );
});

// ★ 고아로 오인하면 컨트롤플레인이 무의미한 복구(healOrphanHomes)를 반복한다 — 매니지드에선
//  그 유저를 되살릴 자리가 애초에 없다(passwd 는 컨테이너 수명).
t("★ 중계로 확인했는데 자격이 없으면 '확실히 미로그인'이다(고아 아님)", () => {
  assert.deepEqual(
    judgeMemberOs({ ready: true, provisioned: false, homeExists: true, credExists: false, credChecked: true }),
    { loggedIn: false, orphanHome: false },
  );
});

// ★ 중앙 게이트웨이 컨테이너에는 box-spawn 이 없어 ready=false 다(실측). 그 사실이 중계 확인을
//  뒤집으면 안 된다 — ready 는 '로컬 격리 인프라'의 이야기지 중계의 이야기가 아니다.
t("★ ready=false(로컬 격리 인프라 없음)여도 중계 확인 결과를 존중한다", () => {
  assert.equal(
    judgeMemberOs({ ready: false, provisioned: false, homeExists: false, credExists: true, credChecked: true }).loggedIn,
    true,
  );
});

t("provisioned 면 credChecked 와 무관하게 종전 경로(무회귀)", () => {
  assert.deepEqual(
    judgeMemberOs({ ready: true, provisioned: true, homeExists: true, credExists: true, credChecked: false }),
    { loggedIn: true, orphanHome: false },
  );
});

// credChecked 를 안 준 호출(구 호출부·셀프호스트)은 종전 세 갈래 그대로여야 한다.
t("credChecked 미지정이면 종전 판정 그대로", () => {
  assert.equal(judgeMemberOs({ ready: true, provisioned: false, homeExists: true, credExists: true }).loggedIn, null);
  assert.equal(judgeMemberOs({ ready: true, provisioned: false, homeExists: false, credExists: true }).loggedIn, false);
});


// ── #1884 — 세션 폼 [내 계정 로그인]이 어느 AI 를 고르게 할지의 근거 ──────────────────────────
//  이 판정이 '표에 있나'여야 하는 이유: 표에 없는 하네스(opencode·antigravity)는 자격이 keyring·제공자별로
//  흩어져 있어 파일 존재로 로그인 여부를 말하면 **거짓말**이 된다(profiles.ts HARNESS_CRED 머리말).
//  그래서 그 하네스들은 목록에 넣지 않는다 — 정직한 침묵.
t("로그인 개념이 있는 AI — claude·codex·grok", () => {
  for (const k of ["claude", "codex", "grok"]) assert.equal(harnessHasCredential(k), true, k);
});

t("자격 위치를 실측 못 한 하네스·셸은 고르게 하지 않는다", () => {
  for (const k of ["opencode", "antigravity", "shell", "", "toString", "__proto__"]) {
    assert.equal(harnessHasCredential(k), false, k);
  }
});

console.log(`\n${pass} passed`);
