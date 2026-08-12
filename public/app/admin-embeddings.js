// admin-embeddings.ts — [의미 검색(임베딩)] 패널 (#1313 R39, admin.ts 에서 verbatim 분리).
//  ⚠ 폴링 타이머 2개(pollTimer=지식 백필 · projPollTimer=프로젝트 백필)와 그 정지 가드가 **함께** 왔다.
//   두 타이머는 body.isConnected 로 '이 패널이 아직 DOM 에 붙어 있나'를 매 tick 확인하고, 아니면 스스로
//   멈춘다(섹션 이동 시 누수 방지). 타이머 변수는 embeddingsEditor 지역이라 모듈 전역 상태가 없다 —
//   패널을 다시 그리면 새 클로저가 새 타이머를 쥐고, 옛 타이머는 isConnected=false 를 보고 끝난다.
import { absTime, api, cardHead, el, fmtNum, toast, uiText } from './core.js';
import { field } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';
function embeddingsEditor(detail, data) {
    const canEdit = !!data.canEdit;
    const body = el('div');
    detail.replaceChildren(sectionHead('의미 검색 (임베딩)', 'AI와 사람이 지식을 단어가 아니라 뜻으로 찾게 합니다. 꺼 두면 단어가 그대로 들어간 지식만 찾습니다.'), el('div', { class: 'card' }, cardHead('의미 검색 상태와 설정'), body));
    body.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
    let pollTimer = null;
    const stopPoll = () => { if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    } };
    let projPollTimer = null;
    const stopProjPoll = () => { if (projPollTimer) {
        clearTimeout(projPollTimer);
        projPollTimer = null;
    } };
    // #1060 자동 백필 일시중지 컨트롤 — knowledge·project 백필을 함께 지배하므로 두 섹션 위에 한 번만 둔다.
    //  buildOnce 가 region 을 만들어 여기 담고, knowledge 폴링(updateStatus)이 최신 paused 로 재렌더해 상태를 항상 신선하게 유지.
    let pauseRegion = null;
    // 일시중지/재개 토글 + 상태 배너. paused=true 면 코랄 경고(자동·수동 백필 모두 멈춤), false 면 평상 힌트.
    function renderPauseControl(paused, region) {
        if (!region)
            return;
        const btn = el('button', { class: 'btn btn-sm', text: paused ? '자동 백필 재개' : '자동 백필 일시중지' });
        btn.disabled = !canEdit;
        const note = el('div');
        if (paused) {
            note.className = 'admin-warn';
            note.replaceChildren(el('div', { text: '⏸ 자동 임베딩 백필이 일시중지되었습니다.' }), el('div', { text: '자동 스윕(부팅·10분 주기·동기화 후·저장 시)과 수동 백필이 모두 멈춰 있습니다. 새로 쌓이는 미임베딩은 재개할 때까지 채워지지 않습니다(그동안 검색은 grep 폴백으로 동작). 재개하면 그동안 밀린 항목을 이어서 채웁니다. 이 설정은 게이트웨이 재시작 후에도 유지됩니다.' }));
        }
        else {
            note.className = 'admin-hint';
            note.textContent = '자동 백필이 켜져 있습니다(정상 동작). 성능 등의 이유로 멈추려면 일시중지하세요 — 실행 중이던 백필도 곧 멈춥니다.';
        }
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await api('/api/ui/org/embeddings/backfill/pause', { method: 'POST', body: JSON.stringify({ paused: !paused }) });
                toast(!paused ? '자동 백필을 일시중지했습니다.' : '자동 백필을 재개했습니다 — 밀린 항목을 채웁니다.');
                load(); // paused 상태·양쪽 백필 버튼 게이트를 한번에 재계산
            }
            catch (e) {
                toast(e.message, true);
                btn.disabled = false;
            }
        });
        region.replaceChildren(note, canEdit ? el('div', { class: 'admin-actions' }, btn) : el('p', { class: 'admin-hint' }, ...uiText('※ 편집은 관리자만 가능합니다.')));
    }
    async function load() {
        let st;
        try {
            st = await api('/api/ui/org/embeddings');
        }
        catch (e) {
            body.replaceChildren(el('p', { class: 'admin-hint', text: '상태를 불러오지 못했습니다: ' + e.message }));
            return;
        }
        buildOnce(st);
    }
    // 폼(설정 입력)은 한 번만 짓는다 — 폴링은 statusRegion 만 갱신해 입력 중 리셋되지 않게.
    function buildOnce(st) {
        stopPoll();
        stopProjPoll();
        const cfg = st.config || { provider: 'off', base_url: null, model: null, dimensions: 1024, auth_env_ref: null };
        const on = cfg.provider === 'http';
        const provSel = el('select', { class: 'input' }, el('option', { value: 'off', text: '꺼짐 — grep 검색으로 폴백' }), el('option', { value: 'http', text: '켜짐 — HTTP /v1/embeddings' }));
        provSel.value = on ? 'http' : 'off';
        provSel.disabled = !canEdit;
        const baseIn = el('input', { class: 'input', type: 'text', placeholder: 'http://localhost:11434  (로컬 Ollama 사이드카)' });
        baseIn.value = cfg.base_url || '';
        baseIn.disabled = !canEdit;
        const modelIn = el('input', { class: 'input', type: 'text', placeholder: 'bge-m3  (한국어 강화 = KURE-v1, 둘 다 1024차원)' });
        modelIn.value = cfg.model || '';
        modelIn.disabled = !canEdit;
        const dimIn = el('input', { class: 'input emb-num', type: 'number', min: '1', max: '16000', placeholder: '1024' });
        dimIn.value = String(cfg.dimensions || 1024);
        dimIn.disabled = !canEdit;
        const authIn = el('input', { class: 'input', type: 'text', placeholder: '예: OPENAI_API_KEY' });
        authIn.value = cfg.auth_env_ref || '';
        authIn.disabled = !canEdit;
        // 성능 튜닝(#602) — 느린/CPU 백엔드는 배치를 낮춰 요청당 시간을 타임아웃 안으로.
        const batchIn = el('input', { class: 'input emb-num', type: 'number', min: '1', max: '512', placeholder: '8  (CPU 백엔드 권장 4~8)' });
        batchIn.value = String(cfg.batch_size || 8);
        batchIn.disabled = !canEdit;
        const timeoutIn = el('input', { class: 'input emb-num', type: 'number', min: '1000', max: '3600000', placeholder: '300000  (요청당 ms)' });
        timeoutIn.value = String(cfg.request_timeout_ms || 300000);
        timeoutIn.disabled = !canEdit;
        // #1644 질의 데드라인 — 검색·유사·추천처럼 사람이 기다리는 단건 임베딩의 상한(배치 타임아웃과 별개).
        const queryTimeoutIn = el('input', { class: 'input emb-num', type: 'number', min: '100', max: '60000', placeholder: '1200  (질의당 ms)' });
        queryTimeoutIn.value = String(cfg.query_timeout_ms || 1200);
        queryTimeoutIn.disabled = !canEdit;
        // #1059 G3 — 백필 pre-flight 메모리 게이트: 가용 메모리가 이 값 미만이면 자동 백필 스윕을 건너뛴다(0=끔).
        const backfillMinIn = el('input', { class: 'input emb-num', type: 'number', min: '0', max: '1048576', placeholder: '0  (끔; 16GB 박스 권장 4096~5000)' });
        backfillMinIn.value = String(cfg.backfill_min_available_mb || 0);
        backfillMinIn.disabled = !canEdit;
        const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '설정 저장' });
        saveBtn.disabled = !canEdit;
        const saveSt = el('span', { class: 'admin-status' });
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveSt.textContent = '';
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
                    query_timeout_ms: Number(queryTimeoutIn.value) || 1200, // #1644 질의 데드라인(검색 경로)
                    backfill_min_available_mb: Number(backfillMinIn.value) || 0, // #1059 G3 — 백필 pre-flight 메모리 게이트(0=끔)
                };
                const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ embedding_config }) });
                if (r && r.runtimeConfig)
                    data.runtimeConfig = r.runtimeConfig;
                toast(provSel.value === 'http' ? '임베딩 켜짐 — 기존 지식은 아래 [백필]로 채우세요.' : '저장됨 — 임베딩 꺼짐(서버 .env 시드도 무시됩니다)');
                load(); // 상태 새로고침(백로그·백필 버튼 활성 재계산)
            }
            catch (e) {
                toast(e.message, true);
                saveBtn.disabled = false;
            }
        });
        // #688 설정 출처 안내 — env 시드로 도는지 / 명시적 off 인지(관리탭 저장과 .env 의 우선순위 혼동 방지).
        const srcNote = st.config_source === 'env'
            ? el('p', { class: 'admin-hint' }, ...uiText('현재 설정은 서버 환경변수(.env EMBEDDINGS_*) 시드로 동작 중입니다 — 여기서 저장하면 관리탭(DB) 설정이 우선하게 됩니다.'))
            : st.config_source === 'db-off'
                ? el('p', { class: 'admin-hint' }, ...uiText('관리탭에서 명시적으로 꺼둔 상태입니다 — 서버 .env 의 EMBEDDINGS_* 시드는 무시됩니다(다시 켜려면 여기서 켜기 저장).'))
                : null;
        const statusRegion = el('div');
        const projectRegion = el('div');
        pauseRegion = el('div'); // #1060 — updateStatus 가 st.backfill_paused 로 채운다(초기·폴링 공통)
        body.replaceChildren(...(srcNote ? [srcNote] : []), field('벡터 임베딩', provSel), field('엔드포인트 base_url', baseIn), el('p', { class: 'admin-hint' }, ...uiText('로컬 사이드카 또는 외부 API 주소입니다. 경로 /v1/embeddings 는 자동으로 붙습니다.')), field('모델', modelIn), field('차원', dimIn), el('p', { class: 'admin-hint' }, ...uiText('모델의 출력 차원과 일치해야 합니다. 변경하면 전체 재임베딩이 필요합니다.')), field('인증 환경변수 이름 (선택 · 외부 API 용)', authIn), el('p', { class: 'admin-hint' }, ...uiText('키 값이 아니라 키를 담은 환경변수의 이름을 입력합니다.')), field('배치 크기', batchIn), el('p', { class: 'admin-hint' }, ...uiText('요청당 보내는 텍스트 수입니다. 느린 백엔드나 CPU 백엔드에서는 낮추면 타임아웃을 피할 수 있습니다(기본 8).')), field('배치 요청 타임아웃 (ms)', timeoutIn), el('p', { class: 'admin-hint' }, ...uiText('백필처럼 사람이 기다리지 않는 배치 요청에 적용됩니다. 초과하면 배치를 반으로 줄여 재시도합니다(기본 300000).')), field('검색 질의 데드라인 (ms)', queryTimeoutIn), el('p', { class: 'admin-hint' }, ...uiText('의미검색·유사도·추천처럼 사람이 응답을 기다리는 경로에서 질의 한 건을 임베딩하는 데 허용하는 시간입니다. 이 시간을 넘기면 기다리지 않고 grep(렉시컬) 검색 결과로 답하고, 그렇게 답했다는 사실을 응답에 표시합니다. 임베딩 백엔드가 CPU이거나 백필과 겹쳐 밀릴 때 검색이 수십 초씩 멈추는 것을 막습니다(기본 1200). 값을 키우면 의미검색이 유지되는 대신 느린 순간에 더 오래 기다립니다.')), field('백필 메모리 게이트 (MB, 0=끔)', backfillMinIn), el('p', { class: 'admin-hint' }, ...uiText('#1059 — 자동 백필이 임베딩 모델(예: Ollama)을 호출하기 전 가용 메모리를 확인해, 이 값 미만이면 이번 스윕을 건너뜁니다(다음 주기 재시도, 밀린 항목 유실 없음). 모델 로드 스파이크가 세션 baseline 과 겹쳐 박스가 OOM 나는 걸 예방합니다. 0=끔(무회귀). 16GB 박스 권장 4096~5000. 수동 백필 버튼은 게이트하지 않습니다.')), canEdit ? el('div', { class: 'admin-actions' }, saveBtn, saveSt) : el('p', { class: 'admin-hint' }, ...uiText('※ 편집은 관리자만 가능합니다.')), 
        // #1060 자동 백필 일시중지 — knowledge·project 를 함께 지배하므로 두 백필 섹션 위에. 임베딩 켜진 경우에만 노출(꺼지면 백필 자체가 무의미).
        ...(on ? [
            el('div', { class: 'admin-subhead', text: '자동 임베딩 백필' }),
            el('p', { class: 'admin-hint' }, ...uiText('저장·수정·동기화, 그리고 부팅·10분 주기 스윕으로 쌓이는 미임베딩을 게이트웨이가 백그라운드에서 자동으로 채웁니다. 임베딩 백엔드가 느리거나(CPU) 성능에 영향을 줄 때는 아래에서 일시중지하세요 — 재개할 때까지 자동·수동 백필이 모두 멈추고, 재개하면 그동안 밀린 항목을 이어서 채웁니다.')),
            pauseRegion,
        ] : []), el('div', { class: 'admin-subhead', text: '기존 지식 임베딩 (임베딩을 나중에 켠 경우)' }), el('p', { class: 'admin-hint' }, ...uiText('임베딩을 켜도 이미 저장된 지식은 자동으로 임베딩되지 않습니다(켠 이후에 새로 만들거나 수정한 지식만 자동 처리). 기존 지식은 아래 버튼으로 일괄 임베딩하세요 — 중단하거나 다시 실행해도 안전합니다.')), statusRegion, el('div', { class: 'admin-subhead', text: '프로젝트 임베딩 (프로젝트·태스크·서브태스크 검색용)' }), el('p', { class: 'admin-hint' }, ...uiText('프로젝트·태스크·서브태스크의 이름/설명을 임베딩합니다. 임베딩을 켠 이후에 생성·수정·동기화된 항목은 텍스트가 실제로 바뀔 때만 자동으로 임베딩되고, 기존 항목은 아래 버튼으로 일괄 임베딩합니다. 지식과 같은 임베딩 설정을 사용합니다.')), projectRegion);
        updateStatus(st, statusRegion);
        loadProjectStatus(projectRegion);
    }
    // #688 백필 실패 사유별 처방 — 한 줄 reason 만으론 원인 파악이 어려웠던 실사례(고객사 A 박스)의 판독표를 UI 로.
    function backfillReasonNotice(reason) {
        if (reason === 'off')
            return '임베딩 설정이 꺼져 있습니다 — 위에서 켠 뒤 저장하세요.';
        if (reason === 'unavailable')
            return '임베딩 엔드포인트 연결/응답 실패 — base_url 과 사이드카(예: Ollama 컨테이너) 상태를 확인하세요. 엔드포인트가 살아 있는데도 반복되면 과부하일 수 있습니다: 배치 크기를 줄이고(예 2) 요청 타임아웃을 늘려(예 600000) 저장 후 재시도하세요.';
        if (reason === 'schema')
            return 'pgvector 스키마가 없습니다 — items-db 컨테이너가 pgvector 이미지인지 확인하세요.';
        if (/timeout|abort/i.test(reason))
            return '임베딩 요청이 요청 타임아웃을 초과했습니다(느린 CPU 백엔드에서 흔함) — 배치 크기를 줄이고(예 2) 요청 타임아웃을 늘려(예 600000) 저장한 뒤 재시도하세요.';
        return '오류가 반복되면 게이트웨이 로그를 확인하세요.';
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
        if (on)
            renderPauseControl(paused, pauseRegion);
        const bfBtn = el('button', { class: 'btn btn-sm', text: running ? '백필 진행 중…' : '기존 지식 임베딩(백필)' });
        bfBtn.disabled = !canEdit || !on || running || (backlog.pending || 0) === 0 || paused;
        const bfSt = el('span', { class: 'admin-status' });
        if (!on)
            bfSt.textContent = '먼저 임베딩을 켜고 저장하세요.';
        else if (paused)
            bfSt.replaceChildren(...uiText('일시중지됨 — 위 [자동 임베딩 백필]에서 재개한 뒤 실행하세요.'));
        else if ((backlog.pending || 0) === 0 && !running)
            bfSt.textContent = '모두 임베딩됨 ✓';
        bfBtn.addEventListener('click', async () => {
            bfBtn.disabled = true;
            try {
                await api('/api/ui/org/embeddings/backfill', { method: 'POST', body: JSON.stringify({ mode: 'pending' }) });
                toast('백필 시작 — 진행 상황을 표시합니다.');
                poll();
            }
            catch (e) {
                toast(e.message, true);
                bfBtn.disabled = false;
            }
        });
        const jobLine = el('div', { class: 'admin-hint' });
        if (job) {
            if (job.running)
                jobLine.textContent = `백필 진행: ${fmtNum(job.done)}/${fmtNum(job.total)} …`;
            else if (job.reason) {
                // #688 실패 사유 배너 — reason 원문 + 원인별 처방(admin-warn 코랄 박스).
                jobLine.className = 'admin-warn';
                jobLine.replaceChildren(el('div', { text: `⚠ 직전 백필 미완료: ${job.reason}` }), el('div', { text: backfillReasonNotice(String(job.reason)) }));
            }
            else if (job.finishedAt)
                jobLine.textContent = `직전 백필 완료: ${fmtNum(job.embedded)}건 (${absTime(job.finishedAt)}).`;
        }
        region.replaceChildren(el('p', { class: 'admin-hint', text: `기존 지식 ${fmtNum(backlog.total)}건 중 임베딩 ${fmtNum(embedded)}건 · 미임베딩 ${fmtNum(backlog.pending)}건.` }), jobLine, el('div', { class: 'admin-actions' }, bfBtn, bfSt));
        stopPoll();
        if (running)
            poll(region);
    }
    function poll(region) {
        stopPoll();
        pollTimer = setTimeout(async () => {
            if (!body.isConnected) {
                stopPoll();
                return;
            } // 다른 섹션으로 이동 → 폴링 종료(누수 방지)
            try {
                const st = await api('/api/ui/org/embeddings');
                const r = region || body.lastChild;
                // region 이 사라졌으면 전체 재빌드(안전) — 보통은 statusRegion 재갱신.
                if (r && r.replaceChildren)
                    updateStatus(st, r);
                else
                    buildOnce(st);
            }
            catch (_) {
                poll(region);
            } // 일시 실패 → 재시도
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
        const bfBtn = el('button', { class: 'btn btn-sm', text: running ? '프로젝트 백필 진행 중…' : '프로젝트 임베딩(백필)' });
        bfBtn.disabled = !canEdit || !on || running || (backlog.pending || 0) === 0 || paused;
        const bfSt = el('span', { class: 'admin-status' });
        if (!on)
            bfSt.textContent = '먼저 임베딩을 켜고 저장하세요.';
        else if (paused)
            bfSt.replaceChildren(...uiText('일시중지됨 — 위 [자동 임베딩 백필]에서 재개한 뒤 실행하세요.'));
        else if ((backlog.pending || 0) === 0 && !running)
            bfSt.textContent = '모두 임베딩됨 ✓';
        bfBtn.addEventListener('click', async () => {
            bfBtn.disabled = true;
            try {
                await api('/api/ui/org/project-embeddings/backfill', { method: 'POST', body: JSON.stringify({ mode: 'pending' }) });
                toast('프로젝트 백필 시작 — 진행 상황을 표시합니다.');
                pollProj(region);
            }
            catch (e) {
                toast(e.message, true);
                bfBtn.disabled = false;
            }
        });
        const jobLine = el('div', { class: 'admin-hint' });
        if (job) {
            if (job.running)
                jobLine.textContent = `백필 진행: ${fmtNum(job.done)}/${fmtNum(job.total)} …`;
            else if (job.reason) {
                // #688 실패 사유 배너 — reason 원문 + 원인별 처방(admin-warn 코랄 박스).
                jobLine.className = 'admin-warn';
                jobLine.replaceChildren(el('div', { text: `⚠ 직전 백필 미완료: ${job.reason}` }), el('div', { text: backfillReasonNotice(String(job.reason)) }));
            }
            else if (job.finishedAt)
                jobLine.textContent = `직전 백필 완료: ${fmtNum(job.embedded)}건 (${absTime(job.finishedAt)}).`;
        }
        region.replaceChildren(el('p', { class: 'admin-hint', text: `프로젝트 ${fmtNum(backlog.total)}건 중 임베딩 ${fmtNum(embedded)}건 · 미임베딩 ${fmtNum(backlog.pending)}건.` }), jobLine, el('div', { class: 'admin-actions' }, bfBtn, bfSt));
        stopProjPoll();
        if (running)
            pollProj(region);
    }
    function pollProj(region) {
        stopProjPoll();
        projPollTimer = setTimeout(async () => {
            if (!body.isConnected) {
                stopProjPoll();
                return;
            } // 다른 섹션으로 이동 → 폴링 종료(누수 방지)
            try {
                const st = await api('/api/ui/org/project-embeddings');
                renderProjectStatus(st, region);
            }
            catch (_) {
                pollProj(region);
            } // 일시 실패 → 재시도
        }, 1500);
    }
    async function loadProjectStatus(region) {
        try {
            const st = await api('/api/ui/org/project-embeddings');
            renderProjectStatus(st, region);
        }
        catch (e) {
            region.replaceChildren(el('p', { class: 'admin-hint', text: '프로젝트 임베딩 상태를 불러오지 못했습니다: ' + e.message }));
        }
    }
    load();
}
export { embeddingsEditor, };
