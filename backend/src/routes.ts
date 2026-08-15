import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { ApiError } from './errors.js';
import type { PromptRefinementOptions } from './gemini.js';
import { hasValidPromptPlaceholderOutput, validateRedactionContract } from './placeholders.js';
import { enhanceRouteSchema } from './schemas.js';
import type { EnhanceRequest, PlaceholderSource } from './types.js';

interface CacheResult {
  optimizedText: string;
  cached: boolean;
  embedding: number[];
}

export interface RouteDependencies {
  optimizePrompt: (prompt: string, options: PromptRefinementOptions) => Promise<string>;
  checkSemanticCache: (
    text: string,
    namespace: string,
    signal?: AbortSignal
  ) => Promise<CacheResult | null>;
  saveToSemanticCache: (
    text: string,
    optimizedText: string,
    namespace: string,
    embedding?: number[],
    signal?: AbortSignal
  ) => Promise<void>;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function abortWhenRequestDisconnects(
  request: FastifyRequest,
  reply: FastifyReply
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfResponseIncomplete = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abortIfResponseIncomplete);
  reply.raw.once('close', abortIfResponseIncomplete);
  if (request.raw.aborted || request.raw.socket.destroyed) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      request.raw.off('aborted', abort);
      request.raw.socket.off('close', abortIfResponseIncomplete);
      reply.raw.off('close', abortIfResponseIncomplete);
    }
  };
}

async function optimizeWithPlaceholderSafety(
  source: string,
  options: PromptRefinementOptions,
  optimizePrompt: RouteDependencies['optimizePrompt']
): Promise<{ text: string; degraded: boolean }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await optimizePrompt(source, options);
    if (
      result.trim().length > 0 &&
      result.length <= config.maxEnhancedOutputCharacters &&
      hasValidPromptPlaceholderOutput(source, result)
    ) {
      return { text: result, degraded: false };
    }
  }
  return { text: source, degraded: true };
}

export function registerApiRoutes(server: FastifyInstance, dependencies: RouteDependencies): void {
  server.post<{ Body: EnhanceRequest }>(
    '/api/enhance',
    { schema: enhanceRouteSchema },
    async (request, reply) => {
      const body = request.body;
      const scrubbedText = body.payload.scrubbedText.trim();
      if (!scrubbedText) {
        throw new ApiError(400, 'INVALID_REQUEST', 'Prompt text cannot be empty.');
      }

      const mode = body.preferences?.mode || 'balanced';
      const targetPlatform = body.meta.hostPlatform;
      const taskType = body.preferences?.taskType?.trim() || 'auto';
      const customGuidance = body.preferences?.customGuidance?.trim() || '';
      const conversationContext = body.preferences?.conversationContext?.trim() || '';
      const preserveVoice = body.preferences?.preserveVoice !== false;
      const askClarifying = body.preferences?.askClarifying !== false;
      const qualityChecks = body.preferences?.qualityChecks !== false;
      const bypassCache = body.preferences?.bypassCache === true;
      const fields: Record<PlaceholderSource, string> = {
        PROMPT: scrubbedText,
        CONTEXT: conversationContext,
        GUIDANCE: customGuidance
      };
      validateRedactionContract({
        sessionId: body.sessionId,
        log: body.payload.redactionLog,
        fields,
        allowLegacy: !config.isProduction
      });

      const cacheKey = [
        `platform:${targetPlatform}`,
        `mode:${mode}`,
        `task:${taskType}`,
        `guidance:${customGuidance}`,
        `conversation:${conversationContext}`,
        `voice:${preserveVoice}`,
        `clarify:${askClarifying}`,
        `quality:${qualityChecks}`,
        scrubbedText
      ].join('\n');
      const cacheNamespace = request.authPrincipal?.subject || 'unauthenticated';
      const cancellation = abortWhenRequestDisconnects(request, reply);
      try {
        const cacheResult = bypassCache
          ? null
          : await dependencies.checkSemanticCache(cacheKey, cacheNamespace, cancellation.signal);
        if (
          cacheResult?.cached &&
          cacheResult.optimizedText.length <= config.maxEnhancedOutputCharacters &&
          hasValidPromptPlaceholderOutput(scrubbedText, cacheResult.optimizedText)
        ) {
          return {
            sessionId: body.sessionId,
            optimizedText: cacheResult.optimizedText,
            cached: true,
            mode,
            taskType,
            estimatedTokens: estimateTokens(cacheResult.optimizedText),
            contextUsed: Boolean(conversationContext)
          };
        }

        const optimization = await optimizeWithPlaceholderSafety(
          scrubbedText,
          {
            mode,
            targetPlatform,
            taskType,
            customGuidance,
            conversationContext,
            preserveVoice,
            askClarifying,
            qualityChecks,
            signal: cancellation.signal
          },
          dependencies.optimizePrompt
        );
        if (!optimization.degraded) {
          await dependencies.saveToSemanticCache(
            cacheKey,
            optimization.text,
            cacheNamespace,
            cacheResult?.embedding,
            cancellation.signal
          );
        }
        return {
          sessionId: body.sessionId,
          optimizedText: optimization.text,
          cached: false,
          mode,
          taskType,
          estimatedTokens: estimateTokens(optimization.text),
          degraded: optimization.degraded,
          contextUsed: Boolean(conversationContext)
        };
      } finally {
        cancellation.dispose();
      }
    }
  );
}
