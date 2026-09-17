// Slack 웹훅 URL
// prd 채널
export const slackWebhookUrlPrd = process.env.SLACK_WEBHOOK_URL_PRD;
// qa 채널
export const slackWebhookUrlQa = process.env.SLACK_WEBHOOK_URL_QA;

// Confluence API 설정
export const ATLASSIAN_SITE = process.env.ATLASSIAN_SITE;
export const ATLASSIAN_EMAIL = process.env.ATLASSIAN_EMAIL;
export const ATLASSIAN_API_TOKEN = process.env.ATLASSIAN_API_TOKEN;
export const CONFLUENCE_SPACE_KEY = process.env.CONFLUENCE_SPACE_KEY;
export const MAX_W = Number(process.env.MAX_W) || 45;

// Claude API
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// AI 코드리뷰 Claude 스트림 호출의 전역 동시 실행 상한.
// PR·청크 구분 없이 이 값만큼만 동시에 Claude를 호출한다. rate limit 관찰 시 이 값을 조정한다.
export const CLAUDE_STREAM_CONCURRENCY = Number(process.env.CLAUDE_STREAM_CONCURRENCY) || 4;

// 임시 CRG 전용 모드. true이면 Claude SDK를 호출하지 않고 CRG 참조 결과만 PR 코멘트로 남긴다.
export const CODE_REVIEW_CRG_ONLY = process.env.CODE_REVIEW_CRG_ONLY === 'true';

// Bitbucket Bot 계정 (코멘트 작성용)
export const BITBUCKET_BOT_AUTH_HEADER = process.env.BITBUCKET_BOT_AUTH_HEADER;
export const BITBUCKET_BOT_SLUG = process.env.BITBUCKET_BOT_SLUG;

// 심볼 참조 힌트 - 이미 준비된 example-app 로컬 clone 경로(컨텍스트 클론). 새로 clone하지 않고 그대로 가리킨다.
export const CODE_REVIEW_CONTEXT_CLONE_PATH = process.env.CODE_REVIEW_CONTEXT_CLONE_PATH;
// 마스터 워크트리(상시 유지, master 최신 상태 + code-review-graph)를 만들 위치. 이 서비스 기준 상대/절대 경로.
export const CODE_REVIEW_MASTER_WORKTREE_DIR = process.env.CODE_REVIEW_MASTER_WORKTREE_DIR || '.worktrees/code-review-master';

// 공개 배포 환경별 선택 설정
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
export const JIRA_BASE_URL = process.env.JIRA_BASE_URL?.replace(/\/+$/, '');
export const DEPLOY_CHECKLIST_URL = process.env.DEPLOY_CHECKLIST_URL;
export const ENABLE_DAILY_PR_CRON = process.env.ENABLE_DAILY_PR_CRON === 'true';
export const ENABLE_WEEKLY_BLOG_CRON = process.env.ENABLE_WEEKLY_BLOG_CRON === 'true';
