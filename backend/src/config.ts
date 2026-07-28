import dotenv from 'dotenv';
import path from 'path';

// Load .env from the current working directory
const envPath = path.resolve(process.cwd(), '.env');
console.log(`[Config] Loading environment variables from: ${envPath}`);
dotenv.config({ path: envPath });

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '127.0.0.1',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  redisUrl: process.env.REDIS_URL || undefined,
};

if (!config.geminiApiKey) {
  console.warn('WARNING: GEMINI_API_KEY environment variable is not set. API calls to Gemini will fail.');
}
