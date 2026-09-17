import os, { type NetworkInterfaceInfo } from 'os';
import app from './app.js';
import { startConfiguredCrons } from './cron/startup.js';
import { serverDownMsg } from './services/notifications/serverNotification.js';

const port = 8088;

const getLocalIP = (): string => {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces) as NetworkInterfaceInfo[][]) {
        for (const info of iface) {
            if (info.family === 'IPv4' && !info.internal) {
                return info.address;
            }
        }
    }
    return 'localhost';
};

// 서버 시작
const server = app.listen(port, async () => {
    // Start Cron Jobs automatically
    startConfiguredCrons();

    const localIP = getLocalIP();
    console.log('');
    console.log('┌─────────────────────────────────────────┐');
    console.log('│        🟢 PR 알람 서버 실행 완료 ✅       │');
    console.log('├─────────────────────────────────────────┤');
    console.log(`│  Local  : http://localhost:${port}         │`);
    console.log(`│  Network: http://${localIP}:${port}  │`);
    console.log(`│  PORT   : ${port}                           │`);
    console.log('└─────────────────────────────────────────┘');
    console.log('');

    const message = '🟢 PR 알람 서버 실행 완료 ✅';
    console.log('⭐️ message =>', message);
});

//서버 다이
process.on('SIGTERM', async () => {
    console.log('⭐️ 이벤트 종료!!! =>');
    try {
        await serverDownMsg();
        console.log('Slack 알림이 전송되었습니다.');
        process.exit(0); // 정상적으로 프로세스 종료
    } catch (error) {
        console.error('Slack 알림 전송 중 오류가 발생했습니다.', error);
        process.exit(1); // 오류로 인한 프로세스 종료
    }

});
process.on('SIGHUP', async () => {
    console.log('⭐️ SIGHUP 종료!!! =>');
    try {
        await serverDownMsg();
        console.log('Slack 알림이 전송되었습니다.');
        process.exit(0); // 정상적으로 프로세스 종료
    } catch (error) {
        console.error('Slack 알림 전송 중 오류가 발생했습니다.', error);
        process.exit(1); // 오류로 인한 프로세스 종료
    }

});
process.on('uncaughtException', async (err) => {
    console.error('⭐️ uncaughtException 발생!!! =>', err.message);
    console.error('Stack Trace:', err.stack);
    try {
        await serverDownMsg();
        console.log('Slack 알림이 전송되었습니다.');
        process.exit(1); // uncaughtException은 비정상 종료이므로 exit(1)
    } catch (error) {
        console.error('Slack 알림 전송 중 오류가 발생했습니다.', error);
        process.exit(1); // 오류로 인한 프로세스 종료
    }

});
process.on('exit', async () => {
    console.log('⭐️ exit 종료!!! =>');
    try {
        await serverDownMsg();
        console.log('Slack 알림이 전송되었습니다.');
        process.exit(0); // 정상적으로 프로세스 종료
    } catch (error) {
        console.error('Slack 알림 전송 중 오류가 발생했습니다.', error);
        process.exit(1); // 오류로 인한 프로세스 종료
    }

});
(process as NodeJS.Process & { on(event: 'close', listener: () => void): NodeJS.Process }).on('close', async () => {
    console.log('⭐️ close 종료!!! =>');
    try {
        await serverDownMsg();
        console.log('Slack 알림이 전송되었습니다.');
        process.exit(0); // 정상적으로 프로세스 종료
    } catch (error) {
        console.error('Slack 알림 전송 중 오류가 발생했습니다.', error);
        process.exit(1); // 오류로 인한 프로세스 종료
    }

});
//서버 다이
process.on('SIGINT', async () => {
    console.log('⭐️  =>', 'SIGINT');
    try {
        await serverDownMsg();
        console.log('Slack 알림이 전송되었습니다.');
        process.exit(0);
    } catch (error) {
        console.error('Slack 알림 전송 중 오류가 발생했습니다.', error);
        process.exit(1);
    }
});

export { server };
