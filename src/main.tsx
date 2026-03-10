/**
 * @fileoverview 应用入口文件
 * @description React 应用挂载点，导入全局样式并将根组件挂载到 DOM。
 *              使用 StrictMode 在开发环境中启用额外的运行时检查和警告。
 *
 * @author WildMap Team
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('[main.tsx] 找不到 #root 挂载点，请检查 public/index.html 中的 <div id="root"> 是否存在');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
