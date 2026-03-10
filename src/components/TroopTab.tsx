/**
 * @fileoverview 部队管理标签页组件
 * @description 展示当前玩家的部队列表，支持选中部队（切换相机跟随）、删除部队和创建部队。
 *
 * 交互设计：
 *   - 点击部队卡片：选中该部队，相机切换到部队跟随视角
 *   - 右键部队卡片：复制部队 ID 到剪贴板（开发调试便利）
 *   - 删除按钮：确认弹窗后发送 deleteTroop 指令
 *   - 创建部队按钮：发送 createTroop 指令，服务端在玩家城市附近生成新部队
 *
 * @author WildMap Team
 */
import React, { useState, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import type { TroopData } from '../types/game';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

interface TroopTabProps {
  ws: UseWebSocketReturn;
}

/**
 * 将部队状态数字转换为 CSS 类名和显示文字
 * 部队状态位掩码：1=空闲 2=行军 4=采集 8=驻守
 * @param state - 部队行为状态值
 */
function getTroopStatus(state: number): { css: string; text: string } {
  switch (state) {
    case 2:  return { css: 'moving',    text: '🚶 行军' };
    case 4:  return { css: 'gathering', text: '⛏️ 采集' };
    case 8:  return { css: 'garrison',  text: '🛡️ 驻守' };
    default: return { css: 'idle',      text: '⏸️ 空闲' };
  }
}

/**
 * 复制文本到剪贴板
 * 优先使用 navigator.clipboard API（需 HTTPS 或 localhost），
 * 降级使用 document.execCommand（兼容旧环境）。
 */
async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('复制失败'));
    } catch (err) {
      document.body.removeChild(ta);
      reject(err);
    }
  });
}

/**
 * 单条部队卡片组件
 * 包含：部队 ID、行为状态、坐标显示，以及选中/删除交互。
 */
const TroopItem: React.FC<{
  troop: TroopData;
  isActive: boolean;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
}> = ({ troop, isActive, onSelect, onDelete }) => {
  const [notification, setNotification] = useState<{ msg: string; error: boolean } | null>(null);
  const notifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { css, text } = getTroopStatus(troop.state);

  /** 右键复制部队 ID，短暂显示操作结果浮层 */
  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyToClipboard(troop.id.toString());
      showNotif(`已复制部队ID: ${troop.id}`, false);
    } catch {
      showNotif('复制失败', true);
    }
  };

  const showNotif = (msg: string, error: boolean) => {
    if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
    setNotification({ msg, error });
    notifTimerRef.current = setTimeout(() => setNotification(null), 1500);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(troop.id);
  };

  return (
    <div
      className={`troop-item${isActive ? ' active' : ''}`}
      onClick={() => onSelect(troop.id)}
      onContextMenu={handleContextMenu}
      style={{ position: 'relative' }}
    >
      <div className="troop-item-header">
        <span className="troop-item-id">⚔️ 部队 #{troop.id}</span>
        <div className="troop-item-header-right">
          <span className={`troop-item-status ${css}`}>{text}</span>
          <button
            className="btn-delete-troop"
            onClick={handleDeleteClick}
            title="删除部队"
          >
            🗑️
          </button>
        </div>
      </div>
      <div className="troop-item-pos">
        坐标: ({Math.round(troop.position.x)}, {Math.round(troop.position.z)})
      </div>

      {notification && (
        <div
          className="copy-notification"
          style={{
            background: notification.error
              ? 'rgba(237, 66, 69, 0.95)'
              : 'rgba(87, 242, 135, 0.95)',
          }}
        >
          {notification.msg}
        </div>
      )}
    </div>
  );
};

export const TroopTab: React.FC<TroopTabProps> = ({ ws }) => {
  const troops         = useGameStore(s => s.troops);
  const currentPid     = useGameStore(s => s.currentPlayerId);
  const isPlayerJoined = useGameStore(s => s.isPlayerJoined);
  const selectedId     = useGameStore(s => s.selectedTroopId);
  const setSelectedId  = useGameStore(s => s.setSelectedTroopId);
  const setViewMode    = useGameStore(s => s.setViewMode);

  const myTroops: TroopData[] = Array.from(troops.values())
    .filter(t => t.owner === currentPid);

  /** 选中部队并切换相机到部队跟随视角 */
  const handleSelect = (id: number) => {
    setSelectedId(id);
    setViewMode('troop');
  };

  const handleDelete = (id: number) => {
    if (!isPlayerJoined) { alert('请先加入游戏！'); return; }
    const troop = troops.get(id);
    if (!troop) { alert('部队不存在！'); return; }
    if (troop.owner !== currentPid) { alert('不能删除其他玩家的部队！'); return; }
    if (!confirm(`确定要删除部队 #${id} 吗？`)) return;

    ws.sendMessage({ kind: 'deleteTroop', data: { troop_id: id } });
    if (selectedId === id) setViewMode('free');
  };

  const handleCreate = () => {
    if (!isPlayerJoined) { alert('请先加入游戏！'); return; }
    ws.sendMessage({ kind: 'createTroop' });
  };

  return (
    <div>
      <div className="troop-list-header">
        <div className="troop-list-header-title">🎯 我的部队列表</div>
        <button className="btn btn-success" onClick={handleCreate}>
          ➕ 创建部队
        </button>
      </div>

      <div className="troop-list">
        {myTroops.length === 0 ? (
          <p className="troop-empty-tip">暂无部队</p>
        ) : (
          myTroops.map(troop => (
            <TroopItem
              key={troop.id}
              troop={troop}
              isActive={troop.id === selectedId}
              onSelect={handleSelect}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  );
};
