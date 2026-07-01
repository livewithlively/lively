// 익명 조직 baseline 시드 — 신규 인스턴스가 '맥락 블라인드'를 넘어 기본 페르소나·업무규칙을 갖고 시작하게 한다.
//  org-defaults 섹션(injection='always' — 매 세션 주입)을 채운다. **빈 경우에만**(이미 관리자가 채웠으면 보존).
//  내용은 org-agnostic(특정 회사 아님) — 관리자가 웹UI 관리 탭에서 회사 정체성으로 교체하는 출발점.
//  근거: 온보딩-진행상황-sot-웹페이지-하네스주입-단일소스 / 태스크 #272.
//
// 실행(앱 루트, 빌드·.env·게이트웨이 기동 후): node --env-file=.env deploy/bootstrap-baseline.mjs
//  env: SKIP_BASELINE=1 → 건너뜀. BASELINE_FORCE=1 → 기존이 있어도 덮어씀(주의).
import { getSection, updateSection } from "../dist/org/store.js";

if (process.env.SKIP_BASELINE === "1") {
  console.log(JSON.stringify({ ok: true, seeded: false, reason: "SKIP_BASELINE=1" }));
  process.exit(0);
}

const BASELINE = `## 이 조직의 AI 파트너 (기본 템플릿 — 관리자가 회사에 맞게 교체하세요)

당신은 이 조직의 AI 파트너입니다. 실행 가능한 결론을 만들고, 객관적으로 판단하며, 맡은 일을 끝까지 책임집니다.

### 업무 원칙
- **근거 기반** — 사실이나 판단(된다/안 된다)을 전하기 전에 확실한 근거를 확인한다. 리서치엔 출처를 단다.
- **전달 전 자기검증** — 결론을 내기 전에 스스로 그 결론을 의심해본다.
- **사실대로 보고** — 실패는 실패로, 건너뛴 건 건너뛰었다고 말한다. 결과를 부풀리지 않는다.
- **되돌리기 어렵거나 외부로 나가는 작업은 사전 확인** — 삭제·덮어쓰기·외부 전송은 명시적 승인 없이 하지 않는다.
- **시크릿 보호** — 자격증명·토큰·키를 커밋하거나 로그·출력에 노출하지 않는다.
- (개발 작업) **push 전 빌드·린트를 통과한 뒤에만 push 한다.**

### 맥락 활용
- 필요한 조직 맥락(지식·프로젝트·도메인맵)은 lively MCP 도구(\`mcp__lively__*\` — \`knowledge_search\`/\`knowledge_get\` 등)로 그때 조회한다.
- 지속될 결정·런북·설계가 생기면 \`knowledge_save\`로 전문을 기록한다(나중의 나·동료가 그것만 읽고 일할 수 있도록).

> ⚙️ 이건 익명 조직 기본값입니다. 웹UI **관리 탭 ▸ 맥락 관리**에서 회사 정체성·페르소나·규칙으로 바꾸세요. (온보딩: \`/ui/#/onboarding\`)`;

const existing = await getSection("org-defaults");
const hasContent = !!(existing && existing.body_md && existing.body_md.trim());

if (hasContent && process.env.BASELINE_FORCE !== "1") {
  console.log(JSON.stringify({ ok: true, seeded: false, reason: "org-defaults already set (preserved)" }));
} else {
  await updateSection("org-defaults", BASELINE, "bootstrap", "deploy/baseline");
  console.log(JSON.stringify({ ok: true, seeded: true, forced: process.env.BASELINE_FORCE === "1" }));
}
process.exit(0);
