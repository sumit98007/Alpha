import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

let ai: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!ai) {
    if (!config.geminiApiKey) {
      throw new Error('GEMINI_API_KEY environment variable is missing.');
    }
    ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return ai;
}

/**
 * Optimizes the input prompt using gemini-2.5-flash.
 */
export async function optimizePrompt(prompt: string): Promise<string> {
  const client = getGeminiClient();
  const systemInstruction = `You are an expert prompt engineering optimizer. Your goal is to optimize the user's input prompt for execution quality and token efficiency.

You must:
1. Maintain the original intent and all target instructions.
2. Keep all special tokens like {{ALPHA_SECRET_X}} (where X is a number) exactly as they appear. Do not evaluate, resolve, or remove these placeholders. They are critical for local data injection.
3. Structure the final prompt using a clear blueprint:
   - Role Assignment (e.g., "Act as a...")
   - Clear Objective Statement
   - Step-by-Step Instructions
   - Output Formatting Constraints
4. Compress the text by removing filler words while keeping technical terms, key instructions, and target parameters intact.`;

  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      systemInstruction: systemInstruction,
      temperature: 0.2,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('Empty response received from the Gemini model.');
  }

  return text.trim();
}

/**
 * Generates a vector embedding for the input text using text-embedding-004.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const client = getGeminiClient();
  const result = await client.models.embedContent({
    model: 'text-embedding-004',
    contents: text,
  });

  const embedding = result.embedding;
  if (!embedding || !embedding.values) {
    throw new Error('Failed to generate embedding values from Gemini API.');
  }

  return embedding.values;
}
export const isMockMode = false;
