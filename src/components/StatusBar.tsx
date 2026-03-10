/**
 * @fileoverview 状态栏组件
 * @description 显示实时连接状态、当前玩家信息（名称、ID、城市坐标）及登出操作。
 *              城市坐标可点击，触发相机切换到城市俯视视角。
 *
 * @author WildMap Team
 */
import React from 'react';
import { useGameStore } from '../store/gameStore';
import type { ConnectionStatus } from '../types/game';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

/**
 * 将连接状态枚举值转换为用户可读的中文文本
 * @param status - 当前连接状态
 */
function getStatusText(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':    return '已连接';
    case 'connecting':   return '连接中...';
    case 'reconnecting': return '重连中...';
    case 'error':        return '连接错误';
    case 'disconnected': default: return '等待配置';
  }
}

interface StatusBarProps {
  ws: UseWebSocketReturn;
}

export const StatusBar: React.FC<StatusBarProps> = ({ ws }) => {
  const connectionStatus  = useGameStore(s => s.connectionStatus);
  const isPlayerJoined    = useGameStore(s => s.isPlayerJoined);
  const currentPlayerData = useGameStore(s => s.currentPlayerData);
  const setViewMode       = useGameStore(s => s.setViewMode);

  const isOnline = connectionStatus === 'connected';

  const handleLogout = () => {
    if (!confirm('确定要登出吗？')) return;
    ws.disconnect();
  };

  /** 点击城市坐标切换到城市跟随视角 */
  const handleCityClick = () => {
    setViewMode('city');
  };

  const playerName = currentPlayerData?.name ?? '--';
  const cityCoord  = currentPlayerData?.city_pos
    ? `(${Math.round(currentPlayerData.city_pos.x)}, ${Math.round(currentPlayerData.city_pos.z)})`
    : '--';

  return (
    <div className="status-bar">
      <div className="status-item">
        <span className="status-label">📡</span>
        <div className="status-right">
          <span
            className={`status-value ${isOnline ? 'connection-online' : 'connection-offline'}`}
          >
            {getStatusText(connectionStatus)}
          </span>
          {isPlayerJoined && (
            <button className="btn-logout-inline" onClick={handleLogout}>
              登出
            </button>
          )}
        </div>
      </div>

      {isPlayerJoined && (
        <div className="status-item">
          <span className="status-label">👤</span>
          <span className="status-value">{playerName}</span>
        </div>
      )}

      {isPlayerJoined && currentPlayerData && (
        <div className="status-item">
          <span className="status-label">🆔</span>
          <span className="status-value">{currentPlayerData.id}</span>
        </div>
      )}

      {isPlayerJoined && (
        <div className="status-item">
          <span className="status-label">📍</span>
          <span
            className="status-value clickable"
            title="点击切换到城市视角"
            onClick={handleCityClick}
          >
            {cityCoord}
          </span>
        </div>
      )}
    </div>
  );
};
