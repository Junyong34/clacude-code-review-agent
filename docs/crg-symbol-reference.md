# CRG 심볼 참조 힌트 구성

CRG는 변경 심볼을 참조하지만 이번 PR에서 수정되지 않은 파일을 찾아 Claude 입력과 최종 댓글에 힌트로 제공합니다. TypeScript 컴파일러 API로 인터페이스 변경 여부도 판정합니다. 힌트 계산 실패는 로그로 남기고 Claude 리뷰를 계속 시도합니다.

## 실행 조건

- Node.js 24 이상, 25 미만: `node:sqlite`로 그래프 DB를 읽습니다.
- Git과 이미 준비된 대상 저장소 clone: 원격 이름 `origin`, 브랜치 `master`가 필요합니다.
- 서버의 PATH에서 실행 가능한 `code-review-graph` CLI와 그 실행 환경: npm 의존성이 아니므로 별도 설치가 필요합니다.
- 대상 원격 저장소 fetch 권한, 컨텍스트 클론의 Git 메타데이터와 전용 워크트리 쓰기 권한이 필요합니다.

외부 CLI 설치는 [code-review-graph 저장소](https://github.com/tirth8205/code-review-graph)를 참고하세요. 설치 버전에 따라 인터페이스가 다를 수 있으므로 다음 계약을 실제로 지원하는지 확인해야 합니다. 본 프로젝트에서 호환 버전을 고정하지 않습니다.

```bash
code-review-graph --version
code-review-graph build --help
code-review-graph update --help
```

서버는 `build --repo <path> --quiet`, `update --repo <path> --quiet`를 실행합니다. MCP 서버는 사용하지 않습니다. `.code-review-graph/graph.db`의 `nodes`, `edges` 테이블을 읽고, 심볼 이름·파일·라인 범위와 CALLS/REFERENCES 관계를 사용합니다. 설치 버전의 CLI 옵션과 스키마가 이 계약과 일치해야 합니다.

## 설정과 생명주기

```dotenv
CODE_REVIEW_CONTEXT_CLONE_PATH=/path/to/example-app
CODE_REVIEW_MASTER_WORKTREE_DIR=.worktrees/code-review-master
CODE_REVIEW_CRG_ONLY=false
```

상대 경로는 서버 실행 디렉터리 기준입니다. 컨텍스트 클론은 새로 만들지 않습니다. 매 리뷰에서:

1. 컨텍스트 클론에서 `git fetch origin master`를 실행합니다. 기존 체크아웃과 미커밋 파일은 변경하지 않습니다.
2. 전용 워크트리가 없으면 `git worktree add --detach`로 생성하고, 있으면 `git reset --hard origin/master`로 최신화합니다.
3. DB가 없으면 `build`, 있으면 `update`로 그래프를 준비합니다.

**워크트리 경로는 봇 전용으로 지정하세요.** 이 위치의 추적 파일 수정은 reset으로 삭제됩니다. 개인 작업 폴더를 지정하면 안 됩니다. 워크트리는 PR별로 제거하지 않고 재사용합니다.

세 단계 갱신 전체는 프로세스 내부 동시성 1로 직렬화합니다. 이후 그래프·파일 조회는 이 잠금 밖입니다. 다른 리뷰 갱신과의 경합, 다중 프로세스 공유까지 막는 구조는 아닙니다. 조회 기준은 항상 master이며 PR 브랜치 소스 자체를 checkout하지 않습니다.

## 실패와 CRG 전용 모드

변수 미설정, Git 인증 오류, CLI 부재·옵션 불일치, DB/소스 조회 오류가 나면 힌트 없이 진행합니다. 최초 그래프 생성은 오래 걸릴 수 있습니다.

`CODE_REVIEW_CRG_ONLY=true`이면 Claude를 호출하지 않고 CRG 결과만 댓글로 게시합니다. Claude가 `budget_exceeded`로 실패한 경우에도 이미 계산한 결과를 게시합니다. 두 경우 모두 완료 시그니처가 없어 정상 모드·예산 복구 후 리뷰를 다시 요청할 수 있습니다.

현재 빈 결과 표현은 “참조 없음”과 “조회 실패”를 구분하지 못합니다. 로그를 함께 확인하세요. 참조 파일 힌트 자체도 호출부 수정 누락을 확정하는 검사는 아닙니다.

## Docker와 검증

기본 Dockerfile에는 CLI 설치나 clone/워크트리 volume 구성이 없습니다. 컨테이너에서 CRG를 사용하려면 호환 CLI를 설치한 이미지, fetch 인증, clone과 전용 워크트리의 지속 저장 공간, 위 환경변수를 준비해야 합니다. 호스트와 컨테이너 사이에서 Git worktree 메타데이터의 절대 경로가 유효한지도 확인하세요.

`test/contextClone.test.ts`는 임시 Git 저장소에서 갱신과 원본 clone 보존을 검증합니다. CLI가 없으면 해당 통합 테스트 일부를 건너뜁니다. `test/symbolReference.test.ts`, `test/interfaceChange.test.ts`는 참조·시그니처 판정을 검증합니다.

[파이프라인](ai-code-review-pr-flow.md) · [설계 결정](adr/0003-local-clone-worktree-for-review-context.md)
