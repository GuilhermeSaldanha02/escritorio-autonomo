import type { OfficeDataSource } from './data/OfficeDataSource';
import { OfficeDataProvider } from './context/OfficeDataContext';
import { SelectionProvider } from './context/SelectionContext';
import Dashboard from './components/Dashboard';
import Inspector from './components/Inspector';
import OfficeCanvas from './components/OfficeCanvas';
import Timeline from './components/Timeline';
import { officeThemeStyle } from './office/theme';
import './App.css';

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
            <div className="office-workspace">
              <OfficeCanvas />
              <Inspector />
            </div>
            <Timeline />
          </main>
        </div>
      </SelectionProvider>
    </OfficeDataProvider>
  );
}
