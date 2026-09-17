import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.ATLASSIAN_SITE = 'https://confluence.example.com';
process.env.ATLASSIAN_EMAIL = 'bot@example.test';
process.env.ATLASSIAN_API_TOKEN = 'test-token';
process.env.CONFLUENCE_SPACE_KEY = 'DEPLOY';

const { createWeeklyBlogPost } = await import('../../src/services/confluence/index.js');

test('createWeeklyBlogPost returns existing post without creating a duplicate', async () => {
    const originalGet = axios.get;
    const originalPost = axios.post;
    const calls: string[] = [];

    axios.get = (async (url) => {
        calls.push(String(url));
        return {
            data: {
                results: [{ id: 'existing-blog-id' }],
            },
        };
    }) as typeof axios.get;
    axios.post = (async () => {
        throw new Error('create should not be called for existing blog posts');
    }) as typeof axios.post;

    try {
        const result = await createWeeklyBlogPost();

        assert.equal(result.success, true);
        assert.equal(result.message, 'Blog post already exists');
        assert.equal(result.id, 'existing-blog-id');
        assert.match(result.title, /^FY\d{4} W\d+ 이슈 및 현안$/);
        assert.match(calls[0], /\/wiki\/rest\/api\/content\?/);
        assert.match(calls[0], /spaceKey=DEPLOY/);
        assert.match(calls[0], /type=blogpost/);
    } finally {
        axios.get = originalGet;
        axios.post = originalPost;
    }
});
