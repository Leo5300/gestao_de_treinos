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
2. Nunca peca o nome. O nome ja existe no login e no banco.
3. Se faltarem dados obrigatorios, peca apenas os campos faltantes desta lista: ${
   input.missingRequiredTrainFields.length > 0
     ? input.missingRequiredTrainFields.join(", ")
     : "nenhum"
 }.
4. Gordura corporal e opcional. Se o usuario nao souber ou nao informar, use ${input.defaultBodyFatPercentage}.
5. Nao bloqueie a criacao do plano por falta de gordura corporal.
6. Nao repita perguntas ja respondidas nesta conversa nem dados ja retornados pelas tools.
7. Se os dados obrigatorios ja estiverem completos, nao pergunte peso, altura ou idade novamente.
8. Se o usuario pedir um treino, pergunte apenas o que faltar entre: objetivo, dias por semana e restricoes fisicas.
9. Assim que tiver objetivo, dias por semana e restricoes fisicas, chame createWorkoutPlan imediatamente.
10. Quando terminar de coletar os dados necessários, chame updateUserTrainData se precisar e depois createWorkoutPlan sem pedir confirmacao extra.
11. Depois de criar o plano, informe claramente que o treino foi criado com sucesso.
12. Durante o onboarding, faca apenas uma pergunta por vez.

Regras do updateUserTrainData:
- weightInGrams deve ser enviado em gramas.
- Converta kg para gramas multiplicando por 1000.
- Se gordura corporal nao for informada, envie ${input.defaultBodyFatPercentage}.

Regras do plano:
- O plano deve ter exatamente 7 dias: MONDAY a SUNDAY.
- Dias sem treino: isRest true, exercises [], estimatedDurationInSeconds 0.
- Para 2-3 dias: Full Body ou ABC.
- Para 4 dias: Upper/Lower.
- Para 5 dias: PPLUL.
- Para 6 dias: PPL 2x.
- Compostos primeiro, isoladores depois.
- 4 a 8 exercicios por sessao.
- 3 a 4 series por exercicio.
- Evite repetir o mesmo grupo muscular em dias consecutivos.

Imagens de capa:
- Superior: https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCO3y8pQ6GBg8iqe9pP2JrHjwd1nfKtVSQskI0v
- Superior: https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCOW3fJmqZe4yoUcwvRPQa8kmFprzNiC30hqftL
- Inferior: https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCOgCHaUgNGronCvXmSzAMs1N3KgLdE5yHT6Ykj
- Inferior: https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCO85RVu3morROwZk5NPhs1jzH7X8TyEvLUCGxY
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
        stopWhen: stepCountIs(12),
        tools: {
          getUserTrainData: tool({
            description:
              "Busca os dados fisicos do usuario autenticado. Gordura corporal pode vir nula.",
            inputSchema: z.object({}),
            execute: async () => {
              const usecase = new GetUserTrainData();
              return usecase.execute({ userId });
            },
          }),
          updateUserTrainData: tool({
            description:
              "Salva os dados fisicos do usuario autenticado. Peso deve ser enviado em gramas.",
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
            description: "Lista os planos de treino do usuario autenticado.",
            inputSchema: z.object({}),
            execute: async () => {
              const usecase = new ListWorkoutPlans();
              return usecase.execute({ userId });
            },
          }),
          createWorkoutPlan: tool({
            description:
              "Cria um novo plano de treino completo para o usuario autenticado.",
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
