/**
 * @fileoverview 坐标转换与地形高程工具
 * @description 负责游戏世界坐标（服务端逻辑坐标）与 Three.js 场景坐标之间的双向转换，
 *              以及基于 Perlin 噪声的程序化地形高程缓存管理。
 *
 * 坐标系说明：
 *   - 世界坐标（World Coord）：服务端使用的游戏逻辑坐标，原点在地图左上角
 *   - 场景坐标（Scene Coord）：Three.js 使用的 3D 坐标，原点在地图中心，Y 轴为高度
 *
 * 内存管理策略（v2 优化）：
 *   - TerrainCache 由 Map<string, entry> 改为 Float64Array 平坦数组
 *   - 访问方式：cache.data[tileX * cache.ztilecount + tileZ]（O(1) 无字符串分配）
 *   - 消除每帧数百次的字符串模板拼接（`${tileX}-${tileZ}`）产生的临时对象 GC 压力
 *   - Float64Array 元素直接存储 elevation 原始值，无额外包装对象
 *   - 典型地图 500×500=250,000 条目，每条 8 bytes，总内存约 2MB（原 Map 约 20MB）
 *
 * @author WildMap Team
 */
import * as THREE from 'three';
import type { MapCenter, TileMeshConfig } from '../types/game';
import { globalPerlinNoise } from './perlinNoise';

/**
 * 地形高程渲染缩放系数
 * 原始 Perlin 噪声输出值域约 [-800, 800]，乘以此系数得到 Three.js 场景中的 Y 轴高度。
 *
 * 取值依据：
 *   - 0.035：最大高度 28，相对相机高度 75000 仅 0.037%，视觉上几乎平坦
 *   - 0.15：最大高度 120，在斜视角（37°）下地形起伏清晰可见（当前值）
 *
 * 注意：修改此值会影响所有地形相关计算（障碍物贴地、实体 Y 坐标、相机对齐）。
 *       ObstacleMeshes.tsx 中的 HEIGHT_SCALE 常量需与此值同步。
 */
export const HEIGHT_SCALE_FACTOR = 0.15;

/**
 * 地形数据缓存结构（v2：平坦数组替代字符串键 Map）
 *
 * @property data        - 平坦 Float64Array，存储所有瓦片的 elevation 原始值
 *                         索引公式：tileX * ztilecount + tileZ
 * @property xtilecount  - X 方向瓦片数（与 TileMeshConfig 一致）
 * @property ztilecount  - Z 方向瓦片数（与 TileMeshConfig 一致）
 * @property tilewidth   - 单个瓦片宽度（世界坐标单位）
 * @property tileheight  - 单个瓦片高度（世界坐标单位）
 *
 * 访问示例：
 *   const tileX = Math.floor(worldX / tilewidth);
 *   const tileZ = Math.floor(worldZ / tileheight);
 *   const elevation = cache.data[tileX * cache.ztilecount + tileZ];
 */
export interface TerrainCache {
  data:       Float64Array;
  xtilecount: number;
  ztilecount: number;
  tilewidth:  number;
  tileheight: number;
}

/**
 * 空地形缓存（地图尚未加载时的初始值）
 * 空缓存的 data.length === 0，所有 getTerrainElevation 调用会快速返回 0。
 */
export const EMPTY_TERRAIN_CACHE: TerrainCache = {
  data:       new Float64Array(0),
  xtilecount: 0,
  ztilecount: 0,
  tilewidth:  1,
  tileheight: 1,
};

/**
 * 根据瓦片配置预生成全量地形高程缓存
 * 在地图资源加载完成后调用一次，避免后续每帧重复计算 Perlin 噪声。
 *
 * 算法：以世界坐标为噪声输入，使用 5 倍频 FBM 生成自然地形，输出值 × 800 得到高程原始值。
 *
 * 内存：Float64Array 每元素 8 bytes。
 *   500×500 = 250,000 × 8 = 2,000,000 bytes ≈ 1.9 MB（优化前 Map 约 20 MB）。
 *
 * @param tilesData - 瓦片地图配置（包含瓦片尺寸和数量）
 * @returns 填充完毕的地形缓存对象
 */
export function generateTerrainCache(tilesData: TileMeshConfig): TerrainCache {
  const { tilewidth, tileheight, xtilecount, ztilecount } = tilesData;
  const data = new Float64Array(xtilecount * ztilecount);

  for (let x = 0; x < xtilecount; x++) {
    for (let z = 0; z < ztilecount; z++) {
      const worldX  = x * tilewidth;
      const worldZ  = z * tileheight;
      const noiseX  = worldX * 0.0001;
      const noiseZ  = worldZ * 0.0001;
      const elevation = globalPerlinNoise.fbm(noiseX * 0.8, noiseZ * 0.8, 5, 0.5, 2.0) * 800;
      // 索引：tileX * ztilecount + tileZ（行优先存储）
      data[x * ztilecount + z] = elevation;
    }
  }

  return { data, xtilecount, ztilecount, tilewidth, tileheight };
}

/**
 * 从地形缓存查询指定世界坐标处的高程值（未缩放的原始值）
 *
 * 性能关键路径优化（v2）：
 *   - 原方案：`cache.get(\`${tileX}-${tileZ}\`)?.elevation` — 每次创建字符串临时对象
 *   - 新方案：`cache.data[tileX * cache.ztilecount + tileZ]` — 纯整数运算，零 GC
 *
 * @param worldX       - 世界坐标 X
 * @param worldZ       - 世界坐标 Z
 * @param tilesData    - 瓦片地图配置（null 时返回 0）
 * @param terrainCache - 地形缓存
 * @returns 高程原始值（未经 HEIGHT_SCALE_FACTOR 缩放），缓存为空时返回 0
 */
export function getTerrainElevation(
  worldX: number,
  worldZ: number,
  tilesData: TileMeshConfig,
  terrainCache: TerrainCache
): number {
  if (terrainCache.data.length === 0) return 0;
  const tileX = Math.floor(worldX / tilesData.tilewidth);
  const tileZ = Math.floor(worldZ / tilesData.tileheight);
  // 边界检查，防止越界
  if (tileX < 0 || tileX >= terrainCache.xtilecount) return 0;
  if (tileZ < 0 || tileZ >= terrainCache.ztilecount) return 0;
  return terrainCache.data[tileX * terrainCache.ztilecount + tileZ];
}

/**
 * 获取指定世界坐标处的 Three.js 场景 Y 高度（经过 HEIGHT_SCALE_FACTOR 缩放）
 * @param worldX       - 世界坐标 X
 * @param worldZ       - 世界坐标 Z
 * @param tilesData    - 瓦片配置（null 时返回 0）
 * @param terrainCache - 地形缓存
 * @returns 场景坐标 Y 值
 */
export function getTerrainHeight(
  worldX: number,
  worldZ: number,
  tilesData: TileMeshConfig | null,
  terrainCache: TerrainCache
): number {
  if (!tilesData) return 0;
  return getTerrainElevation(worldX, worldZ, tilesData, terrainCache) * HEIGHT_SCALE_FACTOR;
}

/**
 * 世界坐标 → Three.js 场景坐标转换
 * 地图中心（mapCenter）映射到场景原点，Y 轴根据 includeHeight 参数决定是否包含地形高度。
 *
 * @param worldX        - 世界坐标 X
 * @param worldZ        - 世界坐标 Z
 * @param mapCenter     - 地图中心世界坐标
 * @param tilesData     - 瓦片配置（null 时 Y=0）
 * @param terrainCache  - 地形缓存
 * @param includeHeight - 是否包含地形高度（false 时 Y=0，用于平面计算）
 * @returns Three.js Vector3 场景坐标
 *
 * @example
 * const scenePos = worldToScene(playerX, playerZ, mapCenter, tilesData, terrainCache, true);
 * mesh.position.copy(scenePos);
 */
export function worldToScene(
  worldX: number,
  worldZ: number,
  mapCenter: MapCenter,
  tilesData: TileMeshConfig | null,
  terrainCache: TerrainCache,
  includeHeight = true,
  target?: THREE.Vector3
): THREE.Vector3 {
  const height = (includeHeight && tilesData)
    ? getTerrainHeight(worldX, worldZ, tilesData, terrainCache)
    : 0;
  if (target) {
    return target.set(worldX - mapCenter.x, height, worldZ - mapCenter.z);
  }
  return new THREE.Vector3(worldX - mapCenter.x, height, worldZ - mapCenter.z);
}

/**
 * 可复用的世界坐标输出对象接口
 * 用于 sceneToWorld 的 target 参数，避免在热路径中创建新的 {x, z} 对象。
 */
export interface WorldCoordXZ {
  x: number;
  z: number;
}

/**
 * Three.js 场景坐标 → 世界坐标转换
 * worldToScene 的逆操作，用于鼠标点击场景坐标还原为游戏逻辑坐标（如右键行军目标）。
 *
 * 【性能优化】新增 target 参数：
 *   原始代码每次调用都 return { x: ..., z: ... } 创建新的堆对象。
 *   在拖拽热路径中（onChange + useFrame），每帧调用 2-4 次 sceneToWorld，
 *   产生 120-240 个短生命周期对象/秒，增加 GC 压力。
 *   新增 target 参数后，调用方可传入预分配对象，实现零分配。
 *
 * @param sceneVec  - Three.js 场景坐标向量
 * @param mapCenter - 地图中心世界坐标
 * @param target    - 可选的可复用输出对象，提供时直接写入并返回，避免 GC 分配
 * @returns 包含 x, z 的世界坐标对象
 *
 * @example
 * // 非热路径：分配新对象（保持向后兼容）
 * const worldCoord = sceneToWorld(intersectPoint, mapCenter);
 * // 热路径：复用预分配对象
 * const _reusable: WorldCoordXZ = { x: 0, z: 0 };
 * sceneToWorld(controls.target, mapCenter, _reusable);
 */
export function sceneToWorld(
  sceneVec: THREE.Vector3,
  mapCenter: MapCenter,
  target?: WorldCoordXZ,
): WorldCoordXZ {
  const x = sceneVec.x + mapCenter.x;
  const z = sceneVec.z + mapCenter.z;
  if (target) {
    target.x = x;
    target.z = z;
    return target;
  }
  return { x, z };
}
