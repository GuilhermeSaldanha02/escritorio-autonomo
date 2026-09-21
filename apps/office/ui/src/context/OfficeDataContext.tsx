import { createContext, useContext, type ReactNode } from 'react';

import type { OfficeDataSource } from '../data/OfficeDataSource';

const OfficeDataContext = createContext<OfficeDataSource | null>(null);

export function useOfficeDataSource(): OfficeDataSource {
  const dataSource = useContext(OfficeDataContext);
  if (dataSource === null) {
    throw new Error('OfficeDataProvider é obrigatório para consumir os dados do Office.');
  }
  return dataSource;
}

export function OfficeDataProvider({ dataSource, children }: { dataSource: OfficeDataSource; children: ReactNode }) {
  return <OfficeDataContext.Provider value={dataSource}>{children}</OfficeDataContext.Provider>;
}
