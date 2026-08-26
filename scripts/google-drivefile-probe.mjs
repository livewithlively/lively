#!/usr/bin/env node
// #1881 G6 실측 하네스 — `drive.file`(비민감) 로 **폴더를 고르면 그 안의 파일까지 주는가**.
//
//  왜 이걸 재나: 이 한 줄이 드라이브 트랙의 비용을 가른다(지식 google-single-connect-design-1881 §4·§9).
//   · 준다  → 드라이브를 `drive.file` 로 → 구글 심사 0 · CASA 0 · 미검증 100명 한도 0
//   · 안 준다 → `drive.readonly`(제한범위) → CASA(연 $540~1,800·초회 6~12주) 또는 100명 한도
//  구글 공식 문서는 **어느 쪽도 명시하지 않는다**(2026-08-26 확인: Picker 개요·Drive scope 가이드·
//  add-ons Picker 문서 전부 폴더 선택 후의 접근 범위를 말하지 않는다). 그래서 실측 말고는 길이 없다.
//
//  사람이 할 일은 딱 둘이다 — ① OAuth 클라이언트 ID 하나(G1 에서 어차피 만든다) ② 브라우저에서 [허용] 클릭.
//  나머지(토큰 흐름·Picker·API 프로브·판정)는 이 하네스가 한다.
//
//  실행:
//    node scripts/google-drivefile-probe.mjs --client-id=<...>.apps.googleusercontent.com [--port=8971]
//  그리고 뜬 주소를 브라우저로 연다.
//
//  ⚠ 이 스크립트는 **아무것도 저장하지 않는다.** 토큰은 브라우저 메모리에만 있고 서버로 오지 않는다.
//   서버가 하는 일은 정적 HTML 한 장을 내려 주는 것뿐이다(로컬 http origin 이 필요해서 — file:// 는 구글이 거부).
import http from "node:http";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.join("=") || "true"];
}));
const CLIENT_ID = args["client-id"] ?? "";
const PORT = Number(args.port ?? 8971);

if (!CLIENT_ID) {
  console.error(`
사용법: node scripts/google-drivefile-probe.mjs --client-id=<OAuth 클라이언트 ID>

OAuth 클라이언트 만드는 법(G1 2단계와 같은 것 — 이미 있으면 그거 쓰세요):
  1. console.cloud.google.com ▸ API 및 서비스 ▸ 라이브러리에서 **Google Picker API** 와 **Google Drive API** 활성화
  2. 사용자 인증 정보 ▸ [사용자 인증 정보 만들기] ▸ OAuth 클라이언트 ID ▸ 유형 **웹 애플리케이션**
  3. **승인된 JavaScript 원본**에 http://localhost:${PORT} 추가  ← 리디렉션 URI 아님, 원본(origin)
  4. 만들어진 클라이언트 ID 를 --client-id 로 넘기세요

⚠ 이 테스트는 실 프로젝트가 아니라 **테스트용 GCP 프로젝트**에서 하세요 —
  미검증 100명 한도는 프로젝트 수명 누적이고 리셋이 안 됩니다(여기선 drive.file 만 쓰므로
  한도를 안 태우지만, 습관을 그렇게 들이는 게 안전합니다).
`);
  process.exit(1);
}

const PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>drive.file 폴더 실측 (#1881 G6)</title>
<style>
 body{font:14px/1.6 system-ui,-apple-system,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#111}
 h1{font-size:20px} button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer}
 button:disabled{opacity:.5;cursor:default} #log{white-space:pre-wrap;background:#f6f7f9;border-radius:8px;padding:16px;margin-top:20px;font-family:ui-monospace,Menlo,monospace;font-size:13px}
 .v{margin-top:20px;padding:16px;border-radius:8px;font-weight:600} .pass{background:#e6f7ec;color:#0a6b32} .fail{background:#fdeaea;color:#8b1a1a}
 ol{padding-left:20px} code{background:#f0f1f3;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>drive.file 폴더 실측 (#1881 G6)</h1>
<p><b>재는 것</b>: <code>drive.file</code>(비민감 범위)로 Picker에서 <b>폴더</b>를 고르면, 그 폴더 <b>안의 파일까지</b> 읽을 수 있는가.</p>
<ol>
  <li>아래 버튼 → 구글 로그인 → <b>[허용]</b> (요청 범위는 <code>drive.file</code> 하나뿐입니다)</li>
  <li>Picker가 열리면 <b>파일이 몇 개 들어 있는 폴더</b>를 하나 고르고 [선택]</li>
  <li>판정이 자동으로 나옵니다</li>
</ol>
<button id="go">① 폴더 고르기 (본 실험)</button>\n<button id="goFile" style="margin-left:8px">② 파일 고르기 (대조군)</button>
<div id="verdict"></div>
<div id="log">대기 중…</div>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script src="https://apis.google.com/js/api.js" async defer></script>
<script>
const CLIENT_ID = ${JSON.stringify(CLIENT_ID)};
const APP_ID = CLIENT_ID.split("-")[0]; // 클라이언트 ID 접두 = GCP 프로젝트 번호(=Picker 의 앱 id)
const SCOPE = "https://www.googleapis.com/auth/drive.file"; // ★ 이것 하나만. 다른 걸 섞으면 실험이 무의미해진다.
const logEl = document.getElementById("log");
const lines = [];
const log = (s) => { lines.push(s); logEl.textContent = lines.join("\\n"); };
const verdict = (ok, msg) => {
  const el = document.getElementById("verdict");
  el.className = "v " + (ok ? "pass" : "fail");
  el.textContent = (ok ? "✅ 준다 — " : "❌ 안 준다 — ") + msg;
};

let token = null;
async function api(path) {
  const r = await fetch("https://www.googleapis.com/drive/v3/" + path, { headers: { Authorization: "Bearer " + token } });
  const body = await r.text();
  let j = null; try { j = JSON.parse(body); } catch {}
  return { status: r.status, json: j, body: body.slice(0, 300) };
}

async function probe(folderId, folderName) {
  log("\\n── 프로브 시작 — 폴더 '" + folderName + "' (" + folderId + ")");

  // 0) 기준선: 고른 폴더 자체는 읽히는가(읽히지 않으면 Picker 승인 자체가 안 된 것)
  const meta = await api("files/" + folderId + "?fields=id,name,mimeType");
  log("[0] 폴더 메타 files/{id}        → HTTP " + meta.status + (meta.json?.name ? " (" + meta.json.name + ")" : " " + meta.body));
  if (meta.status !== 200) { verdict(false, "고른 폴더 자체도 안 읽힙니다(HTTP " + meta.status + ") — Picker 승인이 안 됐거나 설정 문제입니다."); return; }

  // 1) ★ 핵심: 그 폴더의 자식 목록
  const kids = await api("files?q=" + encodeURIComponent("'" + folderId + "' in parents and trashed=false") + "&fields=files(id,name,mimeType)&pageSize=50");
  const files = kids.json?.files ?? [];
  log("[1] 자식 목록 q='id' in parents → HTTP " + kids.status + " · 파일 " + files.length + "개" + (kids.status !== 200 ? " " + kids.body : ""));
  if (kids.status !== 200) { verdict(false, "자식 목록 조회가 HTTP " + kids.status + " 로 거부됐습니다."); return; }
  if (files.length === 0) {
    verdict(false, "폴더는 읽히는데 **자식이 0개**로 옵니다 — drive.file 은 고른 폴더 하나만 주고 내용물은 안 줍니다. (폴더가 정말 비어 있었다면 파일이 든 폴더로 다시 해보세요.)");
    return;
  }
  log("    " + files.slice(0, 5).map((f) => "· " + f.name).join("\\n    "));

  // 2) 자식 하나의 본문까지 실제로 읽히는가(목록만 되고 본문이 막히면 수집기는 못 돈다)
  const bin = files.find((f) => !String(f.mimeType).startsWith("application/vnd.google-apps"));
  if (bin) {
    const dl = await fetch("https://www.googleapis.com/drive/v3/files/" + bin.id + "?alt=media", { headers: { Authorization: "Bearer " + token } });
    log("[2] 자식 본문 alt=media        → HTTP " + dl.status + " (" + bin.name + ")");
    if (dl.status !== 200) { verdict(false, "목록은 오는데 **본문이 막힙니다**(HTTP " + dl.status + ") — 수집기가 못 돕니다."); return; }
  } else {
    log("[2] 자식 본문 — 건너뜀(구글 네이티브 문서뿐. export 는 별도 경로라 이 실험 범위 밖)");
  }

  // 3) 2단계(하위 폴더의 자식)까지 따라가지는가 — '폴더째'가 성립하려면 재귀가 돼야 한다
  const sub = files.find((f) => f.mimeType === "application/vnd.google-apps.folder");
  if (sub) {
    const g = await api("files?q=" + encodeURIComponent("'" + sub.id + "' in parents and trashed=false") + "&fields=files(id,name)&pageSize=10");
    log("[3] 손자 목록(하위폴더 '" + sub.name + "') → HTTP " + g.status + " · " + (g.json?.files?.length ?? 0) + "개");
  } else {
    log("[3] 하위 폴더가 없어 재귀 확인 못 함 — 하위 폴더가 있는 폴더로 한 번 더 해보면 좋습니다");
  }

  verdict(true, "폴더를 고르니 자식 " + files.length + "개가 읽힙니다. → 드라이브를 drive.file 로 내릴 수 있습니다(심사·CASA·100명 한도 전부 0).");
}

function start(mode) {
  document.getElementById("go").disabled = true; document.getElementById("goFile").disabled = true;
  lines.length = 0; log("구글 인증 중…");
  const tc = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: SCOPE,
    callback: (resp) => {
      if (!resp.access_token) { log("토큰을 못 받았습니다: " + JSON.stringify(resp)); document.getElementById("go").disabled = false; return; }
      token = resp.access_token;
      log("토큰 OK — 부여된 scope: " + (resp.scope || "(미표기)"));
      if (resp.scope && !resp.scope.includes("drive.file")) log("⚠ drive.file 이 안 보입니다 — 실험이 성립하지 않습니다");
      // ⚠ auth/drive\\b 로 쓰면 drive.file 에도 걸린다(경계가 '.' 이라서) — 전체 드라이브 scope 만 겨눈다
      if (resp.scope && /drive\\.readonly|drive\\.metadata|auth\\/drive(\\s|$)/.test(resp.scope)) log("⚠ 제한범위가 섞였습니다 — 이러면 결과가 무의미합니다(테스트 클라이언트를 확인하세요)");
      gapi.load("picker", () => {
        // mode='folder' = 본 실험 · mode='file' = 대조군(파일 하나). 대조군이 200 이면 설정은 정상이라는 뜻이라,
        //  폴더 쪽 404 를 "설정 실수"가 아니라 **답**으로 읽을 수 있다.
        const view = mode === "file"
          ? new google.picker.DocsView(google.picker.ViewId.DOCS)
          : new google.picker.DocsView(google.picker.ViewId.FOLDERS)
              .setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes("application/vnd.google-apps.folder");
        new google.picker.PickerBuilder()
          // ★ setAppId 가 **필수**다 — 이게 없으면 Picker 선택이 앱에 권한을 붙이지 못해 무엇을 골라도 404 다.
          //  (그걸 "폴더는 안 준다"로 오독하기 쉽다 — 실제로 1차 실행에서 그렇게 나왔다.)
          .setAppId(APP_ID)
          .addView(view).setOAuthToken(token).setCallback((d) => {
            if (d.action !== google.picker.Action.PICKED) return;
            const doc = d.docs[0];
            (mode === "file" ? controlProbe(doc.id, doc.name) : probe(doc.id, doc.name)).catch((e) => log("오류: " + e.message));
          }).build().setVisible(true);
        log(mode === "file" ? "Picker 를 엽니다 — [대조군] 아무 파일이나 하나 고르세요" : "Picker 를 엽니다 — 파일이 든 폴더를 하나 고르세요");
      });
    },
  });
  tc.requestAccessToken({ prompt: "consent" });
}
/** 대조군 — Picker 로 고른 **파일** 하나가 읽히는가. 이게 200 이면 클라이언트·원본·appId 설정은 정상이다.
 *  그래야 폴더 쪽 404 를 "설정 실수"가 아니라 **drive.file 의 성질**로 읽을 수 있다. */
async function controlProbe(fileId, name) {
  log("\\n── [대조군] 파일 '" + name + "' (" + fileId + ")");
  const meta = await api("files/" + fileId + "?fields=id,name,mimeType");
  log("[C] 파일 메타 files/{id}        → HTTP " + meta.status + (meta.json?.name ? " (" + meta.json.name + ")" : " " + meta.body));
  if (meta.status === 200) {
    verdict(true, "대조군 통과 — 고른 **파일**은 읽힙니다. 즉 설정은 정상이고, 폴더가 404 였다면 그건 drive.file 이 폴더 내용물을 안 준다는 뜻입니다.");
  } else {
    verdict(false, "대조군도 HTTP " + meta.status + " — 설정 문제입니다(클라이언트 ID·JS 원본·appId·Picker API 활성화를 보세요). 이 상태의 폴더 결과는 무효입니다.");
  }
}
document.getElementById("go").onclick = () => start("folder");
document.getElementById("goFile").onclick = () => start("file");
</script></body></html>`;

http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(PAGE);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`
#1881 G6 — drive.file 폴더 실측 하네스

  브라우저로 여세요 →  http://localhost:${PORT}

  거기서 하실 일: [시작] → 구글 로그인 → [허용] → 파일이 든 폴더 하나 고르기.
  판정(준다/안 준다)이 화면에 자동으로 뜹니다. 그 화면을 그대로 알려 주시면 됩니다.

  ⚠ 승인된 JavaScript 원본에 http://localhost:${PORT} 가 등록돼 있어야 합니다.
  (Ctrl+C 로 종료)
`);
});
