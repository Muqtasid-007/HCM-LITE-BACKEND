import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  MONGODB_URI: z.string().min(1).regex(/^mongodb(?:\+srv)?:\/\//,'MONGODB_URI must use mongodb:// or mongodb+srv://'),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_FALLBACK_MODE: z.enum(['auto', 'always', 'never']).default('auto'),
  LOG_LEVEL: z.enum(['trace','debug','info','warn','error','fatal','silent']).default('info'),
});
export const env = schema.parse(process.env);
