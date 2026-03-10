/**
 * @fileoverview 登录/加入游戏面板组件
 * @description 全屏遮罩层内的登录弹窗，包含服务器地址和玩家 ID 输入。
 *              玩家加入成功（isPlayerJoined=true）后面板自动隐藏，无需手动关闭。
 *
 * 交互设计：
 *   - 服务器地址输入框按 Enter 自动跳转到玩家 ID 输入框（Tab 顺序优化）
 *   - 玩家 ID 输入框按 Enter 直接触发加入操作
 *   - 上次连接的地址和 ID 通过 localStorage 记忆，提升重连体验
 *   - 连接中状态禁用表单，防止重复提交
 *
 * @author WildMap Team
 */
import React, { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { showError } from '../store/messageStore';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

interface JoinPanelProps {
  ws: UseWebSocketReturn;
}

export const JoinPanel: React.FC<JoinPanelProps> = ({ ws }) => {
  const isPlayerJoined   = useGameStore(s => s.isPlayerJoined);
  const connectionStatus = useGameStore(s => s.connectionStatus);

  const [serverUrl, setServerUrl] = useState<string>('');
  const [playerId,  setPlayerId]  = useState<string>('1');
  const [isLoading, setIsLoading] = useState(false);

  const serverInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const savedUrl = localStorage.getItem('game_server_url') || 'localhost:8080';
    const savedPid = localStorage.getItem('game_player_id') || '1';
    setServerUrl(savedUrl);
    setPlayerId(savedPid);
  }, []);

  useEffect(() => {
    if (connectionStatus === 'error' || connectionStatus === 'disconnected') {
      setIsLoading(false);
    }
    if (isPlayerJoined) {
      setIsLoading(false);
    }
  }, [connectionStatus, isPlayerJoined]);

  useEffect(() => {
    const timer = setTimeout(() => {
      serverInputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const handleJoin = () => {
    const trimmedUrl = serverUrl.trim();
    if (!trimmedUrl) {
      showError('请输入服务端地址！');
      return;
    }
    const pidNum = parseInt(playerId.trim(), 10);
    if (!playerId.trim() || isNaN(pidNum)) {
      showError('玩家 ID 必须是有效的数字！');
      return;
    }

    setIsLoading(true);
    ws.connect(trimmedUrl, pidNum);
  };

  const handleServerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('join-player-id-input')?.focus();
    }
  };

  const handlePlayerIdKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleJoin();
    }
  };

  const visible = !isPlayerJoined;

  return (
    <div className={`overlay-mask${visible ? ' show' : ''}`}>
      <div className="join-panel">
        <h2>🚀 战局准入</h2>
        <p>配置服务端节点与指挥官标识以接入战场</p>

        <div className="join-input-group">
          <label htmlFor="join-server-url-input">📡 服务端节点地址</label>
          <input
            id="join-server-url-input"
            ref={serverInputRef}
            type="text"
            className="join-input"
            placeholder="例如: localhost:8080 或 game.example.com"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            onKeyDown={handleServerKeyDown}
            disabled={isLoading}
          />
        </div>

        <div className="join-input-group">
          <label htmlFor="join-player-id-input">🆔 战术指挥官标识 (ID)</label>
          <input
            id="join-player-id-input"
            type="number"
            className="join-input"
            placeholder="请输入玩家ID"
            value={playerId}
            onChange={e => setPlayerId(e.target.value)}
            onKeyDown={handlePlayerIdKeyDown}
            disabled={isLoading}
          />
        </div>

        <button
          className="join-btn"
          onClick={handleJoin}
          disabled={isLoading}
        >
          {isLoading ? '建立神经连接中...' : '接入战场'}
        </button>
      </div>
    </div>
  );
};
