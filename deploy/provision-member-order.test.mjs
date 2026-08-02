// #1014 회귀 가드 — provision-member.sh 의 유저 생성 순서 불변식.
//  사양: box_<slug>·broker_<slug> OS 유저를 **먼저 생성(useradd)** 한 뒤에만 per-member 공유그룹 m_<slug> 에
//   편입(usermod -aG)해야 한다. usermod 는 대상 유저가 없으면 실패 → set -e 로 스크립트 abort → box_ 유저
//   생성 전에 죽음 → 새 멤버 프로비저닝 전원 실패 → 격리 안 됨 → 세션이 공유 config 폴백으로 남의 lively
//   신원 인증(임퍼스네이션). 버그였던 옛 순서(usermod 가 useradd 앞)면 이 테스트는 실패(red)한다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, "provision-member.sh"), "utf8").split(/\r?\n/);
// 주석(#)이 아닌 실제 명령 라인에서만 찾는다 — 설명 주석의 명령어 언급에 오탐되지 않게.
const codeIdx = (re) => {
  const i = lines.findIndex((l) => !l.trimStart().startsWith("#") && re.test(l));
  assert.ok(i >= 0, `패턴 미발견(명령 라인): ${re}`);
  return i;
};

for (const who of ["OSUSER", "BROKER_USER"]) {
  const created = codeIdx(new RegExp(`useradd\\b.*"\\$${who}"`));               // 유저 생성
  const intoMgroup = codeIdx(new RegExp(`usermod -aG "\\$MGROUP" "\\$${who}"`)); // m_<slug> 편입
  assert.ok(
    created < intoMgroup,
    `${who}: useradd(line ${created + 1})는 usermod -aG m_group(line ${intoMgroup + 1})보다 앞서야 한다 — #1014`,
  );
}

console.log("provision-member-order.test OK — box_·broker_ 유저 생성이 m_group 편입보다 선행(#1014 가드)");
