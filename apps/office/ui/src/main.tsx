import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { fixtureOfficeDataSource } from './data/FixtureOfficeDataSource';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App dataSource={fixtureOfficeDataSource} />
  </StrictMode>,
);
