import { config } from './config.js';
import { REDACTION_PLACEHOLDER_SCHEMA_PATTERN } from './placeholders.js';

const platformSchema = {
  type: 'string',
  enum: ['chatgpt', 'claude', 'gemini']
} as const;

const taskTypeSchema = {
  type: 'string',
  enum: ['auto', 'code', 'research', 'career', 'writing', 'business', 'study']
} as const;

const sessionIdSchema = {
  type: 'string',
  minLength: 36,
  maxLength: 36,
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
} as const;

const redactionLogSchema = {
  type: 'array',
  maxItems: 100,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['placeholder'],
    properties: {
      placeholder: {
        type: 'string',
        minLength: 18,
        maxLength: 160,
        pattern: REDACTION_PLACEHOLDER_SCHEMA_PATTERN
      },
      source: {
        type: 'string',
        enum: ['PROMPT', 'CONTEXT', 'GUIDANCE']
      },
      requestId: sessionIdSchema,
      occurrences: {
        type: 'integer',
        minimum: 1,
        maximum: 1000
      }
    }
  }
} as const;

export const enhanceRouteSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['sessionId', 'meta', 'payload'],
    properties: {
      sessionId: sessionIdSchema,
      meta: {
        type: 'object',
        additionalProperties: false,
        required: ['hostPlatform'],
        properties: {
          hostPlatform: platformSchema
        }
      },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: ['scrubbedText', 'redactionLog'],
        properties: {
          scrubbedText: {
            type: 'string',
            minLength: 1,
            maxLength: config.maxPromptCharacters
          },
          redactionLog: redactionLogSchema
        }
      },
      preferences: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['quick', 'balanced', 'deep', 'agent'] },
          taskType: taskTypeSchema,
          customGuidance: { type: 'string', maxLength: 2000 },
          conversationContext: { type: 'string', maxLength: 12000 },
          preserveVoice: { type: 'boolean' },
          askClarifying: { type: 'boolean' },
          qualityChecks: { type: 'boolean' },
          bypassCache: { type: 'boolean' }
        }
      }
    }
  },
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: [
        'sessionId',
        'optimizedText',
        'cached',
        'mode',
        'taskType',
        'estimatedTokens',
        'contextUsed'
      ],
      properties: {
        sessionId: sessionIdSchema,
        optimizedText: {
          type: 'string',
          minLength: 1,
          maxLength: config.maxEnhancedOutputCharacters
        },
        cached: { type: 'boolean' },
        mode: { type: 'string', enum: ['quick', 'balanced', 'deep', 'agent'] },
        taskType: taskTypeSchema,
        estimatedTokens: {
          type: 'integer',
          minimum: 1,
          maximum: config.maxEnhancedOutputCharacters
        },
        degraded: { type: 'boolean' },
        contextUsed: { type: 'boolean' }
      }
    }
  }
} as const;
