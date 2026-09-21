// src/context/SelectionContext.tsx
import React, { createContext, useContext, ReactNode, useState } from "react";

interface SelectionContextValue {
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
}

const SelectionContext = createContext<SelectionContextValue>(
  {} as SelectionContextValue
);

export const SelectionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  return (
    <SelectionContext.Provider value={{ selectedAgentId, setSelectedAgentId }}>
      {children}
    </SelectionContext.Provider>
  );
};

export const useSelection = () => useContext(SelectionContext);
