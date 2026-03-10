/**
 * @fileoverview 相机控制器组件
 * @description 基于 @react-three/drei OrbitControls 的高级相机控制封装，实现 RTS 风格的地图导航。
 *
 * 核心功能：
 *   1. 水平面平移（与 gamesvr overridePanBehavior 完全一致）
 *   2. 平滑相机跟随（城市/部队视角，三次缓出插值）
 *   3. 地形对齐（target.y 贴地）
 *   4. 地图边界约束（target 不超出 mapBounds）
 *   5. 视口范围同步（每 100ms 将 viewSpan 和 viewCenter 写入 Store）
 *
 * 视角配置：
 *   - 初始偏移：(0, 75000, 100000)，仰角 ≈ 37°，经典 RTS 斜视角
 *   - 俯仰角范围：[10°, 70°]，防止贴地平视或完全俯视
 *   - 缩放范围：[50000, 700000]，约对应 1 格子～2 个全图视野
 *
 * Pan 行为重写（overridePanBehavior）设计原因：
 *   默认 OrbitControls.pan 使相机在"屏幕平面"内移动，导致视角倾斜时
 *   水平拖拽会有上下偏移感（相机向屏幕法线方向分量移动）。
 *   重写后强制 pan 在 XZ 水平面内移动，与地图导航的直觉一致。
 *   注意：必须在 OrbitControls 实例创建后立即注入（ref callback），
 *   而非 useEffect，否则首次渲染前 controls 可能为 null。
 *
 * 拖拽期间退出跟随模式：
 *   城市/部队视角下，用户开始拖拽时需立即（同步）清除 isSmoothing 和 smoothTarget，
 *   否则当前帧的 useFrame 仍会执行平滑插值，覆盖用户的拖拽位移，产生"橡皮筋"感。
 *
 * @author WildMap Team
 */
import { useRef, useEffect, useCallback } from 'react';
import type React from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useGameStore } from '../store/gameStore';
import {
  worldToScene,
  sceneToWorld,
  getTerrainHeight,
  type TerrainCache,
  type WorldCoordXZ,
} from '../utils/coordinates';
import type {
  MapBounds,
  MapCenter,
  TileMeshConfig,
} from '../types/game';

/**
 * 初始相机偏移向量（相对于 OrbitControls target 的偏移）
 * (0, 75000, 100000) 对应仰角 atan(75000/100000) ≈ 37°，
 * 这是帝国时代、文明系列等经典 RTS 的标准斜视角。
 */
const INITIAL_CAMERA_OFFSET = new THREE.Vector3(0, 75000, 100000);

/**
 * 俯仰角范围（弧度）
 * MIN(10°)：防止相机贴近地面，地形严重遮挡视线
 * MAX(70°)：防止完全俯视，失去 3D 纵深感和地形层次感
 * 最佳游戏视角约在 30°~60° 之间
 */
const MIN_POLAR_ANGLE = THREE.MathUtils.degToRad(10);
const MAX_POLAR_ANGLE = THREE.MathUtils.degToRad(70);

/**
 * 计算当前可视范围（世界坐标跨度）
 * 与 gamesvr updateViewSpanDisplay 方法逻辑完全一致：
 *   viewHeight = 2 × tan(vFOV/2) × distance
 *   viewWidth  = viewHeight × aspectRatio
 */
function calcViewSpan(camera: THREE.PerspectiveCamera, target: THREE.Vector3) {
  const distance   = camera.position.distanceTo(target);
  const vFOV       = THREE.MathUtils.degToRad(camera.fov);
  const viewHeight = 2 * Math.tan(vFOV / 2) * distance;
  const viewWidth  = viewHeight * camera.aspect;
  return { x_span: Math.round(viewWidth), z_span: Math.round(viewHeight) };
}

/**
 * 覆写 OrbitControls 的 pan 方法，强制在 XZ 水平面内平移
 * 与 gamesvr overridePanBehavior 函数完全对等。
 *
 * 关键技术细节：
 *   - 使用 element.clientWidth/clientHeight（CSS 像素）而非 devicePixelRatio 像素
 *     确保在任何 DPR 下，相同屏幕距离的拖拽产生相同的世界单位位移
 *   - 预分配 forward/right/panOff 向量，避免每次 pan 调用时 GC 分配
 *   - forward 投影到水平面（y=0）后归一化，确保相机倾斜时水平方向不变
 */
function overridePanBehavior(
  controls: OrbitControlsImpl,
  perspCam: THREE.PerspectiveCamera,
  domElement: HTMLElement
) {
  const forward = new THREE.Vector3();
  const right   = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const panOff  = new THREE.Vector3();

  (controls as unknown as { pan: (dx: number, dy: number) => void }).pan = function(deltaX: number, deltaY: number) {
    const element  = domElement;
    const distance = perspCam.position.distanceTo(controls.target);
    if (!distance) return;

    const vSpan = 2 * distance * Math.tan(THREE.MathUtils.degToRad(perspCam.fov * 0.5));
    const hSpan = vSpan * perspCam.aspect;

    const moveX = (deltaX / element.clientWidth)  * hSpan;
    const moveZ = (deltaY / element.clientHeight) * vSpan;

    perspCam.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    else forward.normalize();

    right.copy(forward).cross(worldUp);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    else right.normalize();

    panOff.set(0, 0, 0)
      .addScaledVector(right, -moveX)
      .addScaledVector(forward, moveZ);

    controls.target.add(panOff);
    perspCam.position.add(panOff);
  };
}

interface CameraControllerProps {
  mapBounds:    MapBounds;
  mapCenter:    MapCenter;
  tilesData:    TileMeshConfig | null;
  terrainCache: TerrainCache;
  /** 外部传入的 ref，供 GameScene 右键行军坐标计算读取 controls.target.y */
  controlsRef?: React.RefObject<OrbitControlsImpl | null>;
}

export function CameraController({
  mapBounds,
  mapCenter,
  tilesData,
  terrainCache,
  controlsRef: externalControlsRef,
}: CameraControllerProps) {
  const { camera, gl } = useThree();
  const perspCam = camera as THREE.PerspectiveCamera;

  const internalControlsRef = useRef<OrbitControlsImpl | null>(null);

  const cameraOffsetRef  = useRef<THREE.Vector3>(INITIAL_CAMERA_OFFSET.clone());
  const smoothTargetRef  = useRef<THREE.Vector3 | null>(null);
  const isSmoothing      = useRef(false);
  const isDragging       = useRef(false);
  const isInitialized    = useRef(false);
  const lastViewUpdate   = useRef(0);
  const lastFollowUpdate = useRef(0);

  const viewMode          = useGameStore(s => s.viewMode);
  const selectedTroopId   = useGameStore(s => s.selectedTroopId);
  const troops            = useGameStore(s => s.troops);
  const currentPlayer     = useGameStore(s => s.currentPlayerData);
  const setViewSpan       = useGameStore(s => s.setViewSpan);
  const setViewMode       = useGameStore(s => s.setViewMode);
  const setHasCenteredOnCity = useGameStore(s => s.setHasCenteredOnCity);

  const getHeight = useCallback((wx: number, wz: number) => {
    return getTerrainHeight(wx, wz, tilesData, terrainCache);
  }, [tilesData, terrainCache]);

  /**
   * 将 OrbitControls target 对齐到当前地形高度
   * 保持相机与 target 的相对偏移不变，仅调整 target.y 和 camera.y。
   * 当 isSmoothing=true 时跳过，避免与平滑插值冲突。
   */
  const _tmpTarget = useRef(new THREE.Vector3());
  const _tmpOffset = useRef(new THREE.Vector3());
  /**
   * 【性能优化】预分配世界坐标复用对象，避免 sceneToWorld() 每次创建 {x,z} 临时对象。
   * 拖拽热路径中 sceneToWorld 每帧调用 2-4 次，消除这些分配可减少 GC 压力。
   */
  const _tmpWorldCoord = useRef<WorldCoordXZ>({ x: 0, z: 0 });

  const alignTargetToTerrain = useCallback(() => {
    const controls = internalControlsRef.current;
    if (!controls || isSmoothing.current) return;
    /** 【性能优化】复用 _tmpWorldCoord 避免热路径对象分配 */
    const world = sceneToWorld(controls.target, mapCenter, _tmpWorldCoord.current);
    const h     = getHeight(world.x, world.z);
    if (!Number.isFinite(h)) return;
    if (Math.abs(controls.target.y - h) < 0.5) return;
    _tmpOffset.current.copy(perspCam.position).sub(controls.target);
    controls.target.y = h;
    perspCam.position.copy(controls.target).add(_tmpOffset.current);
    cameraOffsetRef.current.copy(_tmpOffset.current);
  }, [getHeight, mapCenter, perspCam]);

  /**
   * 将相机 target 约束在地图边界内
   * 超出边界时强制对齐到边界，防止相机漂移到地图外的空白区域。
   */
  const constrainToBounds = useCallback(() => {
    const controls = internalControlsRef.current;
    if (!controls || !mapBounds.maxX) return;
    /** 【性能优化】复用 _tmpWorldCoord 避免热路径对象分配 */
    const world = sceneToWorld(controls.target, mapCenter, _tmpWorldCoord.current);
    const cx = THREE.MathUtils.clamp(world.x, mapBounds.minX, mapBounds.maxX);
    const cz = THREE.MathUtils.clamp(world.z, mapBounds.minY, mapBounds.maxY);
    if (cx !== world.x || cz !== world.z) {
      worldToScene(cx, cz, mapCenter, tilesData, terrainCache, true, _tmpTarget.current);
      controls.target.copy(_tmpTarget.current);
      perspCam.position.copy(_tmpTarget.current).add(cameraOffsetRef.current);
    }
  }, [mapBounds, mapCenter, tilesData, terrainCache, perspCam]);

  /**
   * 启动平滑移动到指定世界坐标
   * 设置 smoothTargetRef 和 isSmoothing 标志，由 useFrame 驱动实际插值。
   */
  const smoothMoveTo = useCallback((wx: number, wz: number) => {
    const target = worldToScene(wx, wz, mapCenter, tilesData, terrainCache, true);
    smoothTargetRef.current = target;
    isSmoothing.current     = true;
  }, [mapCenter, tilesData, terrainCache]);

  useEffect(() => {
    if (!tilesData || !mapCenter.x || isInitialized.current) return;
    isInitialized.current = true;
    const controls = internalControlsRef.current;
    if (!controls) return;
    const target = worldToScene(mapCenter.x, mapCenter.z, mapCenter, tilesData, terrainCache, false);
    controls.target.copy(target);
    perspCam.position.copy(target.clone().add(INITIAL_CAMERA_OFFSET));
    controls.update();
  }, [tilesData, mapCenter, terrainCache, perspCam]);

  /**
   * viewMode / selectedTroopId 切换时立即触发相机归位。
   * 使用 Ref 持有最新的 currentPlayer/troops，避免 useEffect 依赖爆炸同时保证读取最新值。
   */
  const currentPlayerRef   = useRef(currentPlayer);
  const troopsRef          = useRef(troops);
  const smoothMoveToRef    = useRef(smoothMoveTo);
  useEffect(() => { currentPlayerRef.current = currentPlayer; }, [currentPlayer]);
  useEffect(() => { troopsRef.current = troops; }, [troops]);
  useEffect(() => { smoothMoveToRef.current = smoothMoveTo; }, [smoothMoveTo]);

  useEffect(() => {
    if (!tilesData) return;
    if (viewMode === 'city') {
      if (currentPlayerRef.current?.city_pos) {
        smoothMoveToRef.current(
          currentPlayerRef.current.city_pos.x,
          currentPlayerRef.current.city_pos.z,
        );
        setHasCenteredOnCity(true);
      }
    } else if (viewMode === 'troop') {
      if (selectedTroopId !== null) {
        const troop = troopsRef.current.get(selectedTroopId);
        if (troop) smoothMoveToRef.current(troop.position.x, troop.position.z);
      }
    }
    // 仅在视角模式或选中部队切换时触发，currentPlayer/troops 通过 Ref 读取最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedTroopId, tilesData]);

  /**
   * 周期性跟随（200ms 间隔）
   * 当目标实体移动时（如部队行军），非 smoothing 状态下重新触发 smoothMoveTo，
   * 使相机持续跟随移动中的实体，而不是只在 viewMode 切换时跳一次。
   */
  const viewModeRef = useRef(viewMode);
  const selectedTroopIdRef = useRef(selectedTroopId);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { selectedTroopIdRef.current = selectedTroopId; }, [selectedTroopId]);

  useEffect(() => {
    if (!tilesData) return;
    const now = Date.now();
    if (now - lastFollowUpdate.current < 200) return;
    lastFollowUpdate.current = now;
    if (isSmoothing.current) return;
    const vm = viewModeRef.current;
    const sid = selectedTroopIdRef.current;
    if (vm === 'city' && currentPlayerRef.current?.city_pos) {
      smoothMoveToRef.current(
        currentPlayerRef.current.city_pos.x,
        currentPlayerRef.current.city_pos.z,
      );
    } else if (vm === 'troop' && sid !== null) {
      const troop = troopsRef.current.get(sid);
      if (troop) smoothMoveToRef.current(troop.position.x, troop.position.z);
    }
    // 依赖 troops/currentPlayer 数据更新触发，viewMode/selectedTroopId 通过 Ref 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [troops, currentPlayer, tilesData]);

  useFrame((_, delta) => {
    const controls = internalControlsRef.current;
    if (!controls) return;

    if (isSmoothing.current && smoothTargetRef.current) {
      const target  = controls.target;
      const dest    = smoothTargetRef.current;
      const diff    = _tmpTarget.current.copy(dest).sub(target);
      const distance = diff.length();

      if (distance < 1) {
        target.copy(dest);
        perspCam.position.copy(target).add(cameraOffsetRef.current);
        isSmoothing.current     = false;
        smoothTargetRef.current = null;
        /**
         * 【性能优化】消除 .clone() 临时对象分配，复用 _tmpOffset ref。
         * 原代码 perspCam.position.clone().sub() 每次平滑结束创建一个临时 Vector3，
         * 虽然不是每帧热路径，但保持一致的零分配风格。
         */
        cameraOffsetRef.current.copy(_tmpOffset.current.copy(perspCam.position).sub(controls.target));
        controls.update();
      } else {
        /**
         * 三次缓出插值（ease-out cubic）：progress = 1 - (1 - t)³
         * 开始快速收敛，接近目标时减速，避免超调（overshooting）。
         * 与 gamesvr applyCameraTargetLerp 中的 lerp 系数策略一致。
         */
        const progress     = Math.min(1, delta * 3.5);
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        target.add(diff.multiplyScalar(easeProgress));
        perspCam.position.copy(target).add(cameraOffsetRef.current);

        /** 【性能优化】复用 _tmpWorldCoord 避免平滑动画期间每帧对象分配 */
        const world = sceneToWorld(target, mapCenter, _tmpWorldCoord.current);
        const h = getHeight(world.x, world.z);
        if (Number.isFinite(h)) {
          const lerpFactor = Math.min(1, delta * 8);
          const curY = target.y;
          const newY = curY + (h - curY) * lerpFactor;
          _tmpOffset.current.copy(perspCam.position).sub(target);
          target.y = newY;
          perspCam.position.copy(target).add(_tmpOffset.current);
          cameraOffsetRef.current.copy(_tmpOffset.current);
        }

        constrainToBounds();
        controls.update();
      }

      const span = calcViewSpan(perspCam, controls.target);
      setViewSpan(span);
    }

    const now = Date.now();
    if (now - lastViewUpdate.current > 100) {
      lastViewUpdate.current = now;
      const newSpan = calcViewSpan(perspCam, controls.target);

      /**
       * 增量判断：仅当 viewSpan 变化超过 1% 时才触发 Zustand set → React 重渲染。
       * 防止相机轻微抖动（浮点数精度）导致 EntityLabels 每秒 10 次不必要重算。
       */
      const oldSpan = useGameStore.getState().viewSpan;
      if (
        Math.abs(newSpan.x_span - oldSpan.x_span) / (oldSpan.x_span || 1) > 0.01 ||
        Math.abs(newSpan.z_span - oldSpan.z_span) / (oldSpan.z_span || 1) > 0.01
      ) {
        setViewSpan(newSpan);
      }

      /**
       * viewCenter 增量判断：仅当移动超过 500 世界单位（约半个地块）时才更新。
       * 防止相机微小移动频繁触发 mapView 轮询范围重计算。
       */
      /** 【性能优化】复用 _tmpWorldCoord 避免 100ms 轮询路径对象分配 */
      const worldCenter = sceneToWorld(controls.target, mapCenter, _tmpWorldCoord.current);
      const oldCenter = useGameStore.getState().viewCenter;
      if (
        Math.abs(worldCenter.x - oldCenter.x) > 500 ||
        Math.abs(worldCenter.z - oldCenter.z) > 500
      ) {
        useGameStore.getState().setViewCenter({
          x: Math.round(worldCenter.x),
          z: Math.round(worldCenter.z),
        });
      }
    }
  });

  /**
   * OrbitControls ref callback（关键）
   * 在 controls 实例创建完毕后立即注入自定义 Pan 行为。
   * 不能用 useEffect，因为 controls 实例在 ref callback 时才可用，
   * useEffect 中 controls 可能为 null（组件渲染周期问题）。
   */
  const handleControlsRef = useCallback((controls: OrbitControlsImpl | null) => {
    internalControlsRef.current = controls;

    if (externalControlsRef) {
      (externalControlsRef as React.MutableRefObject<OrbitControlsImpl | null>).current = controls;
    }

    if (!controls) return;

    overridePanBehavior(controls, perspCam, gl.domElement);
  }, [externalControlsRef, perspCam, gl.domElement]);

  return (
    <OrbitControls
      ref={handleControlsRef}
      args={[perspCam, gl.domElement]}
      /**
       * 鼠标按键映射（符合 RTS 习惯）：
       *   左键：平移（主操作，与屏幕内容的直觉拖拽一致）
       *   中键/滚轮：缩放
       *   右键：旋转视角（3D 观察地形）
       */
      enableRotate={true}
      enableZoom={true}
      enablePan={true}
      enableDamping={true}
      dampingFactor={0.15}
      zoomSpeed={1.2}
      rotateSpeed={0.6}
      minDistance={50000}
      maxDistance={700000}
      minPolarAngle={MIN_POLAR_ANGLE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      mouseButtons={{
        LEFT:   THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT:  THREE.MOUSE.ROTATE,
      }}
      touches={{
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_ROTATE,
      }}
      screenSpacePanning={false}
      onChange={() => {
        const controls = internalControlsRef.current;
        if (!controls) return;
        cameraOffsetRef.current.copy(
          _tmpOffset.current.copy(perspCam.position).sub(controls.target)
        );
        /**
         * 拖拽时退出跟随模式（关键）：
         * 必须立即（同步）清除 isSmoothing，防止当前帧 useFrame 覆盖拖拽位移。
         * 仅在非 free 视角时执行，避免 free 模式下多余的状态更新。
         */
        if (isDragging.current && useGameStore.getState().viewMode !== 'free') {
          isSmoothing.current     = false;
          smoothTargetRef.current = null;
          setViewMode('free');
        }
        alignTargetToTerrain();
        constrainToBounds();
      }}
      onStart={() => {
        isDragging.current = true;
        if (useGameStore.getState().viewMode !== 'free') {
          isSmoothing.current     = false;
          smoothTargetRef.current = null;
          setViewMode('free');
        }
      }}
      onEnd={() => {
        isDragging.current = false;
        alignTargetToTerrain();
        constrainToBounds();
      }}
      makeDefault
    />
  );
}
