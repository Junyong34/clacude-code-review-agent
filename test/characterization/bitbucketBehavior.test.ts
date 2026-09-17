import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { createOpenPr } from '../helpers/fixtures.js';

process.env.BITBUCKET_API_URL = 'https://bitbucket.example.test/rest/api/1.0/projects/DEMO/repos/example-app/pull-requests?state=OPEN';

const bitbucket = await import('../../src/services/bitbucket/index.js');

test('filterPRs keeps non-draft non-WIP master PRs only', () => {
    const included = createOpenPr({ id: 1 });
    const draft = createOpenPr({ id: 2, draft: true });
    const wip = createOpenPr({ id: 3, title: 'WIP DEMO-1234 작업중' });
    const qa = createOpenPr({ id: 4, toRef: { displayId: 'release/release' } });

    assert.deepEqual(bitbucket.filterPRs([included, draft, wip, qa]).map((pr) => pr.id), [1]);
});

test('checkBotCommentExists reads top-level review signatures from activities', async () => {
    const originalGet = axios.get;
    const calledUrls: string[] = [];

    axios.get = (async (url) => {
        calledUrls.push(String(url));
        return {
            data: {
                values: [
                    { action: 'APPROVED' },
                    { action: 'COMMENTED', comment: { text: '일반 코멘트' } },
                    { action: 'COMMENTED', comment: { text: '🤖 AI Code Review\n\n완료' } },
                ],
            },
        };
    }) as typeof axios.get;

    try {
        assert.equal(await bitbucket.checkBotCommentExists(123), true);
        assert.equal(
            calledUrls[0],
            'https://bitbucket.example.test/rest/api/1.0/projects/DEMO/repos/example-app/pull-requests/123/activities?limit=100',
        );
    } finally {
        axios.get = originalGet;
    }
});

test('checkBotCommentExists ignores non-comment activities and missing text', async () => {
    const originalGet = axios.get;

    axios.get = (async () => ({
        data: {
            values: [
                { action: 'OPENED' },
                { action: 'COMMENTED', comment: {} },
                { action: 'COMMENTED', comment: { text: '다른 코멘트' } },
            ],
        },
    })) as typeof axios.get;

    try {
        assert.equal(await bitbucket.checkBotCommentExists(456), false);
    } finally {
        axios.get = originalGet;
    }
});
