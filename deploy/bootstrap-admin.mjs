// 첫 관리자 부트스트랩 — "코드 없이 온보딩"의 시작점.
//  정적 토큰(AUTH_TOKENS_JSON)은 DANGEROUS_SCOPES 라 admin/runtime 행위가 거부된다(kill-switch).
//  따라서 진짜 관리는 '사람 세션 로그인'(이메일+비번)으로 한다 — 그 첫 계정을 여기서 만든다.
//  (근거: knowledge_get auth-2계층-사람세션-에이전트토큰-intersection)
//
// 실행(앱 루트에서, 빌드·.env 이후): node --env-file=.env deploy/bootstrap-admin.mjs
//  env: BOOTSTRAP_ADMIN_EMAIL(필수 권장) · BOOTSTRAP_ADMIN_PASSWORD(없으면 랜덤 생성) ·
//       BOOTSTRAP_ADMIN_ID(기본 admin) · BOOTSTRAP_ADMIN_NAME(기본 Admin) · BOOTSTRAP_RETRY_MAX_MS(기본 60000)
//  멱등: 이미 비번이 설정된 계정이면 비번을 덮지 않는다(BOOTSTRAP_ADMIN_PASSWORD 명시 시에만 재설정).
//  #2578: 스키마가 아직 안 섰거나(42703/42P01) DB 가 기동 중이면 ≤60s 백오프 재시도(lib/bootstrap-retry.mjs).
//   실패하면 stdout 에 아무것도 안 내고 exit 1 — install.sh 가 ✗ 로 요약하고 비-0 으로 끝난다.
import { upsertMember } from "../dist/org/store.js";
import { setMemberPassword, hasCredential, generateInitialPassword } from "../dist/auth/local-accounts.js";
import { withBootstrapRetry, exitOnBootstrapFailure } from "./lib/bootstrap-retry.mjs";

const id = process.env.BOOTSTRAP_ADMIN_ID || "admin";
const email = process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@example.com";
const name = process.env.BOOTSTRAP_ADMIN_NAME || "Admin";
const forcedPw = process.env.BOOTSTRAP_ADMIN_PASSWORD || "";

try {
  const result = await withBootstrapRetry("bootstrap-admin", async () => {
    await upsertMember(
      // 첫 관리자 = 조직의 유일한 전권 계정 → 전 scope(#248). memory/code 가 빠지면 지식·코드 도구가
      //  Forbidden 인데 설치·healthz 는 초록이라 조용히 실패한다 — scope 누락은 여기가 아니라 웹 관리에서 좁힌다.
      { id, kind: "human", display_name: name, email,
        scopes: ["admin", "runtime", "context", "db", "items", "memory", "code"], state: "active" },
      "bootstrap", "deploy/bootstrap-admin",
    );
    let password;
    if ((await hasCredential(id)) && !forcedPw) {
      password = "(기존 비번 보존 — 재설정 안 함)";
    } else {
      password = forcedPw || generateInitialPassword();
      await setMemberPassword(id, password, { mustChange: true, actor: "bootstrap" });
    }
    return { ok: true, id, email, password };
  });
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  exitOnBootstrapFailure("bootstrap-admin", err);
}
