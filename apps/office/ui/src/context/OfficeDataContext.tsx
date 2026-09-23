import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { OfficeDataSource } from '../data/OfficeDataSource';
import type { OfficeSnapshot } from '../data/types';

interface OfficeContextValue {
  dataSource: OfficeDataSource;
  snapshot: OfficeSnapshot | null;
  error: string | null;
}
const OfficeDataContext = createContext<OfficeContextValue | null>(null);

export function useOfficeData(): OfficeContextValue {
  const value = useContext(OfficeDataContext);
  if (!value) throw new Error('OfficeDataProvider é obrigatório para consumir os dados do Office.');
  return value;
}

export function useOfficeDataSource(): OfficeDataSource { return useOfficeData().dataSource; }

export function OfficeDataProvider({ dataSource, children }: { dataSource: OfficeDataSource; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void dataSource.getSnapshot().then(next => {
        if (active) { setSnapshot(next); setError(null); }
      }).catch(() => {
        if (active) setError('Office LIVE indisponível. Verifique a API local.');
      });
    };
    const unsubscribe = dataSource.subscribe(refresh);
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [dataSource]);
  return <OfficeDataContext.Provider value={{ dataSource, snapshot, error }}>{children}</OfficeDataContext.Provider>;
}
