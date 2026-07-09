import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { createQueryClient } from '@/lib/queryClient';

/** Top-level providers: TanStack Query + Firebase auth context + global analytics filter + sonner toaster. Query defaults (no-4xx-retry, staleTime) live in lib/queryClient.ts. */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AnalyticsFilterProvider>
          {children}
          <Toaster richColors position="top-right" />
        </AnalyticsFilterProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
