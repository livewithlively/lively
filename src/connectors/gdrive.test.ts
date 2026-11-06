// #541 gdrive 커넥터 테스트 — DB/실네트워크 불요(백필 블록은 fetch 를 스텁한다).
//   실행: npm run build && node dist/connectors/gdrive.test.js
//   목적: 쿼리 인젝션 가드(since/폴더 보간) + [BINARY] 메타-스텁 포맷(통합 distill 프롬프트·slack 과의 계약)
//         + 본문 추출 시간 상한 + 백필 진행 로그 배선(러너 정체 감지 오판 방지) 회귀 잠금.
//   (OOXML 추출 골든은 ./ooxml.test.ts 로 분리 — 공용 유틸.)
import assert from "node:assert/strict";
import { buildFilesQuery, isRfc3339, buildBinaryStub, gdriveConnector } from "./gdrive.js";
import { PROGRESS_LOG_INTERVAL_MS } from "./progress-log.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 쿼리/인젝션 가드 — 폴더/휴지통 제외 유지 + since 는 RFC3339 만 통과(보간 인젝션 차단). ──
t("buildFilesQuery/isRfc3339: 폴더·휴지통 제외 유지·인젝션 가드 불변", () => {
  assert.ok(buildFilesQuery().includes("mimeType != 'application/vnd.google-apps.folder'"));
  assert.ok(buildFilesQuery().includes("trashed = false"));
  assert.ok(!isRfc3339("2026-06-30' or '1'='1")); // 인젝션 시도 거부
  assert.ok(isRfc3339("2026-06-30T00:00:00Z"));
  assert.ok(buildFilesQuery({ since: "2026-06-30T00:00:00Z" }).includes("modifiedTime > '2026-06-30T00:00:00Z'"));
  // 형식 이상 since 는 절 생략(전체 백필 폴백) — 인젝션 문자열이 q 에 안 들어감.
  assert.ok(!buildFilesQuery({ since: "bogus' or 1=1" }).includes("bogus"));
  // 폴더 id 는 허용 문자만 보간 — 이상치는 드랍.
  assert.ok(buildFilesQuery({ folderIds: ["ABC_123"] }).includes("'ABC_123' in parents"));
  assert.ok(!buildFilesQuery({ folderIds: ["bad') or ('1'='1"] }).includes("bad"));
});

// ── [BINARY] 스텁 — 마커·filename·mime·size·url·owner·modified 포함(distill 판단 + source_artifact 계약). ──
t("buildBinaryStub: 마커·메타 필드 포함(통합 distill·slack 공용 계약)", () => {
  const file = {
    id: "1AbC_xyz-9", name: "계약서.pdf", mimeType: "application/pdf", size: "245760",
    webViewLink: "https://drive.google.com/file/d/1AbC_xyz-9/view",
    owners: [{ emailAddress: "cto@ernest.ai", displayName: "CTO" }],
    modifiedTime: "2026-06-30T00:00:00Z",
  };
  const stub = buildBinaryStub(file as never);
  assert.ok(stub.startsWith("[BINARY] "), stub.slice(0, 40)); // 통합 프롬프트가 이 시작 토큰으로 분기
  assert.ok(stub.includes("filename=계약서.pdf"));
  assert.ok(stub.includes("mime=application/pdf"));
  assert.ok(stub.includes("size=245760"));
  assert.ok(stub.includes("url=https://drive.google.com/file/d/1AbC_xyz-9/view"));
  assert.ok(stub.includes("owner=cto@ernest.ai"));
  assert.ok(stub.includes("modified=2026-06-30T00:00:00Z"));
  assert.ok(stub.includes("source_artifact")); // distill 에게 on-demand 페치 경로 안내
});

t("buildBinaryStub: size/owner 부재 시 해당 필드 생략·url 합성(딥링크)", () => {
  const stub = buildBinaryStub({ id: "ZZZ", mimeType: "image/png" } as never);
  assert.ok(stub.startsWith("[BINARY] filename=ZZZ")); // name 부재 → id 로 폴백
  assert.ok(stub.includes("mime=image/png"));
  assert.ok(!stub.includes("size="), "size 부재 시 필드 생략");
  assert.ok(!stub.includes("owner="), "owner 부재 시 필드 생략");
  assert.ok(stub.includes("url=https://drive.google.com/file/d/ZZZ")); // webViewLink 부재 → 합성
});

// ── 본문 추출 시간 상한 — export 가 응답 없이 매달려도 그 파일은 메타만 남기고 백필은 끝난다. ──
//  상한이 없으면 러너의 무출력 정체 감지가 run 을 죽이고, 커서가 그 파일 앞에 묶여 매 run 이 같은 자리에서 죽는다.
{
  const envKeys = ["GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET", "GDRIVE_REFRESH_TOKEN", "GDRIVE_BODY_TIMEOUT_MS"] as const;
  const origEnv = envKeys.map((k) => process.env[k]);
  process.env.GDRIVE_CLIENT_ID = "test-client";
  process.env.GDRIVE_CLIENT_SECRET = "test-secret";
  process.env.GDRIVE_REFRESH_TOKEN = "test-refresh";
  process.env.GDRIVE_BODY_TIMEOUT_MS = "50";
  const origFetch = globalThis.fetch;
  const origWarn = console.warn;
  const warned: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/files?")) {
      const files = [
        { id: "hang", name: "big-sheet", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-11-05T09:30:00Z" },
        { id: "ok", name: "note.txt", mimeType: "text/plain", modifiedTime: "2026-11-05T09:20:00Z" },
      ];
      return new Response(JSON.stringify({ files }), { status: 200 });
    }
    if (url.includes("/files/hang/export")) {
      // 응답하지 않는다 — abort 신호가 와야만 끝난다.
      return new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (!sig) return;
        if (sig.aborted) return reject(sig.reason);
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    }
    return new Response("본문", { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  const got: { id: string; body?: string }[] = [];
  try {
    const run = (async () => {
      for await (const it of gdriveConnector.backfill()) got.push({ id: it.provenance.external_id, body: it.body });
    })();
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("백필이 5초 안에 끝나지 않는다 — 매달린 export 에 시간 상한이 없다")), 5_000);
    });
    try { await Promise.race([run, guard]); } finally { clearTimeout(timer); }
  } finally {
    globalThis.fetch = origFetch;
    console.warn = origWarn;
    envKeys.forEach((k, i) => { if (origEnv[i] === undefined) delete process.env[k]; else process.env[k] = origEnv[i]; });
  }
  assert.deepEqual(got.map((g) => g.id), ["hang", "ok"], "매달린 파일도 메타는 남기고, 뒤 파일 처리도 이어져야 한다");
  assert.equal(got[0].body, undefined, "시간 초과 파일은 본문을 비운다");
  assert.equal(got[1].body, "본문");
  assert.ok(warned.some((w) => w.includes("시간 초과") && w.includes("hang")), `시간 초과 경고가 없다: ${JSON.stringify(warned)}`);
  pass++; console.log("ok  본문 추출 시간 상한 — 매달린 export 는 메타만 남기고 백필이 끝난다(정체 감지 반복 사망 방지)");
}


// ── 진행 로그 — 러너는 무출력 15분이면 죽인다. 백필이 파일을 처리하는 동안 stdout 에 진행을 남겨야 한다. ──
{
  const envKeys = ["GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET", "GDRIVE_REFRESH_TOKEN"] as const;
  const origEnv = envKeys.map((k) => process.env[k]);
  process.env.GDRIVE_CLIENT_ID = "test-client";
  process.env.GDRIVE_CLIENT_SECRET = "test-secret";
  process.env.GDRIVE_REFRESH_TOKEN = "test-refresh";
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  // 시계를 호출마다 간격 이상 전진시켜 스로틀을 매번 통과시킨다 — 한 페이지(최대 1000건)의 export 합이 15분을
  //  넘는 게 실제 사고였으므로, 페이지 경계 로그가 아니라 파일 단위 로그가 나가는지를 잠가야 한다.
  const origNow = performance.now;
  let tick = 0;
  performance.now = () => (tick += PROGRESS_LOG_INTERVAL_MS + 1);
  const logged: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/files?")) {
      const files = [1, 2, 3].map((n) => ({ id: `f${n}`, name: `doc${n}.txt`, mimeType: "text/plain", modifiedTime: "2026-11-01T00:00:00Z" }));
      return new Response(JSON.stringify({ files }), { status: 200 });
    }
    return new Response("본문", { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  let items = 0;
  try {
    for await (const _ of gdriveConnector.backfill()) items++;
  } finally {
    globalThis.fetch = origFetch;
    console.log = origLog;
    performance.now = origNow;
    envKeys.forEach((k, i) => { if (origEnv[i] === undefined) delete process.env[k]; else process.env[k] = origEnv[i]; });
  }
  assert.equal(items, 3);
  const perFile = logged.filter((l) => l.startsWith("gdrive: ") && l.includes("번째 파일"));
  assert.equal(perFile.length, 3, `파일 단위 진행 로그가 없다 — 한 페이지가 15분을 넘기면 정체 감지로 죽는다. stdout: ${JSON.stringify(logged)}`);
  pass++; console.log("ok  백필 진행 로그 — 파일을 훑는 동안 stdout 에 진행을 남긴다(러너 정체 오판 방지)");
}

console.log(`\n${pass} passed (gdrive 쿼리 인젝션 가드 + [BINARY] 스텁 계약 + 본문 시간 상한 + 진행 로그)`);
