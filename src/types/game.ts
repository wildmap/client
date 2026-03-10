/**
 * @fileoverview 游戏核心数据类型定义
 * @description 定义客户端所有核心数据结构，与服务端 cspb/def.go 中的协议结构严格对应。
 *              类型命名遵循 PascalCase 接口规范，字段命名保持与服务端 JSON 协议一致。
 * @author WildMap Team
 */

/**
 * 2D/3D 世界坐标点
 * 采用 X-Z 平面坐标系（Y 轴为高度轴），与 Three.js 场景坐标系一致。
 */
export interface Coord {
  x: number;
  z: number;
}

/**
 * 寻路路径节点
 * 服务端导航网格 A* 算法返回的路径点序列中的单个节点。
 */
export interface PathNode {
  x: number;
  z: number;
}

/**
 * 行军移动数据
 * 对应服务端 cspb.MoveInfo 结构，包含行军起点、起始时间、已行军时长和路径。
 * path 数组中每个元素对应 cspb.Path，含 end_coord（嵌套坐标对象）和 speed（行军速度）。
 * @see server/cspb/def.go MoveInfo
 */
export interface MoveData {
  /** 行军起始坐标 */
  start_coord?: Coord;
  /** 行军开始时间戳（毫秒） */
  start_time?: number;
  /** 从 start_time 到服务端打包时刻的已行军时长（毫秒） */
  duration?: number;
  /** 行军路径节点列表（对应 cspb.Path 数组） */
  path: Array<{ end_coord?: Coord; speed?: number; x?: number; z?: number }>;
}

/**
 * 地图单元实体位置信息
 * 服务端实体的位置字段存在两种格式：嵌套 coord 对象或直接 x/z 字段。
 * 客户端统一通过空值合并运算符兼容处理。
 */
export interface EntityPosition {
  coord?: Coord;
  x?: number;
  z?: number;
  move?: MoveData;
}

/**
 * 地图单元原始实体（服务端 mapView 推送格式）
 * 服务端通过 WebSocket 推送的原始实体数据，由 useWebSocket Hook 解析为具体类型。
 */
export interface RawEntity {
  id: number;
  kind: string;
  owner?: number;
  /** 【BUG修复】配置表ID（如 D2GatherConf.ID），服务端新增字段，用于客户端按资源类型分组渲染 */
  conf_id?: number;
  position?: EntityPosition;
  block_radius?: number;
  occupy_radius?: number;
  remains?: number;
}

/**
 * 采集点（自然资源点）数据
 * 对应服务端 MapUnitNpcGatherable 类型实体，经过客户端归一化后的结构。
 */
export interface GatherData {
  id: number;
  /** 【BUG修复】D2GatherConf 配置表ID，用于按资源类型（粮/木/石/铁）进行 InstancedMesh 分组渲染 */
  conf_id: number;
  position: Coord;
  block_radius?: number;
  occupy_radius?: number;
  remains?: number;
  kind?: string;
}

/**
 * 玩家城市数据
 * 对应服务端 MapUnitPlayerCity 类型实体，包含城市坐标和阵营半径信息。
 */
export interface PlayerData {
  id: number;
  name: string;
  city_pos: Coord;
  block_radius?: number;
  occupy_radius?: number;
}

/**
 * 部队数据
 * 对应服务端 MapUnitPlayerTroop 类型实体。
 * @property state - 部队行为状态位掩码：1=空闲 2=行军 4=采集 8=驻守
 * @property path  - 当前行军寻路路径节点序列（仅 state=2 时有效）
 */
export interface TroopData {
  id: number;
  owner: number;
  position: Coord;
  block_radius?: number;
  occupy_radius?: number;
  state: number;
  path: PathNode[];
}

/**
 * 瓦片地图配置
 * 服务端通过 mapRes 消息返回的地图基础参数，用于计算地形坐标与地图边界。
 */
export interface TileMeshConfig {
  tilewidth: number;
  tileheight: number;
  xtilecount: number;
  ztilecount: number;
}

/**
 * 导航网格顶点坐标
 */
export interface NavVertex {
  x: number;
  z: number;
}

/**
 * 导航网格配置
 * 包含 AI 寻路所用的三角剖分网格数据，用于客户端可视化调试。
 */
export interface NavMeshConfig {
  vertices: NavVertex[];
  triangles: Array<[number, number, number]>;
}

/**
 * 障碍物顶点坐标
 */
export interface ObstacleVertex {
  x: number;
  z: number;
}

/**
 * 障碍物配置
 * 服务端全局障碍物网格，由 Three.js ExtrudeGeometry 挤出为 3D 山体地形。
 */
export interface ObstacleConfig {
  vertices: ObstacleVertex[];
  triangles: Array<[number, number, number]>;
}

/**
 * 地图资源数据（服务端 mapRes 消息携带数据）
 * 包含导航网格、障碍物和瓦片配置，在连接建立后一次性加载。
 */
export interface MapResourceData {
  navMeshCfg?: NavMeshConfig;
  globalObstacleCfg?: ObstacleConfig;
  tileMeshCfg?: TileMeshConfig;
}

/**
 * 地图视图数据（服务端 mapView 消息携带数据）
 * 每 300ms 轮询返回当前可视窗口内的所有实体列表。
 * @see server/cspb/def.go WildMapViewAck
 */
export interface MapViewData {
  /** 当前视野内的实体列表 */
  entities: RawEntity[];
  /** 需要从客户端移除的实体 ID 列表（已离开视野或已销毁） */
  need_delete_entities?: number[];
  /** 已探索的视图区域 ID 列表 */
  explored_views?: number[];
}

/**
 * 玩家加入响应数据（服务端 playerJoin 消息携带数据）
 * 对应服务端 cspb.PlayerJoinAck 结构（内嵌 EntityInfo），
 * 包含玩家城市的实体类型、ID、所有者、配置ID、初始坐标和领地半径。
 * @see server/cspb/def.go PlayerJoinAck / EntityInfo
 */
export interface PlayerJoinData {
  /** 实体类型（如 "PlayerCity"） */
  kind?: string;
  /** 实体唯一 ID */
  id?: number;
  /** 所有者玩家 ID */
  owner?: number;
  /** 配置表 ID */
  conf_id?: number;
  position?: {
    coord?: Coord;
    x?: number;
    z?: number;
  };
  block_radius?: number;
  occupy_radius?: number;
}

/**
 * WebSocket 消息通用结构
 * 所有客户端与服务端之间的消息均采用此格式，通过 kind 字段区分消息类型。
 */
export interface WSMessage {
  kind: string;
  data?: unknown;
}

/**
 * 地图世界坐标边界
 * 以世界坐标系定义地图的矩形区域，用于相机边界约束。
 */
export interface MapBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * 地图中心世界坐标
 * Three.js 场景以地图中心为原点，所有世界坐标在渲染前均减去此中心值。
 */
export interface MapCenter {
  x: number;
  z: number;
}

/**
 * 地图元素显示控制状态
 * 每个字段对应一个可切换显示的地图图层。
 */
export interface DisplayState {
  navMesh: boolean;
  obstacles: boolean;
  tiles: boolean;
  path: boolean;
}

/**
 * 相机视图模式
 * - free：自由视角，用户可自由拖拽
 * - city：跟随玩家城市，相机平滑移动至城市位置
 * - troop：跟随选中部队，相机平滑移动至部队位置
 */
export type ViewMode = 'free' | 'city' | 'troop';

/**
 * WebSocket 连接状态枚举
 * 状态流转：disconnected → connecting → connected → disconnected/error
 *           disconnected/error → reconnecting → connecting（自动重连）
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting';

/**
 * 地形高程缓存条目
 * 预计算每个瓦片的 Perlin 噪声高程值，避免渲染帧内重复计算。
 */
export interface TerrainCacheEntry {
  x: number;
  z: number;
  elevation: number;
}

/**
 * 障碍物高度缓存条目
 * @deprecated 当前版本障碍物高度直接由面积计算，此结构暂未使用
 */
export interface ObstacleHeightEntry {
  height: number;
}

/**
 * 资源类型-ID-值 三元组
 * 对应服务端 mtype.KindIDVal 结构，用于描述一项具体资源的数量、系数和产量。
 * @see server/wmap/mmap/mtype/def.go KindIDVal
 */
export interface KindIDVal {
  /** 资源大类（如 "gold", "wood", "stone", "iron"） */
  kind?: string;
  /** 资源配置表 ID */
  id?: number;
  /** 资源数量值 */
  val?: number;
  /** 重量系数 */
  coef?: number;
  /** 产量 */
  yield?: number;
}

/**
 * 采集速度描述
 * 对应服务端 mtype.GatherSpeed 结构，描述某种资源的采集加速倍数。
 * @see server/wmap/mmap/mtype/def.go GatherSpeed
 */
export interface GatherSpeed {
  /** 资源大类 */
  kind?: string;
  /** 资源配置表 ID */
  id?: number;
  /** 采集速率（单位：资源/秒） */
  val?: number;
}

/**
 * 单个采集点的详细数据
 * 对应服务端 cspb.GatherDetail 结构，包含采集点资源信息、正在采集的部队信息、
 * 采集进度时间戳等完整状态。
 * @see server/cspb/def.go GatherDetail
 */
export interface GatherDetailData {
  /** 采集点实例 ID */
  gather_id?: number;
  /** 正在采集此资源点的部队 ID（0 表示无部队占据） */
  troop_id?: number;
  /** 资源点剩余资源列表（按资源类型分列） */
  remains?: KindIDVal[];
  /** 已采集获得的资源列表 */
  got?: KindIDVal[];
  /** 当前周期内正在采集的资源量 */
  cur?: KindIDVal[];
  /** 采集速率列表（按资源类型分列） */
  speed?: GatherSpeed[];
  /** 采集结束时间戳（毫秒） */
  end_ts?: number;
  /** 资源点满载恢复时间戳（毫秒） */
  full_ts?: number;
  /** 采集开始时间戳（毫秒） */
  start_ts?: number;
  /** 上次采集结算时间戳（毫秒） */
  last_ts?: number;
}

/**
 * 采集详情通知数据（服务端 gatherDetailNtf 消息携带数据）
 * 对应服务端 cspb.GatherDetailNtf 结构，包含一个或多个采集点的详细信息。
 * @see server/cspb/def.go GatherDetailNtf
 */
export interface GatherDetailNtfData {
  infos?: GatherDetailData[];
}

/**
 * Lua 脚本执行结果数据（服务端 doLua 消息携带数据）
 */
export interface LuaResultData {
  result: string;
}

// ============================================================
// 服务端实时推送通知类型（entitiesNtf / positionNtf / delEntitiesNtf）
// ============================================================

/**
 * 实体位置信息（服务端 positionNtf 中的单条位置数据）
 * 对应服务端 cspb.Position / cspb.PositionInfo 结构。
 * @see server/cspb/def.go Position
 */
export interface PositionEntry {
  /** 实体 ID */
  id?: number;
  /** 位置详情 */
  info?: EntityPosition;
}

/**
 * 实体增量推送数据（服务端 entitiesNtf 消息携带数据）
 * 当视野内有新实体出现或已有实体属性变更时，服务端通过此消息增量推送。
 * @see server/cspb/def.go EntitiesNtf
 */
export interface EntitiesNtfData {
  /** 新增或更新的实体列表 */
  entities?: RawEntity[];
  /** 服务端时间戳（毫秒） */
  timestamp?: number;
}

/**
 * 实体位置变更推送数据（服务端 positionNtf 消息携带数据）
 * 当视野内实体发生移动时，服务端通过此消息推送位置增量更新。
 * @see server/cspb/def.go PositionNtf
 */
export interface PositionNtfData {
  /** 位置变更的实体信息 */
  position?: PositionEntry;
  /** 服务端时间戳（毫秒） */
  timestamp?: number;
}

/**
 * 实体删除推送数据（服务端 delEntitiesNtf 消息携带数据）
 * 当视野内实体被销毁时，服务端通过此消息推送需要移除的实体 ID 列表。
 * @see server/cspb/def.go DelEntitiesNtf
 */
export interface DelEntitiesNtfData {
  /** 需要移除的实体 ID 列表 */
  ids?: number[];
  /** 服务端时间戳（毫秒） */
  timestamp?: number;
}

/**
 * 相机可视范围（世界坐标跨度）
 * 由 CameraController 每帧计算并写入 Store，mapView 轮询使用此参数限定服务端返回范围。
 */
export interface ViewSpan {
  x_span: number;
  z_span: number;
}
