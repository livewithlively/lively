// 렌더러 (#1541 T2) — 상태를 그리고 사람의 답을 메인에 넘긴다. **판단은 메인에 있다**(여긴 표시만).
//  window.lively 는 preload 가 노출한 함수 묶음뿐이다(ipcRenderer 원본은 안 넘어온다).
"use strict";

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hidden", !on);
let state = null, prompt = null;

function renderState(s) {
  state = s || {};
  const label = !s?.cliFound ? "라이블리 CLI 없음"
    : !s.loggedIn ? "로그인이 필요합니다"
      : !s.kitInstalled ? "키트 설치가 필요합니다"
        : s.nodeRunning ? "노드 실행 중" : s.nodeRegistered ? "노드 정지됨" : "설치 완료";
  $("status").textContent = label;
  $("sub").textContent = s?.gatewayUrl || "";
  $("dot").className = "dot " + (s?.nodeRunning ? "on" : s?.loggedIn ? "warn" : "off");
  // 게이트웨이 카드는 주소를 모를 때만 — 아는데 또 물으면 사용자가 '뭘 잘못했나' 한다.
  show($("gw-card"), !s?.gatewayUrl || !s?.loggedIn);
  show($("node-card"), !!(s?.cliFound && s?.loggedIn && s?.kitInstalled));
  $("node-start").disabled = !!s?.busy || !!s?.nodeRunning;
  $("node-stop").disabled = !!s?.busy || !s?.nodeRunning;
  $("gw-go").disabled = !!s?.busy;
}

function renderProgress(p) {
  show($("progress-card"), !!p && !p.done);
  if (!p) return;
  $("progress-title").textContent = p.done ? (p.ok ? "완료" : "실패") : "진행 중";
  // 진행률을 모르면(i/n 없음) 바를 채우지 않는다 — 가짜 퍼센트는 멈춘 것처럼 보인다.
  const pct = Number.isFinite(p.i) && Number.isFinite(p.n) && p.n > 0 ? Math.round((p.i / p.n) * 100) : null;
  $("bar-fill").style.width = pct === null ? "0%" : pct + "%";
  $("bar-fill").classList.toggle("indeterminate", pct === null && !p.done);
  $("steps").replaceChildren(...(p.steps || []).map((st) => {
    const li = document.createElement("li");
    li.className = "step " + st.status;
    li.textContent = (st.status === "done" ? "✓ " : st.status === "fail" ? "✗ " : "· ") + st.label;
    return li;
  }));
  renderPrompt(p.prompt);
}

function renderPrompt(p) {
  prompt = p || null;
  show($("prompt-card"), !!p);
  if (!p) return;
  $("prompt-label").textContent = p.label || (p.kind === "device-code" ? "브라우저에서 승인" : "확인이 필요합니다");
  show($("prompt-device"), p.kind === "device-code");
  show($("prompt-confirm"), p.kind === "confirm");
  if (p.kind === "device-code") {
    $("device-code").textContent = p.user_code || "";
    const url = p.verification_uri_complete || p.verification_uri || "";
    $("device-link").textContent = url;
    $("device-link").dataset.url = url;
  }
}

function log(line) {
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

// ── 배선 ────────────────────────────────────────────────────────────────────
$("gw-go").addEventListener("click", async () => {
  const url = $("gw").value.trim();
  const r = await window.lively.setGateway(url);
  if (!r?.ok && r?.error) log("✗ " + r.error);
});
$("cancel").addEventListener("click", () => window.lively.cancel());
$("prompt-yes").addEventListener("click", () => { if (prompt) { window.lively.answer(prompt.id, true); renderPrompt(null); } });
$("prompt-no").addEventListener("click", () => { if (prompt) { window.lively.answer(prompt.id, false); renderPrompt(null); } });
$("device-link").addEventListener("click", (e) => { e.preventDefault(); const u = e.target.dataset.url; if (u) window.lively.openExternal(u); });
$("node-start").addEventListener("click", async () => { const r = await window.lively.run("node-start"); if (r?.error) log("✗ " + r.error); });
$("node-stop").addEventListener("click", async () => { const r = await window.lively.run("node-stop"); if (r?.error) log("✗ " + r.error); });

window.lively.onState(renderState);
window.lively.onProgress(renderProgress);
window.lively.onLog((l) => log(l.line));
window.lively.getState().then(({ state: s, progress: p }) => { renderState(s); renderProgress(p); });
