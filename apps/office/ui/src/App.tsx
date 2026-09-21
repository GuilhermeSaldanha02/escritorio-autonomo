import React from "react";
import { OfficeDataProvider } from "./context/OfficeDataContext";
import { SelectionProvider } from "./context/SelectionContext";
import Dashboard from "./components/Dashboard";
import Inspector from "./components/Inspector";
import Timeline from "./components/Timeline";
import OfficeCanvas from "./components/OfficeCanvas";
import "./App.css";

function App() {
  return (
    <OfficeDataProvider>
      <SelectionProvider>
        <div className="m7-ui-root">
          <header className="m7-header">
            <h1>M7 Office UI</h1>
          </header>
          <main className="m7-main">
            <section className="m7-dashboard">
              <Dashboard />
            </section>
            <section className="m7-canvas">
              <OfficeCanvas />
            </section>
            <section className="m7-inspector">
              <Inspector />
            </section>
            <section className="m7-timeline">
              <Timeline />
            </section>
          </main>
        </div>
      </SelectionProvider>
    </OfficeDataProvider>
  );
}

export default App;


