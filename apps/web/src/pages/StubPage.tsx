/** Shared shell for screens not yet ported (Phase 4). Renders inside MainLayout via each route's element. */
export function StubPage({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground">Ported in Phase 4.</p>
    </div>
  );
}
