// src/components/__tests__/Dashboard.test.tsx
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import Dashboard from "../Dashboard";
import { OfficeDataProvider } from "../../context/OfficeDataContext";

// The fixture data source provides a static snapshot; we rely on it.

test("Dashboard renders metrics and flags", async () => {
  render(
    <OfficeDataProvider>
      <Dashboard />
    </OfficeDataProvider>
  );

  // Initially shows loading state.
  expect(screen.getByText(/Loading dashboard.../i)).toBeInTheDocument();

  // Wait for snapshot to load.
  await waitFor(() => {
    expect(screen.getByText(/Metrics/i)).toBeInTheDocument();
  });

  // Verify a few metric cells are present (values depend on fixture).
  const cashRealCell = screen.getByText(/Cash \(Real\)/i);
  expect(cashRealCell).toBeInTheDocument();
  // The adjacent cell should contain a number.
  const cashRealValue = cashRealCell.parentElement?.nextElementSibling;
  expect(cashRealValue?.textContent).toMatch(/\d+/);

  // Verify status flags are rendered.
  expect(screen.getByText(/Autonomy Enabled:/i)).toBeInTheDocument();
});
