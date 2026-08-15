import type { EnhancementMode } from './gemini.js';

export type PlaceholderSource = 'PROMPT' | 'CONTEXT' | 'GUIDANCE';
export type TaskType = 'auto' | 'code' | 'research' | 'career' | 'writing' | 'business' | 'study';

export interface RedactionLogEntry {
  placeholder: string;
  source?: PlaceholderSource;
  requestId?: string;
  occurrences?: number;
}

export interface EnhanceRequest {
  sessionId: string;
  meta: {
    hostPlatform: 'chatgpt' | 'claude' | 'gemini';
  };
  payload: {
    scrubbedText: string;
    redactionLog: RedactionLogEntry[];
  };
  preferences?: {
    mode?: EnhancementMode;
    taskType?: TaskType;
    customGuidance?: string;
    conversationContext?: string;
    preserveVoice?: boolean;
    askClarifying?: boolean;
    qualityChecks?: boolean;
    bypassCache?: boolean;
  };
}

export interface AuthPrincipal {
  subject: string;
  issuer: string;
  audience: string[];
  scopes: string[];
  authMethod: 'bearer' | 'legacy-development-key';
}

declare module 'fastify' {
  interface FastifyRequest {
    authPrincipal?: AuthPrincipal;
  }
}
