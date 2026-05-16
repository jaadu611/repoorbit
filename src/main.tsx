import React from 'react';
import ReactDOM from 'react-dom/client';
import WorkspaceLayout from '@/components/WorkspaceLayout';
import '@/src/styles/globals.css';

// Mock state or receive from VS Code
const mockProps = {
  repoUrl: undefined,
  activeMode: 'tree',
  filter: '',
  fullRepoData: null,
  treeRoot: null,
  error: null,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="h-screen w-screen overflow-hidden bg-gray-950">
       <WorkspaceLayout {...mockProps} />
    </div>
  </React.StrictMode>
);
