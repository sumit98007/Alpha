(function initializeAlphaDlp(globalScope) {
  'use strict';

  const PLACEHOLDER_PATTERN = /\{\{ALPHA_SECRET_[A-F0-9]{32}_(?:PROMPT|CONTEXT|GUIDANCE)_\d+\}\}/g;
  const ANY_ALPHA_PLACEHOLDER_PATTERN = /\{\{\s*ALPHA_(?:CONTEXT_)?SECRET_[^}]*\}\}/gi;
  const SOURCES = new Set(['PROMPT', 'CONTEXT', 'GUIDANCE']);
  const WEAK_ANCHOR_WORDS = new Set([
    'about',
    'after',
    'also',
    'and',
    'are',
    'before',
    'being',
    'but',
    'for',
    'from',
    'has',
    'have',
    'into',
    'its',
    'only',
    'please',
    'that',
    'the',
    'their',
    'then',
    'this',
    'those',
    'use',
    'using',
    'was',
    'were',
    'with',
    'would',
    'your'
  ]);

  function luhn(value) {
    const digits = value.replace(/[\s-]/g, '');
    if (digits.length < 13 || digits.length > 19 || !/^\d+$/.test(digits)) return false;
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (doubleDigit) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  }

  function validAustralianTfn(value) {
    const digits = value.replace(/\s/g, '');
    if (!/^\d{9}$/.test(digits)) return false;
    const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
    return (
      digits.split('').reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0) %
        11 ===
      0
    );
  }

  const RULES = Object.freeze([
    {
      name: 'AWS_ACCESS_KEY',
      regex: /\b(?:AKIA|ASCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g
    },
    {
      name: 'AWS_SECRET_KEY',
      regex:
        /\b(?:aws[\s_-]*)?secret(?:[\s_-]*(?:access|api))?[\s_-]*key\s*[:=]\s*([A-Za-z0-9+/]{40})(?![A-Za-z0-9+/])/gi,
      capture: 1
    },
    {
      name: 'OPENAI_API_KEY',
      regex: /\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}\b/g
    },
    {
      name: 'STRIPE_SECRET_KEY',
      regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24,}\b/g
    },
    {
      name: 'GITHUB_PAT',
      regex: /\bghp_[0-9a-zA-Z]{36}\b|\bgithub_pat_[0-9a-zA-Z_]{70,255}\b/g
    },
    {
      name: 'US_SSN',
      regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g
    },
    {
      name: 'AUS_TFN',
      regex: /\b\d{3}\s*\d{3}\s*\d{3}\b/g,
      validate: validAustralianTfn
    },
    {
      name: 'CREDIT_CARD',
      regex: /\b(?:\d[ -]?){13,19}\b/g,
      validate: luhn
    },
    {
      name: 'DATABASE_URL',
      regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:?#]+:[^\s]+@[^\s/?#]+(?:\/[^\s?#]*)?/gi
    }
  ]);

  function requestToken(requestId) {
    const token = String(requestId || '')
      .replace(/-/g, '')
      .toUpperCase();
    if (!/^[A-F0-9]{32}$/.test(token)) {
      throw new Error('A valid cryptographic request identifier is required for redaction.');
    }
    return token;
  }

  function sourceName(source) {
    const normalized = String(source || '').toUpperCase();
    if (!SOURCES.has(normalized)) throw new Error('Unknown redaction source.');
    return normalized;
  }

  function meaningfulWords(value) {
    return (value.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) || []).filter(
      (word) => !word.startsWith('alpha_secret_') && !WEAK_ANCHOR_WORDS.has(word)
    );
  }

  function semanticPosition(text, index) {
    const semanticText = text.replace(PLACEHOLDER_PATTERN, '');
    const semanticPrefix = text.slice(0, index).replace(PLACEHOLDER_PATTERN, '');
    return semanticPrefix.length / Math.max(1, semanticText.length);
  }

  function attachAnchors(scrubbedText, record) {
    const anchors = [];
    let offset = 0;
    while (offset < scrubbedText.length) {
      const index = scrubbedText.indexOf(record.placeholder, offset);
      if (index === -1) break;
      const before = scrubbedText.slice(Math.max(0, index - 120), index);
      const afterStart = index + record.placeholder.length;
      const after = scrubbedText.slice(afterStart, Math.min(scrubbedText.length, afterStart + 120));
      anchors.push({
        before: meaningfulWords(before).slice(-4),
        after: meaningfulWords(after).slice(0, 4),
        relativePosition: semanticPosition(scrubbedText, index)
      });
      offset = afterStart;
    }
    record.anchors = anchors;
  }

  function redact(text, options) {
    const input = typeof text === 'string' ? text : '';
    const requestId = options?.requestId;
    const source = sourceName(options?.source);
    const token = requestToken(requestId);
    const candidates = [];
    for (let ruleIndex = 0; ruleIndex < RULES.length; ruleIndex += 1) {
      const rule = RULES[ruleIndex];
      rule.regex.lastIndex = 0;
      for (const match of input.matchAll(rule.regex)) {
        const value = match[rule.capture || 0];
        if (!value) continue;
        if (rule.validate && !rule.validate(value)) continue;
        const fullMatch = match[0];
        const captureOffset = rule.capture ? fullMatch.indexOf(value) : 0;
        if (captureOffset < 0) continue;
        const start = match.index + captureOffset;
        candidates.push({
          start,
          end: start + value.length,
          value,
          rule,
          ruleIndex
        });
      }
    }

    const selected = [];
    for (const candidate of candidates.sort(
      (left, right) =>
        right.end - right.start - (left.end - left.start) ||
        left.ruleIndex - right.ruleIndex ||
        left.start - right.start
    )) {
      const overlaps = selected.some(
        (entry) => candidate.start < entry.end && entry.start < candidate.end
      );
      if (!overlaps) selected.push(candidate);
    }
    selected.sort((left, right) => left.start - right.start || left.ruleIndex - right.ruleIndex);

    const groups = new Map();
    for (const span of selected) {
      const groupKey = `${span.ruleIndex}\u0000${span.value}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { ...span, spans: [] });
      groups.get(groupKey).spans.push(span);
    }

    const redactionLog = [];
    const secrets = Object.create(null);
    let placeholderIndex = 0;
    for (const group of groups.values()) {
      let placeholder;
      do {
        placeholder = `{{ALPHA_SECRET_${token}_${source}_${placeholderIndex}}}`;
        placeholderIndex += 1;
      } while (input.includes(placeholder));
      group.placeholder = placeholder;
      const record = {
        placeholder,
        type: group.rule.name,
        source,
        requestId,
        occurrences: group.spans.length,
        value: group.value,
        anchors: []
      };
      redactionLog.push(record);
      secrets[placeholder] = record;
    }

    const replacements = [];
    for (const group of groups.values()) {
      for (const span of group.spans) {
        replacements.push({ ...span, placeholder: group.placeholder });
      }
    }
    let scrubbedText = input;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      scrubbedText =
        scrubbedText.slice(0, replacement.start) +
        replacement.placeholder +
        scrubbedText.slice(replacement.end);
    }

    for (const record of redactionLog) attachAnchors(scrubbedText, record);
    return { scrubbedText, redactionLog, secrets };
  }

  function wireLog(records) {
    return records.map(({ placeholder, source, requestId, occurrences }) => ({
      placeholder,
      source,
      requestId,
      occurrences
    }));
  }

  function placeholderSequence(text) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    return Array.from(text.matchAll(PLACEHOLDER_PATTERN), (match) => ({
      placeholder: match[0],
      index: match.index
    }));
  }

  function sameSequence(expected, actual) {
    return (
      expected.length === actual.length &&
      expected.every((entry, index) => entry.placeholder === actual[index].placeholder)
    );
  }

  function sameWords(expected, actual) {
    return (
      expected.length === actual.length && expected.every((word, index) => word === actual[index])
    );
  }

  function anchorIsIntact(text, outputEntry, record, occurrenceIndex) {
    const anchor = record.anchors[occurrenceIndex];
    if (!anchor) return false;

    const expectedBefore = anchor.before.slice(-2);
    const expectedAfter = anchor.after.slice(0, 2);
    if (expectedBefore.length + expectedAfter.length < 2) return false;

    const actualBefore = meaningfulWords(
      text.slice(Math.max(0, outputEntry.index - 160), outputEntry.index)
    ).slice(-expectedBefore.length);
    const afterStart = outputEntry.index + outputEntry.placeholder.length;
    const actualAfter = meaningfulWords(
      text.slice(afterStart, Math.min(text.length, afterStart + 160))
    ).slice(0, expectedAfter.length);

    if (!sameWords(expectedBefore, actualBefore) || !sameWords(expectedAfter, actualAfter)) {
      return false;
    }

    return Math.abs(semanticPosition(text, outputEntry.index) - anchor.relativePosition) <= 0.2;
  }

  function validateAndHydrate(optimizedText, protection) {
    if (typeof optimizedText !== 'string' || !optimizedText.trim()) {
      return { ok: false, reason: 'empty_result', text: null };
    }

    const malformed = optimizedText.match(ANY_ALPHA_PLACEHOLDER_PATTERN) || [];
    const actual = placeholderSequence(optimizedText);
    if (malformed.length !== actual.length) {
      return { ok: false, reason: 'malformed_or_unknown_placeholder', text: null };
    }

    const expected = placeholderSequence(protection.scrubbedText);
    if (!sameSequence(expected, actual)) {
      return { ok: false, reason: 'placeholder_sequence_changed', text: null };
    }

    const occurrenceByPlaceholder = Object.create(null);
    for (let index = 0; index < actual.length; index += 1) {
      const outputEntry = actual[index];
      const record = protection.secrets[outputEntry.placeholder];
      if (!record || record.source !== 'PROMPT') {
        return { ok: false, reason: 'placeholder_ownership_changed', text: null };
      }
      const occurrence = occurrenceByPlaceholder[outputEntry.placeholder] || 0;
      if (!anchorIsIntact(optimizedText, outputEntry, record, occurrence)) {
        return { ok: false, reason: 'placeholder_semantic_anchor_changed', text: null };
      }
      occurrenceByPlaceholder[outputEntry.placeholder] = occurrence + 1;
    }

    let hydrated = optimizedText;
    for (const record of protection.redactionLog) {
      hydrated = hydrated.split(record.placeholder).join(record.value);
    }
    return { ok: true, reason: null, text: hydrated };
  }

  function removeProtectedTokens(text) {
    ANY_ALPHA_PLACEHOLDER_PATTERN.lastIndex = 0;
    return String(text || '').replace(ANY_ALPHA_PLACEHOLDER_PATTERN, '[protected value]');
  }

  globalScope.AlphaDlp = Object.freeze({
    ANY_ALPHA_PLACEHOLDER_PATTERN,
    PLACEHOLDER_PATTERN,
    RULES,
    redact,
    removeProtectedTokens,
    validateAndHydrate,
    validAustralianTfn,
    wireLog
  });
})(globalThis);
