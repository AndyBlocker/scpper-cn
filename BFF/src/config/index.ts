import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(4396),
  
  database: z.object({
    url: z.string(),
  }),
  
  redis: z.object({
    host: z.string().default('localhost'),
    port: z.coerce.number().default(6379),
    password: z.string().optional(),
    db: z.coerce.number().default(0),
  }),
  
  api: z.object({
    prefix: z.string().default(''),
    version: z.string().default('v1'),
    timeout: z.coerce.number().default(30000),
  }),
  
  cache: z.object({
    enabled: z.coerce.boolean().default(true),
    defaultTTL: z.coerce.number().default(300),
  }),
  
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    dir: z.string().default('./logs'),
  }),
  
  metrics: z.object({
    enabled: z.coerce.boolean().default(true),
    port: z.coerce.number().default(9090),
  }),
});

export const config = configSchema.parse({
  nodeEnv: process.env.NODE_ENV,
  port: process.env.PORT,
  
  database: {
    url: process.env.DATABASE_URL,
  },
  
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD,
    db: process.env.REDIS_DB,
  },
  
  api: {
    prefix: process.env.API_PREFIX,
    version: process.env.API_VERSION,
    timeout: process.env.API_TIMEOUT,
  },
  
  cache: {
    enabled: process.env.CACHE_ENABLED,
    defaultTTL: process.env.CACHE_DEFAULT_TTL,
  },
  
  logging: {
    level: process.env.LOG_LEVEL,
    dir: process.env.LOG_DIR,
  },
  
  metrics: {
    enabled: process.env.METRICS_ENABLED,
    port: process.env.METRICS_PORT,
  },
});