import type { OfficeDataSource } from './OfficeDataSource';
import { fixtureOfficeDataSource } from './FixtureOfficeDataSource';
import { LiveOfficeDataSource } from './LiveOfficeDataSource';

export function createOfficeDataSource(mode: string | undefined): OfficeDataSource {
  if (mode === undefined || mode === 'fixture') return fixtureOfficeDataSource;
  if (mode === 'live') return new LiveOfficeDataSource();
  throw new Error('VITE_OFFICE_MODE deve ser fixture ou live');
}
