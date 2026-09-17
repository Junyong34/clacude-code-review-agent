# 코드리뷰 파이프라인 개발 가이드

## 진입점과 책임

`src/app.ts`가 라우터를 등록하고 `src/server.ts`가 listen과 선택적 cron 시작을 담당합니다. 앱 import만으로 서버나 cron을 시작하지 않습니다.

- `open.ts`, `modified.ts`: PR 알림과 자동 리뷰 조건 평가
- `comment.ts`, `reviewers.ts`: top-level 멘션 기반 수동 재리뷰
- `prReview.ts`: 공통 컨텍스트, PR 단위 잠금, 전체 파이프라인과 실패 대응
- `codeReview.ts`: 설명 템플릿 필터링, diff 마스킹, Claude 호출·응답 파싱
- `diffFormatter.ts`, `reviewOutput.ts`: 청크 생성과 결과 병합·출력

## 처리 순서

1. `extractPrContext()`로 PR 정보 추출. 자동 리뷰는 `shouldRunAutoReview()`로 master/non-draft 조건 확인.
2. `runCodeReview()`에서 PR별 `reviewInProgress` Set 잠금. 자동 리뷰는 활동 API에서 봇 완료 시그니처를 재확인.
3. Bitbucket diff 조회. 파일·hunk 등 nested truncate가 있으면 일반 댓글을 남기고 중단.
4. 자동·수동 모두 CRG 워크트리 최신화, 미갱신 참조 파일 조회, 인터페이스 변경 판정을 시도. 실패하면 힌트 없이 진행.
5. CRG 전용 모드이면 Claude 없이 결과 게시 후 종료.
6. diff를 파일·라인 경계를 보존하는 약 40,000자 청크로 분할. 소스 파일 우선, lockfile 등은 후순위. 입력 길이 때문에 라인을 생략하지 않으며 긴 한 라인은 예산을 넘을 수 있음.
7. PR 설명에서 미작성 기본 템플릿 섹션 제거. 각 청크의 이메일·전화번호·주민번호·인증 토큰 패턴을 마스킹.
8. 청크별 `messages.stream()` / `finalMessage()` 호출. PR 내 청크는 순차 실행, 모든 PR은 전역 동시성 상한(기본 4)을 공유. 출력 예산 8,192 토큰, 프롬프트 캐싱 적용.
9. JSON 파싱과 출력 잘림 확인. 파싱 실패는 인라인 의견 없는 안내 요약으로 대체. 호출 실패는 전체 중단하되 `budget_exceeded`는 CRG 전용 댓글로 fallback.
10. 모든 청크 처리 후 요약과 댓글 병합. 다중 청크 요약 중복 제거, 댓글은 파일·라인·라인 유형 기준 중복 제거.
11. 수동 재리뷰에서는 로컬 위치 검증. 기존 봇 인라인 댓글 위치와도 비교해 새 댓글 게시.
12. 최종 요약·CRG 힌트 댓글 게시. 자동 리뷰와 `/pr/comment` 재리뷰는 Slack 요약 전송, `/pr/reviewers` 재리뷰는 생략. 종료 시 잠금 해제.

인라인 REMOVED 댓글은 Bitbucket `fileType: FROM`, 나머지는 `TO`로 보냅니다. 봇 댓글 조회는 `/comments`가 아닌 `/activities?limit=100` 기반입니다.

## 용어

| 용어 | 의미 |
|---|---|
| 청크 | 문자 예산과 파일·라인 경계로 나눈 diff 입력 하나. Anthropic Batch API와 구분 |
| 스트림 호출 | 청크 하나를 Claude로 보내는 요청 |
| 컨텍스트 클론 | 운영자가 이미 준비한 대상 저장소 clone. 서버는 새로 clone하지 않고 fetch만 수행 |
| 마스터 워크트리 | CRG 조회를 위해 origin/master로 최신화하는 별도 작업 공간 |
| 미갱신 참조 파일 | 변경 심볼을 참조하지만 이번 PR diff에 없는 파일. 결함 확정이 아닌 호출부 확인 힌트 |
| 로컬 검증 | 댓글의 file:line:lineType이 diff ADD/REM에 존재하는지 코드로 검사 |

## 경계와 제한

자동 리뷰는 CRG만 활성화하고, 수동 재리뷰는 CRG와 로컬 검증을 활성화합니다. 현재 동작을 변경할 때는 두 진입점을 각각 검증하세요.

완료 시그니처는 자동 `🤖 AI Code Review`, 수동 `🤖 AI Re-Review`입니다. 실패·CRG 전용 댓글에는 완료 시그니처를 넣지 않습니다. 수동 재리뷰에는 과거 실행 횟수 제한이 없습니다.

CRG 워크트리 갱신 잠금과 PR 실행 잠금은 프로세스 내부에만 존재합니다. CRG 조회 자체는 갱신 잠금 밖이므로 다른 리뷰의 갱신과 겹칠 수 있습니다. 여러 인스턴스에서 같은 워크트리를 공유하는 구성은 보장하지 않습니다.

모델의 기술 스택·구조 판단은 제공된 diff와 설명을 기반으로 합니다. 특정 대상 프로젝트 규칙을 시스템 프롬프트에 일반 규칙처럼 추가하지 마세요.

[CRG 상세](crg-symbol-reference.md) · [운영 가이드](ai-code-review-agent-guide.md) · [Streaming 설계 기록](adr/0002-streaming-over-batch-for-code-review.md)
