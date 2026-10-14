#!/usr/bin/env node
// 빌드 끝에 **자산 세대**를 public/.asset-version 에 남긴다. (#2643)
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// 매니지드 롤은 축이 여럿인데 그중 **「사람이 받는 웹 자산에 이번 판이 닿았나」를 묻는 축이 없었다.**
//  롤이 전 축 초록으로 끝났는데 기존 테넌트가 옛 화면을 서빙한 실측이 있다
//  (지식 core-web-change-not-reaching-existing-tenants-1631). 그때는 사람이 손으로 번들을 받아
//  grep 해서 알았다 — 다음 사람은 그 문서를 안 읽을 수 있다.
//
// 그 축이 성립하려면 **기대값**이 있어야 한다. 서빙 쪽 실제값은 이미 있다(`GET /ui/__gen`).
//  기대값은 「이번에 롤한 이미지가 담은 자산의 세대」인데, 그건 이미지 안에서만 알 수 있다.
//  → 굽는 자리에서 계산해 이미지에 남긴다. 롤 검증(lvly-cloud control/src/imageaxes.ts)이
//    이미지 rootfs 에서 이 파일을 되읽어 테넌트가 서빙하는 값과 대조한다.
//
// ★ 계산은 **여기서 하지 않는다** — dist/web-assets.js 가 정본이고 서빙(src/web.ts)도 그걸 쓴다.
//  두 벌이면 규칙이 갈리는 날 롤이 거짓 드리프트를 낸다(그 파일 머리말 참조).
//
// ⚠ **빌드 체인의 맨 끝**이어야 한다. 자산은 build:web 만 만드는 게 아니다 —
//  단독 페이지 번들(scripts/build-standalone.mjs 의 public/terminal.js·md.js·page-scrollbar.js)이
//  public 최상위에 떨어지고 그것도 세대 입력이다. 실측: build:web 까지만 돌린 판은 309개 파일로
//  `119d294c9039`, 전체 빌드는 312개로 `ffaf0354d4b3` 였다(뒤엣것이 프로덕션 서빙값과 일치).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_VERSION_FILE, listLocalAssets, computeAssetVersion } from "../dist/web-assets.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, "public");

const files = listLocalAssets(publicDir);
if (files.length === 0) {
  // 조용히 0 을 적지 않는다 — 빈 스탬프는 롤 검증에서 «닿지 않았다» 로 읽히고, 그건 사실이 아니다.
  console.error(`[stamp:assets] ${publicDir} 에서 자산을 하나도 못 찾았다 — 빌드가 덜 돌았나?`);
  process.exit(1);
}
const v = computeAssetVersion(publicDir, files);
const out = path.join(publicDir, ASSET_VERSION_FILE);
writeFileSync(out, JSON.stringify({ v, files: files.length }) + "\n");
console.log(`✓ 자산 세대 ${v} (${files.length}개) → public/${ASSET_VERSION_FILE}`);
