/**
 * Fixture locale object for `insightCopy.test.ts` (Phase 39.1 Plan 09,
 * UI-SPEC §13.8). Never the real locale files — a small, deliberately
 * mixed object proving each of the six locales' second-person patterns AND
 * the probability-phrasing pattern fire on a known-bad value, while several
 * clean values alongside them prove the guard does not fire on ordinary
 * copy. Plan 39.1-11 repoints `insightCopy.test.ts`'s single exported scan
 * target at the six real locale JSON files under
 * `apps/web/src/i18n/locales/`; this fixture is never edited by that plan.
 *
 * The `insights` namespace holds the guard's real scan surface. The
 * `unrelated` namespace holds a second-person string OUTSIDE that
 * namespace — proving D-05's scoping (the app's existing second-person
 * copy elsewhere is left alone) does not accidentally get swept in.
 */
export interface FixtureLocaleTree {
  insights: Record<string, string>;
  unrelated: Record<string, string>;
}

export const fixtureLocales: Record<string, FixtureLocaleTree> = {
  en: {
    insights: {
      cleanVerdict: 'win rate down 6 pts over the last 20 games',
      offendingSecondPerson: 'your win rate is down 6 pts over the last 20 games',
      cleanRate: 'observed rate 62% over 20 games',
      offendingProbability: 'a 70% chance the trend will continue',
    },
    unrelated: {
      existingSecondPerson: 'update your profile to continue',
    },
  },
  es: {
    insights: {
      cleanVerdict: 'tasa de victorias baja 6 pts en los últimos 20 partidos',
      offendingSecondPerson: 'tu tasa de victorias bajó 6 pts en los últimos 20 partidos',
      cleanRate: 'tasa observada 62% en 20 partidos',
      offendingProbability: 'una probabilidad del 70% de que continúe la tendencia',
    },
    unrelated: {
      existingSecondPerson: 'actualiza tu perfil para continuar',
    },
  },
  fr: {
    insights: {
      cleanVerdict: 'taux de victoires en baisse de 6 pts sur les 20 derniers matchs',
      offendingSecondPerson: 'votre taux de victoires a baissé de 6 pts sur les 20 derniers matchs',
      cleanRate: 'taux observé de 62% sur 20 matchs',
      offendingProbability: 'probabilité de 70% que la tendance se poursuive',
    },
    unrelated: {
      existingSecondPerson: 'mettez à jour votre profil pour continuer',
    },
  },
  de: {
    insights: {
      cleanVerdict: 'Siegquote um 6 Pkt. in den letzten 20 Spielen gesunken',
      offendingSecondPerson: 'deine Siegquote ist um 6 Pkt. in den letzten 20 Spielen gesunken',
      cleanRate: 'beobachtete Quote 62% über 20 Spiele',
      offendingProbability: 'eine Chance von 70%, dass sich der Trend fortsetzt',
    },
    unrelated: {
      existingSecondPerson: 'Aktualisiere dein Profil, um fortzufahren',
    },
  },
  pt: {
    insights: {
      cleanVerdict: 'taxa de vitórias caiu 6 pts nos últimos 20 jogos',
      offendingSecondPerson: 'sua taxa de vitórias caiu 6 pts nos últimos 20 jogos',
      cleanRate: 'taxa observada de 62% em 20 jogos',
      offendingProbability: 'uma chance de 70% de que a tendência continue',
    },
    unrelated: {
      existingSecondPerson: 'atualize seu perfil para continuar',
    },
  },
  ja: {
    insights: {
      cleanVerdict: '過去20試合で勝率が6ポイント下降',
      offendingSecondPerson: 'あなたの勝率は過去20試合で6ポイント下降しました',
      cleanRate: '20試合で観測された勝率は62%',
      offendingProbability: 'この傾向が続く確率は70%',
    },
    unrelated: {
      existingSecondPerson: '続行するにはあなたのプロフィールを更新してください',
    },
  },
};
