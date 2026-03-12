import "dotenv/config";

import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifyApiReference from "@scalar/fastify-api-reference";
import Fastify, { FastifyReply } from "fastify";
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

const rootOrigin = env.WEB_APP_BASE_URL.replace(/\/$/, "");

const wwwOrigin = rootOrigin.startsWith("https://www.")
  ? rootOrigin
  : rootOrigin.replace("https://", "https://www.");

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
  origin: [rootOrigin, wwwOrigin],
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

function splitSetCookieHeader(setCookieHeader: string): string[] {
  return setCookieHeader.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function copyResponseHeadersToReply(response: Response, reply: FastifyReply) {
  const headersWithOptionalGetSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  let setCookies: string[] = [];

  if (typeof headersWithOptionalGetSetCookie.getSetCookie === "function") {
    setCookies = headersWithOptionalGetSetCookie.getSetCookie();
  } else {
    const setCookieHeader = response.headers.get("set-cookie");

    if (setCookieHeader) {
      setCookies = splitSetCookieHeader(setCookieHeader);
    }
  }

  if (setCookies.length > 0) {
    reply.raw.setHeader("set-cookie", setCookies);
  }

  response.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();

    if (lowerKey === "set-cookie") return;
    if (lowerKey === "content-length") return;

    reply.header(key, value);
  });
}

app.route({
  method: ["GET", "POST", "OPTIONS"],
  url: "/api/auth/*",

  async handler(request, reply) {
    try {
      const url = new URL(request.url, env.BETTER_AUTH_URL);

      const headers = new Headers();

      Object.entries(request.raw.headers).forEach(([key, value]) => {
        if (!value) return;

        if (Array.isArray(value)) {
          value.forEach((v) => headers.append(key, v));
        } else {
          headers.append(key, String(value));
        }
      });

      if (request.raw.headers.cookie) {
        headers.set("cookie", request.raw.headers.cookie);
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

      copyResponseHeadersToReply(response, reply);

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

await app.register(homeRoutes, { prefix: "/home" });
await app.register(meRoutes, { prefix: "/me" });
await app.register(statsRoutes, { prefix: "/stats" });
await app.register(workoutPlanRoutes, { prefix: "/workout-plans" });
await app.register(aiRoutes, { prefix: "/ai" });

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