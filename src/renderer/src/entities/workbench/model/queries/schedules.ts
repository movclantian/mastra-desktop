import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentSchedule,
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  pauseSchedule,
  resumeSchedule,
  runSchedule,
  type ScheduleInput,
  type ScheduleUpdateInput,
  updateSchedule,
} from "@/pages/schedules/api/schedules-api";
import { qk } from "../query-keys";

export function useSchedulesQuery() {
  return useQuery({ queryKey: qk.schedules(), queryFn: fetchSchedules });
}

function invalidateScheduleData(queryClient: ReturnType<typeof useQueryClient>, userId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: qk.schedules() }),
    queryClient.invalidateQueries({ queryKey: qk.threads(userId) }),
  ]);
}

export function useCreateScheduleMutation(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleInput) => createSchedule(input),
    onSuccess: async (schedule) => {
      queryClient.setQueryData<AgentSchedule[]>(qk.schedules(), (current) => [
        schedule,
        ...(current ?? []).filter((item) => item.id !== schedule.id),
      ]);
      await invalidateScheduleData(queryClient, userId);
    },
  });
}

export function useUpdateScheduleMutation(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ScheduleUpdateInput }) =>
      updateSchedule(id, input),
    onSuccess: async (schedule) => {
      queryClient.setQueryData<AgentSchedule[]>(qk.schedules(), (current) =>
        current?.map((item) => (item.id === schedule.id ? schedule : item)),
      );
      await invalidateScheduleData(queryClient, userId);
    },
  });
}

export function useScheduleActionMutation(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" | "run" }) => {
      if (action === "pause") return pauseSchedule(id);
      if (action === "resume") return resumeSchedule(id);
      return runSchedule(id).then(() => undefined);
    },
    onSuccess: async (schedule) => {
      if (schedule) {
        queryClient.setQueryData<AgentSchedule[]>(qk.schedules(), (current) =>
          current?.map((item) => (item.id === schedule.id ? schedule : item)),
        );
      }
      await invalidateScheduleData(queryClient, userId);
    },
  });
}

export function useDeleteScheduleMutation(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: async (_result, id) => {
      queryClient.setQueryData<AgentSchedule[]>(qk.schedules(), (current) =>
        current?.filter((item) => item.id !== id),
      );
      await invalidateScheduleData(queryClient, userId);
    },
  });
}
