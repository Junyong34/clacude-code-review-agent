import cron from 'node-cron';
import { fetchOpenPRs, filterPRs } from '../services/bitbucket/index.js';
import { sendDailyPRNotification } from '../services/notifications/slack.js';

interface PRCheckResult {
    success: boolean;
    message: string;
    prCount: number;
}

let task: ReturnType<typeof cron.schedule> | null = null;
const CRON_EXPRESSION = process.env.CRON_EXPRESSION || '00 09 * * 1-5';
const TIMEZONE = 'Asia/Seoul';

// PR 체크 로직을 별도 함수로 분리 (cron과 API에서 공통 사용)
export const runPRCheck = async (): Promise<PRCheckResult> => {
    console.log('Running Daily PR Check...');
    try {
        const allPRs = await fetchOpenPRs();
        const filteredPRs = filterPRs(allPRs);
        await sendDailyPRNotification(filteredPRs);
        return { success: true, message: 'PR check completed successfully', prCount: filteredPRs.length };
    } catch (error) {
        console.error('Error in Daily PR Check:', error);
        throw error;
    }
};

export const startCron = (): boolean => {
    if (task) {
        console.log('Cron job is already running.');
        return false;
    }

    task = cron.schedule(CRON_EXPRESSION, async () => {
        await runPRCheck();
    }, {
        scheduled: true,
        timezone: TIMEZONE
    } as unknown as Parameters<typeof cron.schedule>[2]);

    console.log(`Cron job started with schedule: ${CRON_EXPRESSION} (${TIMEZONE}) [PID: ${process.pid}]`);
    return true;
};

export const stopCron = (): boolean => {
    if (!task) {
        console.log('Cron job is not running.');
        return false;
    }

    task.stop();
    task = null;
    console.log('Cron job stopped.');
    return true;
};

export const getStatus = (): { running: boolean; schedule: string; timezone: string } => {
    return {
        running: !!task,
        schedule: CRON_EXPRESSION,
        timezone: TIMEZONE
    };
};
