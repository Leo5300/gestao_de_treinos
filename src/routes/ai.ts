import { google } from "@ai-sdk/google";
import {
  convertToModelMessages,
  generateObject,
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
import { ErrorSchema } from "../schemas/index.js";
import { CreateWorkoutPlan } from "../usecases/CreateWorkoutPlan.js";
import { GetUserTrainData } from "../usecases/GetUserTrainData.js";
import { ListWorkoutPlans } from "../usecases/ListWorkoutPlans.js";
import { UpsertUserTrainData } from "../usecases/UpsertUserTrainData.js";

const AiRequestBodySchema = z.object({
  messages: z.array(z.custom<UIMessage>()).min(1),
});

const OnboardingWorkoutPlanRequestBodySchema = z.object({
  objective: z.string().trim().min(1),
  experienceLevel: z.enum(["beginner", "intermediate", "advanced"]),
  workoutDaysPerWeek: z.number().int().min(1).max(7),
  sessionDurationInMinutes: z.number().int().min(15).max(180),
  equipmentAccess: z.enum(["bodyweight", "basic", "gym"]),
  restrictions: z.string().trim().max(500).nullable().optional(),
});

const GeneratedTrainingDaysSchema = z.object({
  name: z.string().trim().min(1).max(60),
  trainingDays: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        weekDay: z.enum(WeekDay),
        estimatedDurationInSeconds: z.number().int().positive(),
        exercises: z.array(
          z.object({
            order: z.number().int().min(0),
            name: z.string().trim().min(1),
            sets: z.number().int().positive(),
            reps: z.number().int().positive(),
            restTimeInSeconds: z.number().int().positive(),
          }),
        ),
      }),
    )
    .min(1)
    .max(7),
});

const GeneratedWorkoutPlanResponseSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  workoutDays: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        weekDay: z.enum(WeekDay),
        isRest: z.boolean(),
        estimatedDurationInSeconds: z.number().int().positive(),
        exercises: z.array(
          z.object({
            order: z.number().int().min(0),
            name: z.string().trim().min(1),
            sets: z.number().int().positive(),
            reps: z.number().int().positive(),
            restTimeInSeconds: z.number().int().positive(),
          }),
        ),
      }),
    )
    .length(7),
});

const weekDayOrder = [
  WeekDay.MONDAY,
  WeekDay.TUESDAY,
  WeekDay.WEDNESDAY,
  WeekDay.THURSDAY,
  WeekDay.FRIDAY,
  WeekDay.SATURDAY,
  WeekDay.SUNDAY,
] as const;

const restDayNames: Record<WeekDay, string> = {
  MONDAY: "Descanso",
  TUESDAY: "Descanso",
  WEDNESDAY: "Descanso",
  THURSDAY: "Descanso",
  FRIDAY: "Descanso",
  SATURDAY: "Descanso",
  SUNDAY: "Descanso",
};

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

const buildWorkoutPlanPrompt = (input: {
  userName: string;
  weightInKg: number;
  heightInCm: number;
  age: number;
  bodyFatPercentage: number | null;
  objective: string;
  experienceLevel: "beginner" | "intermediate" | "advanced";
  workoutDaysPerWeek: number;
  sessionDurationInMinutes: number;
  equipmentAccess: "bodyweight" | "basic" | "gym";
  restrictions?: string | null;
}) => `
Monte um plano semanal em portugues do Brasil.

Usuario:
- nome: ${input.userName}
- peso: ${input.weightInKg} kg
- altura: ${input.heightInCm} cm
- idade: ${input.age}
- gordura corporal: ${
   input.bodyFatPercentage == null ? "nao informada" : `${input.bodyFatPercentage}%`
 }
- objetivo: ${input.objective}
- nivel: ${input.experienceLevel}
- dias/semana: ${input.workoutDaysPerWeek}
- duracao por treino: ${input.sessionDurationInMinutes} minutos
- equipamento: ${input.equipmentAccess}
- restricoes: ${input.restrictions?.trim() || "nenhuma"}

Regras:
- retorne somente os dias de treino em trainingDays
- retorne exatamente ${input.workoutDaysPerWeek} dias de treino
- nao repita weekDay
- cada dia de treino deve ter 4 a 6 exercicios
- estimatedDurationInSeconds proximo de ${input.sessionDurationInMinutes} minutos
- respeite objetivo, nivel, equipamento e restricoes
- use nomes curtos em portugues para plano, dias e exercicios
- nao retorne dias de descanso
- nao retorne texto fora do schema
`;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
};

const classifyWorkoutPlanError = (
  error: unknown,
): {
  statusCode: 500 | 502 | 503;
  code: string;
  error: string;
} => {
  const message = getErrorMessage(error);
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes("quota") ||
    normalizedMessage.includes("rate limit") ||
    normalizedMessage.includes("resource_exhausted") ||
    normalizedMessage.includes("too many requests")
  ) {
    return {
      statusCode: 503,
      code: "AI_QUOTA_EXCEEDED",
      error: "AI provider quota exceeded",
    };
  }

  if (
    normalizedMessage.includes("model") &&
    (normalizedMessage.includes("not found") ||
      normalizedMessage.includes("not supported") ||
      normalizedMessage.includes("unavailable"))
  ) {
    return {
      statusCode: 502,
      code: "AI_MODEL_ERROR",
      error: "AI model is unavailable",
    };
  }

  if (
    normalizedMessage.includes("apikey") ||
    normalizedMessage.includes("api key") ||
    normalizedMessage.includes("permission") ||
    normalizedMessage.includes("unauthorized") ||
    normalizedMessage.includes("forbidden")
  ) {
    return {
      statusCode: 502,
      code: "AI_PROVIDER_AUTH_ERROR",
      error: "AI provider authentication failed",
    };
  }

  if (
    normalizedMessage.includes("schema") ||
    normalizedMessage.includes("validation") ||
    normalizedMessage.includes("json") ||
    normalizedMessage.includes("object")
  ) {
    return {
      statusCode: 502,
      code: "AI_INVALID_OUTPUT",
      error: "AI returned an invalid workout plan",
    };
  }

  if (
    normalizedMessage.includes("prisma") ||
    normalizedMessage.includes("transaction") ||
    normalizedMessage.includes("workout plan")
  ) {
    return {
      statusCode: 500,
      code: "WORKOUT_PLAN_PERSISTENCE_ERROR",
      error: "Failed to persist workout plan",
    };
  }

  return {
    statusCode: 500,
    code: "INTERNAL_SERVER_ERROR",
    error: "Internal server error",
  };
};

export const aiRoutes = async (app: FastifyInstance) => {
  // Se o onboarding voltar a ser conduzido totalmente pela IA, remova esta rota
  // dedicada e volte a enviar o fluxo do frontend para o chat stream em "/".
  app.withTypeProvider<ZodTypeProvider>().route({
    method: "POST",
    url: "/workout-plan",
    schema: {
      tags: ["AI"],
      summary: "Generate and persist a workout plan from guided onboarding",
      body: OnboardingWorkoutPlanRequestBodySchema,
      response: {
        201: GeneratedWorkoutPlanResponseSchema,
        400: ErrorSchema,
        401: ErrorSchema,
        502: ErrorSchema,
        503: ErrorSchema,
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

        const user = await prisma.user.findUnique({
          where: { id: session.user.id },
          select: {
            name: true,
            weightInGrams: true,
            heightInCentimeters: true,
            age: true,
            bodyFatPercentage: true,
          },
        });

        if (
          !user?.weightInGrams ||
          !user.heightInCentimeters ||
          !user.age
        ) {
          return reply.status(400).send({
            error: "Incomplete user train data",
            code: "INCOMPLETE_USER_TRAIN_DATA",
          });
        }

        const { object } = await generateObject({
          model: google("gemini-2.0-flash"),
          maxRetries: 0,
          maxOutputTokens: 900,
          temperature: 0.4,
          schema: GeneratedTrainingDaysSchema,
          prompt: buildWorkoutPlanPrompt({
            userName: session.user.name?.trim() || user.name?.trim() || "usuario",
            weightInKg: user.weightInGrams / 1000,
            heightInCm: user.heightInCentimeters,
            age: user.age,
            bodyFatPercentage: user.bodyFatPercentage,
            objective: request.body.objective,
            experienceLevel: request.body.experienceLevel,
            workoutDaysPerWeek: request.body.workoutDaysPerWeek,
            sessionDurationInMinutes: request.body.sessionDurationInMinutes,
            equipmentAccess: request.body.equipmentAccess,
            restrictions: request.body.restrictions,
          }),
        });

        const uniqueTrainingDays = new Map<WeekDay, (typeof object.trainingDays)[number]>();

        for (const trainingDay of object.trainingDays) {
          if (!uniqueTrainingDays.has(trainingDay.weekDay)) {
            uniqueTrainingDays.set(trainingDay.weekDay, trainingDay);
          }
        }

        if (uniqueTrainingDays.size !== request.body.workoutDaysPerWeek) {
          return reply.status(502).send({
            error: "AI returned an invalid workout plan",
            code: "AI_INVALID_OUTPUT",
          });
        }

        const workoutDays = weekDayOrder.map((weekDay) => {
          const trainingDay = uniqueTrainingDays.get(weekDay);

          if (!trainingDay) {
            return {
              name: restDayNames[weekDay],
              weekDay,
              isRest: true,
              estimatedDurationInSeconds: 900,
              exercises: [],
            };
          }

          return {
            name: trainingDay.name,
            weekDay,
            isRest: false,
            estimatedDurationInSeconds: trainingDay.estimatedDurationInSeconds,
            exercises: trainingDay.exercises,
          };
        });

        const createWorkoutPlan = new CreateWorkoutPlan();
        const result = await createWorkoutPlan.execute({
          userId: session.user.id,
          name: object.name,
          workoutDays,
        });

        return reply.status(201).send({
          id: result.id,
          name: result.name,
          summary: `Plano criado para ${request.body.workoutDaysPerWeek} dia(s) por semana com foco em ${request.body.objective}.`,
          workoutDays: result.workoutDays,
        });
      } catch (error) {
        app.log.error(error);

        const classifiedError = classifyWorkoutPlanError(error);

        return reply.status(classifiedError.statusCode).send({
          error: classifiedError.error,
          code: classifiedError.code,
        });
      }
    },
  });

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
        model: google("gemini-2.0-flash"),
        maxRetries: 0,
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


