// NAS 접속 사양 검증(DB 없음) — 매니지드 차단 · 연결 전 주소 가드와 IP 고정 · 색인 키 분리 · 오류 분류(색인 상태에 원문 없음).
//  실 DB 가 있어야 보이는 불변식(공용 계정 폴백 없음 · 서버 주소는 관리자 칸만 · 내려받기 인증 · nas_find 응답의 last_error)은
//  nas-access.pg-test.mjs 가 본다.
// 실행: npm run build && node dist/net/nas/nas-access.test.js
import assert from "node:assert/strict";
import { itemsPool } from "../../db/client.js";
import { withTenant } from "../../org/tenant-context.js";
import { FtpError, type FtpConnectOpts, type FtpSession } from "../ftp/ftp-client.js";
import type { CrawlResult } from "./nas-index.js";
import {
  NasConfigError, NAS_MANAGED_OFF, resolveNasServer, resolveNasAccess, nasAddressBlocked, pinNasAddress, connectNas,
  nasErrorReply, nasIndexCache, nasIndexKey, type NasLookup, type NasServer, type NasLogin,
} from "./nas-access.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

// 금고 페이크 — 어떤 칸도 없다. 부른 SQL 을 센다: «매니지드에서는 금고를 안 읽는다» 의 근거이자, 페이크가 실제로 걸렸다는 배선 확인.
const dbCalls: string[] = [];
(itemsPool as unknown as { query: (sql: string) => Promise<{ rows: unknown[] }> }).query = async (sql: string) => {
  dbCalls.push(sql);
  return { rows: [] };
};

// 매니지드 판정의 근거(org/tenancy/state.managedMode) — 시험 러너는 LIVELY_* 를 지운 env 로 띄우므로 기본은 셀프호스트다.
async function inManaged<T>(fn: () => Promise<T>): Promise<T> {
  process.env.LIVELY_TENANT_HEADER_SECRET = "nas-access-test";
  try { return await fn(); } finally { delete process.env.LIVELY_TENANT_HEADER_SECRET; }
}

const S: NasServer = { host: "nas.internal", port: 21 };
const L: NasLogin = { username: "u1", password: "pw" };
const lookupOf = (answers: Array<[string, 4 | 6]>): NasLookup => async () => answers.map(([address, family]) => ({ address, family }));
const isConfig = (status: number) => (e: unknown) => e instanceof NasConfigError && e.status === status;

// ── 매니지드 차단 ────────────────────────────────────────────────────────────────────────────

await t("매니지드: resolveNasServer·resolveNasAccess 는 자체 호스팅 안내(501)로 거절하고 금고를 읽지 않는다", async () => {
  dbCalls.length = 0;
  await inManaged(async () => {
    for (const run of [() => resolveNasServer(), () => resolveNasAccess("m1")]) {
      await assert.rejects(run, (e: unknown) => isConfig(501)(e) && (e as Error).message === NAS_MANAGED_OFF);
    }
  });
  assert.match(NAS_MANAGED_OFF, /자체 호스팅/);
  assert.equal(dbCalls.length, 0, `금고 조회: ${dbCalls.join(" | ")}`);
});

await t("셀프호스트: 매니지드 거절이 아니다 — 금고를 읽고, 서버 칸이 없으면 503", async () => {
  dbCalls.length = 0;
  await assert.rejects(() => resolveNasServer(), isConfig(503));
  assert.ok(dbCalls.length >= 1, "금고를 읽었다(페이크 배선 확인)");
});

// ── 색인 키 ──────────────────────────────────────────────────────────────────────────────────

await t("nasIndexKey: 테넌트·구성원·FTP 아이디·서버(host·port) 중 하나만 달라도 다른 키, 모두 같으면 같은 키", () => {
  const base = nasIndexKey("m1", "u1", S);
  assert.equal(nasIndexKey("m1", "u1", { ...S }), base, "결정적");
  const inT1 = () => withTenant({ id: "t1", slug: "a" }, () => nasIndexKey("m1", "u1", S));
  assert.equal(inT1(), inT1(), "같은 테넌트면 같다");
  const variants: Array<[string, string]> = [
    ["테넌트 t1", inT1()],
    ["테넌트 t2", withTenant({ id: "t2", slug: "b" }, () => nasIndexKey("m1", "u1", S))],
    ["구성원", nasIndexKey("m2", "u1", S)],
    ["FTP 아이디", nasIndexKey("m1", "u2", S)],
    ["host", nasIndexKey("m1", "u1", { host: "nas2.internal", port: 21 })],
    ["port", nasIndexKey("m1", "u1", { host: "nas.internal", port: 2121 })],
  ];
  for (const [what, k] of variants) assert.notEqual(k, base, `${what} 만 달라도 다른 키`);
  const all = [base, ...variants.map(([, k]) => k)];
  assert.equal(new Set(all).size, all.length, "서로도 겹치지 않는다");
});

// ── 연결 전 주소 가드 ────────────────────────────────────────────────────────────────────────

await t("nasAddressBlocked: loopback·link-local(메타데이터)·unspecified·multicast·v4-mapped·클라우드 메타데이터는 막고 RFC1918·공인은 연다", () => {
  const blocked = [
    "127.0.0.1", "127.1.2.3", "::1",
    "169.254.169.254", "169.254.1.1", "fe80::1",
    "0.0.0.0", "::",
    "224.0.0.1", "239.255.255.250", "255.255.255.255", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254",
    "fd00:ec2::254", "100.100.100.200",
  ];
  const open = ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.10", "8.8.8.8"];
  for (const ip of blocked) assert.equal(nasAddressBlocked(ip), true, `막아야 함: ${ip}`);
  for (const ip of open) assert.equal(nasAddressBlocked(ip), false, `열어야 함: ${ip}`);
  // CGNAT·ULA 는 통째로 막힌 채다 — 그 안에 클라우드 메타데이터가 있다(위 두 주소). 열려면 메타데이터를 따로 막아야 한다.
  for (const ip of ["100.64.0.1", "fd12:3456::1"]) assert.equal(nasAddressBlocked(ip), true, ip);
});

await t("pinNasAddress: 막힌 답은 건너뛰고 열리는 답을 고른다 — IPv4 가 있으면 IPv4", async () => {
  assert.equal(await pinNasAddress("nas.local", lookupOf([["fe80::1", 6], ["192.168.1.10", 4]])), "192.168.1.10");
  assert.equal(await pinNasAddress("nas.example", lookupOf([["2001:db8::5", 6], ["192.168.1.10", 4]])), "192.168.1.10");
  assert.equal(await pinNasAddress("nas.v6", lookupOf([["fe80::1", 6], ["2001:db8::5", 6]])), "2001:db8::5");
});

await t("pinNasAddress: 열리는 답이 없으면(localhost·빈 답) 설정 오류 503 — 문구에 IP 를 싣지 않는다", async () => {
  const cases: Array<Array<[string, 4 | 6]>> = [[["127.0.0.1", 4], ["::1", 6]], []];
  for (const answers of cases) {
    await assert.rejects(() => pinNasAddress("localhost", lookupOf(answers)),
      (e: unknown) => isConfig(503)(e) && !/127\.0\.0\.1|::1/.test((e as Error).message));
  }
});

await t("pinNasAddress: 기본 조회(시스템 리졸버)로도 판정한다 — IP 리터럴 127.0.0.1 거절, 192.168.1.10 통과", async () => {
  await assert.rejects(() => pinNasAddress("127.0.0.1"), isConfig(503));
  assert.equal(await pinNasAddress("192.168.1.10"), "192.168.1.10");
});

await t("pinNasAddress: DNS 실패는 그대로 거절되고, 분류하면 원문 없는 접속 실패(502)", async () => {
  const raw = Object.assign(new Error("getaddrinfo ENOTFOUND nas.secret-corp.internal"), { code: "ENOTFOUND" });
  const err = await pinNasAddress("nas.secret-corp.internal", async () => { throw raw; }).then(() => null, (e: unknown) => e);
  assert.equal(err, raw);
  const r = nasErrorReply(err);
  assert.equal(r.status, 502);
  assert.equal(r.expected, false);
  assert.doesNotMatch(r.message, /ENOTFOUND|secret-corp/);
});

await t("connectNas: 한 번 푼 IP 로 붙는다 — 다음 조회가 127.0.0.1 로 바뀌어도(재바인딩) 연결 대상은 처음 IP, 조회 1회", async () => {
  const looked: string[] = [];
  const rebinding: NasLookup = async (h) => {
    looked.push(h);
    return [{ address: looked.length === 1 ? "192.168.77.7" : "127.0.0.1", family: 4 }];
  };
  const opened: FtpConnectOpts[] = [];
  const session = {} as FtpSession;
  const got = await connectNas({ host: "nas.example", port: 2121 }, L, { lookup: rebinding, connect: async (o) => { opened.push(o); return session; } });
  assert.equal(got, session);
  assert.deepEqual(looked, ["nas.example"]);
  assert.deepEqual(opened, [{ host: "192.168.77.7", port: 2121, user: "u1", password: "pw" }]);
});

await t("connectNas: 막힌 대역으로만 풀리면 연결을 시도하지 않는다", async () => {
  const opened: FtpConnectOpts[] = [];
  await assert.rejects(
    () => connectNas(S, L, { lookup: lookupOf([["169.254.169.254", 4]]), connect: async (o) => { opened.push(o); return {} as FtpSession; } }),
    isConfig(503),
  );
  assert.equal(opened.length, 0);
});

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
