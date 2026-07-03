import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

/** Link status for the signed-in user; refetches after link/unlink/sync. */
export function useStartggStatus() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['startgg', 'status'],
    queryFn: () => api.startgg.status(),
    enabled: user != null,
  });
}

/** Starts the link flow: asks the API for the authorize URL and navigates to it. */
export function useStartggConnect() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.startgg.authorize();
      window.location.assign(url);
    },
  });
}

/** Runs a tournament sync; imported matches/opponents invalidate immediately. */
export function useStartggSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.startgg.sync(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['matches'] }),
        queryClient.invalidateQueries({ queryKey: ['opponents'] }),
        queryClient.invalidateQueries({ queryKey: ['startgg', 'status'] }),
      ]);
    },
  });
}

export function useStartggUnlink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.startgg.unlink(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['startgg', 'status'] });
    },
  });
}
