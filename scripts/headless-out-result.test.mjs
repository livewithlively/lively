// scripts/headless-chrome.mjs 의 readOut — dump 된 DOM 에서 `<pre id="out">` 결과 본문을 꺼내는 계약.
//
// 무엇이 문제였나: 런타임 테스트들이 결과를 `/<pre id="out">([\s\S]*?)ENDRESULT/` 로 꺼냈다. 페이지가 결과를 쓰기 전에
//  덤프되면(본문이 아직 PENDING) 이 정규식은 `</pre>` 를 넘어 인라인 스크립트 속 `'ENDRESULT'` 문자열까지 건너가
//  `PENDING</pre><script>…` 를 결과로 집는다. 그래서 «결과 없음» 이 `SyntaxError: Unexpected token 'P', "PENDING</p"…`
//  로 둔갑했다(side-files-finder-runtime, CI 실측 2회). 원인이 타이밍인데 파싱 오류로 보여 진단이 엇나갔다.
//
// 표(행 = 시나리오):
//  O1 결과가 있으면 marker 앞까지를 엔티티를 되돌려 돌려준다
//  O2 아직 PENDING 이고 스크립트에 marker 문자열이 있으면 결과 없음 + out=PENDING   ← 이번 결함
//  O3 `<pre id="out">` 자체가 없으면 둘 다 null
//  O4 marker 를 바꿔 부를 수 있다(정규식 특수문자도 글자 그대로)
//  O5 결과 본문의 `&amp;lt;` 는 `&lt;` 로 한 번만 되돌린다(이중 복원 금지)
import assert from "node:assert/strict";
import { readOut } from "./headless-chrome.mjs";

let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };

//  실제 런타임 테스트 페이지의 모양 — 결과 칸 뒤에 marker 를 문자열로 품은 인라인 스크립트가 온다.
const page = (out) => `<html><head></head><body><div id="toasts"></div><pre id="out">${out}</pre>`
  + `<script>(async function main(){ document.getElementById("out").textContent = JSON.stringify({}) + "ENDRESULT"; })()`
  + `.catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e) }) + 'ENDRESULT'; });</script></body></html>`;

{
  const r = readOut(page(`{"a":"&lt;b&gt; &amp; c","n":1}ENDRESULT`));
  ok(r.text === `{"a":"<b> & c","n":1}` && r.out === null, "O1 결과 본문을 되돌려 돌려준다", JSON.stringify(r));
  ok(JSON.parse(r.text).a === "<b> & c", "O1 되돌린 본문은 JSON 으로 읽힌다");
}
{
  const r = readOut(page("PENDING"));
  ok(r.text === null, "O2 PENDING 이면 결과로 집지 않는다 — 스크립트 속 marker 까지 건너가지 않는다", JSON.stringify(r));
  ok(r.out === "PENDING", "O2 지금 결과 칸 내용을 실패 사유로 돌려준다", JSON.stringify(r));
}
{
  const r = readOut("<html><body><p>nothing</p></body></html>");
  ok(r.text === null && r.out === null, "O3 결과 칸이 없으면 둘 다 null", JSON.stringify(r));
}
{
  ok(readOut(`<pre id="out">{"x":2}DONE.*</pre>`, "DONE.*").text === `{"x":2}`, "O4 marker 를 글자 그대로 쓴다");
  ok(readOut(`<pre id="out">{"x":2}DONEzz</pre>`, "DONE.*").text === null, "O4 marker 의 정규식 특수문자를 패턴으로 해석하지 않는다");
}
{
  ok(readOut(`<pre id="out">"&amp;lt;"ENDRESULT</pre>`).text === `"&lt;"`, "O5 &amp;lt; 는 &lt; 로 한 번만 되돌린다");
}

console.log(`headless-out-result.test: ${pass} passed`);
