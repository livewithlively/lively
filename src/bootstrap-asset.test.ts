// 부트스트랩 전달 계약 테스트 (#1087) — 회귀 대상: `kit/cli/bootstrap.ps1` 에 UTF-8 BOM 이 붙어 있어서
//  `irm <gw>/cli.ps1 | iex` 가 파스 에러로 죽었다(Missing closing ')' in expression @ line 12 col 32).
//  BOM 은 **파일 실행이면 리더가 먹지만 문자열 파싱이면 파서까지 간다** — 그래서 션의 우회
//  (`iwr -OutFile` 후 `& file.ps1`)는 되고 안내된 한 줄만 죽었다. 전 윈도우 사용자가 설치 불가였다.
//
//  ⚠ 이 계열은 **mac/linux 개발 박스에서 절대 재현되지 않는다.** PowerShell 을 CI 에서 못 돌리므로
//   파스 실증은 수동 재현(pwsh 파서로 12행 32칸 동일 재현)으로 마쳤고, 여기선 그 원인을
//   **바이트 불변식**으로 못박는다: 인터프리터가 받는 1번 문자는 주석 문자 '#' 여야 한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootstrapBody, GATEWAY_PLACEHOLDER } from "./bootstrap-asset.js";

const BOM = "﻿";
const GW = "https://lively.example.com";

// ── 소스 파일 불변식 (표 ①②) — 서빙 strip 이 없어도 사람이 지켜야 하는 1차 계약 ──
//  ⚠ utf8 로 읽지 말 것: Node 는 BOM 을 안 떼지만, 바이트로 봐야 "무엇이 붙었는지"가 드러난다.
for (const file of ["bootstrap.sh", "bootstrap.ps1"]) {
  const buf = readFileSync(fileURLToPath(new URL(`../kit/cli/${file}`, import.meta.url)));
  const hex = buf.subarray(0, 3).toString("hex");
  assert.equal(
    buf[0], 0x23,
    `${file}: 1번 바이트가 0x${buf[0]?.toString(16)} (앞 3바이트 ${hex}) — ` +
    `'#'(0x23) 이어야 한다. 선행 잡문자는 1행을 주석이 아니라 명령으로 만든다(BOM=efbbbf).`,
  );
  // 치환이 물 게 실제로 있는가 — 플레이스홀더가 한쪽에서만 이름이 바뀌면 게이트웨이 주소가 안 구워진다.
  assert.ok(
    readFileSync(fileURLToPath(new URL(`../kit/cli/${file}`, import.meta.url)), "utf8").includes(GATEWAY_PLACEHOLDER),
    `${file}: ${GATEWAY_PLACEHOLDER} 가 없다 — 서버가 굽는 자리와 소스가 어긋났다`,
  );
}

// ── 서빙 변환: 소스에 BOM 이 있어도 다운로더가 받는 1번 문자는 '#' (표 ⑤) ──
{
  const out = bootstrapBody(`${BOM}# lively 부트스트랩\n$GW = "${GATEWAY_PLACEHOLDER}"\n`, GW);
  assert.equal(out[0], "#", "BOM 이 붙은 소스를 서빙해도 1번 문자는 '#' 이어야 한다");
  assert.ok(!out.includes(BOM), "본문 어디에도 BOM 이 남으면 안 된다");
}

// ── BOM 이 없으면 아무것도 깎지 않는다 (표 ⑥) — 과잉 strip 으로 1번 문자를 먹는 사고 방지 ──
{
  const src = `# lively\n$GW = "${GATEWAY_PLACEHOLDER}"\n`;
  assert.equal(bootstrapBody(src, GW), src.replaceAll(GATEWAY_PLACEHOLDER, GW));
}

// ── 경계: 빈 문자열·BOM 단독·1글자 (표 ⑦) — 새로 도입한 헬퍼가 짧은 입력에서 죽지 않는가 ──
{
  assert.equal(bootstrapBody("", GW), "");
  assert.equal(bootstrapBody(BOM, GW), "");
  assert.equal(bootstrapBody("#", GW), "#");
}

// ── BOM 이 아닌 선행 문자는 건드리지 않는다 (표 ⑧) ──
//  strip 은 BOM 전용이다. 공백 선행은 소스면 단언(①②)이 잡는 문제이지 서빙이 숨겨줄 일이 아니다.
{
  assert.equal(bootstrapBody(" # lively", GW), " # lively");
}

// ── BOM 2개면 1개만 떼인다 (표 ⑨) — 2차 방어의 한계를 명시. 그래서 ①② 가 최종 방어다. ──
{
  assert.equal(bootstrapBody(`${BOM}${BOM}# lively`, GW)[0], BOM);
}

// ── 게이트웨이 주소 굽기: 모든 출현이 치환되고 플레이스홀더가 남지 않는다 ──
{
  const out = bootstrapBody(`# a=${GATEWAY_PLACEHOLDER}\n# b=${GATEWAY_PLACEHOLDER}\n`, GW);
  assert.equal(out, `# a=${GW}\n# b=${GW}\n`);
  assert.ok(!out.includes(GATEWAY_PLACEHOLDER), "플레이스홀더가 남으면 CLI 가 엉뚱한 주소로 나간다");
}

console.log("ok — bootstrap-asset (#1087 BOM 회귀 방어)");
