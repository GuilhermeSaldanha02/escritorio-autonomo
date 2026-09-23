import type { OfficeDataSource } from './data/OfficeDataSource';
import { OfficeDataProvider } from './context/OfficeDataContext';
import { SelectionProvider } from './context/SelectionContext';
import Dashboard from './components/Dashboard';
import Inspector from './components/Inspector';
import OfficeCanvas from './components/OfficeCanvas';
import Timeline from './components/Timeline';
import { useSelection } from './context/SelectionContext';
import { officeThemeStyle } from './office/theme';
import { getWorkspaceClassName } from './workspace-layout';
import './App.css';
import { useOfficeLoadError, useOfficeSnapshot } from './hooks/useOfficeSnapshot';

function OfficeHeader() {
  const snapshot = useOfficeSnapshot();
  const error = useOfficeLoadError();
  return <>
    <header className="office-header">
      <div><p className="eyebrow">Escritório Autônomo</p><h1>Centro de operações</h1></div>
      <p>{snapshot?.mode === 'LIVE' ? `Projeção read-only · ${snapshot.metadata.connection}` : snapshot?.mode === 'DEMO' ? 'Projeção visual read-only · dados locais de demonstração' : 'Projeção visual read-only'}</p>
    </header>
    {error && <p role="status" className="office-loading">{error}</p>}
  </>;
}

function OfficeWorkspace() {
  const { selectedAgentId } = useSelection();

  return (
    <div className={getWorkspaceClassName(selectedAgentId)}>
      <OfficeCanvas />
      <Inspector />
    </div>
  );
}

export default function App({ dataSource }: { dataSource: OfficeDataSource }) {
  return (
    <OfficeDataProvider dataSource={dataSource}>
      <SelectionProvider>
        <div className="office-app" style={officeThemeStyle}>
          <OfficeHeader />
          <main>
            <Dashboard />
            <OfficeWorkspace />
            <Timeline />
          </main>
        </div>
      </SelectionProvider>
    </OfficeDataProvider>
  );
}
