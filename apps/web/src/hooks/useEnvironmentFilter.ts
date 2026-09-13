import { rememberedChoice, useRemembered } from './rememberedChoice';

/**
 * Which environment's portfolios to show, remembered across pages.
 *
 * `null` shows all of them. Otherwise it is an environment name, and the
 * filtering happens in the browser rather than the API: the list is already
 * fetched and small, and a portfolio's environment is on every row.
 */
const store = rememberedChoice('zusu.environmentFilter');

export function useEnvironmentFilter(): {
  environment: string | null;
  setEnvironment: (environment: string | null) => void;
} {
  const { value, set } = useRemembered(store);
  return { environment: value, setEnvironment: set };
}
