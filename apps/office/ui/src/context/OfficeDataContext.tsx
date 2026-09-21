// src/context/OfficeDataContext.tsx

import React, { createContext, useContext, ReactNode } from "react";
import type { OfficeDataSource } from "../data/OfficeDataSource";
import { fixtureOfficeDataSource } from "../data/FixtureOfficeDataSource";

/**
 * React context that provides the OfficeDataSource implementation.
 * The default implementation is the in‑memory FixtureOfficeDataSource (demo mode).
 */
const OfficeDataContext = createContext<OfficeDataSource>(fixtureOfficeDataSource);

/** Hook to access the current OfficeDataSource. */
export const useOfficeDataSource = () => useContext(OfficeDataContext);

interface ProviderProps {
  /** Allows swapping the data source (e.g., in tests). */
  dataSource?: OfficeDataSource;
  children: ReactNode;
}

/** Provider component that injects the chosen data source into the React tree. */
export const OfficeDataProvider: React.FC<ProviderProps> = ({ dataSource, children }) => {
  const source = dataSource ?? fixtureOfficeDataSource;
  return <OfficeDataContext.Provider value={source}>{children}</OfficeDataContext.Provider>;
};
