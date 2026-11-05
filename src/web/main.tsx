import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Host } from './Host';
import { Viewer } from './Viewer';
import './style.css';

function Root() {
  const [compatibility, setCompatibility] = useState(false);
  useEffect(() => {
    if (!window.ghost) return;
    void window.ghost.state().then(state => setCompatibility(state.graphics.compatibility));
    return window.ghost.onState(state => setCompatibility(state.graphics.compatibility));
  }, []);
  return (
  <ConfigProvider locale={zhCN} theme={{ token: {
    motion: !compatibility,
    colorPrimary: '#2563eb', colorText: '#24334a', colorTextSecondary: '#758096',
    colorBgContainer: '#ffffff', colorBorder: '#e2e7ef', borderRadius: 9, controlHeight: 38,
    fontFamily: '"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    fontSize: 13, boxShadow: '0 6px 24px rgba(30, 45, 75, .07)',
  }, components: { Button: { primaryShadow: '0 3px 9px rgba(37,99,235,.18)' }, Modal: { borderRadiusLG: 14 } } }}>
    <AntApp>{window.ghost ? <Host /> : <Viewer />}</AntApp>
  </ConfigProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Root />);
