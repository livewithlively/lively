// 패키징 산출물 검증 (#1541 T2) — **수동 실행**(빌드 후):
//   cd desktop && npx electron-builder --dir --publish never && node verify-packaged.mjs
// 왜: electron-builder 는 files 글롭이 틀려 **렌더러가 통째로 빠져도 성공으로 끝난다**. 빌드 로그가 아니라
//  뜬 앱의 DOM 으로 판정한다. (서명·아이콘·설치기는 T6 범위 — 여긴 "산출물이 실행되나"까지다.)
//
// 패키징된 .app 이 실제로 뜨는가 — files 글롭이 틀리면 렌더러가 통째로 빠진 채 '성공' 빌드가 나온다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path"; import { fileURLToPath } from "node:url";
const DESKTOP = dirname(fileURLToPath(import.meta.url));
const R = DESKTOP + "/../";
const WebSocket = createRequire(R + "package.json")("ws");
// 산출물 경로는 플랫폼·아키텍처마다 다르다 — 있는 걸 찾는다(없으면 무엇을 먼저 하라고 말한다).
import { existsSync, readdirSync } from "node:fs";
const REL = DESKTOP + "/release";
const BIN = (() => {
  if (!existsSync(REL)) return null;
  for (const d of readdirSync(REL)) {
    for (const c of [`${REL}/${d}/Lively.app/Contents/MacOS/Lively`, `${REL}/${d}/Lively.exe`, `${REL}/${d}/lively`]) if (existsSync(c)) return c;
  }
  return null;
})();
if (!BIN) { console.error("빌드 산출물이 없습니다 — 먼저: npx electron-builder --dir --publish never"); process.exit(2); }
const BOX = mkdtempSync(join(tmpdir(), "pkg-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0; const chk = (ok, l, d="") => { console.log(`[${ok?"PASS":"FAIL"}] ${l}${d?"  "+d:""}`); if(!ok) fail++; };
const p = spawn(BIN, ["--remote-debugging-port=9335"], { env: { ...process.env, LIVELY_HOME: BOX }, stdio: ["ignore","pipe","pipe"] });
let log = ""; p.stdout.on("data",d=>log+=d); p.stderr.on("data",d=>log+=d);
let page = null;
for (let i=0;i<40;i++){ await sleep(500); try{ const r=await fetch("http://127.0.0.1:9335/json/list"); if(r.ok){ const t=await r.json(); page=t.find(x=>x.type==="page"); if(page) break; } }catch{} }
chk(!!page, "① 패키징된 앱의 창이 뜬다", page? "" : log.slice(0,300));
if (page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.on("open",r));
  let id=0; const pend=new Map(); ws.on("message",m=>{const o=JSON.parse(m);const cb=pend.get(o.id); if(cb){pend.delete(o.id);cb(o);}});
  const ev=(e)=>new Promise(res=>{const n=++id;pend.set(n,o=>res(o.result?.result?.value));ws.send(JSON.stringify({id:n,method:"Runtime.evaluate",params:{expression:e,returnByValue:true,awaitPromise:true}}));});
  for(let i=0;i<40;i++){ if(await ev("document.readyState")==="complete") break; await sleep(250); }
  chk(await ev("document.title")==="라이블리","② 렌더러 자산이 번들에 들어갔다(HTML)");
  chk(await ev("getComputedStyle(document.body).backgroundColor")!=="rgba(0, 0, 0, 0)","③ CSS 도 들어갔다");
  chk(typeof await ev("typeof window.lively.getState")==="string" && await ev("typeof window.lively.getState")==="function","④ preload 도 들어갔다");
  const st = await ev("window.lively.getState().then(r=>JSON.stringify(r.state))");
  chk(/cliFound/.test(String(st)),"⑤ 메인 프로세스 IPC 동작", String(st).slice(0,90));
  ws.close();
}
p.kill(); try{ rmSync(BOX,{recursive:true,force:true}); }catch{}
console.log(`\n${fail===0?"✓ 패키징 산출물 실동작 확인":`✗ ${fail}건 실패`}`);
process.exit(fail?1:0);
