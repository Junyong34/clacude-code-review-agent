import { JIRA_BASE_URL } from '../config/env.js';

export const formatPrTitle = (title: string): string => JIRA_BASE_URL
    ? title.replace(/(\b[A-Z][A-Z0-9_]+-[1-9][0-9]*)/g, (_, key: string) => `<${JIRA_BASE_URL}/${key}|${key}>`)
    : title;
