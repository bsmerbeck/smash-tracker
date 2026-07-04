/**
 * Test stub for react-chartjs-2, aliased in vitest.config.ts. jsdom has no
 * canvas implementation, so real chart components flood test output with
 * "Not implemented: getContext" / "Failed to create chart" noise. Chart DATA
 * correctness is covered by each chart's exported pure builder functions;
 * component tests only need a stable placeholder to assert presence.
 */
interface ChartStubProps {
  data?: unknown;
  options?: unknown;
}

function makeStub(type: string) {
  return function ChartStub(_props: ChartStubProps) {
    return <div data-testid="chartjs-stub" data-chart-type={type} role="img" />;
  };
}

export const Line = makeStub('line');
export const Bar = makeStub('bar');
export const Doughnut = makeStub('doughnut');
export const Pie = makeStub('pie');
export const Radar = makeStub('radar');
export const Scatter = makeStub('scatter');
