import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod";

import { getRequestSession } from "../lib/session.js";
import { ErrorSchema, HomeDataSchema } from "../schemas/index.js";
import { GetHomeData } from "../usecases/GetHomeData.js";

export const homeRoutes = async (app: FastifyInstance) => {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/:date",
    schema: {
      tags: ["Home"],
      summary: "Get home page data",
      params: z.object({
        date: z.iso.date(),
      }),
      response: {
        200: HomeDataSchema,
        401: ErrorSchema,
        500: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      try {
        const { duplicateSessionCookie, session } = await getRequestSession(
          request,
          reply,
        );

        if (!session) {
          return reply.status(401).send({
            error: duplicateSessionCookie
              ? "Duplicated session cookie"
              : "Unauthorized",
            code: duplicateSessionCookie
              ? "DUPLICATED_SESSION_COOKIE"
              : "UNAUTHORIZED",
          });
        }

        const getHomeData = new GetHomeData();
        const result = await getHomeData.execute({
          userId: session.user.id,
          date: request.params.date,
        });

        return reply.status(200).send(result);
      } catch (error) {
        app.log.error(error);

        return reply.status(500).send({
          error: "Internal server error",
          code: "INTERNAL_SERVER_ERROR",
        });
      }
    },
  });
};
