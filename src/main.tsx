import React from 'react';
import ReactDOM from 'react-dom/client';
import WorkspaceLayout from './components/WorkspaceLayout';
import '@/src/styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkspaceLayout />
  </React.StrictMode>
);
