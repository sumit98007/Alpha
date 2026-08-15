import { ApiError } from './errors.js';
import type { PlaceholderSource, RedactionLogEntry } from './types.js';

const OPAQUE_PLACEHOLDER_SOURCE = String.raw`\{\{ALPHA_SECRET_([A-F0-9]{32})_(PROMPT|CONTEXT|GUIDANCE)_(\d+)\}\}`;
const LEGACY_PLACEHOLDER_SOURCE = String.raw`\{\{ALPHA_SECRET_(\d+)\}\}`;
const ANY_ALPHA_MARKER = /\{\{ALPHA_SECRET_[^}\r\n]{0,180}\}\}/g;

export const REDACTION_PLACEHOLDER_SCHEMA_PATTERN = `^(?:${OPAQUE_PLACEHOLDER_SOURCE}|${LEGACY_PLACEHOLDER_SOURCE})$`;

interface ParsedPlaceholder {
  placeholder: string;
  requestToken?: string;
  source: PlaceholderSource;
}

function opaqueRegex(global = false): RegExp {
  return new RegExp(OPAQUE_PLACEHOLDER_SOURCE, global ? 'g' : undefined);
}

function legacyRegex(global = false): RegExp {
  return new RegExp(LEGACY_PLACEHOLDER_SOURCE, global ? 'g' : undefined);
}

function recognizedRegex(): RegExp {
  return new RegExp(`(?:${OPAQUE_PLACEHOLDER_SOURCE}|${LEGACY_PLACEHOLDER_SOURCE})`, 'g');
}

export function parsePlaceholder(placeholder: string): ParsedPlaceholder | null {
  const opaque = opaqueRegex().exec(placeholder);
  if (opaque) {
    return {
      placeholder,
      requestToken: opaque[1],
      source: opaque[2] as PlaceholderSource
    };
  }
  if (legacyRegex().test(placeholder)) {
    return { placeholder, source: 'PROMPT' };
  }
  return null;
}

export function getPlaceholders(text: string): ParsedPlaceholder[] {
  const matches: ParsedPlaceholder[] = [];
  for (const match of text.matchAll(recognizedRegex())) {
    const parsed = parsePlaceholder(match[0]);
    if (parsed) matches.push(parsed);
  }
  return matches;
}

function countOccurrences(text: string, value: string): number {
  if (!value) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(value, cursor)) !== -1) {
    count += 1;
    cursor += value.length;
  }
  return count;
}

function expectedTextForSource(
  source: PlaceholderSource,
  fields: Record<PlaceholderSource, string>
): string {
  return fields[source] || '';
}

export function validateRedactionContract(options: {
  sessionId: string;
  log: RedactionLogEntry[];
  fields: Record<PlaceholderSource, string>;
  allowLegacy: boolean;
}): void {
  const { sessionId, log, fields, allowLegacy } = options;
  const normalizedSessionId = sessionId.replaceAll('-', '').toUpperCase();
  const combined = Object.values(fields).join('\n');
  const parsedInFields = getPlaceholders(combined);
  const alphaMarkers = combined.match(ANY_ALPHA_MARKER) || [];
  if (alphaMarkers.length !== parsedInFields.length) {
    throw new ApiError(400, 'INVALID_REQUEST', 'A protected placeholder is malformed.');
  }

  const logByPlaceholder = new Map<string, RedactionLogEntry>();
  for (const entry of log) {
    if (logByPlaceholder.has(entry.placeholder)) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'The redaction log contains duplicate placeholders.'
      );
    }
    const parsed = parsePlaceholder(entry.placeholder);
    if (!parsed) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'The redaction log contains an invalid placeholder.'
      );
    }
    if (!parsed.requestToken) {
      if (!allowLegacy) {
        throw new ApiError(
          400,
          'INVALID_REQUEST',
          'Legacy protected placeholders are not accepted.'
        );
      }
    } else {
      if (parsed.requestToken !== normalizedSessionId) {
        throw new ApiError(
          400,
          'INVALID_REQUEST',
          'A protected placeholder does not belong to this request.'
        );
      }
      if (entry.requestId !== sessionId || entry.source !== parsed.source) {
        throw new ApiError(
          400,
          'INVALID_REQUEST',
          'The redaction log does not match its protected placeholder.'
        );
      }
      const expectedOccurrences = countOccurrences(
        expectedTextForSource(parsed.source, fields),
        entry.placeholder
      );
      if (
        entry.occurrences !== expectedOccurrences ||
        expectedOccurrences < 1 ||
        countOccurrences(combined, entry.placeholder) !== expectedOccurrences
      ) {
        throw new ApiError(
          400,
          'INVALID_REQUEST',
          'The redaction log occurrence count is invalid.'
        );
      }
    }
    logByPlaceholder.set(entry.placeholder, entry);
  }

  for (const parsed of parsedInFields) {
    if (!logByPlaceholder.has(parsed.placeholder)) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'A protected placeholder is missing from the redaction log.'
      );
    }
  }
  for (const entry of log) {
    if (!combined.includes(entry.placeholder)) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'The redaction log contains an unused placeholder.'
      );
    }
  }
}

export function hasValidPromptPlaceholderOutput(source: string, result: string): boolean {
  const expected = getPlaceholders(source);
  if (expected.some((placeholder) => placeholder.source !== 'PROMPT')) return false;
  const actual = getPlaceholders(result);
  const markers = result.match(ANY_ALPHA_MARKER) || [];
  if (
    markers.length !== actual.length ||
    actual.some((placeholder) => placeholder.source !== 'PROMPT')
  ) {
    return false;
  }
  return (
    expected.length === actual.length &&
    expected.every((placeholder, index) => placeholder.placeholder === actual[index]?.placeholder)
  );
}
