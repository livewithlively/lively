// NAS 접속 사양 검증(DB 없음) — 오류 분류(색인 상태에 원문 없음).
// 실행: npm run build && node dist/net/nas/nas-access.test.js
import assert from "node:assert/strict";
import { FtpError } from "../ftp/ftp-client.js";
import type { CrawlResult } from "./nas-index.js";
import { NasConfigError, nasErrorReply, nasIndexCache } from "./nas-access.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

// ── 오류 분류 · 색인 상태 ────────────────────────────────────────────────────────────────────

// 색인 실패 원문에 섞여 나올 수 있는 조각 — 사설 IP·포트, 소켓 오류 코드, FTP 서버 응답문, 파일 경로 속 고객 이름.
const RAW_FRAGMENTS = ["10.1.2.3", "192.168.0.9", ":21", "ECONNREFUSED", "ETIMEDOUT", "Login incorrect", "Permission denied", "고객명"];
const assertNoRaw = (text: string, what: string) => {
  for (const frag of RAW_FRAGMENTS) assert.ok(!text.includes(frag), `${what}: 원문 조각 ${frag} → ${text}`);
};

await t("nasErrorReply: 설정 오류는 그 안내·상태, 530=403·550=404, 그 밖(소켓 오류·Error·문자열)은 502 — 어느 문구에도 원문이 없다", () => {
  const cfg = new NasConfigError("NAS 서버가 설정되지 않았습니다", 503);
  assert.deepEqual(nasErrorReply(cfg), { status: 503, message: cfg.message, expected: true });
  const login = nasErrorReply(new FtpError("로그인 실패(아이디·비밀번호 확인): 530 Login incorrect from 10.1.2.3", 530));
  const folder = nasErrorReply(new FtpError("폴더에 들어가지 못했습니다: 550 /고객명 Permission denied", 550));
  const sock = nasErrorReply(new FtpError("FTP 연결 오류: connect ECONNREFUSED 10.1.2.3:21", null, true));
  const plain = nasErrorReply(new Error("connect ETIMEDOUT 192.168.0.9:21"));
  const str = nasErrorReply("raw 10.1.2.3:21");
  assert.deepEqual([login.status, folder.status, sock.status, plain.status, str.status], [403, 404, 502, 502, 502]);
  assert.deepEqual([login.expected, folder.expected, sock.expected, plain.expected], [true, true, false, false]);
  assert.equal(new Set([login.message, folder.message, sock.message]).size, 3, "세 분류는 서로 다른 문구");
  assert.equal(plain.message, sock.message);
  assert.equal(str.message, sock.message);
  for (const [what, r] of Object.entries({ login, folder, sock, plain, str })) assertNoRaw(r.message, what);
});

await t("nasIndexCache(운영 인스턴스): 이전 색인이 있는데 다시 만들기가 실패하면 결과는 그대로, error 는 도구와 같은 분류 문구 — 원문 없음", async () => {
  const key = "nas-access-test\u0000b1";
  const old: CrawlResult = { entries: [], dirs: 1, truncated: null, failedDirs: 0 };
  await nasIndexCache.build(key, async () => old);
  const failures: unknown[] = [
    new FtpError("FTP 연결 오류: connect ECONNREFUSED 10.1.2.3:21", null, true),
    new FtpError("로그인 실패(아이디·비밀번호 확인): 530 Login incorrect.", 530),
    new FtpError("폴더에 들어가지 못했습니다: 550 /고객명 Permission denied.", 550),
  ];
  try {
    for (const boom of failures) {
      await nasIndexCache.build(key, async () => { throw boom; }).catch(() => {});
      const s = nasIndexCache.get(key);
      assert.equal(s.result, old, "이전 색인으로 답할 수 있게 결과를 지우지 않는다");
      assert.equal(s.error, nasErrorReply(boom).message, "nas_find 의 오류 응답과 같은 분류 문구");
      assertNoRaw(String(s.error), (boom as Error).message);
    }
  } finally {
    nasIndexCache.drop(key);
  }
});

console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
