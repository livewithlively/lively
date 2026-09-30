// #4211 Outlook 수집기 토큰 출처 — token_source=member:<id> → 그 사람 [Outlook 연결] 슬롯. 금고·갱신은 주입(DB·네트워크 없음).
//   실행: npm run build && node dist/org/credentials/microsoft-token-source.test.js
//   엣지 표: T1 미지정=null(수집기가 «출처 없음»으로 멈춘다) · T2 member 가 아니면 경고 · T3 슬롯 없음 경고 · T4 갱신 실패는
//   경고(원인 포함) · T5 정상 = 토큰
import assert from "node:assert/strict";
import { resolveMicrosoftTokenSource, type MicrosoftVaultDeps } from "./microsoft-token-source.js";
import type { MemberSecretResolved } from "./member-secret-store.js";

let pass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const slot = (secret: string | null): MemberSecretResolved => ({ owner: "member:kim", kind: "microsoft_oauth", scope_key: "", secret, meta: {} });
const deps = (over: Partial<MicrosoftVaultDeps> & { seen?: string[] } = {}): MicrosoftVaultDeps & { seen: string[] } => {
  const seen = over.seen ?? [];
  return {
    seen,
    resolve: over.resolve ?? (async (id) => { seen.push(id); return slot('{"access_token":"AT"}'); }),
    bearer: over.bearer ?? (async () => "AT"),
  };
};

await ta("T1 출처를 안 적었으면 null — 붙여넣기 칸이 없는 앱이라 커넥터가 «출처 없음»으로 분명히 멈춘다", async () => {
  const d = deps();
  assert.equal(await resolveMicrosoftTokenSource(undefined, d), null);
  assert.equal(await resolveMicrosoftTokenSource("  ", d), null);
  assert.equal(d.seen.length, 0, "출처가 없는데 금고를 읽었다");
});

await ta("T2 member:<id> 가 아니면 경고 — org·bot 같은 값은 Outlook 에 없다", async () => {
  const d = deps();
  for (const bad of ["org", "bot", "member:", "member:   "]) {
    const r = await resolveMicrosoftTokenSource(bad, d);
    assert.ok(r?.warning && !r.token, `${bad} 가 통했다`);
  }
  assert.equal(d.seen.length, 0);
});

await ta("T3 그 사람 슬롯이 없으면 경고(연결 안내 포함) — 빈 토큰으로 Graph 를 때리지 않는다", async () => {
  const r = await resolveMicrosoftTokenSource("member:kim", deps({ resolve: async () => null }));
  assert.equal(r?.token, undefined);
  assert.match(r?.warning ?? "", /Outlook 연결이 없습니다/);
  const r2 = await resolveMicrosoftTokenSource("member:kim", deps({ resolve: async () => slot(null) }));
  assert.match(r2?.warning ?? "", /연결이 없습니다/, "meta 만 있는 행도 연결 없음");
});

await ta("T4 갱신 실패는 원인을 담은 경고 — 옛 토큰으로 조용히 진행하지 않는다", async () => {
  const r = await resolveMicrosoftTokenSource("member:kim", deps({ bearer: async () => { throw new Error("자격 갱신 실패(400) — invalid_grant"); } }));
  assert.equal(r?.token, undefined);
  assert.match(r?.warning ?? "", /invalid_grant/);
});

await ta("T5 정상 — 그 사람의 id 로 금고를 읽고 갱신된 토큰을 돌려준다", async () => {
  const d = deps({ bearer: async () => "FRESH" });
  assert.deepEqual(await resolveMicrosoftTokenSource(" member:kim ", d), { token: "FRESH" });
  assert.deepEqual(d.seen, ["kim"], "배선 — 다른 사람 슬롯을 읽었다");
});

console.log(`\nmicrosoft-token-source tests: ${pass} passed`);
