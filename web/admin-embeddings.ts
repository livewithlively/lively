// admin-embeddings.ts — [의미 검색(임베딩)] 패널 (#1313 R39, admin.ts 에서 verbatim 분리).
//  ⚠ 폴링 타이머 2개(pollTimer=지식 백필 · projPollTimer=프로젝트 백필)와 그 정지 가드가 **함께** 왔다.
//   두 타이머는 body.isConnected 로 '이 패널이 아직 DOM 에 붙어 있나'를 매 tick 확인하고, 아니면 스스로
//   멈춘다(섹션 이동 시 누수 방지). 타이머 변수는 embeddingsEditor 지역이라 모듈 전역 상태가 없다 —
//   패널을 다시 그리면 새 클로저가 새 타이머를 쥐고, 옛 타이머는 isConnected=false 를 보고 끝난다.
import { absTime, api, cardHead, el, fmtNum, replaceKids, toast, uiText } from './core.js';
import { sectionHead } from './admin-widgets.js';
import { dlvBox } from './lib/dlv.js';

//  #5159 — 한 화면에 들도록 2단으로 다시 짰다: 왼쪽 「연결」(설정 폼) · 오른쪽 「지금 상태」(지식·프로젝트 임베딩 수 + 백필).
//   성능 조절 세 칸(배치·타임아웃·메모리 게이트)은 접힘으로 — 처음 켤 때 손댈 일이 없는 값이다.
//   bare 면 머리(sectionHead)·카드를 그리지 않는다 — [AI 주입 설정] 세부 페이지가 자기 머리를 그린다.
function embeddingsEditor(detail, data, opts: { bare?: boolean } = {}) {
  const canEdit = !!data.canEdit;
  const body = el('div', { class: 'emb-body' });
  if (opts.bare) replaceKids(detail, body);
  else replaceKids(detail,
    sectionHead('의미 검색 (임베딩)', 'AI와 사람이 지식을 단어가 아니라 뜻으로 찾게 합니다. 꺼 두면 단어가 그대로 들어간 지식만 찾습니다.'),
    el('div', { class: 'card' }, cardHead('의미 검색 상태와 설정'), body));
  body.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));

  // 라벨 + 칸 + 힌트 한 줄 — 짧은 칸은 .dlv-frow 로 한 줄에 둘·셋씩 세운다.
  const fld = (label, ctrl, hint?) => el('label', { class: 'dlv-f' },
    el('span', { class: 'dlv-f-l', text: label }), ctrl, hint ? el('span', { class: 'dlv-f-h' }, ...uiText(hint)) : null);

  let pollTimer: any = null;
  const stopPoll = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
  let projPollTimer: any = null;
  const stopProjPoll = () => { if (projPollTimer) { clearTimeout(projPollTimer); projPollTimer = null; } };
  // #1060 자동 백필 일시중지 컨트롤 — knowledge·project 백필을 함께 지배하므로 두 섹션 위에 한 번만 둔다.
  //  buildOnce 가 region 을 만들어 여기 담고, knowledge 폴링(updateStatus)이 최신 paused 로 재렌더해 상태를 항상 신선하게 유지.
  let pauseRegion: any = null;

  // 일시중지/재개 토글 + 상태 배너. paused=true 면 코랄 경고(자동·수동 백필 모두 멈춤), false 면 평상 힌트.
  function renderPauseControl(paused, region) {
    if (!region) return;
    const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: paused ? '자동 백필 재개' : '자동 백필 일시중지' });
    btn.disabled = !canEdit;
    const note = el('div');
    if (paused) {
      note.className = 'admin-warn';
      note.replaceChildren(
        el('div', { text: '⏸ 자동 임베딩 백필이 일시중지되었습니다.' }),
        el('div', { text: '자동 스윕(부팅·10분 주기·동기화 후·저장 시)과 수동 백필이 모두 멈춰 있습니다. 새로 쌓이는 미임베딩은 재개할 때까지 채워지지 않습니다(그동안 검색은 grep 폴백으로 동작). 재개하면 그동안 밀린 항목을 이어서 채웁니다. 이 설정은 게이트웨이 재시작 후에도 유지됩니다.' }));
    } else {
      note.className = 'dlv-box-hint';
      note.textContent = '새로 쌓이는 미임베딩을 백그라운드에서 채우는 중입니다. 성능에 부담이 되면 일시중지합니다.';
    }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/api/ui/org/embeddings/backfill/pause', { method: 'POST', body: JSON.stringify({ paused: !paused }) });
        toast(!paused ? '자동 백필을 일시중지했습니다.' : '자동 백필을 재개했습니다 — 밀린 항목을 채웁니다.');
        load(); // paused 상태·양쪽 백필 버튼 게이트를 한번에 재계산
      } catch (e: any) { toast(e.message, true); btn.disabled = false; }
    });
    replaceKids(region, note, canEdit ? el('div', { class: 'dlv-box-acts' }, btn) : null);
  }

  async function load() {
    let st;
    try { st = await api('/api/ui/org/embeddings'); }
    catch (e: any) { replaceKids(body, el('p', { class: 'dlv-note', text: '상태를 불러오지 못했습니다: ' + e.message })); return; }
    buildOnce(st);
  }

  // 폼(설정 입력)은 한 번만 짓는다 — 폴링은 statusRegion 만 갱신해 입력 중 리셋되지 않게.
  function buildOnce(st) {
    stopPoll();
    stopProjPoll();
    const cfg = st.config || { provider: 'off', base_url: null, model: null, dimensions: 1024, auth_env_ref: null };
    const on = cfg.provider === 'http';

    const provSel = el('select', { class: 'input' },
      el('option', { value: 'off', text: '꺼짐 — grep 검색으로 폴백' }),
      el('option', { value: 'http', text: '켜짐 — HTTP /v1/embeddings' }));
    provSel.value = on ? 'http' : 'off'; provSel.disabled = !canEdit;
    const baseIn = el('input', { class: 'input', type: 'text', placeholder: 'http://localhost:11434  (로컬 Ollama 사이드카)' });
    baseIn.value = cfg.base_url || ''; baseIn.disabled = !canEdit;
    const modelIn = el('input', { class: 'input', type: 'text', placeholder: 'bge-m3  (한국어 강화 = KURE-v1, 둘 다 1024차원)' });
    modelIn.value = cfg.model || ''; modelIn.disabled = !canEdit;
    const dimIn = el('input', { class: 'input emb-num', type: 'number', min: '1', max: '16000', placeholder: '1024' });
    dimIn.value = String(cfg.dimensions || 1024); dimIn.disabled = !canEdit;
    const authIn = el('input', { class: 'input', type: 'text', placeholder: '예: OPENAI_API_KEY' });
    authIn.value = cfg.auth_env_ref || ''; authIn.disabled = !canEdit;
    // 성능 튜닝(#602) — 느린/CPU 백엔드는 배치를 낮춰 요청당 시간을 타임아웃 안으로.
    const batchIn = el('input', { class: 'input emb-num', type: 'number', min: '1', max: '512', placeholder: '8  (CPU 백엔드 권장 4~8)' });
    batchIn.value = String(cfg.batch_size || 8); batchIn.disabled = !canEdit;
    const timeoutIn = el('input', { class: 'input emb-num', type: 'number', min: '1000', max: '3600000', placeholder: '300000  (요청당 ms)' });
    timeoutIn.value = String(cfg.request_timeout_ms || 300000); timeoutIn.disabled = !canEdit;
    // #1059 G3 — 백필 pre-flight 메모리 게이트: 가용 메모리가 이 값 미만이면 자동 백필 스윕을 건너뛴다(0=끔).
    const backfillMinIn = el('input', { class: 'input emb-num', type: 'number', min: '0', max: '1048576', placeholder: '0  (끔; 16GB 박스 권장 4096~5000)' });
    backfillMinIn.value = String(cfg.backfill_min_available_mb || 0); backfillMinIn.disabled = !canEdit;

    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '설정 저장' }); saveBtn.disabled = !canEdit;
    const saveSt = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveSt.textContent = '';
      try {
        const dims = Number(dimIn.value) || 1024;
        const embedding_config = {
          provider: provSel.value,
          base_url: baseIn.value.trim() || null,
          model: modelIn.value.trim() || null,
          dimensions: dims,
          auth_env_ref: authIn.value.trim() || null,
          batch_size: Number(batchIn.value) || 8,
          request_timeout_ms: Number(timeoutIn.value) || 300000,
          backfill_min_available_mb: Number(backfillMinIn.value) || 0, // #1059 G3 — 백필 pre-flight 메모리 게이트(0=끔)
        };
        const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ embedding_config }) });
        if (r && r.runtimeConfig) data.runtimeConfig = r.runtimeConfig;
        toast(provSel.value === 'http' ? '임베딩 켜짐 — 기존 지식은 아래 [백필]로 채우세요.' : '저장됨 — 임베딩 꺼짐(서버 .env 시드도 무시됩니다)');
        load(); // 상태 새로고침(백로그·백필 버튼 활성 재계산)
      } catch (e: any) { toast(e.message, true); saveBtn.disabled = false; }
    });

    // #688 설정 출처 안내 — env 시드로 도는지 / 명시적 off 인지(관리탭 저장과 .env 의 우선순위 혼동 방지).
    const srcNote = st.config_source === 'env'
      ? el('p', { class: 'dlv-note' }, ...uiText('지금은 서버 환경변수(.env EMBEDDINGS_*)로 동작 중입니다 — 여기서 저장하면 이 설정이 우선합니다.'))
      : st.config_source === 'db-off'
        ? el('p', { class: 'dlv-note' }, ...uiText('여기서 꺼 둔 상태입니다 — 서버 .env 의 EMBEDDINGS_* 값은 무시됩니다.'))
        : null;

    const statusRegion = el('div');
    const projectRegion = el('div');
    pauseRegion = el('div'); // #1060 — updateStatus 가 st.backfill_paused 로 채운다(초기·폴링 공통)
    const perf = el('details', { class: 'dlv-more' },
      el('summary', { text: '성능 조절 — 느린 백엔드일 때만' }),
      el('div', { class: 'dlv-frow dlv-frow-3' },
        fld('배치 크기', batchIn, '요청당 텍스트 수(기본 8).'),
        fld('요청 타임아웃 (ms)', timeoutIn, '넘으면 배치를 반으로 줄여 다시 보냅니다.'),
        // #1059 — 자동 백필이 임베딩 모델(예: Ollama)을 부르기 전 가용 메모리를 보고, 이 값 미만이면 이번 스윕을 건너뛴다
        //  (다음 주기 재시도, 유실 없음). 모델 로드 스파이크가 세션 baseline 과 겹쳐 박스가 OOM 나는 걸 막는다. 수동 백필은 안 막는다.
        fld('백필 메모리 게이트 (MB)', backfillMinIn, '가용 메모리가 이보다 적으면 자동 백필을 건너뜁니다. 0 = 끔.')));
    replaceKids(body, el('div', { class: 'dlv-grid' },
      el('div', { class: 'dlv-col' },
        dlvBox('연결', null,
          srcNote,
          fld('사용', provSel),
          fld('엔드포인트 base_url', baseIn, '로컬 사이드카나 외부 API 주소입니다. /v1/embeddings 는 자동으로 붙습니다.'),
          el('div', { class: 'dlv-frow' },
            fld('모델', modelIn),
            fld('차원', dimIn, '바꾸면 전체를 다시 임베딩합니다.')),
          fld('인증 환경변수 이름 (외부 API 만)', authIn, '키 값이 아니라 키를 담은 환경변수의 이름입니다.'),
          perf,
          canEdit ? el('div', { class: 'dlv-box-acts' }, saveSt, saveBtn) : el('p', { class: 'dlv-note', text: '편집은 관리자만 합니다.' })),
        // #1060 자동 백필 일시중지 — knowledge·project 를 함께 지배하므로 한 번만. 임베딩이 켜졌을 때만(꺼지면 백필 자체가 무의미).
        //  왼쪽 칸에 둔다 — 오른쪽 두 칸은 직전 백필 실패 안내가 붙으면 길어진다(실측: 셋을 오른쪽에 쌓으면 1440×900 에서 111px 넘침).
        on ? dlvBox('자동 백필', null, pauseRegion) : null),
      el('div', { class: 'dlv-col' },
        dlvBox('지식', null, statusRegion),
        dlvBox('프로젝트 · 태스크', null, projectRegion))));
    updateStatus(st, statusRegion);
    loadProjectStatus(projectRegion);
  }

  // #688 백필 실패 사유별 처방 — 한 줄 reason 만으론 원인 파악이 어려웠던 실사례(고객사 A 박스)의 판독표를 UI 로.
  function backfillReasonNotice(reason: string): string {
    if (reason === 'off') return '임베딩 설정이 꺼져 있습니다 — 위에서 켠 뒤 저장하세요.';
    if (reason === 'unavailable') return '임베딩 엔드포인트 연결/응답 실패 — base_url 과 사이드카(예: Ollama 컨테이너) 상태를 확인하세요. 엔드포인트가 살아 있는데도 반복되면 과부하일 수 있습니다: 배치 크기를 줄이고(예 2) 요청 타임아웃을 늘려(예 600000) 저장 후 재시도하세요.';
    if (reason === 'schema') return 'pgvector 스키마가 없습니다 — items-db 컨테이너가 pgvector 이미지인지 확인하세요.';
    if (/timeout|abort/i.test(reason)) return '임베딩 요청이 요청 타임아웃을 초과했습니다(느린 CPU 백엔드에서 흔함) — 배치 크기를 줄이고(예 2) 요청 타임아웃을 늘려(예 600000) 저장한 뒤 재시도하세요.';
    return '오류가 반복되면 게이트웨이 로그를 확인하세요.';
  }

  // 임베딩 현황 한 칸 — 큰 숫자(임베딩됨/전체) + 남은 수 + 직전 백필 줄 + 백필 단추.
  function statTile(embedded, backlog, jobLine, bfBtn, bfSt) {
    return el('div', { class: 'dlv-stat' },
      el('div', { class: 'dlv-stat-n' }, fmtNum(embedded), el('small', { text: ' / ' + fmtNum(backlog.total || 0) })),
      el('div', { class: 'dlv-stat-l', text: '임베딩됨 · 남은 ' + fmtNum(backlog.pending || 0) + '건' }),
      jobLine.textContent ? jobLine : null,
      el('div', { class: 'dlv-box-acts' }, bfSt, bfBtn));
  }

  // 백로그·잡 진행만 갱신(폼은 그대로). 잡이 돌면 폴링.
  function updateStatus(st, region) {
    const cfg = st.config || { provider: 'off' };
    const on = cfg.provider === 'http';
    const backlog = st.backlog || { total: 0, pending: 0 };
    const job = st.job;
    const paused = !!st.backfill_paused; // #1060 — 일시중지면 수동 백필도 막고 배너를 띄운다
    const embedded = Math.max(0, (backlog.total || 0) - (backlog.pending || 0));
    const running = !!(job && job.running);

    // #1060 — 일시중지 컨트롤을 최신 상태로(초기 렌더·폴링 공통). on 일 때만 pauseRegion 이 존재.
    if (on) renderPauseControl(paused, pauseRegion);

    const bfBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: running ? '백필 진행 중…' : '남은 지식 임베딩' });
    bfBtn.disabled = !canEdit || !on || running || (backlog.pending || 0) === 0 || paused;
    const bfSt = el('span', { class: 'admin-status' });
    if (!on) bfSt.textContent = '먼저 임베딩을 켜고 저장하세요.';
    else if (paused) bfSt.replaceChildren(...uiText('일시중지됨 — 아래 [자동 백필]에서 재개합니다.'));
    else if ((backlog.pending || 0) === 0 && !running) bfSt.textContent = '모두 임베딩됨 ✓';
    bfBtn.addEventListener('click', async () => {
      bfBtn.disabled = true;
      try {
        await api('/api/ui/org/embeddings/backfill', { method: 'POST', body: JSON.stringify({ mode: 'pending' }) });
        toast('백필 시작 — 진행 상황을 표시합니다.');
        poll(region);
      } catch (e: any) { toast(e.message, true); bfBtn.disabled = false; }
    });

    const jobLine = el('div', { class: 'admin-hint' });
    if (job) {
      if (job.running) jobLine.textContent = `백필 진행: ${fmtNum(job.done)}/${fmtNum(job.total)} …`;
      else if (job.reason) {
        // #688 실패 사유 배너 — reason 원문 + 원인별 처방(admin-warn 코랄 박스).
        jobLine.className = 'admin-warn';
        jobLine.replaceChildren(
          el('div', { text: `⚠ 직전 백필 미완료: ${job.reason}` }),
          el('div', { text: backfillReasonNotice(String(job.reason)) }));
      }
      else if (job.finishedAt) jobLine.textContent = `직전 백필 완료: ${fmtNum(job.embedded)}건 (${absTime(job.finishedAt)}).`;
    }

    replaceKids(region, statTile(embedded, backlog, jobLine, bfBtn, bfSt));

    stopPoll();
    if (running) poll(region);
  }

  function poll(region?) {
    stopPoll();
    pollTimer = setTimeout(async () => {
      if (!body.isConnected) { stopPoll(); return; } // 다른 섹션으로 이동 → 폴링 종료(누수 방지)
      try {
        const st = await api('/api/ui/org/embeddings');
        const r = region || (body.lastChild as any);
        // region 이 사라졌으면 전체 재빌드(안전) — 보통은 statusRegion 재갱신.
        if (r && r.replaceChildren) updateStatus(st, r); else buildOnce(st);
      } catch (_) { poll(region); } // 일시 실패 → 재시도
    }, 1500);
  }

  // 프로젝트 임베딩(#631/#624) 백필 — 지식 백필과 동형(대상만 project 엔드포인트). 같은 embedding_config 공유·자체 폴링.
  function renderProjectStatus(st, region) {
    const on = (st.config && st.config.provider) === 'http';
    const backlog = st.backlog || { total: 0, pending: 0 };
    const job = st.job;
    const paused = !!st.backfill_paused; // #1060 — knowledge 와 공통 스위치(같은 flag). 일시중지면 프로젝트 백필도 막는다.
    const embedded = Math.max(0, (backlog.total || 0) - (backlog.pending || 0));
    const running = !!(job && job.running);

    const bfBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: running ? '백필 진행 중…' : '남은 프로젝트 임베딩' });
    bfBtn.disabled = !canEdit || !on || running || (backlog.pending || 0) === 0 || paused;
    const bfSt = el('span', { class: 'admin-status' });
    if (!on) bfSt.textContent = '먼저 임베딩을 켜고 저장하세요.';
    else if (paused) bfSt.replaceChildren(...uiText('일시중지됨 — 아래 [자동 백필]에서 재개합니다.'));
    else if ((backlog.pending || 0) === 0 && !running) bfSt.textContent = '모두 임베딩됨 ✓';
    bfBtn.addEventListener('click', async () => {
      bfBtn.disabled = true;
      try {
        await api('/api/ui/org/project-embeddings/backfill', { method: 'POST', body: JSON.stringify({ mode: 'pending' }) });
        toast('프로젝트 백필 시작 — 진행 상황을 표시합니다.');
        pollProj(region);
      } catch (e: any) { toast(e.message, true); bfBtn.disabled = false; }
    });

    const jobLine = el('div', { class: 'admin-hint' });
    if (job) {
      if (job.running) jobLine.textContent = `백필 진행: ${fmtNum(job.done)}/${fmtNum(job.total)} …`;
      else if (job.reason) {
        // #688 실패 사유 배너 — reason 원문 + 원인별 처방(admin-warn 코랄 박스).
        jobLine.className = 'admin-warn';
        jobLine.replaceChildren(
          el('div', { text: `⚠ 직전 백필 미완료: ${job.reason}` }),
          el('div', { text: backfillReasonNotice(String(job.reason)) }));
      }
      else if (job.finishedAt) jobLine.textContent = `직전 백필 완료: ${fmtNum(job.embedded)}건 (${absTime(job.finishedAt)}).`;
    }

    replaceKids(region, statTile(embedded, backlog, jobLine, bfBtn, bfSt));

    stopProjPoll();
    if (running) pollProj(region);
  }

  function pollProj(region) {
    stopProjPoll();
    projPollTimer = setTimeout(async () => {
      if (!body.isConnected) { stopProjPoll(); return; } // 다른 섹션으로 이동 → 폴링 종료(누수 방지)
      try { const st = await api('/api/ui/org/project-embeddings'); renderProjectStatus(st, region); }
      catch (_) { pollProj(region); } // 일시 실패 → 재시도
    }, 1500);
  }

  async function loadProjectStatus(region) {
    try { const st = await api('/api/ui/org/project-embeddings'); renderProjectStatus(st, region); }
    catch (e: any) { replaceKids(region, el('p', { class: 'dlv-note', text: '프로젝트 임베딩 상태를 불러오지 못했습니다: ' + e.message })); }
  }

  load();
}

export {
  embeddingsEditor,
};
