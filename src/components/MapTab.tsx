/**
 * @fileoverview 地图显示设置标签页组件
 * @description 提供导航网格、障碍物、瓦片网格、寻路路径四个地图图层的显示/隐藏切换按钮。
 *              按钮激活状态（active class）反映当前图层的显示状态。
 *
 * @author WildMap Team
 */
import React from 'react';
import { useGameStore } from '../store/gameStore';
import type { DisplayState } from '../types/game';

export const MapTab: React.FC = () => {
  const display      = useGameStore(s => s.display);
  const toggleDisplay = useGameStore(s => s.toggleDisplay);

  const buttons: Array<{ key: keyof DisplayState; label: string }> = [
    { key: 'navMesh',   label: '导航网格' },
    { key: 'obstacles', label: '障碍物' },
    { key: 'tiles',     label: '瓦片网格' },
    { key: 'path',      label: '寻路路径' },
  ];

  return (
    <div className="button-group grid">
      {buttons.map(({ key, label }) => (
        <button
          key={key}
          className={`btn btn-toggle${display[key] ? ' active' : ''}`}
          onClick={() => toggleDisplay(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
};
