import test from 'node:test';
import assert from 'node:assert/strict';

import { getStatus, startCron, stopCron } from '../../src/cron/dailyPr.js';
import {
    getWeeklyBlogStatus,
    startWeeklyBlogCron,
    stopWeeklyBlogCron,
} from '../../src/cron/weeklyBlog.js';

test('daily PR scheduler preserves status shape across start and stop', () => {
    stopCron();

    assert.deepEqual(getStatus(), {
        running: false,
        schedule: process.env.CRON_EXPRESSION || '00 09 * * 1-5',
        timezone: 'Asia/Seoul',
    });

    assert.equal(startCron(), true);
    assert.deepEqual(getStatus(), {
        running: true,
        schedule: process.env.CRON_EXPRESSION || '00 09 * * 1-5',
        timezone: 'Asia/Seoul',
    });
    assert.equal(startCron(), false);
    assert.equal(stopCron(), true);
    assert.equal(stopCron(), false);
});

test('weekly blog scheduler preserves status shape across start and stop', () => {
    stopWeeklyBlogCron();

    assert.deepEqual(getWeeklyBlogStatus(), {
        running: false,
        schedule: '0 6 * * 1',
        timezone: 'Asia/Seoul',
    });

    assert.equal(startWeeklyBlogCron(), true);
    assert.deepEqual(getWeeklyBlogStatus(), {
        running: true,
        schedule: '0 6 * * 1',
        timezone: 'Asia/Seoul',
    });
    assert.equal(startWeeklyBlogCron(), false);
    assert.equal(stopWeeklyBlogCron(), true);
    assert.equal(stopWeeklyBlogCron(), false);
});
