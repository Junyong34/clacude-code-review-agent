import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BitbucketDiffData, BitbucketDiffLine } from '../../types/bitbucket.js';
import { asArray, getFilePath } from './diffFormatter.js';
import type { InterfaceChange } from './interfaceChange.js';

/**
 * "미갱신 참조 파일" 힌트: diff에서 변경된 함수/컴포넌트를 마스터 워크트리의 code-review-graph
 * (.code-review-graph/graph.db)에서 조회해, 그 심볼을 참조하지만 이번 PR의 변경 파일 목록에는
 * 없는 파일을 찾는다. 참조 카운트가 아니라 "호출부 정리가 이 PR에 빠졌을 가능성"이라는 확인된
 * 사실을 전달하는 게 목적이다.
 */

export interface LineRange {
    start: number;
    end: number;
}

/**
 * REMOVED/CONTEXT 라인의 source(base 라인 번호)만 사용한다. ADDED 라인은 base에 존재하지 않으므로
 * (source=null) 쓰지 않는다.
 */
const getBaseLineNumber = (line: BitbucketDiffLine | undefined): number | undefined => {
    const value = line?.source;
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
};

/**
 * diff의 hunk마다 "이번 diff가 건드린 base 라인 범위"를 만든다.
 * REMOVED 라인은 그대로 쓰고, ADDED segment는 바로 앞뒤 CONTEXT 라인 하나씩으로 base의 삽입 위치를 앵커링한다.
 * CONTEXT 전체를 범위에 넣으면 context가 넓을수록 변경되지 않은 인접 함수까지 변경 심볼로 잡히므로 쓰지 않는다.
 * base 라인 앵커가 없는 hunk(CONTEXT 없는 순수 삽입)는 건너뛴다.
 */
export const collectChangedBaseLineRanges = (diffData: BitbucketDiffData | null | undefined): Map<string, LineRange[]> => {
    const result = new Map<string, LineRange[]>();

    for (const fileDiff of asArray(diffData?.diffs)) {
        const filePath = getFilePath(fileDiff);
        const ranges: LineRange[] = [];

        for (const hunk of asArray(fileDiff?.hunks)) {
            const baseLineNumbers: number[] = [];
            const segments = asArray(hunk?.segments);
            const pushBaseLine = (line: BitbucketDiffLine | undefined): void => {
                const lineNumber = getBaseLineNumber(line);
                if (lineNumber !== undefined) baseLineNumbers.push(lineNumber);
            };

            segments.forEach((segment, index) => {
                if (segment?.type === 'REMOVED') {
                    asArray(segment.lines).forEach(pushBaseLine);
                    return;
                }
                if (segment?.type !== 'ADDED') return;

                const previous = segments[index - 1];
                const next = segments[index + 1];
                if (previous?.type === 'CONTEXT') pushBaseLine(asArray(previous.lines).at(-1));
                if (next?.type === 'CONTEXT') pushBaseLine(asArray(next.lines)[0]);
            });

            if (baseLineNumbers.length === 0) continue;
            ranges.push({ start: Math.min(...baseLineNumbers), end: Math.max(...baseLineNumbers) });
        }

        if (ranges.length > 0) result.set(filePath, ranges);
    }

    return result;
};

export interface CallerSnippet {
    startLine: number;
    endLine: number;
    text: string;
}

/** 변경 심볼을 참조하는 쪽의 함수. 위치는 master 워크트리 기준이다. */
export interface ReferenceCaller {
    file: string;
    name: string;
    lineStart: number;
    lineEnd: number;
    snippet?: CallerSnippet;
}

export interface UnupdatedReferenceFile {
    symbol: string;
    definitionFile: string;
    definitionLineStart?: number;
    definitionLineEnd?: number;
    referencingFiles: string[];
    callers?: ReferenceCaller[];
    interfaceChange?: InterfaceChange;
}

type FunctionNodeRow = { qualified_name: string; name: string; line_start: number; line_end: number };
type ReferenceRow = { file_path: string; caller_name: string | null; line_start: number | null; line_end: number | null };

// 단순 참조 카운트가 아니라 "누가 이 심볼을 쓰는가"를 보는 것이므로 CALLS(호출)와 REFERENCES(그 외 참조)만 본다.
// CONTAINS(소속 관계)/IMPORTS_FROM(파일 단위 import)/HANDLES/INJECTS/INHERITS/TESTED_BY는 다른 목적의 엣지라 제외한다.
const REFERENCE_EDGE_KINDS = ['CALLS', 'REFERENCES'] as const;

// 호출부 스니펫으로 쓸 수 있는 참조 쪽 노드. File/Class는 범위가 너무 넓어 호출 위치를 특정하지 못하므로 제외한다.
const CALLER_NODE_KINDS = ['Function', 'Test'] as const;

const REFERENCE_EDGE_PLACEHOLDERS = REFERENCE_EDGE_KINDS.map(() => '?').join(',');
const CALLER_NODE_PLACEHOLDERS = CALLER_NODE_KINDS.map(() => '?').join(',');

type ReferenceQuery = { all: (targetQualifiedName: string) => ReferenceRow[] };

/**
 * 참조 파일과 참조 쪽 함수(호출부)를 함께 조회하는 쿼리를 준비한다.
 * 설치된 CRG 스키마가 조인에 필요한 컬럼을 제공하지 않으면 기존처럼 참조 파일만 조회하는 쿼리로 물러난다.
 */
const prepareReferenceQuery = (db: DatabaseSync): ReferenceQuery => {
    try {
        const stmt = db.prepare(
            `SELECT DISTINCT e.file_path AS file_path, n.name AS caller_name, n.line_start AS line_start, n.line_end AS line_end
             FROM edges e
             LEFT JOIN nodes n ON n.qualified_name = e.source_qualified AND n.kind IN (${CALLER_NODE_PLACEHOLDERS})
             WHERE e.kind IN (${REFERENCE_EDGE_PLACEHOLDERS}) AND e.target_qualified = ?`
        );
        return { all: (target) => stmt.all(...CALLER_NODE_KINDS, ...REFERENCE_EDGE_KINDS, target) as ReferenceRow[] };
    } catch (error) {
        console.error('[code-review] 호출부 조회 쿼리 준비 실패, 참조 파일만 조회합니다:', (error as Error).message);
        const stmt = db.prepare(
            `SELECT DISTINCT file_path, NULL AS caller_name, NULL AS line_start, NULL AS line_end
             FROM edges WHERE kind IN (${REFERENCE_EDGE_PLACEHOLDERS}) AND target_qualified = ?`
        );
        return { all: (target) => stmt.all(...REFERENCE_EDGE_KINDS, target) as ReferenceRow[] };
    }
};

const isLineNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * 조회 행에서 diff에 포함되지 않은 참조 파일과, 그 파일 안의 참조 쪽 함수를 중복 없이 모은다.
 */
const collectReferences = (
    rows: ReferenceRow[],
    masterWorktreePath: string,
    changedFiles: Set<string>,
): { referencingFiles: string[]; callers: ReferenceCaller[] } => {
    const referencingFiles = new Set<string>();
    const callers = new Map<string, ReferenceCaller>();

    for (const row of rows) {
        const file = path.relative(masterWorktreePath, row.file_path);
        if (changedFiles.has(file)) continue;
        referencingFiles.add(file);

        if (!row.caller_name || !isLineNumber(row.line_start) || !isLineNumber(row.line_end)) continue;
        const key = `${file}:${row.caller_name}:${row.line_start}`;
        if (!callers.has(key)) {
            callers.set(key, { file, name: row.caller_name, lineStart: row.line_start, lineEnd: row.line_end });
        }
    }

    return { referencingFiles: [...referencingFiles], callers: [...callers.values()] };
};

/**
 * masterWorktreePath/.code-review-graph/graph.db를 read-only로 열어 미갱신 참조 파일을 찾는다.
 * 그래프가 없거나 쿼리가 실패해도 throw하지 않고 []를 반환한다 — 리뷰 전체를 절대 막지 않는다.
 */
export const findUnupdatedReferenceFiles = async (
    masterWorktreePath: string,
    diffData: BitbucketDiffData | null | undefined
): Promise<UnupdatedReferenceFile[]> => {
    const graphDbPath = path.join(masterWorktreePath, '.code-review-graph', 'graph.db');
    if (!existsSync(graphDbPath)) {
        console.log('[code-review] code-review-graph DB가 없어 심볼 참조 힌트를 건너뜁니다.');
        return [];
    }

    const changedBaseLineRanges = collectChangedBaseLineRanges(diffData);
    if (changedBaseLineRanges.size === 0) return [];

    const changedFiles = new Set(asArray(diffData?.diffs).map((fileDiff) => getFilePath(fileDiff)));

    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(graphDbPath, { readOnly: true });

        const findFunctionsStmt = db.prepare(
            `SELECT qualified_name, name FROM nodes WHERE kind = 'Function' AND file_path = ? AND line_start <= ? AND line_end >= ?`
        );
        const referenceQuery = prepareReferenceQuery(db);

        const entries: UnupdatedReferenceFile[] = [];
        const seenSymbols = new Set<string>();

        for (const [relativeFilePath, ranges] of changedBaseLineRanges) {
            const absoluteFilePath = path.join(masterWorktreePath, relativeFilePath);

            for (const range of ranges) {
                const rows = findFunctionsStmt.all(absoluteFilePath, range.end, range.start) as FunctionNodeRow[];

                for (const row of rows) {
                    if (seenSymbols.has(row.qualified_name)) continue;
                    seenSymbols.add(row.qualified_name);

                    const { referencingFiles, callers } = collectReferences(
                        referenceQuery.all(row.qualified_name),
                        masterWorktreePath,
                        changedFiles,
                    );

                    if (referencingFiles.length > 0) {
                        entries.push({
                            symbol: row.name,
                            definitionFile: relativeFilePath,
                            definitionLineStart: row.line_start,
                            definitionLineEnd: row.line_end,
                            referencingFiles,
                            callers,
                        });
                    }
                }
            }
        }

        return entries;
    } catch (error) {
        console.error('[code-review] 심볼 참조 힌트 쿼리 실패(무시):', (error as Error).message);
        return [];
    } finally {
        db?.close();
    }
};

const ACTIONABLE_INTERFACE_CHANGE_KINDS = new Set<InterfaceChange['kind']>([
    'parameter-breaking',
    'props-breaking',
    'return-breaking',
    'return-potentially-breaking',
]);

const NON_ACTIONABLE_INTERFACE_CHANGE_KINDS = new Set<InterfaceChange['kind']>([
    'implementation-only',
    'compatible-interface-change',
]);

const getInterfaceChange = (entry: UnupdatedReferenceFile): InterfaceChange => entry.interfaceChange ?? {
    kind: 'unknown',
    confidence: 'low',
    summary: '외부 인터페이스 변경 여부를 자동으로 확인하지 못했습니다.',
};

// 호출부 스니펫 예산. 리뷰 입력이 diff보다 스니펫에 잠식되지 않도록 PR 단위로 제한한다.
export const MAX_CALLER_SNIPPETS_PER_PR = 20;
export const MAX_CALLER_SNIPPET_LINES = 60;
const MAX_CALLER_SNIPPETS_PER_SYMBOL = 5;
const MAX_CALLER_SNIPPET_TOTAL_CHARS = 30_000;
const MAX_CALLER_SNIPPET_LINE_CHARS = 300;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const capSnippetLine = (text: string): string =>
    text.length > MAX_CALLER_SNIPPET_LINE_CHARS ? `${text.slice(0, MAX_CALLER_SNIPPET_LINE_CHARS)} …` : text;

/**
 * 참조 쪽 함수 본문을 master 워크트리에서 읽어 라인 번호가 붙은 스니펫으로 만든다.
 * 함수가 상한보다 길면 변경 심볼이 처음 등장하는 라인을 중심으로 자른다. 읽을 수 없으면 undefined.
 */
export const readCallerSnippet = (
    masterWorktreePath: string,
    caller: ReferenceCaller,
    symbol: string,
): CallerSnippet | undefined => {
    const absolutePath = path.resolve(masterWorktreePath, caller.file);
    const relativePath = path.relative(masterWorktreePath, absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;

    let lines: string[];
    try {
        lines = readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n').split('\n');
    } catch {
        return undefined;
    }

    const start = Math.max(1, caller.lineStart);
    const end = Math.min(lines.length, caller.lineEnd);
    if (end < start) return undefined;

    let startLine = start;
    let endLine = end;
    if (end - start + 1 > MAX_CALLER_SNIPPET_LINES) {
        const symbolPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
        const hitIndex = lines.slice(start - 1, end).findIndex((text) => symbolPattern.test(text));
        const hitLine = hitIndex >= 0 ? start + hitIndex : start;
        // 호출 앞쪽 맥락보다 호출 결과를 쓰는 뒤쪽이 판단에 더 중요해 1/3 지점에 호출 라인을 둔다.
        startLine = Math.max(start, hitLine - Math.floor(MAX_CALLER_SNIPPET_LINES / 3));
        endLine = Math.min(end, startLine + MAX_CALLER_SNIPPET_LINES - 1);
        startLine = Math.max(start, endLine - MAX_CALLER_SNIPPET_LINES + 1);
    }

    const text = lines
        .slice(startLine - 1, endLine)
        .map((lineText, index) => `${startLine + index}| ${capSnippetLine(lineText)}`)
        .join('\n');
    return { startLine, endLine, text };
};

/** 스니펫을 붙일 우선순위. 호출부가 깨질 가능성이 확인된 항목을 먼저, 판정 불가 항목을 다음으로 둔다. */
const getSnippetPriority = (entry: UnupdatedReferenceFile): number | undefined => {
    const kind = getInterfaceChange(entry).kind;
    if (ACTIONABLE_INTERFACE_CHANGE_KINDS.has(kind)) return 0;
    if (kind === 'unknown') return 1;
    return undefined;
};

/**
 * 인터페이스 판정이 끝난 항목에 호출부 스니펫을 붙인다. 호출부 확인이 필요 없는 항목(구현만 변경 등)은 건너뛴다.
 * PR당 개수·심볼당 개수·전체 문자 수 상한을 넘으면 남은 호출부는 위치만 남기고 스니펫 없이 둔다.
 */
export const attachCallerSnippets = (
    masterWorktreePath: string,
    entries: UnupdatedReferenceFile[],
): UnupdatedReferenceFile[] => {
    const order = entries
        .map((entry, index) => ({ index, priority: getSnippetPriority(entry) }))
        .filter((item): item is { index: number; priority: number } => item.priority !== undefined)
        .sort((a, b) => a.priority - b.priority || a.index - b.index);

    const updatedCallers = new Map<number, ReferenceCaller[]>();
    let snippetCount = 0;
    let totalChars = 0;

    for (const { index } of order) {
        const entry = entries[index];
        let perSymbolCount = 0;
        const callers = (entry.callers ?? []).map((caller) => {
            if (perSymbolCount >= MAX_CALLER_SNIPPETS_PER_SYMBOL || snippetCount >= MAX_CALLER_SNIPPETS_PER_PR) return caller;
            const snippet = readCallerSnippet(masterWorktreePath, caller, entry.symbol);
            if (!snippet || totalChars + snippet.text.length > MAX_CALLER_SNIPPET_TOTAL_CHARS) return caller;

            perSymbolCount += 1;
            snippetCount += 1;
            totalChars += snippet.text.length;
            return { ...caller, snippet };
        });
        updatedCallers.set(index, callers);
        if (snippetCount >= MAX_CALLER_SNIPPETS_PER_PR) break;
    }

    console.log(`[code-review] CRG 호출부 스니펫 ${snippetCount}개 첨부 (${totalChars}자)`);
    return entries.map((entry, index) => updatedCallers.has(index) ? { ...entry, callers: updatedCallers.get(index) } : entry);
};

type ReferenceDetail = {
    symbol: string;
    definitionFile: string;
    summary: string;
};

const buildReferenceGroups = (entries: UnupdatedReferenceFile[]): Map<string, ReferenceDetail[]> => {
    const referencesByFile = new Map<string, ReferenceDetail[]>();
    for (const entry of entries) {
        const change = getInterfaceChange(entry);
        if (NON_ACTIONABLE_INTERFACE_CHANGE_KINDS.has(change.kind)) continue;

        for (const referencingFile of entry.referencingFiles) {
            const references = referencesByFile.get(referencingFile) ?? [];
            const detail = {
                symbol: entry.symbol,
                definitionFile: entry.definitionFile,
                summary: change.summary,
            };
            const isDuplicate = references.some(
                (reference) => reference.symbol === detail.symbol
                    && reference.definitionFile === detail.definitionFile
                    && reference.summary === detail.summary,
            );
            if (!isDuplicate) references.push(detail);
            referencesByFile.set(referencingFile, references);
        }
    }
    return referencesByFile;
};

const buildReferenceLines = (entries: UnupdatedReferenceFile[]): string => {
    const referencesByFile = buildReferenceGroups(entries);
    return [...referencesByFile.entries()].map(([referencingFile, references]) => [
        `- 확인할 파일: \`${referencingFile}\``,
        ...references.map((reference) => `  - \`${reference.definitionFile}\` 파일에서 **${reference.symbol} 함수**가 변경되었습니다. (변경 내용: ${reference.summary})`),
        `  - 위 함수${references.length > 1 ? '들을' : '를'} 사용하고 있어, 이번 변경이 해당 파일의 동작에 영향을 주는지 확인해 주세요.`,
    ].join('\n')).join('\n');
};

const buildReferenceSection = (
    entries: UnupdatedReferenceFile[],
    heading: string,
    description: string,
): string => {
    if (entries.length === 0) return '';
    const lines = buildReferenceLines(entries);
    if (!lines) return '';

    return [heading, '', description, '', lines].join('\n');
};

/** Tier 1: 최종 PR 코멘트에 항상 붙는 결정론적 섹션. entries가 비면 빈 문자열. */
export const buildSymbolReferenceMarkdown = (entries: UnupdatedReferenceFile[]): string => {
    if (entries.length === 0) return '';

    const actionableEntries = entries.filter((entry) => ACTIONABLE_INTERFACE_CHANGE_KINDS.has(getInterfaceChange(entry).kind));
    const uncertainEntries = entries.filter((entry) => getInterfaceChange(entry).kind === 'unknown');
    return [
        buildReferenceSection(
            actionableEntries,
            '### 호출부 확인이 필요합니다',
            '이번 PR에서 변경된 함수 또는 컴포넌트를 사용하지만, 이번 PR에는 포함되지 않은 파일입니다.\n아래 파일에 이번 변경으로 인한 영향이 있는지 확인해 주세요.',
        ),
        buildReferenceSection(
            uncertainEntries,
            '### 자동 확인이 제한된 항목',
            '변경된 함수 또는 컴포넌트를 사용하는 파일이지만, 변경 영향 여부를 자동으로 확정하지 못했습니다. 필요한 경우 호출부를 확인해 주세요.',
        ),
    ].filter(Boolean).join('\n\n');
};

const buildCallerSnippetBlock = (symbol: string, caller: ReferenceCaller & { snippet: CallerSnippet }): string => [
    `[REF-CALLER] ${caller.file}:${caller.snippet.startLine}-${caller.snippet.endLine} ${caller.name} (master 기준, ${symbol} 사용부)`,
    caller.snippet.text,
    '[/REF-CALLER]',
].join('\n');

/**
 * Tier 2: Claude 리뷰 입력에 넣는 서버 증거. 심볼별 `[REF]` 줄(인터페이스 판정 포함)과,
 * 스니펫이 붙은 호출부마다 `[REF-CALLER]` 블록을 만든다. entries가 비면 빈 문자열.
 */
export const buildSymbolReferenceHintText = (entries: UnupdatedReferenceFile[]): string => {
    if (entries.length === 0) return '';

    return entries
    
        .filter((entry) => !NON_ACTIONABLE_INTERFACE_CHANGE_KINDS.has(getInterfaceChange(entry).kind))
        .map((entry) => {
            const change = getInterfaceChange(entry);
            const header = `[REF] ${entry.symbol}(${entry.definitionFile}) [판정: ${change.kind}] ${change.summary} — 참조하지만 이번 PR에서 변경되지 않은 파일: ${entry.referencingFiles.join(', ')}`;
            const snippets = (entry.callers ?? [])
                .filter((caller): caller is ReferenceCaller & { snippet: CallerSnippet } => Boolean(caller.snippet))
                .map((caller) => buildCallerSnippetBlock(entry.symbol, caller));
            return [header, ...snippets].join('\n');
        })
        .join('\n\n');
};
