---
status: accepted
---

> 이 문서는 결정 당시의 배경 기록입니다. 현재 실행 방법과 수치는 [README](../../README.md) 및 [개발 가이드](../ai-code-review-pr-flow.md)를 기준으로 합니다.

# example-app 로컬 clone + 상시 마스터 워크트리로 리뷰 컨텍스트 확보

PR diff만으로는 변경된 심볼이 다른 파일에서 어떻게 참조되는지 알 수 없다. Bitbucket REST API의 `browse`/`raw` 엔드포인트로 파일 단위 조회는 가능하지만, 프로젝트 전체 참조 그래프를 쓰려면 실제 소스가 로컬 디스크에 있어야 한다.

대상 저장소의 기존 로컬 clone을 컨텍스트 클론으로 지정하고, 별도 워크트리에 그래프를 생성·갱신하기로 했다. 서버는 새 clone을 만들지 않는다.

컨텍스트 클론은 운영자의 일상적인 작업 디렉토리(당시 feature 브랜치 체크아웃 + 미커밋 변경 있음)이므로 **절대 건드리지 않는다** — `git fetch`만 실행해 `origin/master`를 갱신한다. 이 서비스 자신의 `.worktrees/` 아래에 **마스터 워크트리**를 하나 상시 유지하고, 재리뷰마다 `origin/master`로 강제 동기화(`reset --hard`, 봇 전용 경로의 추적 파일 변경을 폐기)한 뒤 그 안의 `.code-review-graph/graph.db`도 함께 최신화(`build`/`update`)한다. 애초 "PR 재리뷰마다 워크트리를 만들고 지운다"는 설계였으나, 그래프 재빌드 비용이 커서 상시 유지 + 매번 최신화 방식으로 바꿨다. 여러 재리뷰가 동시에 들어와도 이 갱신 사이클(fetch → reset → graph 최신화) 전체가 mutex로 직렬화된다.

미갱신 참조 파일(diff에서 변경된 함수를 참조하지만 diff에 없는 파일) 계산은 `code-review-graph`의 SQLite 그래프(`nodes`/`edges`)를 Node 22 내장 `node:sqlite`로 직접 쿼리한다(CLI shell-out이나 ts-morph 없이, 새 npm 의존성 없이). 참조 조회 기준은 항상 master(base)이며, PR 브랜치(fromRef) 자체의 변경은 diff로만 파악한다.

결정 당시에는 로컬 프로토타입 단계로, 클론/워크트리는 로컬 디스크에 그대로 유지한다(Docker/production 배포 시 persistent volume 등 재검토 필요).

## Consequences

- 이 서비스는 처음으로 Bitbucket REST API 호출 외에 git-level 접근과 `code-review-graph` CLI(Python) 의존이 생긴다.
- 마스터 워크트리와 그 안의 그래프는 서버 프로세스 수명 동안 공유 자원으로 상시 유지된다 — PR별로 격리되지 않는다(대신 재리뷰 시점마다 최신 master로 갱신).
- 참조 조회 기준은 항상 master(base)이며, PR 브랜치 기준 참조 조회는 범위 밖이다. 완전히 새로 추가된 함수/컴포넌트는 master 그래프에 없으므로 참조 대상에서 자연히 빠진다.
