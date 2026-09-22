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
          <header className="office-header">
            <div>
              <p className="eyebrow">Escritório Autônomo</p>
              <h1>Centro de operações</h1>
            </div>
            <p>Projeção visual read-only · dados locais de demonstração</p>
          </header>
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
