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

interface InputDto {
  userId: string;
  date: string;
}

interface OutputDto {
  activeWorkoutPlanId: string | null;
  todayWorkoutDay: {
    workoutPlanId: string;
    id: string;
    name: string;
    isRest: boolean;
    weekDay: WeekDay;
    estimatedDurationInSeconds: number;
    coverImageUrl?: string;
    exercisesCount: number;
  } | null;
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
    const weekStart = currentDate.day(0).startOf("day");
    const weekEnd = currentDate.day(6).endOf("day");

    const workoutPlan = await prisma.workoutPlan.findFirst({
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
      return {
        activeWorkoutPlanId: null,
        todayWorkoutDay: null,
        workoutStreak: 0,
        consistencyByDay: this.buildConsistencyByDay(weekStart, []),
      };
    }

    const todayWeekDay = WEEKDAY_MAP[currentDate.day()];
    const todayWorkoutDay =
      workoutPlan.workoutDays.find((day) => day.weekDay === todayWeekDay) ??
      null;

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

    const workoutStreak = await this.calculateStreak(
      workoutPlan.id,
      workoutPlan.workoutDays,
      currentDate,
    );

    return {
      activeWorkoutPlanId: workoutPlan.id,
      todayWorkoutDay: todayWorkoutDay
        ? {
            workoutPlanId: workoutPlan.id,
            id: todayWorkoutDay.id,
            name: todayWorkoutDay.name,
            isRest: todayWorkoutDay.isRest,
            weekDay: todayWorkoutDay.weekDay,
            estimatedDurationInSeconds:
              todayWorkoutDay.estimatedDurationInSeconds,
            coverImageUrl: todayWorkoutDay.coverImageUrl ?? undefined,
            exercisesCount: todayWorkoutDay.exercises.length,
          }
        : null,
      workoutStreak,
      consistencyByDay: this.buildConsistencyByDay(weekStart, weekSessions),
    };
  }

  private buildConsistencyByDay(
    weekStart: dayjs.Dayjs,
    weekSessions: Array<{ startedAt: Date; completedAt: Date | null }>,
  ) {
    const consistencyByDay: Record<
      string,
      { workoutDayCompleted: boolean; workoutDayStarted: boolean }
    > = {};

    for (let i = 0; i < 7; i++) {
      const day = weekStart.add(i, "day");
      const dateKey = day.format("YYYY-MM-DD");

      const daySessions = weekSessions.filter(
        (session) =>
          dayjs.utc(session.startedAt).format("YYYY-MM-DD") === dateKey,
      );

      consistencyByDay[dateKey] = {
        workoutDayCompleted: daySessions.some(
          (session) => session.completedAt !== null,
        ),
        workoutDayStarted: daySessions.length > 0,
      };
    }

    return consistencyByDay;
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
    const planWeekDays = new Set(workoutDays.map((day) => day.weekDay));
    const restWeekDays = new Set(
      workoutDays.filter((day) => day.isRest).map((day) => day.weekDay),
    );

    const allSessions = await prisma.workoutSession.findMany({
      where: {
        workoutDay: { workoutPlanId },
        completedAt: { not: null },
      },
      select: { startedAt: true },
    });

    const completedDates = new Set(
      allSessions.map((session) =>
        dayjs.utc(session.startedAt).format("YYYY-MM-DD"),
      ),
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
