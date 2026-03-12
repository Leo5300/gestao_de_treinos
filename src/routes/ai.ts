import { google } from "@ai-sdk/google";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  UIMessage,
} from "ai";
import { fromNodeHeaders } from "better-auth/node";
import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod";

import { WeekDay } from "../generated/prisma/enums.js";
import { auth } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { CreateWorkoutPlan } from "../usecases/CreateWorkoutPlan.js";
import { GetUserTrainData } from "../usecases/GetUserTrainData.js";
import { ListWorkoutPlans } from "../usecases/ListWorkoutPlans.js";
import { UpsertUserTrainData } from "../usecases/UpsertUserTrainData.js";

const buildSystemPrompt = (input: {
  userName: string;
  missingRequiredTrainFields: string[];
  hasBodyFatPercentage: boolean;
  defaultBodyFatPercentage: number;
}) => `
Voce e um personal trainer virtual. Responda em portugues simples, curta e objetiva.

Contexto do usuario autenticado:
- Nome ja conhecido: ${input.userName}
- Campos obrigatorios faltando agora: ${
   input.missingRequiredTrainFields.length > 0
     ? input.missingRequiredTrainFields.join(", ")
     : "nenhum"
 }
- Gordura corporal cadastrada: ${
   input.hasBodyFatPercentage ? "sim" : "nao"
 }

Regras obrigatorias:
1. Antes de qualquer resposta, chame getUserTrainData.
2. Nunca peca o nome.
3. Se faltarem dados obrigatorios, peca apenas os campos faltantes.
4. Gordura corporal e opcional.
5. Nao bloqueie a criacao do plano.
6. Nao repita perguntas.
7. Se os dados obrigatorios ja estiverem completos, nao pergunte novamente.
8. Se o usuario pedir treino, pergunte apenas objetivo, dias e restricoes.
9. Assim que tiver esses dados chame createWorkoutPlan.
10. Se necessario atualize dados com updateUserTrainData.
11. Depois de criar o plano informe sucesso.
12. Durante onboarding faca uma pergunta por vez.

Regras do plano:
- Exatamente 7 dias
- Dias sem treino: rest
- 4 a 8 exercicios por sessao
`;

export const aiRoutes = async (app: FastifyInstance) => {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: "POST",
    url: "/",

    schema: {
      tags: ["AI"],
      summary: "Chat with AI personal trainer",
    },

    handler: async (request, reply) => {

      /** proteção contra cookie duplicado */
      const cookieHeader = request.raw.headers.cookie ?? "";

      const duplicatedCookies =
        cookieHeader.match(/__Secure-better-auth\.session_token/g);

      if (duplicatedCookies && duplicatedCookies.length > 1) {

        reply.header(
          "set-cookie",
          "__Secure-better-auth.session_token=; Path=/; Domain=.leomarchi.com.br; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None"
        );

        return reply.status(401).send({
          error: "Duplicated session cookie",
        });
      }

      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.raw.headers),
      });

      if (!session) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const userId = session.user.id;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          name: true,
          weightInGrams: true,
          heightInCentimeters: true,
          age: true,
          bodyFatPercentage: true,
        },
      });

      const missingRequiredTrainFields = [
        user?.weightInGrams == null ? "peso em kg" : null,
        user?.heightInCentimeters == null ? "altura em cm" : null,
        user?.age == null ? "idade" : null,
      ].filter((field): field is string => field !== null);

      const systemPrompt = buildSystemPrompt({
        userName: session.user.name?.trim() || user?.name?.trim() || "usuario",
        missingRequiredTrainFields,
        hasBodyFatPercentage: user?.bodyFatPercentage != null,
        defaultBodyFatPercentage: user?.bodyFatPercentage ?? 18,
      });

      const { messages } = request.body as { messages: UIMessage[] };

      const result = streamText({

        model: google("gemini-2.5-flash"),

        system: systemPrompt,

        messages: await convertToModelMessages(messages),

        /** AUMENTADO raciocínio da IA */
        stopWhen: stepCountIs(20),

        tools: {

          getUserTrainData: tool({

            description:
              "Busca os dados fisicos do usuario autenticado.",

            inputSchema: z.object({}),

            execute: async () => {

              const usecase = new GetUserTrainData();

              return usecase.execute({ userId });
            },
          }),

          updateUserTrainData: tool({

            description:
              "Salva os dados fisicos do usuario autenticado.",

            inputSchema: z.object({
              weightInGrams: z.number(),
              heightInCentimeters: z.number(),
              age: z.number(),
              bodyFatPercentage: z.number().int().min(0).max(100).optional(),
            }),

            execute: async (params) => {

              const usecase = new UpsertUserTrainData();

              return usecase.execute({
                userId,
                weightInGrams: params.weightInGrams,
                heightInCentimeters: params.heightInCentimeters,
                age: params.age,
                bodyFatPercentage: params.bodyFatPercentage ?? 18,
              });
            },
          }),

          getWorkoutPlans: tool({

            description: "Lista planos do usuario",

            inputSchema: z.object({}),

            execute: async () => {

              const usecase = new ListWorkoutPlans();

              return usecase.execute({ userId });
            },
          }),

          createWorkoutPlan: tool({

            description:
              "Cria um plano completo",

            inputSchema: z.object({

              name: z.string(),

              workoutDays: z.array(
                z.object({
                  name: z.string(),
                  weekDay: z.enum(WeekDay),
                  isRest: z.boolean(),
                  estimatedDurationInSeconds: z.number(),
                  coverImageUrl: z.string().url(),
                  exercises: z.array(
                    z.object({
                      order: z.number(),
                      name: z.string(),
                      sets: z.number(),
                      reps: z.number(),
                      restTimeInSeconds: z.number(),
                    }),
                  ),
                }),
              ),
            }),

            execute: async (input) => {

              const usecase = new CreateWorkoutPlan();

              return usecase.execute({
                userId,
                name: input.name,
                workoutDays: input.workoutDays,
              });
            },
          }),
        },
      });

      const response = result.toUIMessageStreamResponse();

      reply.status(response.status);

      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });

      return reply.send(response.body);
    },
  });
};