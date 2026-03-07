import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

import { WeekDay } from "../generated/prisma/enums.js";
import { prisma } from "../lib/db.js";

dayjs.extend(utc);

const WEEKDAY_MAP: Record<number, WeekDay> = {
  0: "SUNDAY",
  1: "MONDAY",
  2: "TUESDAY",
  3: "WEDNESDAY",
  4: "THURSDAY",
  5: "FRIDAY",
  6: "SATURDAY",
};
const DEFAULT_UPPER_COVER_IMAGE_URL =
  "https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCO3y8pQ6GBg8iqe9pP2JrHjwd1nfKtVSQskI0v";
const DEFAULT_LOWER_COVER_IMAGE_URL =
  "https://gw8hy3fdcv.ufs.sh/f/ccoBDpLoAPCOgCHaUgNGronCvXmSzAMs1N3KgLdE5yHT6Ykj";

interface InputDto {
  userId: string;
  date: string;
}

interface OutputDto {
  activeWorkoutPlanId: string;
  todayWorkoutDay: {
    workoutPlanId: string;
    id: string;
    name: string;
    isRest: boolean;
    weekDay: WeekDay;
    estimatedDurationInSeconds: number;
    coverImageUrl?: string;
    exercisesCount: number;
  };
  workoutStreak: number;
  consistencyByDay: Record<
    string,
    {
      workoutDayCompleted: boolean;
      workoutDayStarted: boolean;
    }
  >;
}

export class GetHomeData {
  async execute(dto: InputDto): Promise<OutputDto> {
    const currentDate = dayjs.utc(dto.date);

    let workoutPlan = await prisma.workoutPlan.findFirst({
      where: { userId: dto.userId, isActive: true },
      include: {
        workoutDays: {
          include: {
            exercises: true,
            sessions: true,
          },
        },
      },
    });

    if (!workoutPlan) {
      workoutPlan = await this.createInitialWorkoutPlan(dto.userId);
    }

    const todayWeekDay = WEEKDAY_MAP[currentDate.day()];
    let todayWorkoutDay = workoutPlan.workoutDays.find(
      (day) => day.weekDay === todayWeekDay,
    );

    if (!todayWorkoutDay) {
      todayWorkoutDay = await prisma.workoutDay.create({
        data: {
          id: crypto.randomUUID(),
          name: `Workout ${todayWeekDay}`,
          workoutPlanId: workoutPlan.id,
          isRest: true,
          weekDay: todayWeekDay,
          estimatedDurationInSeconds: 0,
          coverImageUrl: DEFAULT_UPPER_COVER_IMAGE_URL,
        },
        include: {
          exercises: true,
          sessions: true,
        },
      });
      workoutPlan.workoutDays.push(todayWorkoutDay);
    }

    const weekStart = currentDate.day(0).startOf("day");
    const weekEnd = currentDate.day(6).endOf("day");

    const weekSessions = await prisma.workoutSession.findMany({
      where: {
        workoutDay: {
          workoutPlanId: workoutPlan.id,
        },
        startedAt: {
          gte: weekStart.toDate(),
          lte: weekEnd.toDate(),
        },
      },
    });

    const consistencyByDay: Record<
      string,
      { workoutDayCompleted: boolean; workoutDayStarted: boolean }
    > = {};

    for (let i = 0; i < 7; i++) {
      const day = weekStart.add(i, "day");
      const dateKey = day.format("YYYY-MM-DD");

      const daySessions = weekSessions.filter(
        (s) => dayjs.utc(s.startedAt).format("YYYY-MM-DD") === dateKey,
      );

      const workoutDayStarted = daySessions.length > 0;
      const workoutDayCompleted = daySessions.some(
        (s) => s.completedAt !== null,
      );

      consistencyByDay[dateKey] = { workoutDayCompleted, workoutDayStarted };
    }

    const workoutStreak = await this.calculateStreak(
      workoutPlan.id,
      workoutPlan.workoutDays,
      currentDate,
    );

    return {
      activeWorkoutPlanId: workoutPlan.id,
      todayWorkoutDay: {
        workoutPlanId: workoutPlan.id,
        id: todayWorkoutDay.id,
        name: todayWorkoutDay.name,
        isRest: todayWorkoutDay.isRest,
        weekDay: todayWorkoutDay.weekDay,
        estimatedDurationInSeconds: todayWorkoutDay.estimatedDurationInSeconds,
        coverImageUrl: todayWorkoutDay.coverImageUrl ?? undefined,
        exercisesCount: todayWorkoutDay.exercises.length,
      },
      workoutStreak,
      consistencyByDay,
    };
  }

  private async createInitialWorkoutPlan(userId: string) {
    const defaultWorkoutDays: Array<{
      name: string;
      weekDay: WeekDay;
      isRest: boolean;
      estimatedDurationInSeconds: number;
      coverImageUrl?: string;
      exercises: Array<{
        order: number;
        name: string;
        sets: number;
        reps: number;
        restTimeInSeconds: number;
      }>;
    }> = [
      {
        name: "Upper A",
        weekDay: "MONDAY",
        isRest: false,
        estimatedDurationInSeconds: 2700,
        coverImageUrl: DEFAULT_UPPER_COVER_IMAGE_URL,
        exercises: [
          {
            order: 1,
            name: "Push-up",
            sets: 3,
            reps: 12,
            restTimeInSeconds: 60,
          },
        ],
      },
      {
        name: "Lower A",
        weekDay: "TUESDAY",
        isRest: false,
        estimatedDurationInSeconds: 2700,
        coverImageUrl: DEFAULT_LOWER_COVER_IMAGE_URL,
        exercises: [
          {
            order: 1,
            name: "Bodyweight Squat",
            sets: 3,
            reps: 12,
            restTimeInSeconds: 60,
          },
        ],
      },
      {
        name: "Rest",
        weekDay: "WEDNESDAY",
        isRest: true,
        estimatedDurationInSeconds: 0,
        coverImageUrl: DEFAULT_UPPER_COVER_IMAGE_URL,
        exercises: [],
      },
      {
        name: "Upper B",
        weekDay: "THURSDAY",
        isRest: false,
        estimatedDurationInSeconds: 2700,
        coverImageUrl: DEFAULT_UPPER_COVER_IMAGE_URL,
        exercises: [
          {
            order: 1,
            name: "Inverted Row",
            sets: 3,
            reps: 10,
            restTimeInSeconds: 60,
          },
        ],
      },
      {
        name: "Lower B",
        weekDay: "FRIDAY",
        isRest: false,
        estimatedDurationInSeconds: 2700,
        coverImageUrl: DEFAULT_LOWER_COVER_IMAGE_URL,
        exercises: [
          {
            order: 1,
            name: "Lunge",
            sets: 3,
            reps: 10,
            restTimeInSeconds: 60,
          },
        ],
      },
      {
        name: "Cardio",
        weekDay: "SATURDAY",
        isRest: false,
        estimatedDurationInSeconds: 1800,
        coverImageUrl: DEFAULT_UPPER_COVER_IMAGE_URL,
        exercises: [
          {
            order: 1,
            name: "Brisk Walk",
            sets: 1,
            reps: 1,
            restTimeInSeconds: 0,
          },
        ],
      },
      {
        name: "Rest",
        weekDay: "SUNDAY",
        isRest: true,
        estimatedDurationInSeconds: 0,
        coverImageUrl: DEFAULT_UPPER_COVER_IMAGE_URL,
        exercises: [],
      },
    ];

    return prisma.$transaction(async (tx) => {
      await tx.workoutPlan.updateMany({
        where: {
          userId,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });

      return tx.workoutPlan.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          name: "Starter Plan",
          isActive: true,
          workoutDays: {
            create: defaultWorkoutDays.map((workoutDay) => ({
              name: workoutDay.name,
              weekDay: workoutDay.weekDay,
              isRest: workoutDay.isRest,
              estimatedDurationInSeconds: workoutDay.estimatedDurationInSeconds,
              coverImageUrl: workoutDay.coverImageUrl,
              ...(workoutDay.exercises.length > 0
                ? {
                    exercises: {
                      create: workoutDay.exercises.map((exercise) => ({
                        order: exercise.order,
                        name: exercise.name,
                        sets: exercise.sets,
                        reps: exercise.reps,
                        restTimeInSeconds: exercise.restTimeInSeconds,
                      })),
                    },
                  }
                : {}),
            })),
          },
        },
        include: {
          workoutDays: {
            include: {
              exercises: true,
              sessions: true,
            },
          },
        },
      });
    });
  }

  private async calculateStreak(
    workoutPlanId: string,
    workoutDays: Array<{
      weekDay: string;
      isRest: boolean;
      sessions: Array<{ startedAt: Date; completedAt: Date | null }>;
    }>,
    currentDate: dayjs.Dayjs,
  ): Promise<number> {
    const planWeekDays = new Set(workoutDays.map((d) => d.weekDay));
    const restWeekDays = new Set(
      workoutDays.filter((d) => d.isRest).map((d) => d.weekDay),
    );

    const allSessions = await prisma.workoutSession.findMany({
      where: {
        workoutDay: { workoutPlanId },
        completedAt: { not: null },
      },
      select: { startedAt: true },
    });

    const completedDates = new Set(
      allSessions.map((s) => dayjs.utc(s.startedAt).format("YYYY-MM-DD")),
    );

    let streak = 0;
    let day = currentDate;

    for (let i = 0; i < 365; i++) {
      const weekDay = WEEKDAY_MAP[day.day()];

      if (!planWeekDays.has(weekDay)) {
        day = day.subtract(1, "day");
        continue;
      }

      if (restWeekDays.has(weekDay)) {
        streak++;
        day = day.subtract(1, "day");
        continue;
      }

      const dateKey = day.format("YYYY-MM-DD");
      if (completedDates.has(dateKey)) {
        streak++;
        day = day.subtract(1, "day");
        continue;
      }

      break;
    }

    return streak;
  }
}
