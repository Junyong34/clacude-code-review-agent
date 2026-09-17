import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import axios from 'axios';
import app from '../src/app.js';

// 각 환경변수를 독립된 프로세스에서 읽어 import 시점 설정과 모듈 캐시를 함께 검증한다.
const run = (code: string, overrides: Record<string, string> = {}): unknown => {
    const env = { ...process.env };
    for (const key of ['ENABLE_DAILY_PR_CRON', 'ENABLE_WEEKLY_BLOG_CRON', 'CLAUDE_MODEL',
        'JIRA_BASE_URL', 'DEPLOY_CHECKLIST_URL', 'CODE_REVIEW_CONTEXT_CLONE_PATH',
        'CODE_REVIEW_MASTER_WORKTREE_DIR', 'CODE_REVIEW_CRG_ONLY']) delete env[key];
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
        env: { ...env, ...overrides }, encoding: 'utf8',
    });
    return JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:'))!.slice(7));
};

test('public configuration has safe startup defaults and supports overrides', () => {
    const code = `const c = await import('./src/config/env.ts');
        console.log('RESULT:' + JSON.stringify([
            c.ENABLE_DAILY_PR_CRON, c.ENABLE_WEEKLY_BLOG_CRON, c.CLAUDE_MODEL,
            c.CODE_REVIEW_CONTEXT_CLONE_PATH ?? null, c.CODE_REVIEW_MASTER_WORKTREE_DIR]));`;
    assert.deepEqual(run(code), [false, false, 'claude-sonnet-5', null, '.worktrees/code-review-master']);
    assert.deepEqual(run(code, {
        ENABLE_DAILY_PR_CRON: 'true', ENABLE_WEEKLY_BLOG_CRON: 'true', CLAUDE_MODEL: 'test-model',
        CODE_REVIEW_CONTEXT_CLONE_PATH: '/tmp/example-app', CODE_REVIEW_MASTER_WORKTREE_DIR: '/tmp/review-master',
    }), [true, true, 'test-model', '/tmp/example-app', '/tmp/review-master']);
});

test('only explicitly enabled schedulers start; manual start remains available', () => {
    for (const daily of [false, true]) for (const weekly of [false, true]) {
        const result = run(`
            import cron from 'node-cron';
            const schedules = [];
            cron.schedule = (expression) => { schedules.push(expression); return { stop() {} }; };
            const { startConfiguredCrons } = await import('./src/cron/startup.ts');
            const { startCron, stopCron } = await import('./src/cron/dailyPr.ts');
            const { stopWeeklyBlogCron } = await import('./src/cron/weeklyBlog.ts');
            startConfiguredCrons();
            const automatic = [...schedules];
            stopCron(); stopWeeklyBlogCron();
            const manual = startCron(); stopCron();
            console.log('RESULT:' + JSON.stringify({ automatic, manual }));
        `, { ENABLE_DAILY_PR_CRON: String(daily), ENABLE_WEEKLY_BLOG_CRON: String(weekly), CRON_EXPRESSION: '0 9 * * 1-5' });
        assert.deepEqual(result, {
            automatic: [...(daily ? ['0 9 * * 1-5'] : []), ...(weekly ? ['0 6 * * 1'] : [])], manual: true,
        });
    }
});

test('Jira links are opt-in and preserve the title when absent', () => {
    const code = `const { formatPrTitle } = await import('./src/lib/prTitle.ts');
        console.log('RESULT:' + JSON.stringify(formatPrTitle('DEMO-123 변경')));`;
    assert.equal(run(code), 'DEMO-123 변경');
    assert.equal(run(code, { JIRA_BASE_URL: 'https://jira.example.com/browse/' }),
        '<https://jira.example.com/browse/DEMO-123|DEMO-123> 변경');
});

test('Daily PR checklist link is omitted when unset and included when configured', () => {
    const code = `import axios from 'axios';
        let payload;
        axios.post = async (_, body) => { payload = body; return { status: 200 }; };
        const { sendDailyPRNotification } = await import('./src/services/notifications/slack.ts');
        await sendDailyPRNotification([]);
        console.log('RESULT:' + JSON.stringify(payload.blocks[0].text.text));`;
    assert.doesNotMatch(String(run(code)), /배포 체크리스트:|https?:/);
    assert.match(String(run(code, { DEPLOY_CHECKLIST_URL: 'https://docs.example.com/deploy' })),
        /배포 체크리스트: https:\/\/docs\.example\.com\/deploy/);
});

test('app keeps health and management routes and removes legacy debug routes', () => {
    const paths = (app as unknown as { _router: { stack: { route?: { path: string } }[] } })
        ._router.stack.flatMap(layer => layer.route ? [layer.route.path] : []);
    assert.ok(paths.includes('/health-check'));
    assert.ok(paths.includes('/cron/start'));
    assert.ok(paths.includes('/confluence/create'));
    assert.ok(!paths.includes('/call'));
    assert.equal(paths.filter(path => /webhook/.test(path)).length, 0);
});

test('imports do not install a TLS verification bypass on shared axios', async () => {
    await import('../src/services/confluence/index.js');
    assert.equal(axios.defaults.httpsAgent?.options?.rejectUnauthorized === false, false);
});

test('CRG configuration reports the public clone variable when missing', () => {
    const result = run(`
        const { refreshMasterWorktreeGit } = await import('./src/services/contextClone/index.ts');
        try { await refreshMasterWorktreeGit(); }
        catch (error) { console.log('RESULT:' + JSON.stringify(error.message)); }
    `);
    assert.equal(result, 'CODE_REVIEW_CONTEXT_CLONE_PATH가 설정되지 않았습니다.');
});
