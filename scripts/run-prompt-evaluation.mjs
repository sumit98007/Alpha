import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const DEFAULT_SUITE = path.resolve('evaluation/prompt-quality.v1.json');
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;
const TASK_TYPES = new Set(['auto', 'code', 'research', 'career', 'writing', 'business', 'study']);

function occurrences(text, value) {
  if (!value) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(value, cursor)) !== -1) {
    count += 1;
    cursor += value.length;
  }
  return count;
}

function requiredString(value, label, maximum = 30_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters.`);
  }
  return value;
}

export async function loadEvaluationSuite(filePath = DEFAULT_SUITE) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.cases)) {
    throw new Error('Prompt evaluation suite must use schema version 1.');
  }
  if (
    !Number.isInteger(parsed.minimumCaseCount) ||
    parsed.minimumCaseCount < 1 ||
    parsed.cases.length < parsed.minimumCaseCount
  ) {
    throw new Error('Prompt evaluation suite does not meet its minimum case count.');
  }
  const ids = new Set();
  for (const entry of parsed.cases) {
    requiredString(entry.id, 'case id', 80);
    if (!/^[a-z0-9_]+$/u.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`Prompt evaluation case ID is invalid or duplicated: ${entry.id}`);
    }
    ids.add(entry.id);
    if (!['chatgpt', 'claude', 'gemini'].includes(entry.platform)) {
      throw new Error(`Unsupported platform in evaluation case: ${entry.id}`);
    }
    if (!['quick', 'balanced', 'deep', 'agent'].includes(entry.mode)) {
      throw new Error(`Unsupported mode in evaluation case: ${entry.id}`);
    }
    requiredString(entry.taskType, `${entry.id} task type`, 40);
    if (!TASK_TYPES.has(entry.taskType)) {
      throw new Error(`Unsupported task type in evaluation case: ${entry.id}`);
    }
    requiredString(entry.prompt, `${entry.id} prompt`);
    if (typeof entry.context !== 'string' || entry.context.length > 12_000) {
      throw new Error(`${entry.id} context exceeds the API contract.`);
    }
    if (!Array.isArray(entry.mustIncludeAll) || !Array.isArray(entry.mustExcludeAll)) {
      throw new Error(`${entry.id} must define inclusion and exclusion checks.`);
    }
    for (const value of [...entry.mustIncludeAll, ...entry.mustExcludeAll]) {
      requiredString(value, `${entry.id} assertion`, 240);
    }
    if (
      !Number.isInteger(entry.maxOutputCharacters) ||
      entry.maxOutputCharacters < 1 ||
      entry.maxOutputCharacters > 30_000 ||
      typeof entry.maxExpansionRatio !== 'number' ||
      !Number.isFinite(entry.maxExpansionRatio) ||
      entry.maxExpansionRatio <= 0
    ) {
      throw new Error(`${entry.id} has invalid output-efficiency limits.`);
    }
    requiredString(entry.manualCriteria, `${entry.id} manual criteria`, 500);
  }
  return parsed;
}

export function evaluateOutput(testCase, output, resolvedPlaceholder = '') {
  const failures = [];
  if (typeof output !== 'string' || !output.trim()) return ['output is empty'];
  const lowerOutput = output.toLocaleLowerCase('en');
  for (const required of testCase.mustIncludeAll) {
    const resolved = required.replaceAll('[[PROMPT_PLACEHOLDER]]', resolvedPlaceholder);
    if (!lowerOutput.includes(resolved.toLocaleLowerCase('en'))) {
      failures.push(`missing required invariant: ${required}`);
    }
  }
  for (const forbidden of testCase.mustExcludeAll) {
    const resolved = forbidden.replaceAll('[[PROMPT_PLACEHOLDER]]', resolvedPlaceholder);
    if (lowerOutput.includes(resolved.toLocaleLowerCase('en'))) {
      failures.push(`contains forbidden marker: ${forbidden}`);
    }
  }
  if (output.length > testCase.maxOutputCharacters) {
    failures.push(`output exceeds ${testCase.maxOutputCharacters} characters`);
  }
  const sourceLength = Math.max(1, testCase.prompt.length);
  if (output.length / sourceLength > testCase.maxExpansionRatio) {
    failures.push(`output exceeds ${testCase.maxExpansionRatio}x expansion limit`);
  }
  if (
    Number.isInteger(testCase.placeholderOccurrences) &&
    occurrences(output, resolvedPlaceholder) !== testCase.placeholderOccurrences
  ) {
    failures.push(`placeholder occurrence count is not ${testCase.placeholderOccurrences}`);
  }
  return failures;
}

export function evaluateGatewayResult({
  testCase,
  data,
  responseOk,
  responseStatus,
  sessionId,
  resolvedPlaceholder
}) {
  const failures = [];
  if (!responseOk) failures.push(`gateway returned HTTP ${responseStatus}`);
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.sessionId !== sessionId ||
    typeof data.optimizedText !== 'string'
  ) {
    failures.push('gateway response does not match the enhancement contract');
    return failures;
  }
  if (data.degraded === true) failures.push('gateway returned a degraded fallback');
  failures.push(...evaluateOutput(testCase, data.optimizedText, resolvedPlaceholder));
  return failures;
}

function exactHttpsOrigin(raw) {
  const parsed = new URL(raw);
  const hostname = parsed.hostname.toLowerCase();
  const reservedDocumentationHost = ['example.com', 'example.net', 'example.org'].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== parsed.href.replace(/\/$/u, '') ||
    parsed.username ||
    parsed.password ||
    /(?:^|\.)(?:localhost|invalid|test|example|local|internal)$/u.test(hostname) ||
    reservedDocumentationHost ||
    isIP(hostname) !== 0
  ) {
    throw new Error('ALPHA_EVAL_API_ORIGIN must be an exact, deployed HTTPS origin.');
  }
  return parsed.origin;
}

async function boundedJson(response) {
  const announced = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (announced > MAX_RESPONSE_BYTES) throw new Error('Evaluation response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Evaluation response is not stream-readable.');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Evaluation response is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new globalThis.TextDecoder().decode(bytes));
}

function materializeCase(testCase, sessionId) {
  const requestToken = sessionId.replaceAll('-', '').toUpperCase();
  const placeholder = `{{ALPHA_SECRET_${requestToken}_PROMPT_0}}`;
  const prompt = testCase.prompt.replaceAll('[[PROMPT_PLACEHOLDER]]', placeholder);
  const redactionLog = prompt.includes(placeholder)
    ? [
        {
          placeholder,
          source: 'PROMPT',
          requestId: sessionId,
          occurrences: occurrences(prompt, placeholder)
        }
      ]
    : [];
  return { placeholder, prompt, redactionLog };
}

export async function runEvaluation({
  apiOrigin,
  accessToken,
  suitePath = DEFAULT_SUITE,
  onReviewResult
}) {
  const origin = exactHttpsOrigin(apiOrigin);
  if (
    typeof accessToken !== 'string' ||
    accessToken.length < 32 ||
    accessToken.length > 8192 ||
    /\s/u.test(accessToken)
  ) {
    throw new Error('ALPHA_EVAL_ACCESS_TOKEN must be a bounded bearer token.');
  }
  if (onReviewResult !== undefined && typeof onReviewResult !== 'function') {
    throw new Error('onReviewResult must be a function when provided.');
  }
  const suite = await loadEvaluationSuite(suitePath);
  const results = [];
  for (const testCase of suite.cases) {
    const sessionId = randomUUID();
    const materialized = materializeCase(testCase, sessionId);
    const response = await fetch(`${origin}/api/enhance`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sessionId,
        meta: { hostPlatform: testCase.platform },
        payload: {
          scrubbedText: materialized.prompt,
          redactionLog: materialized.redactionLog
        },
        preferences: {
          mode: testCase.mode,
          taskType: testCase.taskType,
          conversationContext: testCase.context,
          preserveVoice: true,
          askClarifying: true,
          qualityChecks: true,
          bypassCache: true
        }
      }),
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const data = await boundedJson(response);
    const failures = evaluateGatewayResult({
      testCase,
      data,
      responseOk: response.ok,
      responseStatus: response.status,
      sessionId,
      resolvedPlaceholder: materialized.placeholder
    });
    if (onReviewResult) {
      await onReviewResult({
        id: testCase.id,
        sourcePrompt: materialized.prompt,
        conversationContext: testCase.context,
        optimizedText: typeof data?.optimizedText === 'string' ? data.optimizedText : '',
        automatedFailures: failures,
        degraded: data?.degraded === true,
        manualCriteria: testCase.manualCriteria
      });
    }
    results.push({
      id: testCase.id,
      passed: failures.length === 0,
      failures,
      sourceCharacters: materialized.prompt.length,
      outputCharacters: typeof data?.optimizedText === 'string' ? data.optimizedText.length : 0,
      degraded: data?.degraded === true,
      manualCriteria: testCase.manualCriteria
    });
  }
  return {
    suiteVersion: suite.version,
    passed: results.every((result) => result.passed),
    automatedPassed: results.filter((result) => result.passed).length,
    total: results.length,
    results
  };
}

export async function writeReviewArtifact(filePath, artifact) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath === '-') {
    throw new Error('ALPHA_EVAL_REVIEW_PATH must name a new private file.');
  }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('The manual-review artifact is invalid.');
  }
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('The manual-review artifact exceeds 2 MiB.');
  }
  await writeFile(path.resolve(filePath), serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
}

async function main() {
  const reviewPath = process.env.ALPHA_EVAL_REVIEW_PATH?.trim() || '';
  const reviewResults = [];
  const report = await runEvaluation({
    apiOrigin: process.env.ALPHA_EVAL_API_ORIGIN || '',
    accessToken: process.env.ALPHA_EVAL_ACCESS_TOKEN || '',
    suitePath: process.env.ALPHA_EVAL_SUITE
      ? path.resolve(process.env.ALPHA_EVAL_SUITE)
      : DEFAULT_SUITE,
    onReviewResult: reviewPath ? (result) => reviewResults.push(result) : undefined
  });
  if (reviewPath) {
    await writeReviewArtifact(reviewPath, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      suiteVersion: report.suiteVersion,
      results: reviewResults
    });
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      `Prompt evaluation failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    process.exitCode = 1;
  });
}
