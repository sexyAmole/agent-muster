import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import './app/style.css';
import { MessageProvider } from './shared/components/message';

createRoot(document.getElementById('root')!).render(<MessageProvider><App /></MessageProvider>);
