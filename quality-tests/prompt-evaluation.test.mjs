import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateGatewayResult,
  evaluateOutput,
  loadEvaluationSuite,
  writeReviewArtifact
} from '../scripts/run-prompt-evaluation.mjs';

test('prompt evaluation suite is versioned, synthetic, and contract-bounded', async () => {
  const suite = await loadEvaluationSuite();
  assert.equal(suite.version, 1);
  assert.ok(suite.cases.length >= 7);
  assert.equal(new Set(suite.cases.map((entry) => entry.id)).size, suite.cases.length);
  assert.ok(suite.cases.some((entry) => entry.prompt.includes('[[PROMPT_PLACEHOLDER]]')));
  assert.ok(suite.cases.some((entry) => entry.context.includes('Ignore the current request')));
});

test('prompt evaluation detects missing facts, injection markers, bloat, and placeholder changes', () => {
  const testCase = {
    prompt: 'Keep Atlas and [[PROMPT_PLACEHOLDER]].',
    mustIncludeAll: ['Atlas', '[[PROMPT_PLACEHOLDER]]'],
    mustExcludeAll: ['SECRET_OVERRIDE_ONLY'],
    maxOutputCharacters: 100,
    maxExpansionRatio: 3,
    placeholderOccurrences: 1
  };
  assert.deepEqual(evaluateOutput(testCase, 'Keep Atlas and {{SAFE}}.', '{{SAFE}}'), []);
  const failures = evaluateOutput(
    testCase,
    `${'x'.repeat(110)} SECRET_OVERRIDE_ONLY {{SAFE}} {{SAFE}}`,
    '{{SAFE}}'
  );
  assert.ok(failures.some((failure) => failure.includes('missing required invariant: Atlas')));
  assert.ok(failures.some((failure) => failure.includes('forbidden marker')));
  assert.ok(failures.some((failure) => failure.includes('characters')));
  assert.ok(failures.some((failure) => failure.includes('expansion')));
  assert.ok(failures.some((failure) => failure.includes('occurrence')));
});

test('prompt evaluation fails a provider-integrity fallback even when text invariants pass', () => {
  const testCase = {
    prompt: 'Keep Atlas.',
    mustIncludeAll: ['Atlas'],
    mustExcludeAll: [],
    maxOutputCharacters: 100,
    maxExpansionRatio: 3
  };
  const failures = evaluateGatewayResult({
    testCase,
    data: {
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      optimizedText: 'Keep Atlas.',
      degraded: true
    },
    responseOk: true,
    responseStatus: 200,
    sessionId: '123e4567-e89b-42d3-a456-426614174000',
    resolvedPlaceholder: ''
  });
  assert.deepEqual(failures, ['gateway returned a degraded fallback']);
});

test('manual-review artifacts are private, explicit, and never overwrite evidence', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alpha-eval-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'review.json');
  const artifact = {
    schemaVersion: 1,
    results: [{ id: 'synthetic', optimizedText: 'Review this generated result.' }]
  };

  await writeReviewArtifact(filePath, artifact);
  const contents = await readFile(filePath, 'utf8');
  const fileStat = await stat(filePath);
  assert.deepEqual(JSON.parse(contents), artifact);
  assert.equal(fileStat.mode & 0o077, 0);
  assert.doesNotMatch(contents, /accessToken|authorization|bearer/iu);
  await assert.rejects(() => writeReviewArtifact(filePath, artifact), { code: 'EEXIST' });
  await assert.rejects(() => writeReviewArtifact('-', artifact), /new private file/u);
});
