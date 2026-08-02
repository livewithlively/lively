// earlyoom 저널 관측 테스트 (#1240) — 이 파서가 틀리면 "누가 왜 죽었나"가 조용히 비어 보이고, 그건
//  관측 공백을 메우려던 이 기능이 **관측하고 있다고 착각하게 만드는** 더 나쁜 상태다.
//  로그 형식 근거: earlyoom v1.7 kill.c:377
//    warn("sending %s to process %d uid %d \"%s\": badness %d, VmRSS %lld MiB\n", ...)
import assert from "node:assert/strict";
import { parseEarlyoomKill, parseJournalJson, readEarlyoomKills } from "./earlyoom-log.js";

// ── 표 K: 메시지 한 줄 파싱 ──────────────────────────────────────────────────────────────
// K1 — 실제 로그(pilot-box 실측 문자열 그대로)
{
  const k = parseEarlyoomKill('sending SIGTERM to process 1985588 uid 1000 "(sd-pam)": badness 733, VmRSS 3 MiB');
  assert.deepEqual(k, { signal: "SIGTERM", pid: 1985588, uid: 1000, name: "(sd-pam)", badness: 733, vmRssMb: 3 },
    "실측 로그의 모든 필드를 읽는다");
}

// K2 — SIGKILL 에스컬레이션도 같은 포맷으로 찍힌다
{
  const k = parseEarlyoomKill('sending SIGKILL to process 42 uid 0 "claude": badness 978, VmRSS 177 MiB');
  assert.equal(k?.signal, "SIGKILL", "시그널 종류를 구분해야 한다(SIGTERM 후 안 죽으면 SIGKILL 이 온다)");
  assert.equal(k?.vmRssMb, 177);
}

// K3 — VmRSS 는 네 자리 이상도 온다(3.3GB llama-server 급)
{
  assert.equal(parseEarlyoomKill('sending SIGTERM to process 7 uid 999 "llama-server": badness 758, VmRSS 3347 MiB')?.vmRssMb,
    3347, "GB 급 프로세스의 회수량이 잘리면 안 된다");
}

// K4 — kill 이 아닌 로그는 전부 null(저널엔 이런 줄이 훨씬 많다)
for (const noise of [
  "mem avail:  2807 of  3905 MiB (71.89%), swap free:    0 of    0 MiB ( 0.00%)",
  "low memory! at or below SIGTERM limits: mem 99.00%, swap  6.00%",
  "escalating to SIGKILL after 10.0 seconds",
  "process exited after 6.3 seconds",
  "earlyoom v1.7",
  "",
]) {
  assert.equal(parseEarlyoomKill(noise), null, `kill 로그가 아니면 null 이어야 한다: ${noise.slice(0, 40)}`);
}

// K5 — 프로세스 이름에 따옴표가 들어가도 **뒤쪽 경계**로 정확히 끊는다(앞에서 끊으면 어긋난다)
{
  const k = parseEarlyoomKill('sending SIGTERM to process 5 uid 1 "we"ird": badness 700, VmRSS 12 MiB');
  assert.equal(k?.name, 'we"ird', "이름 안의 따옴표를 삼켜야 한다");
  assert.equal(k?.badness, 700);
  assert.equal(k?.vmRssMb, 12);
}

// K6 — 형식이 비슷하나 필드가 빠지면 파싱하지 않는다(반쯤 읽은 값으로 화면을 채우면 안 된다)
{
  assert.equal(parseEarlyoomKill('sending SIGTERM to process 5 uid 1 "x": badness 700'), null, "VmRSS 없으면 null");
  assert.equal(parseEarlyoomKill('sending SIGTERM to process x uid 1 "x": badness 700, VmRSS 12 MiB'), null, "pid 가 숫자가 아니면 null");
}

// ── 표 J: journalctl JSON 본문 ───────────────────────────────────────────────────────────
const FALLBACK = 1_700_000_000_000;
const line = (msg: unknown, usec?: string): string =>
  JSON.stringify(usec === undefined ? { MESSAGE: msg } : { MESSAGE: msg, __REALTIME_TIMESTAMP: usec });

// J1 — 타임스탬프는 **마이크로초**다. ms 로 착각하면 시각이 1000배 틀어져 '미래의 사건'이 된다.
{
  const out = parseJournalJson(line('sending SIGTERM to process 1 uid 0 "claude": badness 900, VmRSS 100 MiB', "1785292800000000"), FALLBACK);
  assert.equal(out.length, 1);
  assert.equal(out[0].at, 1785292800000, "__REALTIME_TIMESTAMP(마이크로초) → ms 로 나눠야 한다");
}

// J2 — MESSAGE 가 바이트 배열로 오는 경우(비-UTF8 저널 엔트리)
{
  const bytes = Array.from(Buffer.from('sending SIGTERM to process 2 uid 0 "node": badness 800, VmRSS 50 MiB', "utf8"));
  const out = parseJournalJson(line(bytes, "1785292800000000"), FALLBACK);
  assert.equal(out.length, 1, "바이트 배열 MESSAGE 도 디코드한다");
  assert.equal(out[0].name, "node");
}

// J3 — 잡음 줄(비-JSON·빈 줄)은 건너뛰고 나머지를 계속 읽는다(한 줄 때문에 전체를 잃지 않는다)
{
  const body = ["", "not json at all", line('sending SIGTERM to process 3 uid 0 "claude": badness 900, VmRSS 10 MiB', "1785292800000000"), "{"].join("\n");
  assert.equal(parseJournalJson(body, FALLBACK).length, 1, "깨진 줄은 건너뛰고 유효한 것만");
}

// J5 — 유효한 JSON 이지만 **객체가 아닌** 줄(`null`·숫자)에서 throw 하면 안 된다.
//  throw 가 위로 새면 그 회차 전체가 readable:false 가 된다 — 잡음 한 줄 때문에 '못 봤다'가 되는 건
//  이 기능이 막으려는 바로 그 모호함이다.
{
  const body = ["null", "42", '"just a string"', line('sending SIGTERM to process 9 uid 0 "claude": badness 900, VmRSS 10 MiB', "1785292800000000")].join("\n");
  const out = parseJournalJson(body, FALLBACK);
  assert.equal(out.length, 1, "비-객체 줄은 건너뛰고 유효한 것만 — 예외로 전체를 잃지 않는다");
}

// J4 — 타임스탬프가 없거나 잡값이면 fallback 시각(사건을 버리지 않는다)
{
  const out = parseJournalJson(line('sending SIGTERM to process 4 uid 0 "claude": badness 900, VmRSS 10 MiB'), FALLBACK);
  assert.equal(out[0].at, FALLBACK, "시각을 몰라도 사건 자체는 보고한다");
}

// ── 표 R: 조회 — '없다'와 '못 봤다'를 가른다 ────────────────────────────────────────────
// R1 — 실행이 실패하면(권한 없음·유닛 없음) readable=false. **이게 '기록 없음'과 구분되는 유일한 신호**다.
{
  const r = await readEarlyoomKills({ run: async () => { throw new Error("insufficient permissions"); } });
  assert.deepEqual(r, { readable: false, kills: [] }, "못 읽으면 readable=false — throw 하지 않는다");
}

// R2 — 정상 조회인데 kill 이 없으면 readable=true + 빈 목록('진짜 없음')
{
  const r = await readEarlyoomKills({ run: async () => "" });
  assert.deepEqual(r, { readable: true, kills: [] }, "읽었는데 없으면 readable=true — 화면이 '이상 없음'이라 말해도 되는 유일한 경우");
}

// R3 — sinceMs 는 `--since=@<초>` 로 넘어간다(로케일·타임존 파싱 회피). limit 은 -n 으로.
{
  let got: string[] = [];
  await readEarlyoomKills({ sinceMs: 1_785_292_800_123, limit: 7, run: async (a) => { got = a; return ""; } });
  assert.ok(got.includes("--since=@1785292800"), `초 단위 절대시각으로 넘겨야 한다: ${got.join(" ")}`);
  assert.equal(got[got.indexOf("-n") + 1], "7");
  assert.ok(got.includes("-u") && got[got.indexOf("-u") + 1] === "earlyoom", "earlyoom 유닛만 조회");
  assert.ok(got.includes("json"), "JSON 출력이어야 타임스탬프를 얻는다");
}

// R4 — limit 은 상한으로 클램프(연쇄 학살 시 저널이 길어져도 메모리를 지킨다)
{
  let got: string[] = [];
  await readEarlyoomKills({ limit: 99999, run: async (a) => { got = a; return ""; } });
  assert.equal(got[got.indexOf("-n") + 1], "500", "상한 500 으로 클램프");
}

console.log("earlyoom-log: all passed");
