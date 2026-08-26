// 처음 설정(#/welcome) **화면 확인용 한 장짜리 HTML** 을 만든다 (#1813).
//
//  왜 필요한가: 이 화면을 사람에게 보여 주려면 프리뷰 환경을 띄우고 로그인을 태워야 하는데,
//   프리뷰 프록시 뒤에서는 로그인 POST 가 404 로 떨어진다(알려진 제약 —
//   [[preview-proxy-blocks-workspace-switch-1875]] 와 같은 결). 그래서 "화면만 보고 싶다"는
//   요청이 매번 막힌다.
//
//  이 스크립트는 **진짜 화면 코드**(web/v2/onboarding.ts)를 그대로 번들하고, 서버로 나가는 두
//   모듈만 예시 응답을 주는 것으로 바꿔 끼운다. 그래서 보이는 것은 프로토타입이 아니라
//   **실제 온보딩 화면**이고, 다른 것은 그 뒤의 서버뿐이다.
//
//  ⚠ 이건 시연용이다. 화면 위쪽에 그 사실을 띠로 밝힌다 — 감추면 "됐다"로 읽힌다.
//
//  실행: node scripts/build-welcome-demo.mjs
//  산출: public/onboarding-proto/welcome-demo.html (자기완결 — 파일 하나로 열린다)

import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = path.join(ROOT, "public/onboarding-proto/welcome-demo.html");

/** 서버로 나가는 두 모듈의 대역. 경로는 onboarding.ts 의 import 문과 글자까지 같아야 한다. */
const STUBS = {
  "../core.js": `
// core.js 대역 — 실제로는 인증 헤더를 붙여 게이트웨이로 나간다. 여기선 예시 값을 돌려준다.
export const apiUrl = (p) => p;

const KINDS = [
  { key: 'munseo', name: '문서', n: 14 },
  { key: 'pyo', name: '표·수치', n: 9 },
  { key: 'balpyo', name: '발표 자료', n: 5 },
  { key: 'imiji', name: '이미지', n: 3 },
];
const FORMS = [
  { skel: '주간회의 # # #주', names: ['주간회의_2026-08-1주.md', '주간회의_2026-08-2주.md', '주간회의_2026-08-3주.md'] },
  { skel: '월간 매출 #', names: ['월간_매출_07.xlsx', '월간_매출_08.xlsx'] },
];
const DRAWERS = [
  { name: '회의록', why: '주간회의_ 로 시작하는 파일 3개' },
  { name: '월간 보고', why: '월간_매출_07·08 처럼 달만 다른 파일 2개' },
  { name: '제안·견적', why: '제안서_·견적_ 로 시작하는 파일 4개' },
  { name: '고객 인터뷰', why: '인터뷰_ 로 시작하는 파일 3개' },
  { name: '그 밖의 자료', why: '어디에도 안 들어가는 것' },
];

let upN = 0;
export const __demoAddUpload = (n) => { upN += n; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let analyzeStartedAt = 0;

export async function api(pathname, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  await sleep(220);   // 왕복이 있는 것처럼 — 즉답이면 화면 흐름이 실제와 달라진다

  if (method === 'GET' && pathname.startsWith('/api/ui/me/welcome/analyze/')) {
    const elapsed = Date.now() - analyzeStartedAt;
    if (elapsed < 7000) return { done: false, chunk: '', next: 0 };
    return { done: true, exit: 0, next: 0, drawers: DRAWERS };
  }
  if (method === 'POST' && pathname === '/api/ui/me/welcome/analyze') {
    analyzeStartedAt = Date.now();
    return { turn_id: 't' + '0'.repeat(16), files: 31 };
  }
  if (method === 'GET' && pathname === '/api/ui/me/welcome') {
    const kinds = upN
      ? [{ key: 'ollin', name: '방금 올린 파일', n: upN }, ...KINDS]
      : KINDS;
    return {
      done: false, done_at: null,
      profile: { display_name: '원준', nickname: null, work: null },
      uploads: { total: 31 + upN, sampled: 31 + upN, kinds, names: FORMS.flatMap((f) => f.names), forms: FORMS },
      categories: [],
    };
  }
  if (method === 'POST' && pathname === '/api/ui/me/welcome') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const created = (body.drawers || []).map((d) => d.name).filter(Boolean);
    return { ok: true, created, skipped: [], welcome: { done_at: new Date().toISOString(), drawers: created } };
  }
  return { ok: true };
}
`,
  "../projects/files-upload.js": `
// files-upload.js 대역 — 진짜 판은 개인 폴더로 PUT 해서 자료로 등록한다.
//  시연에서는 파일을 **밖으로 보내지 않고** 고른 것만 세어 준다.
import { __demoAddUpload } from '../core.js';

export function upDropZone(zone, _hit, onFiles) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { stop(e); zone.classList.add('ob-over'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { stop(e); zone.classList.remove('ob-over'); }));
  zone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files.map((f) => ({ file: f, rel: f.name })));
  });
}

export function upControl(onFiles, opts = {}) {
  const mk = (dir) => {
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true; i.hidden = true;
    if (dir) { i.webkitdirectory = true; i.setAttribute('webkitdirectory', ''); }
    i.addEventListener('change', () => {
      const files = [...i.files];
      if (files.length) onFiles(files.map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })));
      i.value = '';
    });
    return i;
  };
  const fileIn = mk(false), dirIn = mk(true);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = opts.className || ''; btn.textContent = opts.label || '파일 고르기';
  btn.addEventListener('click', () => fileIn.click());
  return { btn, fileIn, dirIn };
}

export async function authUploadProgress(_url, file, _onProgress) {
  await new Promise((r) => setTimeout(r, 260 + Math.random() * 240));
  __demoAddUpload(1);
  return { source_id: Math.floor(Math.random() * 100000), name: file.name };
}
`,
  "__entry": `
import { renderOnboarding } from '${path.join(ROOT, "web/v2/onboarding.ts").replace(/\\/g, "/")}';
const host = document.getElementById('app');
renderOnboarding(host, {
  onBare: () => {},
  // 실제로는 셸이 홈으로 데려간다. 시연에서는 끝났다는 것만 보여 주고 처음으로 되돌린다.
  onDone: () => {
    const b = document.getElementById('demobar');
    if (b) b.innerHTML = '<b>정리까지 끝났습니다.</b> 실제 서비스에서는 여기서 워크스페이스 홈으로 넘어갑니다. ' +
      '<a href="" onclick="try{sessionStorage.clear()}catch(e){};return true">처음부터 다시 보기</a>';
  },
});
// 시연에서는 주소가 바뀌어도 다른 화면이 없다 — 끝에서 홈으로 가려는 것을 잡아 둔다.
addEventListener('hashchange', () => { if (location.hash === '#/' || location.hash === '') history.replaceState(null, '', location.pathname); });
`,
};

/** import 두 개를 위 대역으로 바꿔 끼운다. */
const stubPlugin = {
  name: "welcome-demo-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\.\/(core|projects\/files-upload)\.js$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
      contents: STUBS[a.path], loader: "js", resolveDir: ROOT,
    }));
  },
};

const css = ["01-base.css", "40-v2.css", "41-onboarding.css"]
  .map((f) => readFileSync(path.join(ROOT, "public/styles", f), "utf8")).join("\n");

const bundled = await build({
  stdin: { contents: STUBS.__entry, resolveDir: ROOT, sourcefile: "welcome-demo.ts", loader: "ts" },
  bundle: true, write: false, format: "esm", target: "es2022", platform: "browser",
  plugins: [stubPlugin], legalComments: "none",
});
const js = bundled.outputFiles[0].text;

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lively 처음 설정 — 화면 확인</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
${css}
/* 시연 껍데기 — 실제 셸(사이드바·탭)은 없다. 온보딩 화면만 그대로 세운다. */
html,body{height:100%;margin:0}
body{background:var(--canvas);font-family:"Pretendard",-apple-system,"Apple SD Gothic Neo",sans-serif;color:var(--ink)}
#demobar{position:sticky;top:0;z-index:50;background:#FFF7ED;border-bottom:1px solid #F3DCC0;color:#7A5A2E;
  font-size:13px;line-height:1.6;padding:9px 16px;text-align:center}
#demobar b{color:#5E4321}
#demobar a{color:#1E54CC;font-weight:700}
#wrap{height:calc(100% - 40px);display:flex;justify-content:center}
#app{width:min(1180px,100%);background:var(--bg);display:flex;flex-direction:column;min-height:0}
</style>
</head><body>
<div id="demobar"><b>화면 확인용입니다.</b> 화면은 실제 온보딩 코드 그대로이고, <b>서버만 예시 값</b>으로 대신합니다 —
  파일을 골라도 밖으로 나가지 않고, AI 분석은 7초 뒤 예시 갈래를 돌려줍니다.</div>
<div id="wrap"><div id="app"></div></div>
<script type="module">
${js}
</script>
</body></html>`;

writeFileSync(OUT, html, "utf8");
console.log(`✓ 처음 설정 화면 확인본: ${path.relative(ROOT, OUT)} (${(html.length / 1024).toFixed(0)} KiB)`);
