/**
 * @fileoverview 主应用根组件
 * @description 定义应用的整体布局结构：左侧 3D 地图区域 + 右侧控制面板。
 *
 * 布局示意：
 *   ┌──────────────────────────────┬────────────┐
 *   │         3D 地图区域           │  右侧面板   │
 *   │   ┌─── GameScene (R3F) ───┐  │ - StatusBar│
 *   │   │   WebGL Canvas        │  │ - TabPanel │
 *   │   └───────────────────────┘  │            │
 *   └──────────────────────────────┴────────────┘
 *
 * 全屏遮罩（JoinPanel）在未登录时覆盖整个视口，优先级高于主布局。
 * MessageContainer 固定在视口右上角，层级最高（z-index: 9999）。
 *
 * @author WildMap Team
 */
import React from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { JoinPanel } from './components/JoinPanel';
import { StatusBar } from './components/StatusBar';
import { TabPanel } from './components/TabPanel';
import { GameScene } from './three/GameScene';
import { MessageContainer } from './components/MessagePopup';
import { GatherActionMenu } from './components/GatherActionMenu';

const App: React.FC = () => {
  const ws = useWebSocket();

  return (
    <div className="game-container">
      {/* 3D 地图层 - 底层全屏铺满 */}
      <div className="map-layer">
        <GameScene ws={ws} />
      </div>

      {/* UI 悬浮层 - 顶层脱离文档流 */}
      <div className="ui-layer">
        <div className="right-panel">
          <StatusBar ws={ws} />
          <TabPanel ws={ws} />
        </div>
      </div>

      <JoinPanel ws={ws} />

      {/* 资源点采集菜单（点击资源点后弹出，z-index 在地图层之上、JoinPanel 之下） */}
      <GatherActionMenu ws={ws} />

      <MessageContainer />
    </div>
  );
};

export default App;
