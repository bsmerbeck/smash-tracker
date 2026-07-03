import { AppProviders } from '@/providers/AppProviders';
import { AppRouter } from '@/routes/AppRouter';

function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}

export default App;
