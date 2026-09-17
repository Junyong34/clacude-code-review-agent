import { ENABLE_DAILY_PR_CRON, ENABLE_WEEKLY_BLOG_CRON } from '../config/env.js';
import { startCron } from './dailyPr.js';
import { startWeeklyBlogCron } from './weeklyBlog.js';

export const startConfiguredCrons = (): void => {
    if (ENABLE_DAILY_PR_CRON) startCron();
    if (ENABLE_WEEKLY_BLOG_CRON) startWeeklyBlogCron();
};
