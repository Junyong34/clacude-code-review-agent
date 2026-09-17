# 코드리뷰 봇 운영 가이드

설치와 환경변수는 [README](../README.md)를 참고하세요. 이 문서는 PR 작성자와 운영자를 위한 동작 안내입니다.

## 자동 리뷰와 수동 재리뷰

자동 리뷰는 open/modified 이벤트에서 `master` 대상 non-draft PR에 실행합니다. 봇의 `🤖 AI Code Review` 완료 댓글이 있으면 건너뜁니다. 리뷰어가 없거나 제목에 WIP가 있어 PR Slack 알림을 생략해도 자동 리뷰 조건은 별도로 평가합니다.

수동 재리뷰는 PR 일반 댓글에 봇 멘션과 `재리뷰`를 함께 작성합니다. `@review-bot 재리뷰`, `[~review-bot] 재리뷰`에서 slug를 설정한 봇 이름으로 바꾸세요. 브랜치·횟수 제한은 없으며 인라인 댓글, anchor 댓글, 봇 자신의 댓글은 제외합니다. 같은 PR에서 리뷰가 진행 중이면 추가 요청을 건너뜁니다.

두 댓글 경로(`/pr/comment`, `/pr/reviewers`) 모두 재리뷰를 처리합니다. 동시에 연결하면 활동 조회가 중복될 수 있습니다. 같은 프로세스의 Claude 중복 실행은 PR별 잠금으로 방지합니다.

## 리뷰 결과

- 인라인 댓글과 최종 요약 댓글을 작성합니다. 기존 봇 인라인 댓글과 같은 위치의 중복 게시를 줄입니다.
- 수동 재리뷰는 게시 전 댓글의 파일·라인·ADDED/REMOVED 위치를 diff와 대조하고 유효하지 않은 댓글을 제외합니다. 이 검증은 Claude 재호출 없이 수행합니다.
- 자동·수동 모두 CRG 힌트를 시도합니다. CRG 설정이 없거나 조회가 실패해도 Claude 리뷰는 계속 시도합니다. Claude 자체 성공까지 보장하는 것은 아닙니다.
- 자동 리뷰와 `/pr/comment`의 수동 재리뷰는 QA Slack으로 리뷰 요약을 보냅니다. `/pr/reviewers`의 수동 재리뷰는 Slack 요약을 보내지 않습니다.

## 실패 대응

| 상황 | 동작 / 대응 |
|---|---|
| Bitbucket diff 잘림 | 리뷰를 건너뛰고 일반 댓글로 안내. PR 분할 또는 Bitbucket 설정 확인 |
| 청크 호출 실패 | 전체 리뷰 중단. 모든 청크 처리가 끝나기 전 인라인 댓글은 게시하지 않음 |
| JSON 파싱 실패·출력 잘림 | 해당 청크는 인라인 의견 없이 안내 요약으로 대체. 잘림을 감지하면 최종 댓글에 안내 추가 |
| `budget_exceeded` | 이미 계산한 CRG 결과만 게시. 완료 시그니처가 없으므로 예산 복구 후 다시 요청 가능 |
| CRG 준비·조회 실패 | 로그를 남기고 힌트 없이 진행. [CRG 가이드](crg-symbol-reference.md) 확인 |
| 프록시 개인정보 guardrail 차단 | 전송 내용과 정책 확인. diff 마스킹이 PR 설명 등 모든 입력을 포괄하지는 않음 |
| TLS 인증서 오류 | 신뢰할 CA를 `NODE_EXTRA_CA_CERTS`로 지정. 프로세스 재시작 |
| 429 등 호출 제한 | 전역 `CLAUDE_STREAM_CONCURRENCY`를 줄이고 공급자 한도 확인 |

`CODE_REVIEW_CRG_ONLY=true`는 Claude 호출 없이 CRG 결과만 게시하는 진단 모드입니다. 이 모드와 예산 초과 fallback은 완료 시그니처를 남기지 않습니다. CRG 실패와 실제 참조 파일 없음이 모두 빈 결과로 표현될 수 있으므로, “참조 파일 없음” 문구만으로 CRG가 성공했다고 판단하지 마세요.

진단 로그의 `[DEBUG-ANTHROPIC]` 항목에서 네트워크·TLS·오류 원인을 확인할 수 있습니다. 원본 오류 내용에 민감한 입력이 포함될 수 있으므로 공개 이슈에는 필요한 부분만 비식별화해 첨부하세요.

## 부가 기능과 알림

Daily PR은 draft/WIP를 제외한 `master` 대상 open PR을 PRD Slack에 안내합니다. 기본 예약은 평일 09:00 KST이며 `ENABLE_DAILY_PR_CRON=true`일 때 서버 시작 시 예약합니다.

주간 블로그는 `ENABLE_WEEKLY_BLOG_CRON=true`일 때 월요일 06:00 KST에 예약합니다. 3월 시작 회계연도 기준 제목을 사용하며 같은 제목이 존재하면 생성하지 않습니다. 결과는 QA Slack에 알립니다.

| 상황 | Slack 채널 |
|---|---|
| Draft open | QA |
| master 대상 open/modified/merged | PRD |
| release/release 대상 open/modified/merged | 생략 |
| 그 외 일반 PR 이벤트, approved, 리뷰 시작 | QA |
| 자동 리뷰 요약, 서버 종료·예외, 주간 블로그 결과 | QA |
| Daily PR | PRD |

수동 관리 API는 자동 시작 플래그와 독립적입니다. 공개 네트워크에 인증 없이 노출하지 마세요. 서버 종료 시 QA Slack 전송을 시도하지만 강제 종료나 `exit` 이벤트의 비동기 전송 완료는 보장하지 않습니다.
