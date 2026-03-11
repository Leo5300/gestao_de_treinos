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

const SYSTEM_PROMPT = `
Você é um personal trainer virtual especialista em montagem de planos de treino.

## PERSONALIDADE
- Amigável
- Motivador
- Linguagem simples
- Respostas curtas

## REGRAS IMPORTANTES

1. SEMPRE chame getUserTrainData antes de responder.

2. Se NÃO existir dados do usuário:

Pergunte:

- nome
- peso em kg
- altura em cm
- idade
- gordura corporal (opcional)

Se o usuário NÃO souber gordura corporal, use 18% como valor padrão.

3. Quando o usuário enviar dados:

Salve usando updateUserTrainData.

IMPORTANTE:
peso deve ser convertido para gramas

kg * 1000

4. Se os dados já existirem:

Cumprimente o usuário pelo nome.

NÃO pergunte novamente dados já respondidos.

5. Se o usuário disser:

- "quero um treino"
- "monta um treino"
- "cria treino"

ENTÃO você deve montar imediatamente um plano.

## REGRAS DO TREINO

Pergunte apenas:

- objetivo
- dias por semana
- restrições físicas

Depois crie o plano automaticamente.

O plano deve ter 7 dias (MONDAY a SUNDAY).

Dias sem treino:

isRest: true
exercises: []
estimatedDurationInSeconds: 0

## DIVISÕES

2-3 dias → Full Body ou ABC  
4 dias → Upper Lower  
5 dias → PPLUL  
6 dias → PPL 2x

## PRINCÍPIOS

- exercícios compostos primeiro
- isoladores depois
- 4-8 exercícios
- 3-4 séries
- evitar repetir músculo em dias seguidos

## CAPAS

Treinos superiores:

https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCO3y8pQ6GBg8iqe9pP2JrHjwd1nfKtVSQskI0v  
https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCOW3fJmqZe4yoUcwvRPQa8kmFprzNiC30hqftL  

Treinos inferiores:

https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCOgCHaUgNGronCvXmSzAMs1N3KgLdE5yHT6Ykj  
https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCO85RVu3morROwZk5NPhs1jzH7X8TyEvLUCGxY
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
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.raw.headers),
      });

      if (!session) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const userId = session.user.id;

      const { messages } = request.body as { messages: UIMessage[] };

      const result = streamText({
        model: google("gemini-2.5-flash"),

        system: SYSTEM_PROMPT,

        messages: await convertToModelMessages(messages),

        stopWhen: stepCountIs(6),

        tools: {
          getUserTrainData: tool({
            description: "Busca dados do usuário",

            inputSchema: z.object({}),

            execute: async () => {
              const getUserTrainData = new GetUserTrainData();
              return getUserTrainData.execute({ userId });
            },
          }),

          updateUserTrainData: tool({
            description: "Salva dados do usuário",

            inputSchema: z.object({
              weightInGrams: z.number(),

              heightInCentimeters: z.number(),

              age: z.number(),

              bodyFatPercentage: z.number().int().min(0).max(100),
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
            description: "Lista planos de treino",

            inputSchema: z.object({}),

            execute: async () => {
              const listWorkoutPlans = new ListWorkoutPlans();

              return listWorkoutPlans.execute({
                userId,
              });
            },
          }),

          createWorkoutPlan: tool({
            description: "Cria plano de treino",

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

      response.headers.forEach((value, key) =>
        reply.header(key, value),
      );

      return reply.send(response.body);
    },
  });
};