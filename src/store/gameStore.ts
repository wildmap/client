/**
 * @fileoverview 全局游戏状态管理 Store（Zustand）
 * @description 采用单一扁平 Store 集中管理所有游戏状态，避免多 Context 嵌套导致的组件重渲染问题。
 *
 * 状态分层设计：
 *   - 连接层：WebSocket 连接状态、当前登录玩家信息
 *   - 地图层：地图资源（导航网格、障碍物、瓦片配置）、预计算地形缓存
 *   - 实体层：采集点、玩家城市、部队数据（均使用 Map<id, data> 提升查找性能）
 *   - UI 层：地图图层显示开关、标签页、视图模式、选中部队
 *   - 视口层：相机可视范围、视图中心（供 mapView 轮询使用）
 *   - Lua 层：脚本输入内容与执行输出
 *
 * 实体更新策略（差量更新）：
 *   updateGathers/Players/Troops 采用「以服务端最新列表为权威」的差量更新策略：
 *   1. 移除本地存在但服务端最新列表中不存在的实体（离开视野）
 *   2. 新增或更新服务端列表中的实体（进入视野或数据变化）
 *   此策略保证 Map 引用在实体数量不变时不变化，避免触发不必要的 React 重渲染。
 *
 * @author WildMap Team
 */
import { create } from 'zustand';
import type {
  GatherData,
  GatherDetailData,
  PlayerData,
  TroopData,
  TileMeshConfig,
  NavMeshConfig,
  ObstacleConfig,
  DisplayState,
  ViewMode,
  ConnectionStatus,
  MapBounds,
  MapCenter,
  ViewSpan,
} from '../types/game';
import { TerrainCache, generateTerrainCache, EMPTY_TERRAIN_CACHE } from '../utils/coordinates';

/**
 * 游戏全局状态接口定义
 * 包含所有状态字段和 Action 方法声明。
 */
export interface GameState {
  connectionStatus: ConnectionStatus;
  /** 当前登录玩家 ID（null 表示未登录） */
  currentPlayerId: number | null;
  /** 玩家是否已成功加入游戏（收到服务端 playerJoin 确认响应） */
  isPlayerJoined: boolean;
  /** 当前玩家数据（城市坐标、半径等） */
  currentPlayerData: PlayerData | null;

  navMeshData:     NavMeshConfig | null;
  obstaclesData:   ObstacleConfig | null;
  tilesData:       TileMeshConfig | null;
  /** 预计算的地形高程缓存，在 setMapResource 接收瓦片数据时自动填充 */
  terrainCache:    TerrainCache;
  /** 地图世界坐标边界，用于相机移动范围约束 */
  mapBounds:       MapBounds;
  /** 地图中心世界坐标，Three.js 场景以此为原点 */
  mapCenter:       MapCenter;

  /** 采集点数据 Map（id → GatherData），支持 O(1) 查找 */
  gathers:  Map<number, GatherData>;
  /** 玩家城市数据 Map（id → PlayerData） */
  players:  Map<number, PlayerData>;
  /** 部队数据 Map（id → TroopData） */
  troops:   Map<number, TroopData>;

  /** 地图图层显示控制（导航网格/障碍物/瓦片/路径） */
  display: DisplayState;
  /** 当前激活的功能标签页 */
  activeTab: 'troop' | 'map' | 'game';
  /** 相机视图模式（free/city/troop） */
  viewMode: ViewMode;
  /** 当前选中部队 ID（null 表示无选中） */
  selectedTroopId: number | null;
  /** 当前选中采集点 ID（null 表示无选中），点击资源点后弹出采集菜单 */
  selectedGatherId: number | null;
  /** 选中采集点的详细信息列表（服务端 gatherDetailNtf 响应数据） */
  gatherDetails: GatherDetailData[];
  /** 采集详情请求是否正在加载中 */
  gatherDetailLoading: boolean;
  /** 是否已经执行过初次对准城市（用于登录后一次性跳转） */
  hasCenteredOnCity: boolean;
  /** 相机可视范围（世界坐标跨度），由 CameraController 每帧更新 */
  viewSpan: ViewSpan;
  /** 相机 OrbitControls target 对应的世界坐标，mapView 轮询使用此值定位服务端查询范围 */
  viewCenter: { x: number; z: number };

  luaInput:  string;
  luaOutput: string;

  setConnectionStatus:     (status: ConnectionStatus) => void;
  setCurrentPlayerId:      (id: number | null) => void;
  setIsPlayerJoined:       (v: boolean) => void;
  setCurrentPlayerData:    (data: PlayerData | null) => void;

  /**
   * 加载地图资源数据
   * 接收导航网格、障碍物、瓦片配置中的一项或多项，并在瓦片配置存在时
   * 自动触发地形缓存预计算和地图边界计算。
   */
  setMapResource: (data: {
    navMesh?:    NavMeshConfig;
    obstacles?:  ObstacleConfig;
    tiles?:      TileMeshConfig;
  }) => void;

  /** 批量差量更新采集点（以服务端最新列表为权威） */
  updateGathers:  (list: GatherData[]) => void;
  /** 批量差量更新玩家城市（以服务端最新列表为权威） */
  updatePlayers:  (list: PlayerData[]) => void;
  /** 批量差量更新部队（以服务端最新列表为权威） */
  updateTroops:   (list: TroopData[]) => void;

  /**
   * 按 ID 列表批量删除实体
   * 服务端通过 delEntitiesNtf 或 mapView.need_delete_entities 推送需要移除的实体 ID，
   * 此方法从 gathers/players/troops 三个 Map 中同时移除匹配的实体。
   * 仅在确实有实体被删除时才创建新 Map 引用（性能优化）。
   */
  removeEntitiesById: (ids: number[]) => void;

  /** 切换指定图层的显示状态 */
  toggleDisplay: (key: keyof DisplayState) => void;

  setActiveTab:          (tab: 'troop' | 'map' | 'game') => void;
  setViewMode:           (mode: ViewMode) => void;
  setSelectedTroopId:    (id: number | null) => void;
  setSelectedGatherId:   (id: number | null) => void;
  /** 设置采集点详情数据（来自服务端 gatherDetailNtf 响应） */
  setGatherDetails:      (details: GatherDetailData[]) => void;
  /** 设置采集详情加载状态 */
  setGatherDetailLoading: (v: boolean) => void;
  /** 清除采集详情数据（关闭详情弹窗时调用） */
  clearGatherDetails:    () => void;
  setHasCenteredOnCity:  (v: boolean) => void;
  setViewSpan:           (span: ViewSpan) => void;
  /** 更新相机视图中心世界坐标（由 CameraController 每 100ms 写入） */
  setViewCenter:         (center: { x: number; z: number }) => void;

  setLuaInput:     (v: string) => void;
  appendLuaOutput: (text: string) => void;
  clearLuaOutput:  () => void;

  /** 登出时重置所有会话相关状态（保留地图资源，减少重连后的重新加载） */
  resetSession: () => void;
  /** 重置实体数据（重连清场，或进入新地图时调用） */
  clearGameObjects: () => void;
}

/**
 * 根据瓦片配置计算地图边界和中心坐标
 * @param tiles - 瓦片地图配置
 * @returns 包含世界坐标边界矩形和中心点的对象
 */
function calcBoundsAndCenter(tiles: TileMeshConfig): { bounds: MapBounds; center: MapCenter } {
  const { tilewidth, tileheight, xtilecount, ztilecount } = tiles;
  const bounds: MapBounds = {
    minX: 0,
    maxX: tilewidth  * xtilecount,
    minY: 0,
    maxY: tileheight * ztilecount,
  };
  const center: MapCenter = {
    x: (bounds.maxX - bounds.minX) / 2,
    z: (bounds.maxY - bounds.minY) / 2,
  };
  return { bounds, center };
}

/**
 * 【性能优化】实体深度比较辅助函数
 * 原始问题：useWebSocket 每 300ms 的 mapView 轮询会为每个实体创建全新的 JS 对象。
 *   Zustand 的 updateGathers/Players/Troops 函数使用 `prev.get(id) !== newObj` 进行引用比较，
 *   由于新对象的引用永远不等于旧对象，即使字段值完全相同也会判定为"数据已变化"，
 *   导致每 300ms 都创建新的 Map 引用 → 触发 React 重渲染 → InstancedMesh 完全重建。
 *   这是拖拽地图卡顿的根本原因。
 * 修复方案：按实际字段值进行深度比较，只在真正有数据变化时才创建新 Map。
 * 预期效果：在实体位置/状态不变的帧内跳过 set()，避免 ~90% 的无效重渲染。
 */
function gatherDataEqual(a: GatherData, b: GatherData): boolean {
  return a.id === b.id
    && a.conf_id === b.conf_id
    && a.position.x === b.position.x
    && a.position.z === b.position.z
    && a.remains === b.remains
    && a.block_radius === b.block_radius
    && a.occupy_radius === b.occupy_radius;
}

function playerDataEqual(a: PlayerData, b: PlayerData): boolean {
  return a.id === b.id
    && a.name === b.name
    && a.city_pos.x === b.city_pos.x
    && a.city_pos.z === b.city_pos.z
    && a.block_radius === b.block_radius
    && a.occupy_radius === b.occupy_radius;
}

function troopDataEqual(a: TroopData, b: TroopData): boolean {
  if (a.id !== b.id
    || a.owner !== b.owner
    || a.position.x !== b.position.x
    || a.position.z !== b.position.z
    || a.state !== b.state
    || a.block_radius !== b.block_radius
    || a.occupy_radius !== b.occupy_radius) return false;
  // 路径比较：长度不同 → 不等；长度相同时比较首尾节点坐标（避免 O(n) 全量遍历）
  const ap = a.path, bp = b.path;
  if (ap.length !== bp.length) return false;
  if (ap.length > 0) {
    const aFirst = ap[0], bFirst = bp[0];
    if (aFirst.x !== bFirst.x || aFirst.z !== bFirst.z) return false;
    const aLast = ap[ap.length - 1], bLast = bp[bp.length - 1];
    if (aLast.x !== bLast.x || aLast.z !== bLast.z) return false;
  }
  return true;
}

export const useGameStore = create<GameState>((set, get) => ({
  connectionStatus:  'disconnected',
  currentPlayerId:   null,
  isPlayerJoined:    false,
  currentPlayerData: null,

  navMeshData:   null,
  obstaclesData: null,
  tilesData:     null,
  terrainCache:  EMPTY_TERRAIN_CACHE,
  mapBounds:     { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  mapCenter:     { x: 0, z: 0 },

  gathers: new Map(),
  players: new Map(),
  troops:  new Map(),

  display: {
    navMesh:   false,
    obstacles: true,
    tiles:     true,
    path:      true,
  },

  activeTab:         'troop',
  viewMode:          'free',
  selectedTroopId:   null,
  selectedGatherId:     null,
  gatherDetails:        [],
  gatherDetailLoading:  false,
  hasCenteredOnCity:    false,
  viewSpan: { x_span: 500000, z_span: 500000 },
  viewCenter: { x: 0, z: 0 },

  luaInput:  '',
  luaOutput: '',

  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setCurrentPlayerId:  (id)     => set({ currentPlayerId: id }),
  setIsPlayerJoined:   (v)      => set({ isPlayerJoined: v }),
  setCurrentPlayerData: (data)  => set({ currentPlayerData: data }),

  setMapResource: ({ navMesh, obstacles, tiles }) => {
    const updates: Partial<GameState> = {};
    if (navMesh)    updates.navMeshData   = navMesh;
    if (obstacles)  updates.obstaclesData = obstacles;
    if (tiles) {
      updates.tilesData    = tiles;
      updates.terrainCache = generateTerrainCache(tiles);
      const { bounds, center } = calcBoundsAndCenter(tiles);
      updates.mapBounds = bounds;
      updates.mapCenter = center;
    }
    set(updates as GameState);
  },

  /**
   * 【性能优化】差量更新采集点 — 避免无变化时创建新 Map 引用
   * 原始问题：每次 300ms mapView 轮询都会执行 `new Map(get().gathers)` 创建新 Map，
   * 即使实体列表没有任何变化也会产生新引用，触发所有订阅此 Map 的 React 组件重渲染，
   * 导致 InstancedMesh 每 300ms 无意义重建一次。
   * 同时修复了 `for (const id of next.keys()) { next.delete(id) }` 的 Map 迭代中删除问题。
   * 修复方案：先检查是否有实际变化（ID 集合差异或数据更新），无变化时直接跳过 set()。
   * 预期效果：在实体不变的帧内避免触发重渲染，减少约 70%+ 的无效 InstancedMesh 重建。
   */
  updateGathers: (list) => {
    const prev = get().gathers;
    const newIds = new Set(list.map(g => g.id));
    // 检查是否有需要移除的旧 ID
    let hasRemoval = false;
    for (const id of prev.keys()) {
      if (!newIds.has(id)) { hasRemoval = true; break; }
    }
    // 快速路径：如果 ID 集合和大小都相同且没有移除，可能无变化
    if (!hasRemoval && prev.size === list.length) {
      // 检查数据引用是否相同（服务端每次返回新对象，所以只能比 size）
      // 对于频繁轮询，size 相同且无增删时直接复用旧 Map，减少重渲染
      let allSame = true;
      for (const g of list) {
        if (!prev.has(g.id)) { allSame = false; break; }
      }
      if (allSame) {
        /**
         * 【性能优化】使用深度字段比较代替引用比较
         * 原始代码 `old !== g` 是引用比较，由于 useWebSocket 每 300ms 轮询时
         * 为每个实体创建全新的 JS 对象，引用比较永远返回 true（即判定为"已变化"），
         * 即使实体的所有字段值（position.x, position.z, remains 等）完全不变。
         * 这导致每 300ms 必然创建新的 Map 引用，触发 React 重渲染链：
         *   新 Map → SceneContents 重渲染 → GatherGroup/PlayerGroup useEffect 重执行
         *   → InstancedMesh 完全拆除重建 → 掉帧卡顿
         * 修复：使用 gatherDataEqual() 逐字段比较实际值，在数据不变时跳过 set()。
         * 预期：在静态视口中消除 ~100% 的无效 InstancedMesh 重建。
         */
        let dataChanged = false;
        for (const g of list) {
          const old = prev.get(g.id)!;
          if (!gatherDataEqual(old, g)) { dataChanged = true; break; }
        }
        if (!dataChanged) return; // 所有字段值完全相同，跳过更新
      }
    }
    const next = new Map<number, GatherData>();
    list.forEach(g => next.set(g.id, g));
    set({ gathers: next });
  },

  updatePlayers: (list) => {
    const prev = get().players;
    const newIds = new Set(list.map(p => p.id));
    let hasRemoval = false;
    for (const id of prev.keys()) {
      if (!newIds.has(id)) { hasRemoval = true; break; }
    }
    if (!hasRemoval && prev.size === list.length) {
      let allSame = true;
      for (const p of list) {
        if (!prev.has(p.id)) { allSame = false; break; }
      }
      if (allSame) {
        /** 【性能优化】深度字段比较 — 同 updateGathers 说明 */
        let dataChanged = false;
        for (const p of list) {
          if (!playerDataEqual(prev.get(p.id)!, p)) { dataChanged = true; break; }
        }
        if (!dataChanged) return;
      }
    }
    const next = new Map<number, PlayerData>();
    list.forEach(p => next.set(p.id, p));
    set({ players: next });
  },

  updateTroops: (list) => {
    const prev = get().troops;
    const newIds = new Set(list.map(t => t.id));
    let hasRemoval = false;
    for (const id of prev.keys()) {
      if (!newIds.has(id)) { hasRemoval = true; break; }
    }
    if (!hasRemoval && prev.size === list.length) {
      let allSame = true;
      for (const t of list) {
        if (!prev.has(t.id)) { allSame = false; break; }
      }
      if (allSame) {
        /** 【性能优化】深度字段比较 — 同 updateGathers 说明 */
        let dataChanged = false;
        for (const t of list) {
          if (!troopDataEqual(prev.get(t.id)!, t)) { dataChanged = true; break; }
        }
        if (!dataChanged) return;
      }
    }
    const next = new Map<number, TroopData>();
    list.forEach(t => next.set(t.id, t));
    set({ troops: next });
  },

  toggleDisplay: (key) => {
    const current = get().display;
    set({ display: { ...current, [key]: !current[key] } });
  },

  setActiveTab:         (tab)    => set({ activeTab: tab }),
  setViewMode:          (mode)   => set({ viewMode: mode }),
  setSelectedTroopId:   (id)     => set({ selectedTroopId: id }),
  setSelectedGatherId:  (id)     => set({ selectedGatherId: id }),
  setGatherDetails:      (details) => set({ gatherDetails: details, gatherDetailLoading: false }),
  setGatherDetailLoading: (v)      => set({ gatherDetailLoading: v }),
  clearGatherDetails:    ()        => set({ gatherDetails: [], gatherDetailLoading: false }),
  setHasCenteredOnCity: (v)      => set({ hasCenteredOnCity: v }),
  setViewSpan:          (span)   => set({ viewSpan: span }),
  setViewCenter:        (center) => set({ viewCenter: center }),

  setLuaInput: (v) => set({ luaInput: v }),

  appendLuaOutput: (text) => {
    const prev = get().luaOutput;
    set({ luaOutput: prev ? `${prev}\n${text}` : text });
  },

  clearLuaOutput: () => set({ luaInput: '', luaOutput: '' }),

  resetSession: () => set({
    isPlayerJoined:      false,
    currentPlayerId:     null,
    currentPlayerData:   null,
    selectedTroopId:     null,
    selectedGatherId:    null,
    gatherDetails:       [],
    gatherDetailLoading: false,
    viewMode:            'free',
    hasCenteredOnCity:   false,
    gathers:             new Map(),
    players:             new Map(),
    troops:              new Map(),
  }),

  removeEntitiesById: (ids) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    const { gathers, players, troops } = get();
    let gatherChanged = false;
    let playerChanged = false;
    let troopChanged  = false;

    for (const id of idSet) {
      if (gathers.has(id)) gatherChanged = true;
      if (players.has(id)) playerChanged = true;
      if (troops.has(id))  troopChanged  = true;
    }

    if (!gatherChanged && !playerChanged && !troopChanged) return;

    const updates: Partial<GameState> = {};

    if (gatherChanged) {
      const next = new Map(gathers);
      for (const id of idSet) next.delete(id);
      updates.gathers = next;
    }
    if (playerChanged) {
      const next = new Map(players);
      for (const id of idSet) next.delete(id);
      updates.players = next;
    }
    if (troopChanged) {
      const next = new Map(troops);
      for (const id of idSet) next.delete(id);
      updates.troops = next;
    }

    set(updates as GameState);
  },

  clearGameObjects: () => set({
    gathers: new Map(),
    players: new Map(),
    troops:  new Map(),
  }),
}));
