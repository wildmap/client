/**
 * @fileoverview 功能标签页容器组件
 * @description 渲染顶部导航标签栏和对应的内容区域，包含三个功能面板：
 *              部队管理 / 地图显示控制 / Lua 脚本执行器。
 *
 * 状态说明：
 *   - 未登录（!isPlayerJoined）时整个面板不渲染，避免渲染空数据。
 *   - activeTab 状态存储在 gameStore，保证标签切换时状态跨组件持久。
 *
 * @author WildMap Team
 */
import React from 'react';
import { useGameStore } from '../store/gameStore';
import { TroopTab } from './TroopTab';
import { MapTab } from './MapTab';
import { LuaTab } from './LuaTab';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

interface TabPanelProps {
  ws: UseWebSocketReturn;
}

type TabKey = 'troop' | 'map' | 'game';

/** 标签导航项定义（图标 + 标识 + 显示名称） */
const TAB_DEFS: Array<{ key: TabKey; icon: string; label: string }> = [
  { key: 'troop', icon: '⚔️', label: '部队管理' },
  { key: 'map',   icon: '🗺️', label: '地图显示' },
  { key: 'game',  icon: '💻', label: 'Lua执行器' },
];

export const TabPanel: React.FC<TabPanelProps> = ({ ws }) => {
  const isPlayerJoined = useGameStore(s => s.isPlayerJoined);
  const activeTab      = useGameStore(s => s.activeTab);
  const setActiveTab   = useGameStore(s => s.setActiveTab);

  if (!isPlayerJoined) return null;

  return (
    <div className="tab-container">
      {/* 使用 role="tablist" + 各项 role="tab" 符合 WAI-ARIA Tab 规范，支持键盘导航 */}
      <div className="tab-nav" role="tablist" aria-label="功能面板">
        {TAB_DEFS.map(({ key, icon, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={activeTab === key}
            aria-controls={`tab-panel-${key}`}
            id={`tab-btn-${key}`}
            className={`tab-nav-item${activeTab === key ? ' active' : ''}`}
            onClick={() => setActiveTab(key)}
            type="button"
          >
            <span className="icon" aria-hidden="true">{icon}</span>
            {label}
          </button>
        ))}
      </div>

      <div
        className="tab-content"
        role="tabpanel"
        id={`tab-panel-${activeTab}`}
        aria-labelledby={`tab-btn-${activeTab}`}
      >
        {activeTab === 'troop' && <TroopTab ws={ws} />}
        {activeTab === 'map'   && <MapTab />}
        {activeTab === 'game'  && <LuaTab ws={ws} />}
      </div>
    </div>
  );
};
