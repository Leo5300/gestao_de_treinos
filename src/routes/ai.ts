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
import { CreateWorkoutPlan } from "../usecases/CreateWorkoutPlan.js";
import { GetUserTrainData } from "../usecases/GetUserTrainData.js";
import { ListWorkoutPlans } from "../usecases/ListWorkoutPlans.js";
import { UpsertUserTrainData } from "../usecases/UpsertUserTrainData.js";

const SYSTEM_PROMPT = `Você é um personal trainer virtual especialista em montagem de planos de treino personalizados.

## Personalidade
- Tom amigável, motivador e acolhedor.
- Linguagem simples e direta, sem jargões técnicos.
- Respostas curtas e objetivas.

## Regras de Interação

1. **SEMPRE** chame a tool \`getUserTrainData\` antes de qualquer interação com o usuário.
2. Se o usuário **não tem dados cadastrados** (retornou null):
   - Pergunte nome, peso (kg), altura (cm), idade e % de gordura corporal.
   - Após receber os dados, salve com a tool \`updateUserTrainData\`.
3. Se o usuário **já tem dados cadastrados**: cumprimente-o pelo nome.

## Criação de Plano de Treino

Quando o usuário quiser criar um plano de treino:
- Pergunte o objetivo
- Pergunte quantos dias pode treinar
- Pergunte se tem restrições

O plano DEVE ter exatamente 7 dias.

Dias sem treino:
isRest: true
exercises: []
estimatedDurationInSeconds: 0
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
      /**
       * 🔐 CORREÇÃO PRINCIPAL
       * Better Auth precisa dos headers RAW do Node
       */
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.raw.headers),
      });

      if (!session) {
        return reply.status(401).send({
          error: "Unauthorized",
        });
      }

      const userId = session.user.id;

      const { messages } = request.body as {
        messages: UIMessage[];
      };

      const result = streamText({
        model: google("gemini-2.5-flash"),

        system: SYSTEM_PROMPT,

        messages: await convertToModelMessages(messages),

        stopWhen: stepCountIs(5),

        tools: {
          getUserTrainData: tool({
            description: "Busca dados de treino do usuário autenticado",

            inputSchema: z.object({}),

            execute: async () => {
              const getUserTrainData = new GetUserTrainData();

              return getUserTrainData.execute({
                userId,
              });
            },
          }),

          updateUserTrainData: tool({
            description: "Atualiza dados físicos do usuário",

            inputSchema: z.object({
              weightInGrams: z.number(),
              heightInCentimeters: z.number(),
              age: z.number(),
              bodyFatPercentage: z.number(),
            }),

            execute: async (params) => {
              const upsertUserTrainData = new UpsertUserTrainData();

              return upsertUserTrainData.execute({
                userId,
                ...params,
              });
            },
          }),

          getWorkoutPlans: tool({
            description: "Lista planos de treino do usuário",

            inputSchema: z.object({}),

            execute: async () => {
              const listWorkoutPlans = new ListWorkoutPlans();

              return listWorkoutPlans.execute({
                userId,
              });
            },
          }),

          createWorkoutPlan: tool({
            description: "Cria plano de treino para o usuário",

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
              const createWorkoutPlan = new CreateWorkoutPlan();

              return createWorkoutPlan.execute({
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
