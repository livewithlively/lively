# 서술 재작성 배치의 LLM 요청에 답하는 절차

이 문서는 헤드리스 Claude Code 세션에 주는 지시문이다. 이 세션은 `style-rewrite-batch.mjs --llm-dir <dir>` 가 파일로 내놓는 LLM 요청을 서브에이전트로 풀어 답을 파일로 돌려준다. 세션 안의 Bash 에서는 `claude -p` 를 다시 부를 수 없어서 이렇게 한다. 디렉터리 구조는 `scripts/style-rewrite-llm-dir.mjs` 머리 주석이 기준이다.

## 시작

1. 배치를 Bash 백그라운드로 띄운다. 예: `node scripts/style-rewrite-batch.mjs --llm-dir <dir> --report <out.jsonl> --names <names.txt> --max-minutes 50 --resume`
2. `<dir>/batch.pid` 가 생기면 아래 루프를 시작한다.

## 루프

아래를 약 2초 간격으로 되풀이한다.

1. `<dir>/pending/*.json` 을 나열한다. 점(`.`)으로 시작하는 파일은 쓰는 중인 임시 파일이므로 건너뛴다.
2. 각 요청 `<id>.json` 에 대해 다음을 확인한다.
   - `<dir>/done/<id>.txt` 나 `<dir>/done/<id>.error` 가 이미 있으면 다시 처리하지 않는다.
   - 지금 떠 있는 서브에이전트가 4개면 새로 띄우지 않고 다음 바퀴를 기다린다.
3. 처리할 요청은 먼저 `mv <dir>/pending/<id>.json <dir>/claimed/<id>.json` 으로 집는다. mv 가 실패하면 다른 쪽이 이미 집은 것이므로 건너뛴다.
4. 요청마다 새 서브에이전트를 하나씩 띄운다(Agent 도구, `model` 은 요청 JSON 의 `model` 값). 서브에이전트에게는 아래 지시와 claimed 파일 경로만 준다. 다른 요청, 원문 지식, 앞선 답은 주지 않는다. 판정 요청은 원문과 재작성본을 따로 본 판정자여야 독립성이 지켜지기 때문이다.

   > `<dir>/claimed/<id>.json` 을 읽어라. 그 안의 `prompt` 가 너에게 주는 과제 전부다. prompt 가 요구한 출력만, 앞뒤 설명 없이 `<dir>/done/.<id>.tmp` 에 쓴 뒤 `mv <dir>/done/.<id>.tmp <dir>/done/<id>.txt` 로 옮겨라. 과제를 수행할 수 없으면 이유 한 줄을 같은 방식으로 `<dir>/done/<id>.error` 에 남겨라. 다른 파일은 읽거나 쓰지 마라.

5. 서브에이전트는 백그라운드로 띄워 동시에 최대 4개까지 돌린다. 끝난 서브에이전트의 보고 내용은 루프에 필요 없다. 답은 done 파일로만 주고받는다.

## 끝내기

`<dir>/finished` 가 생기거나 `batch.pid` 의 프로세스가 더 이상 없으면(`kill -0 <pid>` 실패) 새 요청을 집지 않는다. 떠 있는 서브에이전트가 모두 끝나면 루프를 끝내고 배치 로그 마지막 줄(처리 건수, 시간 한도로 멈췄는지)을 보고한다.

답은 배치가 요청 하나당 기다리는 제한 시간(10분) 안에 와야 한다. 늦게 온 답은 버려지고 그 문서는 `llm_timeout` 실패로 남아 다음 `--resume` 때 다시 처리된다.
