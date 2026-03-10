/**
 * @fileoverview 玩家城市（中世纪城堡）批量渲染组件
 * @description 以中世纪欧式要塞形态渲染玩家城市，按我方/敌方阵营使用不同材质色系。
 *
 * 城堡建筑结构（由下至上）：
 *   1. 城墙底座：矮宽八棱柱（CylinderGeometry 8段）
 *   2. 主楼：方形主塔（BoxGeometry）
 *   3. 四角楼：四角圆形角塔（InstancedMesh count = n×4）
 *   4. 瞭望塔：主塔顶部细高圆柱
 *   5. 主塔尖：圆锥
 *   6. 角楼塔尖：小圆锥（count = n×4）
 *   7. 旗杆：细柱
 *   8. 旗帜：MeshBasicMaterial 平面，颜色区分阵营（蓝/红）
 *   9. 窗口发光：MeshBasicMaterial + AdditiveBlending 橙黄光晕
 *
 * 材质设计决策（为何不用 ShaderMaterial）：
 *   InstancedMesh 与自定义 ShaderMaterial 结合时，若 ShaderMaterial 声明了
 *   instanceMatrix attribute 会导致 WebGL 编译错误。使用 MeshLambertMaterial
 *   既避免此问题，又比 MeshStandardMaterial 开销更低。
 *
 * 阵营色系：
 *   我方（蓝灰石城）：wall=0x7a8fa0，keep=0x6a7d8e，roof=0x3a5a70
 *   敌方（暗褐砖城）：wall=0x7a5a45，keep=0x6a4a38，roof=0x4a2a20
 *
 * @author WildMap Team
 */
import { useRef, useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { PlayerData, MapCenter, TileMeshConfig } from '../types/game';
import { worldToScene, type TerrainCache } from '../utils/coordinates';
import { CITY_ENTITY_SIZES } from '../utils/entitySizes';

/** 旗帜材质（颜色区分阵营，双面渲染确保从任意方向可见） */
const MY_FLAG_MAT = new THREE.MeshBasicMaterial({ color: 0x2255cc, side: THREE.DoubleSide });
const EN_FLAG_MAT = new THREE.MeshBasicMaterial({ color: 0xcc2211, side: THREE.DoubleSide });

/** 窗口发光材质（AdditiveBlending 模拟橙黄灯光叠加） */
const WINDOW_MAT = new THREE.MeshBasicMaterial({
  color: 0xff9933,
  transparent: true,
  opacity: 0.7,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

/** 我方阵营材质（蓝灰石城风格） */
const MY_WALL_MAT  = new THREE.MeshLambertMaterial({ color: 0x7a8fa0 });
const MY_KEEP_MAT  = new THREE.MeshLambertMaterial({ color: 0x6a7d8e });
const MY_TOWER_MAT = new THREE.MeshLambertMaterial({ color: 0x8090a0 });
const MY_ROOF_MAT  = new THREE.MeshLambertMaterial({ color: 0x3a5a70, emissive: new THREE.Color(0x0a1520), emissiveIntensity: 0.3 });

/** 敌方阵营材质（暗褐砖城风格） */
const EN_WALL_MAT  = new THREE.MeshLambertMaterial({ color: 0x7a5a45 });
const EN_KEEP_MAT  = new THREE.MeshLambertMaterial({ color: 0x6a4a38 });
const EN_TOWER_MAT = new THREE.MeshLambertMaterial({ color: 0x806050 });
const EN_ROOF_MAT  = new THREE.MeshLambertMaterial({ color: 0x4a2a20, emissive: new THREE.Color(0x1a0800), emissiveIntensity: 0.3 });

const POLE_MAT = new THREE.MeshLambertMaterial({ color: 0x888888 });

/** 共享几何体（全局单例，避免重复创建） */
const WALL_GEO    = new THREE.CylinderGeometry(1, 1.08, 0.35, 8);
const KEEP_GEO    = new THREE.BoxGeometry(1.1, 2.2, 1.1);
const TOWER_GEO   = new THREE.CylinderGeometry(0.24, 0.28, 2.0, 8);
const WATCH_GEO   = new THREE.CylinderGeometry(0.17, 0.21, 2.6, 8);
const SPIRE_GEO   = new THREE.ConeGeometry(0.30, 0.75, 8);
const SMALL_SPIRE = new THREE.ConeGeometry(0.22, 0.60, 8);
const POLE_GEO    = new THREE.CylinderGeometry(0.04, 0.04, 1.3, 5);
const FLAG_GEO    = new THREE.PlaneGeometry(1, 0.65);
const WIN_GEO     = new THREE.PlaneGeometry(1, 1);

/** 复用矩阵/向量（每次 setMatrixAt 调用都会用到，全局复用减少 GC） */
const _matrix = new THREE.Matrix4();
const _pos    = new THREE.Vector3();
const _quat   = new THREE.Quaternion();
const _scale  = new THREE.Vector3();
const _euler  = new THREE.Euler();
const _sp     = new THREE.Vector3();

/**
 * 【性能优化】四角楼方向向量提升至模块级
 * 原始问题：cornerDir 在 buildGroup 函数内每次调用时创建 4 个 new THREE.Vector2()，
 *   当 players 列表变化频繁时，会产生不必要的短期对象，增加 GC 压力。
 * 修复方案：提升到模块级（这些方向向量是常量，永不改变），消除函数调用分配。
 */
const CORNER_DIRS = [
  new THREE.Vector2( 1,  1),
  new THREE.Vector2(-1,  1),
  new THREE.Vector2( 1, -1),
  new THREE.Vector2(-1, -1),
] as const;

/**
 * 计算城堡渲染尺寸参数
 * r = occupy_radius × BASE_RADIUS_RATIO，决定城堡底部半径
 * h = r × 0.22，控制所有竖向部件的高度比例
 *
 * 取 0.22 的原因：使主楼高度（h × 2.2 × scale）约为半径的 1 倍，
 * 视觉上城堡高度与宽度接近 1:1，符合中世纪城堡的典型比例。
 */
function computeCitySize(p: PlayerData): { r: number; h: number } {
  const blockR  = p.block_radius  ?? CITY_ENTITY_SIZES.DEFAULT_BLOCK_RADIUS;
  const occupyR = p.occupy_radius ?? blockR * CITY_ENTITY_SIZES.OCCUPY_TO_BLOCK_RATIO;
  const r       = occupyR * CITY_ENTITY_SIZES.BASE_RADIUS_RATIO;
  const h       = r * 0.22;
  return { r, h };
}

interface CastleMeshGroup {
  wallMesh:   THREE.InstancedMesh;
  keepMesh:   THREE.InstancedMesh;
  towerMesh:  THREE.InstancedMesh;
  watchMesh:  THREE.InstancedMesh;
  spireMesh:  THREE.InstancedMesh;
  tSpiMesh:   THREE.InstancedMesh;
  poleMesh:   THREE.InstancedMesh;
  flagMesh:   THREE.InstancedMesh;
  winMesh:    THREE.InstancedMesh;
}

function disposeGroup(g: CastleMeshGroup, scene: THREE.Scene) {
  Object.values(g).forEach((m: THREE.InstancedMesh) => { scene.remove(m); m.dispose(); });
}

/**
 * 创建一个阵营的城堡 InstancedMesh 组并写入所有实例的变换矩阵
 * @param players     - 该阵营的玩家城市列表
 * @param wallMat     - 城墙/底座材质
 * @param keepMat     - 主楼材质
 * @param towerMat    - 角楼材质
 * @param roofMat     - 屋顶/塔尖材质
 * @param flagMat     - 旗帜材质
 * @param scene       - Three.js 场景（用于 add 新建的 mesh）
 */
function buildGroup(
  players: PlayerData[],
  wallMat:  THREE.Material,
  keepMat:  THREE.Material,
  towerMat: THREE.Material,
  roofMat:  THREE.Material,
  flagMat:  THREE.Material,
  mapCenter: MapCenter,
  tilesData: TileMeshConfig | null,
  terrainCache: TerrainCache,
  scene: THREE.Scene,
  prefix: string,
): CastleMeshGroup | null {
  const n = players.length;
  if (n === 0) return null;

  const wallMesh  = new THREE.InstancedMesh(WALL_GEO,   wallMat,  n);
  const keepMesh  = new THREE.InstancedMesh(KEEP_GEO,   keepMat,  n);
  const towerMesh = new THREE.InstancedMesh(TOWER_GEO,  towerMat, n * 4);
  const watchMesh = new THREE.InstancedMesh(WATCH_GEO,  keepMat,  n);
  const spireMesh = new THREE.InstancedMesh(SPIRE_GEO,  roofMat,  n);
  const tSpiMesh  = new THREE.InstancedMesh(SMALL_SPIRE,roofMat,  n * 4);
  const poleMesh  = new THREE.InstancedMesh(POLE_GEO,   POLE_MAT, n);
  const flagMesh  = new THREE.InstancedMesh(FLAG_GEO,   flagMat,  n);
  const winMesh   = new THREE.InstancedMesh(WIN_GEO,    WINDOW_MAT, n * 2);

  const meshes: THREE.InstancedMesh[] = [wallMesh, keepMesh, towerMesh, watchMesh, spireMesh, tSpiMesh, poleMesh, flagMesh, winMesh];
  meshes.forEach((m, idx) => {
    m.castShadow    = true;
    m.receiveShadow = true;
    m.frustumCulled = true;
    m.name = `castle_${prefix}_${idx}`;
  });
  winMesh.renderOrder = 2;

  /* 使用模块级 CORNER_DIRS 常量，避免每次调用 buildGroup 时创建临时 Vector2 */

  players.forEach((p, i) => {
    const { r, h } = computeCitySize(p);
    worldToScene(p.city_pos.x, p.city_pos.z, mapCenter, tilesData, terrainCache, true, _sp);
    const bY = _sp.y;

    _quat.identity();

    _pos.set(_sp.x, bY + h * 0.18, _sp.z);
    _scale.set(r, h * 0.35, r);
    _matrix.compose(_pos, _quat, _scale);
    wallMesh.setMatrixAt(i, _matrix);

    const keepY = bY + h * 0.35 + h * 1.1;
    _pos.set(_sp.x, keepY, _sp.z);
    _scale.set(r * 0.72, h * 2.2, r * 0.72);
    _matrix.compose(_pos, _quat, _scale);
    keepMesh.setMatrixAt(i, _matrix);

    CORNER_DIRS.forEach((d, j) => {
      const cx = _sp.x + d.x * r * 0.65;
      const cz = _sp.z + d.y * r * 0.65;
      _pos.set(cx, bY + h * 0.35 + h * 1.0, cz);
      _scale.set(r * 0.24, h * 2.0, r * 0.24);
      _matrix.compose(_pos, _quat, _scale);
      towerMesh.setMatrixAt(i * 4 + j, _matrix);

      _pos.set(cx, bY + h * 0.35 + h * 2.0 + h * 0.30, cz);
      _scale.set(r * 0.22, h * 0.60, r * 0.22);
      _matrix.compose(_pos, _quat, _scale);
      tSpiMesh.setMatrixAt(i * 4 + j, _matrix);
    });

    const watchY = bY + h * 0.35 + h * 2.2 + h * 1.3;
    _pos.set(_sp.x, watchY, _sp.z);
    _scale.set(r * 0.19, h * 2.6, r * 0.19);
    _matrix.compose(_pos, _quat, _scale);
    watchMesh.setMatrixAt(i, _matrix);

    const spireY = watchY + h * 1.3 + h * 0.38;
    _pos.set(_sp.x, spireY, _sp.z);
    _scale.set(r * 0.30, h * 0.75, r * 0.30);
    _matrix.compose(_pos, _quat, _scale);
    spireMesh.setMatrixAt(i, _matrix);

    const poleY = spireY + h * 0.38 + h * 0.65;
    _pos.set(_sp.x, poleY, _sp.z);
    _scale.set(r * 0.05, h * 1.3, r * 0.05);
    _matrix.compose(_pos, _quat, _scale);
    poleMesh.setMatrixAt(i, _matrix);

    const flagW = r * 0.6;
    const flagH = r * 0.4;
    _pos.set(_sp.x + flagW * 0.5, poleY + h * 0.45, _sp.z);
    _euler.set(0, 0, 0);
    _quat.setFromEuler(_euler);
    _scale.set(flagW, flagH, 1);
    _matrix.compose(_pos, _quat, _scale);
    flagMesh.setMatrixAt(i, _matrix);

    const winW = r * 0.18;
    const winY = bY + h * 0.35 + h * 1.0;
    _euler.set(0, 0, 0);
    _quat.setFromEuler(_euler);
    _pos.set(_sp.x, winY, _sp.z + r * 0.37);
    _scale.setScalar(winW);
    _matrix.compose(_pos, _quat, _scale);
    winMesh.setMatrixAt(i * 2, _matrix);

    _euler.set(0, Math.PI, 0);
    _quat.setFromEuler(_euler);
    _pos.set(_sp.x, winY, _sp.z - r * 0.37);
    _matrix.compose(_pos, _quat, _scale);
    winMesh.setMatrixAt(i * 2 + 1, _matrix);
  });

  meshes.forEach(m => {
    m.instanceMatrix.needsUpdate = true;
    scene.add(m);
  });

  return { wallMesh, keepMesh, towerMesh, watchMesh, spireMesh, tSpiMesh, poleMesh, flagMesh, winMesh };
}

interface PlayerGroupProps {
  players:       Map<number, PlayerData>;
  currentPid:    number | null;
  mapCenter:     MapCenter;
  tilesData:     TileMeshConfig | null;
  terrainCache:  TerrainCache;
}

export function PlayerGroup({
  players,
  currentPid,
  mapCenter,
  tilesData,
  terrainCache,
}: PlayerGroupProps) {
  const { myPlayers, enPlayers } = useMemo(() => {
    const my: PlayerData[] = [];
    const en: PlayerData[] = [];
    for (const p of players.values()) {
      if (p.id === currentPid) my.push(p);
      else en.push(p);
    }
    return { myPlayers: my, enPlayers: en };
  }, [players, currentPid]);

  /**
   * 【性能优化】用 ref 持有最新数据，useEffect 仅依赖数量变化。
   * 原始问题：useEffect 依赖 [myPlayers, ...] / [enPlayers, ...]，每次 players Map
   *   引用变化（即使数据相同）都会创建新数组 → 触发 InstancedMesh 完全重建。
   *   城市是静态实体（不移动），300ms 轮询时仅需在城市增减时重建。
   * 修复方案：useEffect 依赖 length（数量变化才重建），ref 在 useEffect 中提供最新数据。
   * 预期优化效果：城市 InstancedMesh 重建从"每 300ms"降至"仅城市增减时"。
   */
  const myPlayersRef = useRef(myPlayers);
  myPlayersRef.current = myPlayers;
  const enPlayersRef = useRef(enPlayers);
  enPlayersRef.current = enPlayers;

  const myGroupRef = useRef<CastleMeshGroup | null>(null);
  const enGroupRef = useRef<CastleMeshGroup | null>(null);

  const { scene } = useThree();

  useEffect(() => {
    if (myGroupRef.current) {
      disposeGroup(myGroupRef.current, scene);
      myGroupRef.current = null;
    }
    const arr = myPlayersRef.current;
    if (arr.length > 0) {
      myGroupRef.current = buildGroup(
        arr, MY_WALL_MAT, MY_KEEP_MAT, MY_TOWER_MAT, MY_ROOF_MAT, MY_FLAG_MAT,
        mapCenter, tilesData, terrainCache, scene, 'my'
      );
    }
    return () => {
      if (myGroupRef.current) {
        disposeGroup(myGroupRef.current, scene);
        myGroupRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPlayers.length, mapCenter, tilesData, terrainCache, scene]);

  useEffect(() => {
    if (enGroupRef.current) {
      disposeGroup(enGroupRef.current, scene);
      enGroupRef.current = null;
    }
    const arr = enPlayersRef.current;
    if (arr.length > 0) {
      enGroupRef.current = buildGroup(
        arr, EN_WALL_MAT, EN_KEEP_MAT, EN_TOWER_MAT, EN_ROOF_MAT, EN_FLAG_MAT,
        mapCenter, tilesData, terrainCache, scene, 'en'
      );
    }
    return () => {
      if (enGroupRef.current) {
        disposeGroup(enGroupRef.current, scene);
        enGroupRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enPlayers.length, mapCenter, tilesData, terrainCache, scene]);

  return null;
}

export const PlayerCityEntity = PlayerGroup;
