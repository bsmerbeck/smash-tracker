/**
 * Plan 39.1-39 (UI-SPEC §4.3: brand red is reserved for the one filled
 * primary door per card, the HorizonSwitch inset, the focus ring and app
 * chrome — never text): the ONE link treatment for the analytics surfaces.
 * React-free string constants, so Scout multi-host components can import
 * them without a provider-requiring hook.
 *
 * - `MUTED_LINK_TONE`: pass as `className` on a shadcn `Button variant="link"`
 *   (list and disclosure controls — Show all / Show fewer / Show 50 more /
 *   View as table / Restore — and non-door insight links). tailwind-merge
 *   resolves it over the variant's `text-primary`; `components/ui/button.tsx`
 *   is never edited (Coaching and VOD share it).
 * - `INLINE_LINK_TONE`: plain anchors inside content (tournament names,
 *   event headers) — foreground text, underline on hover.
 */
export const MUTED_LINK_TONE = 'text-muted-foreground hover:text-foreground';

export const INLINE_LINK_TONE = 'text-foreground underline-offset-4 hover:underline';
