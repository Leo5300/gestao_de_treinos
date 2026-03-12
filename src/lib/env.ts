import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8081),
  DATABASE_URL: z.string().startsWith("postgresql://"),
  BETTER_AUTH_SECRET: z.string(),
  BETTER_AUTH_URL: z.url().default("http://localhost:8081"),
  API_BASE_URL: z.url().default("http://localhost:8081"),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  OPENAI_API_KEY: z.string(),
  WEB_APP_BASE_URL: z.url().default("http://localhost:3000"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export const env = envSchema.parse(process.env);
