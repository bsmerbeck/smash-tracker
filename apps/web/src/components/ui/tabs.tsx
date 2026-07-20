import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/**
 * Phase 12 (Coach Reviews & Delivery): the radix-ui Tabs wrapper this
 * codebase was missing (Wave-0 gap noted in 12-06-PLAN.md). Mirrors
 * `dialog.tsx`'s unified-package import shape (`{ Tabs as TabsPrimitive }
 * from 'radix-ui'`) and `data-slot` convention.
 *
 * `TabsContent` forwards every prop from `React.ComponentProps<typeof
 * TabsPrimitive.Content>` unmodified — including `forceMount`, which a
 * later mobile plan (12-08, D-17's "inactive panels stay mounted but
 * inert") needs so a hidden tab panel's DOM (and any live form state / VOD
 * player instance inside it) survives a tab switch instead of unmounting.
 */
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 border-b-2 border-transparent px-4 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:font-semibold [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none data-[state=inactive]:hidden', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
