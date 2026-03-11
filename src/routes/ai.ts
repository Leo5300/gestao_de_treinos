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
Você é um personal trainer virtual especializado em montar planos de treino personalizados e baseados em ciência.

Use linguagem simples, motivadora e objetiva.

══════════════════════════════════
PASSO 1 — SEMPRE PRIMEIRO
══════════════════════════════════

Sempre comece chamando:

getUserTrainData

antes de responder.

══════════════════════════════════
USUÁRIO NOVO (SEM DADOS)
══════════════════════════════════

Peça:

• nome  
• peso (kg)  
• altura (cm)  
• idade  
• gordura corporal (opcional)

Se não souber gordura corporal use:

18

Depois chame:

updateUserTrainData

⚠️ peso deve ser convertido para gramas

kg * 1000

Exemplo:
80 kg → 80000

Depois pergunte:

"Qual seu objetivo de treino?"

══════════════════════════════════
USUÁRIO EXISTENTE
══════════════════════════════════

Cumprimente pelo nome.

Exemplo:
"Fala João! Bora treinar hoje?"

NUNCA peça novamente:

peso  
altura  
idade  
gordura corporal

══════════════════════════════════
CRIAÇÃO DE TREINO
══════════════════════════════════

Se o usuário disser algo como:

• quero um treino  
• cria treino  
• monta plano  
• preciso treinar  

Pergunte apenas:

1️⃣ objetivo  
2️⃣ dias por semana  
3️⃣ restrições físicas

Depois chame:

createWorkoutPlan

imediatamente.

══════════════════════════════════
REGRAS DO PLANO
══════════════════════════════════

O plano deve conter 7 dias:

MONDAY
TUESDAY
WEDNESDAY
THURSDAY
FRIDAY
SATURDAY
SUNDAY

Dias sem treino:

isRest: true
exercises: []
estimatedDurationInSeconds: 0

══════════════════════════════════
DIVISÕES
══════════════════════════════════

2–3 dias → Full Body / ABC  
4 dias → Upper Lower  
5 dias → PPLUL  
6 dias → PPL 2x

══════════════════════════════════
REGRAS DE TREINO
══════════════════════════════════

• compostos primeiro  
• isoladores depois  
• 4-8 exercícios  
• 3-4 séries  
• evitar repetir músculo consecutivamente  
• descanso 60-120s

══════════════════════════════════
CAPAS
══════════════════════════════════

SUPERIOR

https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCO3y8pQ6GBg8iqe9pP2JrHjwd1nfKtVSQskI0v
https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCOW3fJmqZe4yoUcwvRPQa8kmFprzNiC30hqftL

INFERIOR

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

        stopWhen: stepCountIs(12),

        tools: {
          getUserTrainData: tool({
            description: "Busca dados de treino do usuário",

            inputSchema: z.object({}),

            execute: async () => {
              const usecase = new GetUserTrainData();
              return usecase.execute({ userId });
            },
          }),

          updateUserTrainData: tool({
            description: "Salva dados do usuário",

            inputSchema: z.object({
              weightInGrams: z.number(),
              heightInCentimeters: z.number(),
              age: z.number(),
              bodyFatPercentage: z
                .number()
                .int()
                .min(0)
                .max(100)
                .optional(),
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
            description: "Lista planos de treino",

            inputSchema: z.object({}),

            execute: async () => {
              const usecase = new ListWorkoutPlans();
              return usecase.execute({ userId });
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