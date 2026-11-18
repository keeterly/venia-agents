import React from 'react';
import { createRoot } from 'react-dom/client';
import '@excalidraw/excalidraw/index.css';
import './styles.css';
import App from './App.jsx';
import { store } from './store.js';
import { inHost, tellHost } from './host.js';

document.documentElement.classList.toggle('in-host', inHost);

store.init().then(() => {
  createRoot(document.getElementById('root')).render(<App />);
  tellHost('boards:ready', { mode: store.mode });
});
