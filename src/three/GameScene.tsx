/**
 * @fileoverview 主 3D 场景组件
 * @description 整合所有场景元素的根容器，包含光源系统、地图元素、游戏实体和相机控制。
 *
 * 组件层级：
 *   GameScene（Canvas 容器）
 *     └── SceneContents（场景内部，可访问 useThree）
 *           ├── Lights（光源系统）
 *           ├── CameraController（相机控制）
 *           ├── TileGrid（地面底板）
 *           ├── NavMeshLines（导航网格线）
 *           ├── ObstacleMeshes（障碍物山体）
 *           ├── GatherGroup（资源采集点）
 *           ├── PlayerGroup（玩家城堡）
 *           ├── TroopGroup（部队方阵）
 *           └── EntityLabels（LOD 实体名称标签）
 *
 * 光源系统说明：
 *   - 环境光（0xc8ddb8，0.75）：均匀基础照明，带轻微绿调配合草地
 *   - 半球光（天蓝↔草绿）：模拟天空散射，使朝上/朝下面产生冷暖差异
 *   - 主方向光（暖白，3.8，投影）：模拟正午太阳，2048² ShadowMap
 *   - 补光（冷蓝，0.45）：对侧天光补光，减少阴影死黑
 *   - 中央点光源（暖调，distance=900000）：填充大地图的光照空白区域
 *
 * 右键行军指令：
 *   右键点击地图发送 newMarch 指令，使用 Raycaster 与 OrbitControls.target.y
 *   对齐的水平面相交，确保点击坐标与视觉位置一致。
 *
 * LOD 标签策略：
 *   viewSpan < LABEL_SHOW_SPAN_THRESHOLD 时显示城市标签（约 500000 世界单位内）
 *   viewSpan < LABEL_SHOW_SPAN_THRESHOLD × 0.4 时显示部队标签（仅在较近距离）
 *
 * @author WildMap Team
 */
import React, { useCallback, useRef, useMemo, useEffect } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useGameStore } from '../store/gameStore';
import { CameraController } from './CameraController';
import { TileGrid } from './TileGrid';
import { NavMeshLines } from './NavMeshLines';
import { ObstacleMeshes } from './ObstacleMeshes';
import { GatherGroup } from './GatherEntity';
import { PlayerGroup } from './PlayerCityEntity';
import { TroopGroup } from './TroopEntity';
import { sceneToWorld, worldToScene } from '../utils/coordinates';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';
import { TROOP_ENTITY_SIZES, CITY_ENTITY_SIZES } from '../utils/entitySizes';
import { getDeviceProfile } from '../utils/DeviceCapability';

/**
 * 场景光源组件
 * 接受地图中心坐标，用于定位中央填充点光源（跟随地图大小缩放）。
 */
const Lights: React.FC<{ mapCenterX: number; mapCenterZ: number }> = ({
  mapCenterX,
  mapCenterZ,
}) => (
  <>
    <ambientLight color={0xc8ddb8} intensity={0.75} />

    <hemisphereLight
      args={[0xb8d8f0, 0x5a7840, 0.65]}
      position={[0, 1, 0]}
    />

    <directionalLight
      color={0xfff4e0}
      intensity={3.8}
      position={[300000, 240000, 280000]}
      castShadow
      shadow-camera-near={50}
      shadow-camera-far={900000}
      shadow-camera-left={-400000}
      shadow-camera-right={400000}
      shadow-camera-top={400000}
      shadow-camera-bottom={-400000}
      shadow-mapSize-width={2048}
      shadow-mapSize-height={2048}
      shadow-bias={-0.00002}
      shadow-normalBias={0.5}
    />

    <directionalLight
      color={0x90bbdd}
      intensity={0.45}
      position={[-200000, 180000, -150000]}
    />

    <pointLight
      color={0xfff0cc}
      intensity={0.5}
      distance={900000}
      decay={2.0}
      position={[mapCenterX * 0.3, 100000, mapCenterZ * -0.3]}
    />
  </>
);

/**
 * 实体名称标签 LOD 组件
 * 订阅 viewSpan 实现距离 LOD：视野越近显示越多标签。
 * 标签通过 @react-three/drei Html 组件挂载到 3D 世界坐标，
 * 比 CSS2DRenderer 更易集成且支持 Three.js 场景深度。
 */

/** 显示标签的视野宽度阈值（世界坐标跨度），小于此值时显示城市标签 */
const LABEL_SHOW_SPAN_THRESHOLD = 500000;
const MAX_CITY_LABELS  = 20;
const MAX_TROOP_LABELS = 10;

/**
 * 复用向量临时变量，避免在 useMemo 内每次 new THREE.Vector3()。
 * 注意：这些临时变量的作用范围仅限于 useMemo 同步执行期间。
 */
const _labelSp = new THREE.Vector3();
const _labelCamPos = new THREE.Vector3();

const EntityLabels: React.FC = () => {
  const { camera }   = useThree();
  const players      = useGameStore(s => s.players);
  const troops       = useGameStore(s => s.troops);
  const currentPid   = useGameStore(s => s.currentPlayerId);
  const selectedId   = useGameStore(s => s.selectedTroopId);
  const mapCenter    = useGameStore(s => s.mapCenter);
  const tilesData    = useGameStore(s => s.tilesData);
  const terrainCache = useGameStore(s => s.terrainCache);
  const viewSpan     = useGameStore(s => s.viewSpan);
  const xSpan        = viewSpan.x_span;

  /**
   * 按相机距离排序，取最近的 MAX_CITY_LABELS 个城市显示标签。
   * viewSpan.x_span 每 100ms 更新一次，触发 useMemo 重新计算时
   * camera.position 已是当前最新位置（由 CameraController 同步写入）。
   */
  /**
   * 【性能优化】用 plain {x,y,z} 代替 _labelSp.clone() 创建 THREE.Vector3。
   * 原始问题：每次 useMemo 计算（xSpan 每 100ms 变化一次）为每个城市/部队
   *   创建 new THREE.Vector3()（含完整原型链 + 方法），约 20-30 个短命对象。
   * 修复方案：改用 plain object {x, y, z}，更轻量且 V8 可内联优化。
   *   距离计算改用 _labelCamPos 手动平方根，避免依赖 Vector3.distanceTo()。
   * 预期优化效果：减少每 100ms 约 20-30 个 Vector3 对象分配，降低 GC 压力。
   */
  const visibleCities = useMemo(() => {
    if (xSpan >= LABEL_SHOW_SPAN_THRESHOLD) return [];
    _labelCamPos.copy(camera.position);
    const cx = _labelCamPos.x, cy = _labelCamPos.y, cz = _labelCamPos.z;
    return Array.from(players.values())
      .map(p => {
        worldToScene(p.city_pos.x, p.city_pos.z, mapCenter, tilesData, terrainCache, true, _labelSp);
        const sp   = { x: _labelSp.x, y: _labelSp.y, z: _labelSp.z };
        const dx = sp.x - cx, dy = sp.y - cy, dz = sp.z - cz;
        const dist = dx * dx + dy * dy + dz * dz; // 用距离平方排序，省去 Math.sqrt
        return { p, sp, dist };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, MAX_CITY_LABELS);
  }, [players, mapCenter, tilesData, terrainCache, xSpan, camera]);

  /**
   * 部队标签：优先保留选中部队，其余按距离取最近的。
   * 选中部队始终显示，确保玩家能看到自己关注的部队名称。
   */
  const visibleTroops = useMemo(() => {
    if (xSpan >= LABEL_SHOW_SPAN_THRESHOLD * 0.4) return [];
    _labelCamPos.copy(camera.position);
    const cx = _labelCamPos.x, cy = _labelCamPos.y, cz = _labelCamPos.z;
    /** 【性能优化】sp 类型从 THREE.Vector3 改为 plain {x,y,z}，减少原型链分配开销 */
    const result: Array<{ t: typeof troops extends Map<number, infer V> ? V : never; sp: { x: number; y: number; z: number } }> = [];
    if (selectedId !== null) {
      const sel = troops.get(selectedId);
      if (sel) {
        worldToScene(sel.position.x, sel.position.z, mapCenter, tilesData, terrainCache, true, _labelSp);
        result.push({ t: sel, sp: { x: _labelSp.x, y: _labelSp.y, z: _labelSp.z } });
      }
    }
    Array.from(troops.values())
      .filter(t => t.id !== selectedId)
      .map(t => {
        worldToScene(t.position.x, t.position.z, mapCenter, tilesData, terrainCache, true, _labelSp);
        const sp   = { x: _labelSp.x, y: _labelSp.y, z: _labelSp.z };
        const dx = sp.x - cx, dy = sp.y - cy, dz = sp.z - cz;
        const dist = dx * dx + dy * dy + dz * dz;
        return { t, sp, dist };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, MAX_TROOP_LABELS - result.length)
      .forEach(item => result.push({ t: item.t, sp: item.sp }));
    return result;
  }, [troops, selectedId, mapCenter, tilesData, terrainCache, xSpan, camera]);

  return (
    <>
      {visibleCities.map(({ p, sp }) => {
        const blockRadius  = p.block_radius  ?? CITY_ENTITY_SIZES.DEFAULT_BLOCK_RADIUS;
        const occupyRadius = p.occupy_radius ?? blockRadius * CITY_ENTITY_SIZES.OCCUPY_TO_BLOCK_RATIO;
        const baseRadius   = occupyRadius * CITY_ENTITY_SIZES.BASE_RADIUS_RATIO;
        const baseHeight   = baseRadius * 0.22;
        const isMyCity     = p.id === currentPid;

        return (
          <Html
            key={`city_${p.id}`}
            position={[sp.x, sp.y + baseHeight * 3 + 8000, sp.z]}
            center
            distanceFactor={150000}
            style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
            zIndexRange={[100, 0]}
          >
            <div style={{
              background:   isMyCity ? 'rgba(46,115,216,0.85)' : 'rgba(180,90,30,0.85)',
              color:        '#fff',
              padding:      '2px 6px',
              borderRadius: '3px',
              fontSize:     '12px',
              fontWeight:   'bold',
              textShadow:   '0 1px 2px rgba(0,0,0,0.8)',
              border:       '1px solid rgba(255,255,255,0.3)',
            }}>
              {p.name}
            </div>
          </Html>
        );
      })}

      {visibleTroops.map(({ t, sp }) => {
        const rawSize   = (t.occupy_radius ?? (t.block_radius ?? TROOP_ENTITY_SIZES.DEFAULT_BLOCK_RADIUS) * 1.4)
          * TROOP_ENTITY_SIZES.SCALE_FACTOR;
        const unitSize  = Math.max(TROOP_ENTITY_SIZES.MIN_SIZE, Math.min(TROOP_ENTITY_SIZES.MAX_SIZE, rawSize));
        const isMyTroop  = t.owner === currentPid;
        const isSelected = t.id === selectedId;

        return (
          <Html
            key={`troop_${t.id}`}
            position={[sp.x, sp.y + unitSize * 5 + 3000, sp.z]}
            center
            distanceFactor={100000}
            style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
            zIndexRange={[100, 0]}
          >
            <div style={{
              background:   isSelected
                ? 'rgba(255,255,255,0.95)'
                : isMyTroop
                  ? 'rgba(36,94,210,0.85)'
                  : 'rgba(207,93,28,0.85)',
              color:        isSelected ? '#111' : '#fff',
              padding:      '1px 5px',
              borderRadius: '2px',
              fontSize:     '11px',
              fontWeight:   isSelected ? 'bold' : 'normal',
              textShadow:   isSelected ? 'none' : '0 1px 2px rgba(0,0,0,0.8)',
              border:       isSelected ? '2px solid #3fa5ff' : '1px solid rgba(255,255,255,0.3)',
            }}>
              {`⚔️ #${t.id}`}
            </div>
          </Html>
        );
      })}
    </>
  );
};

interface SceneContentsProps {
  ws: UseWebSocketReturn;
  /**
   * OrbitControls 实例引用，由 CameraController 写入，供右键行军坐标计算使用。
   * 需要读取 controls.target.y 作为射线平面高度，确保点击坐标与视觉一致。
   */
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  /**
   * 右键菜单处理函数 ref，SceneContents 将最新的 handleContextMenu 写入此 ref，
   * 父层 GameScene 的外层 div 通过此 ref 调用，避免将 R3F ThreeEvent 误用为 DOM 事件。
   */
  contextMenuHandlerRef: React.MutableRefObject<((e: React.MouseEvent<HTMLDivElement>) => void) | null>;
}

const SceneContents: React.FC<SceneContentsProps> = ({ ws, controlsRef, contextMenuHandlerRef }) => {
  const { camera } = useThree();
  const perspCam   = camera as THREE.PerspectiveCamera;

  /**
   * 预分配右键行军射线检测所需的可复用对象，避免每次触发 contextMenu 时 GC 分配。
   * 这些对象与 SceneContents 生命周期相同，不需要每帧重新创建。
   */
  const _raycaster    = useRef(new THREE.Raycaster());
  const _ndcVec2      = useRef(new THREE.Vector2());
  const _pickPlane    = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
  const _intersectPt  = useRef(new THREE.Vector3());

  const navMeshData   = useGameStore(s => s.navMeshData);
  const obstaclesData = useGameStore(s => s.obstaclesData);
  const tilesData     = useGameStore(s => s.tilesData);
  const terrainCache  = useGameStore(s => s.terrainCache);
  const mapBounds     = useGameStore(s => s.mapBounds);
  const mapCenter     = useGameStore(s => s.mapCenter);
  const display       = useGameStore(s => s.display);
  const gathers       = useGameStore(s => s.gathers);
  const players       = useGameStore(s => s.players);
  const troops        = useGameStore(s => s.troops);
  const selectedId    = useGameStore(s => s.selectedTroopId);
  const currentPid    = useGameStore(s => s.currentPlayerId);
  const isPlayerJoined = useGameStore(s => s.isPlayerJoined);
  const setSelectedGatherId = useGameStore(s => s.setSelectedGatherId);

  /**
   * 右键发送行军指令处理函数（通过 ref 暴露给父级 div 的 onContextMenu）。
   * 使用 Raycaster 与 controls.target.y 所在水平面求交，
   * 而非固定 Y=0 平面，确保在地形不平坦区域点击位置准确。
   * 注意：此函数挂载在 DOM div 上（非 R3F group），可安全调用 e.preventDefault()。
   */
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isPlayerJoined || selectedId === null) return;
    const troop = troops.get(selectedId);
    if (!troop || troop.owner !== currentPid) return;

    const canvas  = e.currentTarget;
    const rect    = canvas.getBoundingClientRect();
    const x       = e.clientX - rect.left;
    const y       = e.clientY - rect.top;
    const ndcX    = (x / rect.width)  * 2 - 1;
    const ndcY    = -(y / rect.height) * 2 + 1;

    /* 复用预分配对象，避免每次右键点击时 GC 分配 */
    _ndcVec2.current.set(ndcX, ndcY);
    _raycaster.current.setFromCamera(_ndcVec2.current, perspCam);

    const planeHeight = controlsRef.current ? controlsRef.current.target.y : 0;
    _pickPlane.current.constant = -planeHeight;

    if (_raycaster.current.ray.intersectPlane(_pickPlane.current, _intersectPt.current)) {
      const worldCoord = sceneToWorld(_intersectPt.current, mapCenter);
      ws.sendMessage({
        kind: 'newMarch',
        data: {
          troop_id: selectedId,
          target_coord: {
            x: Math.round(worldCoord.x),
            z: Math.round(worldCoord.z),
          },
        },
      });
    }
  }, [isPlayerJoined, selectedId, troops, currentPid, perspCam, mapCenter, ws, controlsRef]);

  /**
   * 点击地图空白处时关闭资源点菜单（清除 selectedGatherId）。
   * 资源点点击时会 stopPropagation，因此此处 onClick 仅在未点中资源点时触发。
   */
  const handleClick = useCallback(() => {
    setSelectedGatherId(null);
  }, [setSelectedGatherId]);

  /**
   * 【BUG修复】将 ref 赋值从渲染阶段移至 useEffect
   * 原始问题：在函数组件体内直接写 contextMenuHandlerRef.current = handleContextMenu
   *   是渲染阶段的副作用，违反 React 纯渲染原则。在 React 18 Concurrent Mode 下，
   *   如果渲染被中断并重新开始，副作用可能执行多次或与已废弃的渲染帧关联。
   * 修复方案：移到 useEffect 中，确保仅在组件提交（commit）后执行一次。
   */
  useEffect(() => {
    contextMenuHandlerRef.current = handleContextMenu;
  }, [handleContextMenu, contextMenuHandlerRef]);

  return (
    <group onClick={handleClick}>
      <Lights
        mapCenterX={mapCenter.x}
        mapCenterZ={mapCenter.z}
      />

      <CameraController
        mapBounds={mapBounds}
        mapCenter={mapCenter}
        tilesData={tilesData}
        terrainCache={terrainCache}
        controlsRef={controlsRef}
      />

      {tilesData && (
        <TileGrid
          tilesData={tilesData}
          mapCenter={mapCenter}
          visible={display.tiles}
        />
      )}

      {navMeshData && tilesData && (
        <NavMeshLines
          navMeshData={navMeshData}
          mapCenter={mapCenter}
          tilesData={tilesData}
          terrainCache={terrainCache}
          visible={display.navMesh}
        />
      )}

      {obstaclesData && (
        <ObstacleMeshes
          obstaclesData={obstaclesData}
          mapCenter={mapCenter}
          tilesData={tilesData}
          terrainCache={terrainCache}
          visible={display.obstacles}
        />
      )}

      <GatherGroup
        gathers={gathers}
        mapCenter={mapCenter}
        tilesData={tilesData}
        terrainCache={terrainCache}
      />

      <PlayerGroup
        players={players}
        currentPid={currentPid}
        mapCenter={mapCenter}
        tilesData={tilesData}
        terrainCache={terrainCache}
      />

      <TroopGroup
        troops={troops}
        selectedId={selectedId}
        currentPid={currentPid}
        mapCenter={mapCenter}
        tilesData={tilesData}
        terrainCache={terrainCache}
        showPath={display.path}
      />

      <EntityLabels />
    </group>
  );
};

interface GameSceneProps {
  ws: UseWebSocketReturn;
}

/**
 * 主 3D 游戏场景组件
 * 创建 R3F Canvas 并传入场景配置，controlsRef 在此层创建后向下传递，
 * 使右键行军坐标计算能访问 OrbitControls 的当前 target 坐标。
 */
export const GameScene: React.FC<GameSceneProps> = ({ ws }) => {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  /**
   * contextMenuHandlerRef：由 SceneContents（Canvas 内）写入最新的右键行军处理函数，
   * 供外层 div 的 onContextMenu 调用。这样避免在 R3F group 上调用 e.preventDefault()
   * 导致 "e.preventDefault is not a function" 错误（R3F ThreeEvent 没有该方法）。
   */
  const contextMenuHandlerRef = useRef<((e: React.MouseEvent<HTMLDivElement>) => void) | null>(null);

  /**
   * 设备性能档位配置（懒加载单例，仅在组件挂载时执行一次设备检测）。
   * 根据档位动态调整 antialias、DPR、powerPreference 等关键渲染参数：
   *   - 低端设备：关闭 MSAA + 固定 1x DPR → 节省 GPU 填充率 40-75%
   *   - 中端设备：关闭 MSAA + 限制 1.5x DPR → 平衡质量与性能
   *   - 高端设备：开启 MSAA + 最高 2x DPR + 高性能模式
   */
  const deviceProfile = getDeviceProfile();

  return (
    <div
      className="game-area"
      onContextMenu={(e) => {
        e.preventDefault();
        contextMenuHandlerRef.current?.(e);
      }}
    >
      <Canvas
        className="map-canvas"
        /**
         * DPR 根据设备档位动态设置：
         *   - 高端：[1, 2]（允许 Retina/4K 2x 渲染）
         *   - 中端：[1, 1.5]（限制 1.5x，平衡画质与性能）
         *   - 低端：[1, 1]（固定 1x，节省 75% 像素处理量）
         */
        dpr={[1, deviceProfile.maxDpr]}
        gl={{
          antialias: deviceProfile.antialias,
          alpha:     true,
          /**
           * stencil: false：游戏场景不使用模板缓冲，关闭节省显存分配
           * powerPreference：根据设备档位选择 GPU 电源策略
           *   - 高端：'high-performance'，确保使用独立 GPU
           *   - 中端：'default'，系统自动选择
           *   - 低端：'low-power'，优先节电
           */
          stencil:   false,
          powerPreference: deviceProfile.powerPreference,
          outputColorSpace:    THREE.SRGBColorSpace,
          toneMapping:         THREE.ReinhardToneMapping,
          toneMappingExposure: 2.2,
        }}
        shadows={deviceProfile.enableShadows ? { type: THREE.PCFSoftShadowMap, enabled: true } : false}
        camera={{
          /**
           * FOV 65°（而非原始 50°）：增强透视近大远小效果，使地形层次感更强。
           * 65° 是战略游戏（RTS）的经典水平视野值，在 16:9 宽屏下垂直 FOV ≈ 39°。
           * 超过 75° 会产生鱼眼失真，低于 50° 则显得地形压扁。
           */
          fov:      65,
          near:     10,
          far:      3000000,
          position: [0, 75000, 100000],
        }}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color(0x111820));
        }}
      >
        <color attach="background" args={[0x111820]} />
        {/**
         * 指数雾效（FogExp2）：颜色 0x1e2d1e（带绿意的深色），与草地地面过渡自然。
         * 指数雾比线性雾在大地图中视觉更真实（符合大气散射物理）。
         * density=0.0000018：雾效强度，过大会使近处实体也变模糊。
         */}
        <fogExp2 attach="fog" args={[0x1e2d1e, 0.0000018]} />
        <SceneContents ws={ws} controlsRef={controlsRef} contextMenuHandlerRef={contextMenuHandlerRef} />
      </Canvas>
    </div>
  );
};
