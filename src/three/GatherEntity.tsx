/**
 * @fileoverview 资源采集点批量渲染组件
 * @description 按资源类型分组渲染自然资源点（金矿、铁矿、木材、石矿），
 *              支持旋转动画、弹跳动画和发光脉冲效果，以及点击弹出采集菜单。
 *
 * 渲染架构（InstancedMesh 方案）：
 *   - 按资源 ID 映射到 RESOURCE_CONFIGS 进行类型分组
 *   - 每种类型创建两个 InstancedMesh：主体（MeshStandardMaterial）+ 发光外壳（MeshBasicMaterial）
 *   - 资源 ID 不在配置表中的统一归为默认组（key=0）
 *   - 发光外壳使用 AdditiveBlending 实现叠加混合的光晕效果
 *
 * 点击检测策略：
 *   - 在每个 InstancedMesh 上调用 setColorAt 标记选中高亮（橙黄色）
 *   - 使用 R3F 的 raycast 机制：对每个资源点维护一个 SphereGeometry Mesh，
 *     接收 onClick 事件，触发 selectedGatherId store 更新
 *
 * 性能策略：
 *   - InstancedMesh 大幅减少 DrawCall：N 个同类资源点 = 2 次 DrawCall
 *   - gathers Map 引用变化（数量变化）时重建 InstancedMesh，仅位置变化时仅更新矩阵
 *   - 复用 _matrix/_pos/_quat/_scale 等全局向量对象，减少每帧 GC 压力
 *   - emissiveIntensity 动态调整在 useFrame 中执行，不触发 React 重渲染
 *   - 点击检测 Mesh 使用透明不可见材质，不增加渲染开销
 *
 * 资源类型配置（RESOURCE_CONFIGS）：
 *   key 对应服务端资源 ID（如 11151001=金矿），值决定外观和动画参数。
 *   未知资源类型使用 DEFAULT_CONFIG（黄色正二十面体）。
 *
 * @author WildMap Team
 */
import { useRef, useEffect, useMemo, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { GatherData, MapCenter, TileMeshConfig } from '../types/game';
import { worldToScene, type TerrainCache } from '../utils/coordinates';
import { GATHER_ENTITY_SIZES } from '../utils/entitySizes';
import { useGameStore } from '../store/gameStore';

/**
 * 单种资源类型的视觉配置接口
 */
interface ResourceConfig {
  /** 主体材质颜色 */
  mainColor:   number;
  /** 发光外壳颜色 */
  glowColor:   number;
  /** 核心高光颜色（未直接使用，供后续扩展） */
  coreColor:   number;
  /** 主体几何体工厂函数 */
  geoFactory:  () => THREE.BufferGeometry;
  /** 发光外壳相对于主体的尺寸比例 */
  shellScale:  number;
  /** Y 轴旋转速度（弧度/秒） */
  rotSpeed:    number;
}

/**
 * 资源 ID → 视觉配置映射表
 * key 与服务端 D2GatherConf 中的 resource_id 字段对应。
 */
const RESOURCE_CONFIGS: Record<number, ResourceConfig> = {
  11151001: {
    mainColor:  0xFFD700,
    glowColor:  0xFFAA00,
    coreColor:  0xFFFF88,
    geoFactory: () => new THREE.DodecahedronGeometry(1, 0),
    shellScale: 1.35,
    rotSpeed:   0.8,
  },
  11151006: {
    mainColor:  0x5588cc,
    glowColor:  0x3366aa,
    coreColor:  0xaaccff,
    geoFactory: () => new THREE.OctahedronGeometry(1, 0),
    shellScale: 1.3,
    rotSpeed:   0.5,
  },
  11151007: {
    mainColor:  0x2db85c,
    glowColor:  0x1a7a3a,
    coreColor:  0x66ff99,
    geoFactory: () => new THREE.CylinderGeometry(0.6, 0.8, 1.8, 7),
    shellScale: 1.4,
    rotSpeed:   0.3,
  },
  11151008: {
    mainColor:  0x8899aa,
    glowColor:  0x556677,
    coreColor:  0xbbccdd,
    geoFactory: () => new THREE.BoxGeometry(1.4, 1.0, 1.4),
    shellScale: 1.3,
    rotSpeed:   0.4,
  },
};

/** 未在 RESOURCE_CONFIGS 中注册的资源类型使用此默认配置 */
const DEFAULT_CONFIG: ResourceConfig = {
  mainColor:  0xFFD700,
  glowColor:  0xFFAA00,
  coreColor:  0xFFFF88,
  geoFactory: () => new THREE.IcosahedronGeometry(1, 0),
  shellScale: 1.3,
  rotSpeed:   0.6,
};

/** 主体材质缓存，按资源 ID 索引，避免重复创建 */
const _shellMats = new Map<number, THREE.MeshBasicMaterial>();
const _mainMats  = new Map<number, THREE.MeshStandardMaterial>();

function getMainMat(resourceId: number): THREE.MeshStandardMaterial {
  if (!_mainMats.has(resourceId)) {
    const cfg = RESOURCE_CONFIGS[resourceId] ?? DEFAULT_CONFIG;
    _mainMats.set(resourceId, new THREE.MeshStandardMaterial({
      color:          cfg.mainColor,
      emissive:       new THREE.Color(cfg.glowColor),
      emissiveIntensity: 0.45,
      metalness:      0.5,
      roughness:      0.4,
    }));
  }
  return _mainMats.get(resourceId)!;
}

/**
 * 发光外壳材质（MeshBasicMaterial + AdditiveBlending）
 * 使用加法混合而非标准混合，确保多个重叠的外壳光晕能正确叠加而非遮盖。
 */
function getShellMat(resourceId: number): THREE.MeshBasicMaterial {
  if (!_shellMats.has(resourceId)) {
    const cfg = RESOURCE_CONFIGS[resourceId] ?? DEFAULT_CONFIG;
    _shellMats.set(resourceId, new THREE.MeshBasicMaterial({
      color:       cfg.glowColor,
      transparent: true,
      opacity:     0.22,
      depthWrite:  false,
      side:        THREE.FrontSide,
      blending:    THREE.AdditiveBlending,
    }));
  }
  return _shellMats.get(resourceId)!;
}

/** 主体几何体缓存 */
const _geoCache    = new Map<number, THREE.BufferGeometry>();
const _shellGeoCache = new Map<number, THREE.BufferGeometry>();

function getMainGeo(resourceId: number): THREE.BufferGeometry {
  if (!_geoCache.has(resourceId)) {
    const cfg = RESOURCE_CONFIGS[resourceId] ?? DEFAULT_CONFIG;
    _geoCache.set(resourceId, cfg.geoFactory());
  }
  return _geoCache.get(resourceId)!;
}

function getShellGeo(resourceId: number): THREE.BufferGeometry {
  if (!_shellGeoCache.has(resourceId)) {
    const cfg = RESOURCE_CONFIGS[resourceId] ?? DEFAULT_CONFIG;
    _shellGeoCache.set(resourceId, new THREE.SphereGeometry(cfg.shellScale, 12, 8));
  }
  return _shellGeoCache.get(resourceId)!;
}

/**
 * 点击检测材质：colorWrite=false 不写入颜色缓冲，视觉上不可见，
 * 但 R3F raycaster 仍可检测到碰撞，用于资源点点击拾取。
 */
const _hitMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  colorWrite: false,
  depthWrite: false,
  side: THREE.FrontSide,
});

/** 点击检测球体几何体（半径 1，实际尺寸在 Mesh scale 上设置） */
const _hitGeo = new THREE.SphereGeometry(1, 8, 6);

/** 复用矩阵/向量对象（每帧在 useFrame 中大量调用），避免 GC 开销 */
const _matrix = new THREE.Matrix4();
const _pos    = new THREE.Vector3();
const _quat   = new THREE.Quaternion();
const _scale  = new THREE.Vector3();
const _sp     = new THREE.Vector3();
/** Y 轴单位向量常量，避免在 useFrame 中每次 setFromAxisAngle 时 new THREE.Vector3() */
const _YAxis  = new THREE.Vector3(0, 1, 0);
/** 复用颜色对象，避免在 useFrame 中每帧创建 new THREE.Color() 触发 GC */
const _colorNormal   = new THREE.Color(1, 1, 1);
const _colorSelected = new THREE.Color(1.6, 0.8, 0.1);

let _globalPhase = 0;

interface GatherGroupProps {
  gathers:      Map<number, GatherData>;
  mapCenter:    MapCenter;
  tilesData:    TileMeshConfig | null;
  terrainCache: TerrainCache;
}

export function GatherGroup({
  gathers,
  mapCenter,
  tilesData,
  terrainCache,
}: GatherGroupProps) {
  const setSelectedGatherId = useGameStore(s => s.setSelectedGatherId);
  const selectedGatherId    = useGameStore(s => s.selectedGatherId);

  /**
   * 按资源类型分组，同类型资源共用一组 InstancedMesh。
   * 资源 ID 直接作为分组 key，未注册的归入 key=0 的默认组。
   */
  const groups = useMemo(() => {
    const map = new Map<number, GatherData[]>();
    for (const g of gathers.values()) {
      /**
       * 【BUG修复】原代码使用 g.id（唯一实例ID/雪花ID）作为分组键与 RESOURCE_CONFIGS 匹配，
       * 但 RESOURCE_CONFIGS 的键是 D2GatherConf.ID（模板/配置ID，如 11151001）。
       * 唯一实例ID永远不会匹配模板ID，导致所有采集点都落入默认组（key=0），
       * 无法按粮/木/石/铁区分渲染颜色和几何体形状。
       * 修复：使用 g.conf_id（服务端通过 EntityInfo.ConfID 传递的配置表ID）进行匹配。
       */
      const cfgKey = Object.prototype.hasOwnProperty.call(RESOURCE_CONFIGS, g.conf_id) ? g.conf_id : 0;
      if (!map.has(cfgKey)) map.set(cfgKey, []);
      map.get(cfgKey)!.push(g);
    }
    return map;
  }, [gathers]);

  const meshGroupsRef   = useRef<Map<number, { mainMesh: THREE.InstancedMesh; shellMesh: THREE.InstancedMesh }>>(new Map());
  const gathersRef      = useRef(groups);
  /** 追踪上一帧的 selectedGatherId，仅变化时才上传颜色 buffer，减少 GPU 带宽浪费 */
  const prevSelectedRef = useRef<number | null>(null);
  useEffect(() => { gathersRef.current = groups; }, [groups]);

  /**
   * 【性能优化】计算分组结构哈希键：仅当 per-group 数量变化时才改变。
   * 原代码 useEffect 依赖 `gathers` Map 引用，导致 `remains` 等数据字段变化时
   * 也会触发昂贵的 InstancedMesh 完全拆除重建（dispose + new + add 到场景）。
   * 但 useFrame 已经每帧从 gathersRef 读取最新数据更新矩阵，
   * InstancedMesh 仅在 count 变化时需要重建（因为 InstancedMesh.count 是不可变的）。
   * 此哈希键仅依赖 per-group 的资源ID和数量，忽略 remains/position 等动态字段，
   * 将重建频率从"每次数据变化"降低到"仅当采集点增减时"。
   */
  const groupCountsKey = useMemo(() => {
    let hash = gathers.size;
    for (const [id, list] of groups) {
      hash = hash * 31 + id * 997 + list.length;
    }
    return hash;
  }, [groups, gathers.size]);

  const { scene } = useThree();

  /**
   * gathers 数量或分布变化时重建 InstancedMesh
   * 注意：gathers Map 引用（而非内容）变化才触发重建，避免位置更新时不必要的重建。
   * InstancedMesh 的 count 一旦确定就不能改变，数量变化必须重建。
   */
  useEffect(() => {
    for (const { mainMesh, shellMesh } of meshGroupsRef.current.values()) {
      scene.remove(mainMesh);
      scene.remove(shellMesh);
      mainMesh.dispose();
      shellMesh.dispose();
    }
    meshGroupsRef.current.clear();

    for (const [resourceId, list] of groups) {
      const mainGeo  = getMainGeo(resourceId);
      const shellGeo = getShellGeo(resourceId);
      const mainMat  = getMainMat(resourceId);
      const shellMat = getShellMat(resourceId);

      const mainMesh  = new THREE.InstancedMesh(mainGeo,  mainMat,  list.length);
      const shellMesh = new THREE.InstancedMesh(shellGeo, shellMat, list.length);

      mainMesh.castShadow    = true;
      mainMesh.receiveShadow = true;
      mainMesh.name          = `gather_main_${resourceId.toString(16)}`;
      shellMesh.name         = `gather_shell_${resourceId.toString(16)}`;
      shellMesh.renderOrder  = 2;

      // 初始化颜色缓冲（用于选中高亮）
      mainMesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(list.length * 3).fill(1),
        3,
      );

      list.forEach((g, i) => {
        const rawRadius = (g.occupy_radius || GATHER_ENTITY_SIZES.DEFAULT_OCCUPY_RADIUS)
          * GATHER_ENTITY_SIZES.SCALE_FACTOR;
        const radius    = Math.max(GATHER_ENTITY_SIZES.MIN_SIZE, Math.min(GATHER_ENTITY_SIZES.MAX_SIZE, rawRadius));
        const sp        = worldToScene(g.position.x, g.position.z, mapCenter, tilesData, terrainCache, true);
        const isExhausted = (g.remains !== undefined) && g.remains <= 0;
        const scale     = isExhausted ? radius * 0.5 : radius;

        _pos.set(sp.x, sp.y + radius, sp.z);
        _quat.identity();
        _scale.setScalar(scale);
        _matrix.compose(_pos, _quat, _scale);
        mainMesh.setMatrixAt(i, _matrix);

        _scale.setScalar(scale);
        _matrix.compose(_pos, _quat, _scale);
        shellMesh.setMatrixAt(i, _matrix);
      });

      mainMesh.instanceMatrix.needsUpdate  = true;
      shellMesh.instanceMatrix.needsUpdate = true;

      scene.add(mainMesh);
      scene.add(shellMesh);
      meshGroupsRef.current.set(resourceId, { mainMesh, shellMesh });
    }

    return () => {
      for (const { mainMesh, shellMesh } of meshGroupsRef.current.values()) {
        scene.remove(mainMesh);
        scene.remove(shellMesh);
        mainMesh.dispose();
        shellMesh.dispose();
      }
      meshGroupsRef.current.clear();
    };
    /**
     * 【性能优化】依赖 groupCountsKey 而非 gathers Map 引用。
     * 原代码依赖 [gathers, scene]，导致 remains 等字段变化时重建所有 InstancedMesh。
     * 改为仅在 per-group 数量变化时重建，数据变化由 useFrame 通过 gathersRef 处理。
     * 预期优化效果：InstancedMesh 重建从"每次数据变化"降至"仅采集点增减时"。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupCountsKey, scene]);

  /**
   * 每帧更新矩阵（旋转 + 弹跳动画）
   * 主体：Y 轴旋转 + 上下弹跳
   * 外壳：仅上下弹跳（不旋转，保持球形光晕稳定）
   * emissiveIntensity：随 sin 函数脉动，制造"心跳"感
   */
  useFrame((_, delta) => {
    _globalPhase = (_globalPhase + delta * 2.0) % (Math.PI * 2);
    const bounce = Math.sin(_globalPhase) * GATHER_ENTITY_SIZES.BOUNCE_AMPLITUDE;

    /**
     * 增量判断：仅当 selectedGatherId 变化时才更新颜色 buffer（上传 GPU）。
     * 颜色 buffer 上传（instanceColor.needsUpdate）是每帧都做的最大浪费之一。
     * 选中状态通常只在玩家点击时改变，而非每帧变化。
     */
    const selectedChanged = prevSelectedRef.current !== selectedGatherId;
    if (selectedChanged) {
      prevSelectedRef.current = selectedGatherId;
    }

    for (const [resourceId, { mainMesh, shellMesh }] of meshGroupsRef.current) {
      const list = gathersRef.current.get(resourceId);
      if (!list) continue;

      const cfg = RESOURCE_CONFIGS[resourceId] ?? DEFAULT_CONFIG;

      const rotAngle = _globalPhase * cfg.rotSpeed;
      _quat.setFromAxisAngle(_YAxis, rotAngle);

      list.forEach((g, i) => {
        const rawRadius = (g.occupy_radius || GATHER_ENTITY_SIZES.DEFAULT_OCCUPY_RADIUS)
          * GATHER_ENTITY_SIZES.SCALE_FACTOR;
        const radius    = Math.max(GATHER_ENTITY_SIZES.MIN_SIZE, Math.min(GATHER_ENTITY_SIZES.MAX_SIZE, rawRadius));
        worldToScene(g.position.x, g.position.z, mapCenter, tilesData, terrainCache, true, _sp);
        const isExhausted = (g.remains !== undefined) && g.remains <= 0;
        const scale     = isExhausted ? radius * 0.5 : radius;

        _pos.set(_sp.x, _sp.y + radius * (1 + bounce), _sp.z);
        _scale.setScalar(scale);
        _matrix.compose(_pos, _quat, _scale);
        mainMesh.setMatrixAt(i, _matrix);

        _quat.identity();
        _scale.setScalar(scale);
        _matrix.compose(_pos, _quat, _scale);
        shellMesh.setMatrixAt(i, _matrix);

        // 选中高亮：仅在 selectedGatherId 变化时重新计算并标记上传
        if (selectedChanged && mainMesh.instanceColor) {
          const isSelected = g.id === selectedGatherId;
          mainMesh.setColorAt(i, isSelected ? _colorSelected : _colorNormal);
        }
      });

      mainMesh.instanceMatrix.needsUpdate  = true;
      shellMesh.instanceMatrix.needsUpdate = true;
      // 仅当选中状态实际变化时才上传颜色 buffer，减少 ~99% 的颜色 GPU 上传
      if (selectedChanged && mainMesh.instanceColor) {
        mainMesh.instanceColor.needsUpdate = true;
      }

      const mainMat = getMainMat(resourceId);
      mainMat.emissiveIntensity = 0.25 + Math.sin(_globalPhase * 2.5) * 0.15;
    }
  });

  /**
   * 点击检测层：为每个资源点渲染一个透明的 Sphere Mesh，
   * 通过 R3F 的 onClick 接收射线拾取事件，触发选中状态更新。
   * 透明材质不影响视觉渲染，仅参与射线检测。
   */
  const gatherArray = useMemo(() => Array.from(gathers.values()), [gathers]);

  const handleGatherClick = useCallback((e: ThreeEvent<MouseEvent>, gatherId: number) => {
    e.stopPropagation();
    setSelectedGatherId(gatherId);
  }, [setSelectedGatherId]);

  return (
    <>
      {gatherArray.map(g => {
        const rawRadius = (g.occupy_radius || GATHER_ENTITY_SIZES.DEFAULT_OCCUPY_RADIUS)
          * GATHER_ENTITY_SIZES.SCALE_FACTOR;
        const radius = Math.max(GATHER_ENTITY_SIZES.MIN_SIZE, Math.min(GATHER_ENTITY_SIZES.MAX_SIZE, rawRadius));
        const sp = worldToScene(g.position.x, g.position.z, mapCenter, tilesData, terrainCache, true);
        const isExhausted = (g.remains !== undefined) && g.remains <= 0;
        const scale = isExhausted ? radius * 0.5 : radius;

        return (
          <mesh
            key={`gather_hit_${g.id}`}
            geometry={_hitGeo}
            material={_hitMat}
            position={[sp.x, sp.y + radius, sp.z]}
            scale={[scale * 1.5, scale * 1.5, scale * 1.5]}
            onClick={(e) => handleGatherClick(e, g.id)}
          />
        );
      })}
    </>
  );
}

export const GatherEntity = GatherGroup;
