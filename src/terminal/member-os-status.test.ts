// 순수 단위 체크(node:assert) — 구성원 OS 격리 로그인 판정(judgeMemberOs, #1471).
// 실행: npm run build && node dist/terminal/member-os-status.test.js
//
// 이 판정이 왜 '있음/없음' 두 갈래가 아니라 세 갈래여야 하는지가 이 파일의 전부다:
//  홈(/home/box_<slug>)과 OS 유저(/etc/passwd)의 수명이 갈리는 배포(컨테이너)가 있고, 그때
//  "확인할 수 없음"을 "로그인 안 함"으로 반올림하면 그 위에 얹힌 자동화가 조용히 안 켜진다.
import assert from "node:assert/strict";
import { judgeMemberOs } from "./profiles.js";

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

console.log(`\n${pass} passed`);
