// src/components/__tests__/Inspector.test.tsx
import React from "react";
import { render, screen } from "@testing-library/react";
import { OfficeDataProvider } from "../../context/OfficeDataContext";
import { SelectionProvider, useSelection } from "../../context/SelectionContext";
import Inspector from "../Inspector";

// Helper component to set a selected agent ID.
const SetSelection: React.FC<{ id: string }> = ({ id }) => {
  const { setSelectedAgentId } = useSelection();
  React.useEffect(() => {
    setSelectedAgentId(id);
  }, [id, setSelectedAgentId]);
  return null;
};

test("Inspector displays details of the selected agent", async () => {
  render(
    <OfficeDataProvider>
      <SelectionProvider>
        <SetSelection id="agent-1" />
        <Inspector />
      </SelectionProvider>
    </OfficeDataProvider>
  );

  // Wait for inspector to load data (snapshot fetch).
  expect(await screen.findByText(/Agent Inspector/i)).toBeInTheDocument();
  // The fixture should contain an agent with id "agent-1" (adjust if different).
  expect(screen.getByText(/ID:/i)).toBeInTheDocument();
  expect(screen.getByText(/agent-1/i)).toBeInTheDocument();
});
