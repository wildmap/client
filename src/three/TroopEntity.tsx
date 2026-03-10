/**
 * @fileoverview 部队批量渲染组件（人形方阵版）
 * @description 以 3×3 人形方阵渲染每支部队，按我方/敌方阵营使用不同材质色系，
 *              支持行走动画、朝向旋转和行军路径线渲染。
 *
 * 渲染架构（InstancedMesh 方案）：
 *   - 每支部队对应 SQUAD_SIZE（9）个士兵
 *   - 我方/敌方各创建 6 层 InstancedMesh（头/躯干/左臂/右臂/腿/躯干描边）
 *   - InstancedMesh count = 部队数量 × SQUAD_SIZE
 *   - 部队数量变化时重建 InstancedMesh，仅动画时更新矩阵
 *
 * 人形结构（LocalSpace，单位=1）：
 *   - 头部：SphereGeometry，Y = 2.25
 *   - 躯干：CylinderGeometry，Y = 1.18
 *   - 左臂/右臂：CylinderGeometry，Y = 1.08，外侧偏移 0.5
 *   - 腿部：CylinderGeometry，Y = 0.44
 *   - 躯干描边：BackSide CylinderGeometry，略大于躯干
 *
 * 行走动画：
 *   - 行军状态（state=2）的部队：弹跳 + 手臂摆动
 *   - 空闲状态（state=1）：静止姿态（walkPhase=0）
 *   - _globalAnimPhase 全局统一计时，所有士兵同步节拍
 *
 * 路径线（行军时渲染）：
 *   - 每支行军部队对应一条 Line 对象，按需创建/销毁
 *   - polygonOffset 防止与地面 Z-fighting
 *   - showPath=false 时隐藏并清理所有路径线
 *
 * @author WildMap Team
 */
import { useRef, useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { TroopData, MapCenter, TileMeshConfig } from '../types/game';
import { worldToScene, type TerrainCache } from '../utils/coordinates';
import { TROOP_ENTITY_SIZES } from '../utils/entitySizes';

/** 方阵行列数及总人数 */
const SQUAD_ROWS = 3;
const SQUAD_COLS = 3;
const SQUAD_SIZE = SQUAD_ROWS * SQUAD_COLS;

/**
 * 士兵间距相对于 unitSize 的比例
 * 0.7 表示相邻士兵中心距离 = unitSize × 0.7，视觉上略有重叠感，符合方阵密集队形。
 */
const GRID_SPACING_RATIO = 0.7;

/** 我方阵营材质（蓝色系） */
const MY_HELM_MAT    = new THREE.MeshLambertMaterial({ color: 0xaabbdd });
const MY_ARMOR_MAT   = new THREE.MeshLambertMaterial({ color: 0x3366aa });
const MY_OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: 0x00ccff, side: THREE.BackSide });

/** 敌方阵营材质（红色系） */
const EN_HELM_MAT    = new THREE.MeshLambertMaterial({ color: 0x664444 });
const EN_ARMOR_MAT   = new THREE.MeshLambertMaterial({ color: 0xaa2222 });
const EN_OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: 0xff4422, side: THREE.BackSide });

/**
 * 路径线材质
 * polygonOffset 向摄像机方向偏移，防止路径线与地面高度接近时的 Z-fighting 闪烁。
 * depthWrite=false 确保半透明路径线不遮挡后方实体。
 */
const PATH_LINE_MAT = new THREE.LineBasicMaterial({
  color:          0x01ffe9,
  transparent:    true,
  opacity:        0.85,
  polygonOffset:  true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits:  -2,
  depthTest: true,
  depthWrite: false,
});

/** 共享几何体（人形各部件，单位比例，由 scale 控制实际大小） */
const HEAD_GEO         = new THREE.SphereGeometry(0.45, 8, 6);
const TORSO_GEO        = new THREE.CylinderGeometry(0.33, 0.36, 1.1, 7);
const ARM_GEO          = new THREE.CylinderGeometry(0.10, 0.10, 0.85, 5);
const LEG_GEO          = new THREE.CylinderGeometry(0.14, 0.14, 0.88, 5);
const TORSO_OUTLINE_GEO = new THREE.CylinderGeometry(0.38, 0.41, 1.15, 7);

/** 复用矩阵/向量对象（每帧大量 setMatrixAt 调用），避免 GC 开销 */
const _matrix = new THREE.Matrix4();
const _pos    = new THREE.Vector3();
const _quat   = new THREE.Quaternion();
const _scale  = new THREE.Vector3();
const _up     = new THREE.Vector3(0, 1, 0);
const _dirVec = new THREE.Vector3();
const _euler  = new THREE.Euler();
const _tmpV3  = new THREE.Vector3();
const _sp     = new THREE.Vector3();
const _pathSp = new THREE.Vector3();
const _faceQuat = new THREE.Quaternion();

let _globalAnimPhase = 0;

/**
 * 计算部队的渲染单位尺寸
 * 优先使用 occupy_radius，没有时用 block_radius × 1.4，再乘以 SCALE_FACTOR 映射到场景坐标。
 */
function computeUnitSize(t: TroopData): number {
  const raw = (t.occupy_radius ?? (t.block_radius ?? TROOP_ENTITY_SIZES.DEFAULT_BLOCK_RADIUS) * 1.4)
    * TROOP_ENTITY_SIZES.SCALE_FACTOR;
  return Math.max(TROOP_ENTITY_SIZES.MIN_SIZE, Math.min(TROOP_ENTITY_SIZES.MAX_SIZE, raw));
}

/**
 * 计算部队的朝向四元数
 * 当部队有寻路路径时，朝向第一个路径节点方向；无路径时保持默认朝向。
 */
function computeFaceQuat(
  t: TroopData, sp: THREE.Vector3,
  mapCenter: MapCenter, tilesData: TileMeshConfig | null, terrainCache: TerrainCache,
  outQuat: THREE.Quaternion
): THREE.Quaternion {
  outQuat.identity();
  if (t.path?.length) {
    worldToScene(t.path[0].x, t.path[0].z, mapCenter, tilesData, terrainCache, true, _pathSp);
    _dirVec.set(_pathSp.x - sp.x, 0, _pathSp.z - sp.z);
    if (_dirVec.lengthSq() > 1) {
      _dirVec.normalize();
      outQuat.setFromAxisAngle(_up, Math.atan2(_dirVec.x, _dirVec.z));
    }
  }
  return outQuat;
}

/**
 * 写入一支部队的 3×3 方阵所有士兵的变换矩阵到各 InstancedMesh
 * 此函数每帧为每支部队调用一次，是整个渲染管线中最热点的函数。
 *
 * @param troopIdx  - 此部队在 InstancedMesh 中的起始索引（= 部队序号 × SQUAD_SIZE）
 * @param walkPhase - 行走动画相位（0=静止，>0=行走弹跳），仅行军状态传入非零值
 */
function writeTroopSquad(
  headM:    THREE.InstancedMesh,
  torsoM:   THREE.InstancedMesh,
  lArmM:    THREE.InstancedMesh,
  rArmM:    THREE.InstancedMesh,
  legM:     THREE.InstancedMesh,
  outlineM: THREE.InstancedMesh,
  troopIdx: number,
  t: TroopData,
  mapCenter: MapCenter,
  tilesData: TileMeshConfig | null,
  terrainCache: TerrainCache,
  walkPhase = 0,
): void {
  const s    = computeUnitSize(t);
  const sp   = worldToScene(t.position.x, t.position.z, mapCenter, tilesData, terrainCache, true, _sp);
  const bY   = sp.y;
  const fq   = computeFaceQuat(t, sp, mapCenter, tilesData, terrainCache, _faceQuat);
  const step = s * GRID_SPACING_RATIO;

  const halfCols = (SQUAD_COLS - 1) * 0.5;
  const halfRows = (SQUAD_ROWS - 1) * 0.5;

  for (let row = 0; row < SQUAD_ROWS; row++) {
    for (let col = 0; col < SQUAD_COLS; col++) {
      const soldierIdx = troopIdx + row * SQUAD_COLS + col;

      const localX = (col - halfCols) * step;
      const localZ = (row - halfRows) * step;
      _tmpV3.set(localX, 0, localZ).applyQuaternion(fq);
      const wx = sp.x + _tmpV3.x;
      const wz = sp.z + _tmpV3.z;

      /**
       * 棋盘格相位偏移（parity）使相邻士兵弹跳节拍错开，
       * 产生更自然的集体行军感（而非所有人同时起落）。
       */
      const parity  = ((row + col) % 2 === 0) ? 1 : -1;
      const walkBob = Math.sin(walkPhase + parity * 0.8) * (s * 0.04);

      _pos.set(wx, bY + s * 2.25 + walkBob, wz);
      _scale.setScalar(s * 0.46);
      _matrix.compose(_pos, fq, _scale);
      headM.setMatrixAt(soldierIdx, _matrix);

      _pos.set(wx, bY + s * 1.18 + walkBob * 0.5, wz);
      _scale.set(s * 0.36, s * 1.1, s * 0.36);
      _matrix.compose(_pos, fq, _scale);
      torsoM.setMatrixAt(soldierIdx, _matrix);

      const armSwing = Math.sin(walkPhase + parity * 0.8) * 0.28;
      _euler.set(armSwing * Math.PI * 0.25, 0, 0.22);
      _quat.setFromEuler(_euler).premultiply(fq);
      _tmpV3.set(-s * 0.50, 0, 0).applyQuaternion(fq);
      _pos.set(wx + _tmpV3.x, bY + s * 1.08, wz + _tmpV3.z);
      _scale.set(s * 0.12, s * 0.85, s * 0.12);
      _matrix.compose(_pos, _quat, _scale);
      lArmM.setMatrixAt(soldierIdx, _matrix);

      _euler.set(-armSwing * Math.PI * 0.25, 0, -0.22);
      _quat.setFromEuler(_euler).premultiply(fq);
      _tmpV3.set(s * 0.50, 0, 0).applyQuaternion(fq);
      _pos.set(wx + _tmpV3.x, bY + s * 1.08, wz + _tmpV3.z);
      _matrix.compose(_pos, _quat, _scale);
      rArmM.setMatrixAt(soldierIdx, _matrix);

      _pos.set(wx, bY + s * 0.44, wz);
      _scale.set(s * 0.28, s * 0.88, s * 0.28);
      _matrix.compose(_pos, fq, _scale);
      legM.setMatrixAt(soldierIdx, _matrix);

      _pos.set(wx, bY + s * 1.18 + walkBob * 0.5, wz);
      _scale.set(s * 0.40, s * 1.15, s * 0.40);
      _matrix.compose(_pos, fq, _scale);
      outlineM.setMatrixAt(soldierIdx, _matrix);
    }
  }
}

interface TroopGroupProps {
  troops:        Map<number, TroopData>;
  selectedId:    number | null;
  currentPid:    number | null;
  mapCenter:     MapCenter;
  tilesData:     TileMeshConfig | null;
  terrainCache:  TerrainCache;
  showPath:      boolean;
}

export function TroopGroup({
  troops,
  currentPid,
  selectedId,
  mapCenter,
  tilesData,
  terrainCache,
  showPath,
}: TroopGroupProps) {
  const { myTroops, enTroops } = useMemo(() => {
    const my: TroopData[] = [];
    const en: TroopData[] = [];
    for (const t of troops.values()) {
      if (t.owner === currentPid) my.push(t);
      else en.push(t);
    }
    return { myTroops: my, enTroops: en };
  }, [troops, currentPid]);

  const myHeadRef    = useRef<THREE.InstancedMesh | null>(null);
  const myTorsoRef   = useRef<THREE.InstancedMesh | null>(null);
  const myLArmRef    = useRef<THREE.InstancedMesh | null>(null);
  const myRArmRef    = useRef<THREE.InstancedMesh | null>(null);
  const myLegRef     = useRef<THREE.InstancedMesh | null>(null);
  const myOutlineRef = useRef<THREE.InstancedMesh | null>(null);

  const enHeadRef    = useRef<THREE.InstancedMesh | null>(null);
  const enTorsoRef   = useRef<THREE.InstancedMesh | null>(null);
  const enLArmRef    = useRef<THREE.InstancedMesh | null>(null);
  const enRArmRef    = useRef<THREE.InstancedMesh | null>(null);
  const enLegRef     = useRef<THREE.InstancedMesh | null>(null);
  const enOutlineRef = useRef<THREE.InstancedMesh | null>(null);

  const pathLinesRef    = useRef<Map<number, THREE.Line>>(new Map());
  /** 持久化 marchingIds Set，避免每帧 new Set() 造成 GC 压力 */
  const _marchingIdsRef = useRef<Set<number>>(new Set());

  const myTroopsRef = useRef<TroopData[]>(myTroops);
  const enTroopsRef = useRef<TroopData[]>(enTroops);
  const showPathRef = useRef<boolean>(showPath);

  useEffect(() => { myTroopsRef.current = myTroops; }, [myTroops]);
  useEffect(() => { enTroopsRef.current = enTroops; }, [enTroops]);
  useEffect(() => { showPathRef.current = showPath; }, [showPath]);

  const { scene } = useThree();

  /**
   * 创建一个阵营的 InstancedMesh 组
   * 返回包含 6 层 mesh 的对象，调用方负责添加到场景和设置 ref。
   */
  function buildFaction(
    list: TroopData[],
    helmMat: THREE.Material, armorMat: THREE.Material,
    outlineMat: THREE.Material, pfx: string,
  ) {
    if (list.length === 0) return null;
    const count = list.length * SQUAD_SIZE;
    const headM    = new THREE.InstancedMesh(HEAD_GEO,          helmMat,    count);
    const torsoM   = new THREE.InstancedMesh(TORSO_GEO,         armorMat,   count);
    const lArmM    = new THREE.InstancedMesh(ARM_GEO,           armorMat,   count);
    const rArmM    = new THREE.InstancedMesh(ARM_GEO,           armorMat,   count);
    const legM     = new THREE.InstancedMesh(LEG_GEO,           armorMat,   count);
    const outlineM = new THREE.InstancedMesh(TORSO_OUTLINE_GEO, outlineMat, count);

    [headM, torsoM, lArmM, rArmM, legM, outlineM].forEach((m, idx) => {
      m.castShadow    = true;
      m.receiveShadow = true;
      m.frustumCulled = true;
      m.name = `troop_${pfx}_${idx}`;
    });

    list.forEach((t, i) => {
      writeTroopSquad(headM, torsoM, lArmM, rArmM, legM, outlineM,
        i * SQUAD_SIZE, t, mapCenter, tilesData, terrainCache);
    });
    [headM, torsoM, lArmM, rArmM, legM, outlineM].forEach(m => {
      m.instanceMatrix.needsUpdate = true;
    });

    return { headM, torsoM, lArmM, rArmM, legM, outlineM };
  }

  /**
   * InstancedMesh 重建策略：仅当部队【数量】变化时重建，而非每次位置更新时重建。
   *
   * 原因：服务端每 2-3 秒推送部队位置更新，updateTroops 会创建新的 Map 引用，
   * 导致 myTroops 数组引用变化。若依赖整个 myTroops，每次位置更新都重建 6 个
   * InstancedMesh，产生 10-30ms 的峰值卡顿和大量 GC 压力。
   *
   * 优化后：仅依赖 myTroops.length，位置更新在 useFrame 中通过 myTroopsRef.current
   * 读取最新数据（Ref 在 useEffect 中同步），不触发重建。
   *
   * 注意：mapCenter/tilesData/terrainCache 变化时仍需重建（地图切换场景）。
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    [myHeadRef, myTorsoRef, myLArmRef, myRArmRef, myLegRef, myOutlineRef].forEach(r => {
      if (r.current) { scene.remove(r.current); r.current.dispose(); r.current = null; }
    });
    const f = buildFaction(myTroops, MY_HELM_MAT, MY_ARMOR_MAT, MY_OUTLINE_MAT, 'my');
    if (!f) return;
    const { headM, torsoM, lArmM, rArmM, legM, outlineM } = f;
    [headM, torsoM, lArmM, rArmM, legM, outlineM].forEach(m => scene.add(m));
    myHeadRef.current = headM; myTorsoRef.current = torsoM;
    myLArmRef.current = lArmM; myRArmRef.current = rArmM;
    myLegRef.current  = legM;  myOutlineRef.current = outlineM;
    return () => {
      [headM, torsoM, lArmM, rArmM, legM, outlineM].forEach(m => { scene.remove(m); m.dispose(); });
      myHeadRef.current = myTorsoRef.current = myLArmRef.current = myRArmRef.current = null;
      myLegRef.current  = myOutlineRef.current = null;
    };
  // 关键：仅依赖 myTroops.length（数量变化）而非整个 myTroops 数组（内容变化）
  // 位置/状态更新通过 myTroopsRef.current 在 useFrame 中实时读取
  }, [myTroops.length, mapCenter, tilesData, terrainCache, scene]); // eslint-disable-line

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    [enHeadRef, enTorsoRef, enLArmRef, enRArmRef, enLegRef, enOutlineRef].forEach(r => {
      if (r.current) { scene.remove(r.current); r.current.dispose(); r.current = null; }
    });
    const f = buildFaction(enTroops, EN_HELM_MAT, EN_ARMOR_MAT, EN_OUTLINE_MAT, 'en');
    if (!f) return;
    const { headM, torsoM, lArmM, rArmM, legM, outlineM } = f;
    [headM, torsoM, lArmM, rArmM, legM, outlineM].forEach(m => scene.add(m));
    enHeadRef.current = headM; enTorsoRef.current = torsoM;
    enLArmRef.current = lArmM; enRArmRef.current = rArmM;
    enLegRef.current  = legM;  enOutlineRef.current = outlineM;
    return () => {
      [headM, torsoM, lArmM, rArmM, legM, outlineM].forEach(m => { scene.remove(m); m.dispose(); });
      enHeadRef.current = enTorsoRef.current = enLArmRef.current = enRArmRef.current = null;
      enLegRef.current  = enOutlineRef.current = null;
    };
  // 同上：仅依赖敌方部队数量，不依赖内容
  }, [enTroops.length, mapCenter, tilesData, terrainCache, scene]); // eslint-disable-line

  useEffect(() => {
    return () => {
      for (const line of pathLinesRef.current.values()) {
        scene.remove(line);
        line.geometry.dispose();
      }
      pathLinesRef.current.clear();
    };
  }, [scene]);

  useFrame((_, delta) => {
    _globalAnimPhase = (_globalAnimPhase + delta * 3.5) % (Math.PI * 2);
    const walk = _globalAnimPhase;

    const myH = myHeadRef.current, myT = myTorsoRef.current;
    const myLA = myLArmRef.current, myRA = myRArmRef.current;
    const myL = myLegRef.current, myO = myOutlineRef.current;
    const myArr = myTroopsRef.current;
    const myExp = myArr.length * SQUAD_SIZE;
    if (myH && myT && myLA && myRA && myL && myO && myH.count === myExp && myArr.length > 0) {
      /**
       * 静止部队跳过矩阵更新优化：
       * - 仅对 state===2（行军中）的部队调用 writeTroopSquad（矩阵 + 动画）
       * - 静止部队的矩阵在 useEffect 建立时已写入，不会改变，无需每帧重新上传
       * - 有移动部队时才标记 instanceMatrix.needsUpdate（触发 GPU buffer 上传）
       */
      let hasMoving = false;
      myArr.forEach((troop, i) => {
        const isMoving = troop.state === 2;
        if (isMoving) {
          hasMoving = true;
          writeTroopSquad(myH, myT, myLA, myRA, myL, myO,
            i * SQUAD_SIZE, troop, mapCenter, tilesData, terrainCache, walk);
        }
      });
      if (hasMoving) {
        [myH, myT, myLA, myRA, myL, myO].forEach(m => { m.instanceMatrix.needsUpdate = true; });
      }
    }

    const enH = enHeadRef.current, enTM = enTorsoRef.current;
    const enLA = enLArmRef.current, enRA = enRArmRef.current;
    const enL = enLegRef.current, enO = enOutlineRef.current;
    const enArr = enTroopsRef.current;
    const enExp = enArr.length * SQUAD_SIZE;
    if (enH && enTM && enLA && enRA && enL && enO && enH.count === enExp && enArr.length > 0) {
      let hasMoving = false;
      enArr.forEach((troop, i) => {
        const isMoving = troop.state === 2;
        if (isMoving) {
          hasMoving = true;
          writeTroopSquad(enH, enTM, enLA, enRA, enL, enO,
            i * SQUAD_SIZE, troop, mapCenter, tilesData, terrainCache, walk);
        }
      });
      if (hasMoving) {
        [enH, enTM, enLA, enRA, enL, enO].forEach(m => { m.instanceMatrix.needsUpdate = true; });
      }
    }

    /**
     * 路径线更新：仅渲染 state=2（行军）且有路径的部队
     * 按需创建 Line 对象（首次出现），按需销毁（停止行军）
     * Y 轴偏移 pathY 随 unitSize 缩放，确保路径线始终在地面以上
     * _marchingIdsRef.current 持久复用，避免每帧 new Set() GC 分配
     */
    if (showPathRef.current) {
      const myArr   = myTroopsRef.current;
      const enArr   = enTroopsRef.current;
      const pathMap = pathLinesRef.current;

      /* 复用持久 Set，先清空再填充，避免每帧分配新 Set 对象 */
      const marchingIds = _marchingIdsRef.current;
      marchingIds.clear();
      for (const tr of myArr) {
        if (tr.state === 2 && tr.path?.length) marchingIds.add(tr.id);
      }
      for (const tr of enArr) {
        if (tr.state === 2 && tr.path?.length) marchingIds.add(tr.id);
      }

      for (const [id, line] of pathMap) {
        if (!marchingIds.has(id)) {
          scene.remove(line);
          line.geometry.dispose();
          pathMap.delete(id);
        }
      }

      /* 直接遍历两个独立数组，避免 spread 扩展操作符创建临时数组（GC 分配） */
      const allTroopArrays = [myArr, enArr];
      for (const troopArr of allTroopArrays) {
       for (const tr of troopArr) {
        if (!(tr.state === 2 && tr.path?.length)) continue;

        let line = pathMap.get(tr.id);
        if (!line) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(900), 3));
          line = new THREE.Line(geo, PATH_LINE_MAT);
          line.name          = `path_${tr.id}`;
          line.frustumCulled = false;
          line.renderOrder   = 5;
          scene.add(line);
          pathMap.set(tr.id, line);
        }

        const unitSize = computeUnitSize(tr);
        const pathY    = unitSize * 0.25;
        const posAttr  = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        const arr      = posAttr.array as Float32Array;
        let idx = 0;

        worldToScene(tr.position.x, tr.position.z, mapCenter, tilesData, terrainCache, true, _tmpV3);
        arr[idx++] = _tmpV3.x; arr[idx++] = _tmpV3.y + pathY; arr[idx++] = _tmpV3.z;
        for (const node of tr.path) {
          if (idx >= 900) break;
          worldToScene(node.x, node.z, mapCenter, tilesData, terrainCache, true, _tmpV3);
          arr[idx++] = _tmpV3.x; arr[idx++] = _tmpV3.y + pathY; arr[idx++] = _tmpV3.z;
        }

        line.geometry.setDrawRange(0, idx / 3);
        posAttr.needsUpdate = true;
        line.visible = true;
       } /* end: for tr of troopArr */
      } /* end: for troopArr of allTroopArrays */
    } else {
      /**
       * 【代码一致性修复】showPath=false 时清理所有路径线
       * 原始代码在 for...of 迭代中逐个 delete，虽然 ES6 Map 规范允许迭代中删除，
       * 但与 useEffect cleanup（第 360-368 行）使用的 iterate+clear() 模式不一致。
       * 改为先遍历释放资源，再统一 clear()，代码意图更清晰、维护性更好。
       */
      for (const line of pathLinesRef.current.values()) {
        scene.remove(line);
        line.geometry.dispose();
      }
      pathLinesRef.current.clear();
    }
  });

  return null;
}

export const TroopEntity = TroopGroup;
