// 렌더러 (#1541 T2) — 상태를 그리고 사람의 답을 메인에 넘긴다. **판단은 메인에 있다**(여긴 표시만).
//  window.lively 는 preload 가 노출한 함수 묶음뿐이다(ipcRenderer 원본은 안 넘어온다).
"use strict";

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hidden", !on);
let state = null, prompt = null;
// 이번 실행에서 설치를 **방금 마쳤나** — 완료 화면은 그때만 띄운다.
//  앱을 다시 열 때마다 "설치가 끝났습니다" 가 뜨면 그건 안내가 아니라 소음이다.
let justFinished = false;

function renderState(s) {
  state = s || {};
  const label = !s?.cliFound ? "라이블리 CLI 없음"
    : !s.loggedIn ? "로그인이 필요합니다"
      : !s.kitInstalled ? "키트 설치가 필요합니다"
        : s.nodeRunning ? "노드 실행 중" : s.nodeRegistered ? "노드 정지됨" : "설치 완료";
  $("status").textContent = label;
  $("sub").textContent = s?.gatewayUrl || "";
  $("dot").className = "dot " + (s?.nodeRunning ? "on" : s?.loggedIn ? "warn" : "off");
  // 설치가 끝났나 — 이 한 줄이 마법사와 평상시 화면을 가른다.
  const ready = !!(s?.cliFound && s?.loggedIn && s?.kitInstalled);
  // 게이트웨이 카드는 아직 끝나지 않았을 때만 — 다 됐는데 또 물으면 사용자가 '뭘 잘못했나' 한다.
  show($("gw-card"), !ready && !s?.busy);
  show($("done-card"), ready && !s?.busy && justFinished);
  show($("node-card"), ready);
  // 실행 여부를 **모를 때**(측정 실패)는 버튼을 잠그지 않는다 — 모른다고 사용자를 가두면 안 된다.
  const running = s?.nodeRunning === true, stopped = s?.nodeRunning === false;
  $("node-state").textContent = !s?.nodeRegistered ? "아직 이 PC 는 노드로 등록되지 않았습니다."
    : s?.nodeRunning === null ? `노드 ${s?.nodeId || ""} — 실행 여부를 확인하지 못했습니다.`
      : running ? `노드 ${s?.nodeId || ""} 실행 중${s?.nodeDaemon ? " · PC 켤 때 자동 시작" : " · 이 세션만"}`
        : `노드 ${s?.nodeId || ""} 정지됨`;
  $("node-start").disabled = !!s?.busy || running;
  $("node-stop").disabled = !!s?.busy || stopped || !s?.nodeRegistered;
  const al = $("app-autolaunch");
  al.closest("label").classList.toggle("hidden", s?.appAutoLaunch === null || s?.appAutoLaunch === undefined);
  al.checked = !!s?.appAutoLaunch; al.disabled = !!s?.busy;
  $("gw-go").disabled = !!s?.busy;
}

function renderProgress(p) {
  // 실패는 화면에 남긴다 — 성공만 사라지고 실패가 조용히 없어지면 사람은 무슨 일이 났는지 모른다.
  show($("progress-card"), !!p && (!p.done || p.ok === false));
  if (!p) return;
  if (p.done && p.ok) justFinished = true;
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
// 무엇을 실행할지 **입력하는 동안** 보여준다(설치는 원격 코드 실행이다 — 숨기지 않는다).
const preview = () => {
  const gw = $("gw").value.trim().replace(/\/+$/, "");
  const win = /win/i.test(navigator.userAgent || "");
  $("gw-preview").textContent = /^https?:\/\/\S+$/i.test(gw)
    ? (win ? `irm ${gw}/cli.ps1 | iex` : `curl -fsSL ${gw}/cli | sh`) + "  → 이어서 로그인·설치"
    : "";
};
$("gw").addEventListener("input", () => { $("gw-err").textContent = ""; preview(); });
$("gw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("gw-go").click(); });
$("gw-go").addEventListener("click", async () => {
  const url = $("gw").value.trim();
  $("gw-err").textContent = "";
  const r = await window.lively.setGateway(url);
  if (!r?.ok && r?.error) { $("gw-err").textContent = r.error; log("✗ " + r.error); }
});
$("done-web").addEventListener("click", () => { if (state?.gatewayUrl) window.lively.openExternal(state.gatewayUrl); });
$("cancel").addEventListener("click", () => window.lively.cancel());
$("prompt-yes").addEventListener("click", () => { if (prompt) { window.lively.answer(prompt.id, true); renderPrompt(null); } });
$("prompt-no").addEventListener("click", () => { if (prompt) { window.lively.answer(prompt.id, false); renderPrompt(null); } });
$("device-link").addEventListener("click", (e) => { e.preventDefault(); const u = e.target.dataset.url; if (u) window.lively.openExternal(u); });
$("node-start").addEventListener("click", async () => { const r = await window.lively.run("node-start"); if (r?.error) log("✗ " + r.error); });
$("node-stop").addEventListener("click", async () => { const r = await window.lively.run("node-stop"); if (r?.error) log("✗ " + r.error); });
$("app-autolaunch").addEventListener("change", (e) => window.lively.setAppAutoLaunch(e.target.checked));

window.lively.onState(renderState);
window.lively.onProgress(renderProgress);
window.lively.onLog((l) => log(l.line));
window.lively.getState().then(({ state: s, progress: p }) => { renderState(s); renderProgress(p); });
