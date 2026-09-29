// App bootstrap / entry point. Mounts <App> into #root inside React.StrictMode,
// wrapped with the router (BrowserRouter) and two global providers: DialogHost
// (renders imperatively-triggered confirm/prompt dialogs) and ToastContainer
// (react-toastify notifications). Also pulls in the global stylesheet.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import App from './App.jsx';
import { DialogHost } from './components/dialogs.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <DialogHost />
      {/* SMALL, SHORT, AT THE BOTTOM (2026-09-29, user — same as the app):
          a translucent dark pill, ~2 s, no progress bar or ×; a click
          dismisses it. index.css "Toasts — bottom pill" draws it. */}
      <ToastContainer
        position="bottom-center"
        autoClose={2000}
        hideProgressBar
        closeButton={false}
        limit={2}
        closeOnClick
        pauseOnHover
        draggable
        theme="light"
        style={{ zIndex: 100000 }}
      />
    </BrowserRouter>
  </React.StrictMode>
);
