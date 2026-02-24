import React from 'react';
import ReactDOM from 'react-dom/client';

import { initAppearance } from './themes/appearance-store';
import './themes/colors-base.css';
import './themes/colors-extra.css';
import './themes/typefaces.css';
import './sidebar/sidebar-styles.css';
import './themes/canvas-styles.css';
import './themes/spacing-presets.css';
import './tweet-compose/tweet-compose.css';
import './article-compose/ArticleComposeView.css';
import App from './App';
import './App.css';

initAppearance();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
