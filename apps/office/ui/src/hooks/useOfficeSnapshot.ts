import { useEffect, useState } from 'react';

import { useOfficeDataSource } from '../context/OfficeDataContext';
import type { OfficeSnapshot } from '../data/types';

export function useOfficeSnapshot(): OfficeSnapshot | null {
  const dataSource = useOfficeDataSource();
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => dataSource.getSnapshot().then((nextSnapshot) => {
      if (active) setSnapshot(nextSnapshot);
    });
    void refresh();
    const unsubscribe = dataSource.subscribe(refresh);

    return () => {
      active = false;
      unsubscribe();
    };
  }, [dataSource]);

  return snapshot;
}
