import { useContext } from 'react';
import {
  AnalyticsFilterContext,
  type AnalyticsFilterContextValue,
} from '@/context/AnalyticsFilterContext';

/** Reads the global analytics filter (source + time range) and its setters. */
export function useAnalyticsFilter(): AnalyticsFilterContextValue {
  const context = useContext(AnalyticsFilterContext);
  if (!context) {
    throw new Error('useAnalyticsFilter must be used within an AnalyticsFilterProvider');
  }
  return context;
}
