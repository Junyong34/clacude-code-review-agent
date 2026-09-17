export interface RuntimeEnv {
    SLACK_WEBHOOK_URL_PRD?: string;
    SLACK_WEBHOOK_URL_QA?: string;
    SLACK_TARGET_USERS?: string;
    BITBUCKET_API_URL?: string;
    BITBUCKET_AUTH_HEADER?: string;
    BITBUCKET_BOT_AUTH_HEADER?: string;
    BITBUCKET_BOT_SLUG?: string;
    ANTHROPIC_API_KEY?: string;
    CRON_EXPRESSION?: string;
    ATLASSIAN_SITE?: string;
    ATLASSIAN_EMAIL?: string;
    ATLASSIAN_API_TOKEN?: string;
    CONFLUENCE_SPACE_KEY?: string;
    MAX_W?: string;
    CLAUDE_MODEL?: string;
    CLAUDE_STREAM_CONCURRENCY?: string;
    CODE_REVIEW_CONTEXT_CLONE_PATH?: string;
    CODE_REVIEW_MASTER_WORKTREE_DIR?: string;
    CODE_REVIEW_CRG_ONLY?: string;
    JIRA_BASE_URL?: string;
    DEPLOY_CHECKLIST_URL?: string;
    ENABLE_DAILY_PR_CRON?: string;
    ENABLE_WEEKLY_BLOG_CRON?: string;
}
