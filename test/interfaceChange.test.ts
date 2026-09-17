import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    applyBitbucketFileDiff,
    analyzeChangedSymbolInterface,
    compareFunctionInterface,
} from '../src/services/codeReview/interfaceChange.js';
import type { BitbucketDiffData, BitbucketFileDiff } from '../src/types/bitbucket.js';

const diffFile = (segments: NonNullable<BitbucketFileDiff['hunks']>[number]['segments']): BitbucketFileDiff => ({
    source: { toString: 'src/example.ts' },
    destination: { toString: 'src/example.ts' },
    hunks: [{ segments }],
});

test('compareFunctionInterface: 필수 인자가 추가되면 호출부 확인 필요로 분류한다', () => {
    const result = compareFunctionInterface({
        filePath: 'src/example.ts',
        symbol: 'fetchUserProfile',
        beforeSource: 'export function fetchUserProfile(userId: string) { return userId; }\n',
        afterSource: 'export function fetchUserProfile(userId: string, includeDeleted: boolean) { return userId; }\n',
        definitionLineStart: 1,
        definitionLineEnd: 1,
    });

    assert.equal(result.kind, 'parameter-breaking');
    assert.equal(result.confidence, 'high');
    assert.match(result.summary, /인자 1개 → 2개/);
});

test('compareFunctionInterface: 선택 인자가 추가되면 기존 호출부 수정이 필요 없는 변경으로 분류한다', () => {
    const result = compareFunctionInterface({
        filePath: 'src/example.ts',
        symbol: 'fetchUserProfile',
        beforeSource: 'export function fetchUserProfile(userId: string) { return userId; }\n',
        afterSource: 'export function fetchUserProfile(userId: string, includeDeleted?: boolean) { return userId; }\n',
        definitionLineStart: 1,
        definitionLineEnd: 1,
    });

    assert.equal(result.kind, 'compatible-interface-change');
    assert.equal(result.confidence, 'high');
});

test('compareFunctionInterface: 함수 본문만 변경되면 implementation-only로 분류한다', () => {
    const result = compareFunctionInterface({
        filePath: 'src/example.ts',
        symbol: 'getCouponLabel',
        beforeSource: [
            'export function getCouponLabel(coupon: Coupon): string {',
            '    if (coupon.isNew) return coupon.name;',
            '    return coupon.code;',
            '}',
        ].join('\n'),
        afterSource: [
            'export function getCouponLabel(coupon: Coupon): string {',
            '    if (coupon.isNew && coupon.isVisible) return coupon.name;',
            '    return coupon.code;',
            '}',
        ].join('\n'),
        definitionLineStart: 1,
        definitionLineEnd: 4,
    });

    assert.equal(result.kind, 'implementation-only');
    assert.equal(result.confidence, 'high');
});

test('compareFunctionInterface: 명시적 반환 타입이 변경되면 호출부 확인 필요로 분류한다', () => {
    const result = compareFunctionInterface({
        filePath: 'src/example.ts',
        symbol: 'getCoupon',
        beforeSource: 'export function getCoupon(id: string): Coupon { return load(id); }\n',
        afterSource: 'export function getCoupon(id: string): Coupon | undefined { return load(id); }\n',
        definitionLineStart: 1,
        definitionLineEnd: 1,
    });

    assert.equal(result.kind, 'return-breaking');
    assert.match(result.summary, /반환 타입 변경/);
});

test('compareFunctionInterface: 반환 표현식이 변경되면 잠재적 반환값 변경으로 분류한다', () => {
    const result = compareFunctionInterface({
        filePath: 'src/example.ts',
        symbol: 'getCouponId',
        beforeSource: 'export function getCouponId(coupon: Coupon) { return coupon.id; }\n',
        afterSource: 'export function getCouponId(coupon: Coupon) { return coupon.code; }\n',
        definitionLineStart: 1,
        definitionLineEnd: 1,
    });

    assert.equal(result.kind, 'return-potentially-breaking');
    assert.equal(result.confidence, 'medium');
});

test('compareFunctionInterface: 필수 Props가 추가되면 props-breaking으로 분류한다', () => {
    const result = compareFunctionInterface({
        filePath: 'src/Component.tsx',
        symbol: 'CouponComponent',
        beforeSource: [
            'interface Props {',
            '    couponId: string;',
            '}',
            'export const CouponComponent = ({ couponId }: Props) => couponId;',
        ].join('\n'),
        afterSource: [
            'interface Props {',
            '    couponId: string;',
            '    disabled: boolean;',
            '}',
            'export const CouponComponent = ({ couponId }: Props) => couponId;',
        ].join('\n'),
        definitionLineStart: 4,
        definitionLineEnd: 4,
    });

    assert.equal(result.kind, 'props-breaking');
    assert.match(result.summary, /필수 Props 'disabled' 추가/);
});

test('applyBitbucketFileDiff: base 파일에 diff를 적용해 변경 후 소스를 복원한다', () => {
    const baseSource = ['export function getCoupon(id: string) {', '    return id;', '}'].join('\n');
    const fileDiff = diffFile([
        {
            type: 'CONTEXT',
            lines: [{ source: 1, destination: 1, line: 'export function getCoupon(id: string) {' }],
        },
        {
            type: 'REMOVED',
            lines: [{ source: 2, destination: null, line: '    return id;' }],
        },
        {
            type: 'ADDED',
            lines: [{ source: null, destination: 2, line: '    return id.trim();' }],
        },
        {
            type: 'CONTEXT',
            lines: [{ source: 3, destination: 3, line: '}' }],
        },
    ]);

    assert.equal(
        applyBitbucketFileDiff(baseSource, fileDiff),
        ['export function getCoupon(id: string) {', '    return id.trim();', '}'].join('\n'),
    );
});

test('applyBitbucketFileDiff: context가 현재 base와 다르면 undefined를 반환한다', () => {
    const fileDiff = diffFile([
        {
            type: 'CONTEXT',
            lines: [{ source: 1, destination: 1, line: 'export function getCoupon(id: string) {' }],
        },
    ]);

    assert.equal(applyBitbucketFileDiff('export function getCoupon(otherId: string) {}', fileDiff), undefined);
});

test('analyzeChangedSymbolInterface: master 파일과 Bitbucket diff를 함께 사용해 인터페이스를 판정한다', () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-interface-'));
    try {
        const filePath = path.join(worktreePath, 'src/example.ts');
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, [
            'export function fetchUserProfile(userId: string) {',
            '    return userId;',
            '}',
        ].join('\n'));

        const diffData: BitbucketDiffData = {
            diffs: [{
                source: { toString: 'src/example.ts' },
                destination: { toString: 'src/example.ts' },
                hunks: [{
                    segments: [
                        {
                            type: 'REMOVED',
                            lines: [{ source: 1, destination: null, line: 'export function fetchUserProfile(userId: string) {' }],
                        },
                        {
                            type: 'ADDED',
                            lines: [{ source: null, destination: 1, line: 'export function fetchUserProfile(userId: string, includeDeleted: boolean) {' }],
                        },
                        {
                            type: 'CONTEXT',
                            lines: [
                                { source: 2, destination: 2, line: '    return userId;' },
                                { source: 3, destination: 3, line: '}' },
                            ],
                        },
                    ],
                }],
            }],
        };

        const result = analyzeChangedSymbolInterface(worktreePath, diffData, {
            symbol: 'fetchUserProfile',
            definitionFile: 'src/example.ts',
            definitionLineStart: 1,
            definitionLineEnd: 3,
        });

        assert.equal(result.kind, 'parameter-breaking');
        assert.match(result.summary, /인자 1개 → 2개/);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});
