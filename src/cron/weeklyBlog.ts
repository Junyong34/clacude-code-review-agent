import cron from 'node-cron';
import { createWeeklyBlogPost } from '../services/confluence/index.js';

let task: ReturnType<typeof cron.schedule> | null = null;
const CRON_EXPRESSION = '0 6 * * 1'; // 매주 월요일 06:00 KST
const TIMEZONE = 'Asia/Seoul';

// 블로그 포스트 생성 로직을 별도 함수로 분리 (cron과 API에서 공통 사용)
export const runWeeklyBlogPost = async (): Promise<unknown> => {
    console.log('Running Weekly Blog Post Creation...');
    try {
        const result = await createWeeklyBlogPost();
        return result;
    } catch (error) {
        console.error('Error in Weekly Blog Post Creation:', error);
        throw error;
    }
};

export const startWeeklyBlogCron = (): boolean => {
    if (task) {
        console.log('Weekly blog cron job is already running.');
        return false;
    }

    task = cron.schedule(CRON_EXPRESSION, async () => {
        await runWeeklyBlogPost();
    }, {
        scheduled: true,
        timezone: TIMEZONE
    } as unknown as Parameters<typeof cron.schedule>[2]);

    console.log(`Weekly blog cron job started with schedule: ${CRON_EXPRESSION} (${TIMEZONE}) [PID: ${process.pid}]`);
    return true;
};

export const stopWeeklyBlogCron = (): boolean => {
    if (!task) {
        console.log('Weekly blog cron job is not running.');
        return false;
    }

    task.stop();
    task = null;
    console.log('Weekly blog cron job stopped.');
    return true;
};

export const getWeeklyBlogStatus = (): { running: boolean; schedule: string; timezone: string } => {
    return {
        running: !!task,
        schedule: CRON_EXPRESSION,
        timezone: TIMEZONE
    };
};
