import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const Root = /^\/admin\/?$/.test(location.pathname) ? lazy(()=>import('./admin/AdminApp.jsx')) : App;
const loading = new URLSearchParams(location.search).get('lang') === 'kk' ? 'Жүктелуде…' : 'Загрузка…';
createRoot(document.getElementById('root')).render(<React.StrictMode><Suspense fallback={<main className="bootstrap-state"><p role="status">{loading}</p></main>}><Root /></Suspense></React.StrictMode>);
