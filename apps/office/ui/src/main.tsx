import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createOfficeDataSource } from './data/createOfficeDataSource';
import App from './App';
import './index.css';

const dataSource = createOfficeDataSource(import.meta.env.VITE_OFFICE_MODE);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App dataSource={dataSource} />
  </StrictMode>,
);
