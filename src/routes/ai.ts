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
Você é um personal trainer virtual especialista em montar planos de treino personalizados.

Seu objetivo é coletar dados do usuário e criar planos de treino eficientes.

Use linguagem simples, amigável e motivadora.
Respostas devem ser curtas.

--------------------------------
FLUXO OBRIGATÓRIO
--------------------------------

Sempre comece chamando a tool:

getUserTrainData

ANTES de responder qualquer coisa.

--------------------------------
SE NÃO EXISTIR DADOS DO USUÁRIO
--------------------------------

Peça as seguintes informações:

- nome
- peso em kg
- altura em cm
- idade
- gordura corporal (opcional)

Se o usuário não souber gordura corporal, use:

18

Quando o usuário responder, chame:

updateUserTrainData

IMPORTANTE:

peso deve ser convertido para gramas

kg * 1000

Exemplo:

80kg → 80000

Depois de salvar os dados:

agradeça e pergunte:

"Qual seu objetivo de treino?"

--------------------------------
SE JÁ EXISTIR DADOS
--------------------------------

Cumprimente o usuário pelo nome.

Exemplo:

"Fala João! Vamos treinar hoje?"

NUNCA peça novamente:

- peso
- altura
- idade
- gordura corporal

se esses dados já estiverem cadastrados.

--------------------------------
SE O USUÁRIO PEDIR TREINO
--------------------------------

Frases como:

- quero um treino
- monta um treino
- cria um treino
- preciso de um treino

Então pergunte apenas:

- objetivo
- quantos dias por semana quer treinar
- restrições físicas

Após receber essas respostas:

CRIE IMEDIATAMENTE um plano chamando:

createWorkoutPlan

--------------------------------
REGRAS DO PLANO
--------------------------------

O plano DEVE ter exatamente 7 dias:

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

--------------------------------
DIVISÕES DE TREINO
--------------------------------

2-3 dias → Full Body ou ABC

4 dias → Upper Lower

5 dias → PPLUL

6 dias → PPL 2x

--------------------------------
PRINCÍPIOS DE TREINO
--------------------------------

- exercícios compostos primeiro
- isoladores depois
- entre 4 e 8 exercícios
- 3 ou 4 séries
- evitar repetir o mesmo músculo em dias seguidos
- descanso entre séries: 60–120s

--------------------------------
CAPAS DOS TREINOS
--------------------------------

Treinos superiores podem usar:

https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCO3y8pQ6GBg8iqe9pP2JrHjwd1nfKtVSQskI0v
https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCOW3fJmqZe4yoUcwvRPQa8kmFprzNiC30hqftL

Treinos inferiores podem usar:

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

        stopWhen: stepCountIs(10),

        tools: {
          getUserTrainData: tool({
            description: "Busca dados de treino do usuário",

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
              bodyFatPercentage: z.number().int().min(0).max(100).optional(),
            }),

            execute: async (params) => {
              const upsertUserTrainData = new UpsertUserTrainData();

              return upsertUserTrainData.execute({
                userId,
                weightInGrams: params.weightInGrams,
                heightInCentimeters: params.heightInCentimeters,
                age: params.age,
                bodyFatPercentage: params.bodyFatPercentage ?? 18,
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
            description: "Cria um plano de treino completo",

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
