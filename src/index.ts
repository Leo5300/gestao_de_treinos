import "dotenv/config";

import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifyApiReference from "@scalar/fastify-api-reference";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import z from "zod";

import { auth } from "./lib/auth.js";
import { env } from "./lib/env.js";
import { aiRoutes } from "./routes/ai.js";
import { homeRoutes } from "./routes/home.js";
import { meRoutes } from "./routes/me.js";
import { statsRoutes } from "./routes/stats.js";
import { workoutPlanRoutes } from "./routes/workout-plan.js";

const envToLogger = {
  development: {
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  },
  production: true,
  test: false,
} as const;

const app = Fastify({
  logger: envToLogger[env.NODE_ENV],
  trustProxy: true,
});

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(fastifySwagger, {
  openapi: {
    info: {
      title: "Bootcamp Treinos API",
      description: "API para o bootcamp de treinos do FSC",
      version: "1.0.0",
    },
    servers: [
      {
        description: "API Base URL",
        url: env.API_BASE_URL,
      },
    ],
  },
  transform: jsonSchemaTransform,
});

await app.register(fastifyCors, {
  origin: [env.WEB_APP_BASE_URL],
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

await app.register(fastifyApiReference, {
  routePrefix: "/docs",
  configuration: {
    sources: [
      {
        title: "Bootcamp Treinos API",
        slug: "bootcamp-treinos-api",
        url: "/swagger.json",
      },
      {
        title: "Auth API",
        slug: "auth-api",
        url: "/api/auth/open-api/generate-schema",
      },
    ],
  },
});

// ----------------------------
// REST ROUTES
// ----------------------------

await app.register(homeRoutes, { prefix: "/home" });
await app.register(meRoutes, { prefix: "/me" });
await app.register(statsRoutes, { prefix: "/stats" });
await app.register(workoutPlanRoutes, { prefix: "/workout-plans" });
await app.register(aiRoutes, { prefix: "/ai" });

// ----------------------------
// SWAGGER JSON
// ----------------------------

app.withTypeProvider<ZodTypeProvider>().route({
  method: "GET",
  url: "/swagger.json",
  schema: {
    hide: true,
  },
  handler: async () => {
    return app.swagger();
  },
});

// ----------------------------
// HEALTH CHECK
// ----------------------------

app.withTypeProvider<ZodTypeProvider>().route({
  method: "GET",
  url: "/",
  schema: {
    description: "Hello world",
    tags: ["Hello World"],
    response: {
      200: z.object({
        message: z.string(),
      }),
    },
  },
  handler: () => {
    return {
      message: "Hello World",
    };
  },
});

// ----------------------------
// BETTER AUTH PROXY
// ----------------------------

app.route({
  method: ["GET", "POST", "OPTIONS"],
  url: "/api/auth/*",
  async handler(request, reply) {
    try {
      const url = new URL(request.url, env.BETTER_AUTH_URL);

      const headers = new Headers();

      // copia todos os headers da requisição original
      Object.entries(request.headers).forEach(([key, value]) => {
        if (!value) return;

        if (Array.isArray(value)) {
          value.forEach((v) => headers.append(key, v));
        } else {
          headers.append(key, String(value));
        }
      });

      // garante que cookie seja encaminhado
      if (request.headers.cookie) {
        headers.set("cookie", request.headers.cookie);
      }

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.body
          ? {
              body:
                typeof request.body === "string"
                  ? request.body
                  : JSON.stringify(request.body),
            }
          : {}),
      });

      const response = await auth.handler(req);

      reply.status(response.status);

      // copia todos os headers da resposta
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });

      const text = await response.text();

      return reply.send(text || null);
    } catch (error) {
      app.log.error(error);

      return reply.status(500).send({
        error: "Internal authentication error",
        code: "AUTH_FAILURE",
      });
    }
  },
});

// ----------------------------
// SERVER START
// ----------------------------

try {
  await app.listen({
    host: "0.0.0.0",
    port: env.PORT,
  });

  console.log("🚀 Server running");
} catch (err) {
  app.log.error(err);
  process.exit(1);
}