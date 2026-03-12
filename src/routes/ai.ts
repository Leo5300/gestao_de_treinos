import { openai } from "@ai-sdk/openai";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  UIMessage,
} from "ai";
import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import z from "zod";

import { WeekDay } from "../generated/prisma/enums.js";
import { prisma } from "../lib/db.js";
import { getRequestSession } from "../lib/session.js";
import { CreateWorkoutPlan } from "../usecases/CreateWorkoutPlan.js";
import { GetUserTrainData } from "../usecases/GetUserTrainData.js";
import { ListWorkoutPlans } from "../usecases/ListWorkoutPlans.js";
import { UpsertUserTrainData } from "../usecases/UpsertUserTrainData.js";

const AiRequestBodySchema = z.object({
  messages: z.array(z.custom<UIMessage>()).min(1),
});

const buildSystemPrompt = (input: {
  userName: string;
  missingRequiredTrainFields: string[];
  hasBodyFatPercentage: boolean;
  userData: {
    weightInKg?: number | string;
    heightInCm?: number | string;
    age?: number | string;
  };
}) => `
Voce e um personal trainer virtual. Responda em portugues simples, curta e objetiva.

Contexto do usuario autenticado (ja carregado do banco):
- Nome: ${input.userName}
- Peso atual: ${input.userData.weightInKg} kg
- Altura atual: ${input.userData.heightInCm} cm
- Idade: ${input.userData.age}
- Campos obrigatorios faltando: ${
  input.missingRequiredTrainFields.length > 0
    ? input.missingRequiredTrainFields.join(", ")
    : "nenhum"
}
- Gordura corporal cadastrada: ${input.hasBodyFatPercentage ? "sim" : "nao"}

Regras obrigatorias:
1. Use os dados acima para evitar chamar getUserTrainData desnecessariamente.
2. Nunca peca o nome.
3. Se faltarem dados obrigatorios, peca apenas os campos faltantes (um por vez).
4. Ao atualizar peso, use weightInKg em quilogramas.
5. Gordura corporal e opcional.
6. Nao bloqueie a criacao do plano.
7. Nao repita perguntas.
8. Se os dados obrigatorios ja estiverem completos, nao pergunte novamente.
9. Se o usuario pedir treino, pergunte apenas objetivo, dias e restricoes.
10. Assim que tiver esses dados, chame createWorkoutPlan.
11. Se o usuario informar novos dados fisicos, chame updateUserTrainData imediatamente.
12. Depois de criar o plano, informe sucesso.
13. Durante onboarding, faca uma pergunta por vez.

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
      body: AiRequestBodySchema,
    },

    handler: async (request, reply) => {
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

      const userId = session.user.id;

      // Busca dados no banco para injetar no Prompt (Economiza Cota da API)
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
        userData: {
          weightInKg:
            user?.weightInGrams != null
              ? user.weightInGrams / 1000
              : "nao informado",
          heightInCm: user?.heightInCentimeters ?? "nao informado",
          age: user?.age ?? "nao informada",
        },
      });

      const { messages } = request.body;

      const result = streamText({
        model: openai("gpt-4.1-nano"),
        system: systemPrompt,
        messages: await convertToModelMessages(messages),
        stopWhen: stepCountIs(20),
        tools: {
          getUserTrainData: tool({
            description: "Busca os dados fisicos detalhados do usuario no banco.",
            inputSchema: z.object({}),
            execute: async () => {
              const usecase = new GetUserTrainData();
              return usecase.execute({ userId });
            },
          }),

          updateUserTrainData: tool({
            description: "Salva ou atualiza os dados fisicos do usuario.",
            inputSchema: z.object({
              weightInKg: z.number().positive(),
              heightInCentimeters: z.number().positive(),
              age: z.number().int().positive(),
              bodyFatPercentage: z.number().int().min(0).max(100).optional(),
            }),
            execute: async (params) => {
              const usecase = new UpsertUserTrainData();
              return usecase.execute({
                userId,
                weightInGrams: Math.round(params.weightInKg * 1000),
                heightInCentimeters: params.heightInCentimeters,
                age: params.age,
                bodyFatPercentage: params.bodyFatPercentage ?? 18,
              });
            },
          }),

          getWorkoutPlans: tool({
            description: "Lista os planos de treino ja existentes do usuario.",
            inputSchema: z.object({}),
            execute: async () => {
              const usecase = new ListWorkoutPlans();
              return usecase.execute({ userId });
            },
          }),

          createWorkoutPlan: tool({
            description: "Gera um novo plano de treino de 7 dias.",
            inputSchema: z.object({
              name: z.string().min(1),
              workoutDays: z
                .array(
                  z.object({
                    name: z.string().min(1),
                    weekDay: z.enum(WeekDay),
                    isRest: z.boolean(),
                    estimatedDurationInSeconds: z.number().int().positive(),
                    coverImageUrl: z.string().url().optional(),
                    exercises: z.array(
                      z.object({
                        order: z.number().int().min(0),
                        name: z.string().min(1),
                        sets: z.number().int().positive(),
                        reps: z.number().int().positive(),
                        restTimeInSeconds: z.number().int().positive(),
                      }),
                    ),
                  }),
                )
                .length(7),
            }),
            execute: async (input) => {
              const usecase = new CreateWorkoutPlan();
              return usecase.execute({
                userId,
                name: input.name,
                workoutDays: input.workoutDays.map((workoutDay) => ({
                  ...workoutDay,
                  exercises: workoutDay.isRest ? [] : workoutDay.exercises,
                })),
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


