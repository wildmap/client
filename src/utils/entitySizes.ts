/**
 * @fileoverview 游戏实体渲染尺寸常量配置
 * @description 统一管理游戏中所有实体（部队、采集点、城市）的渲染尺寸参数。
 *              修改此文件中的常量即可全局调整实体视觉大小，无需散乱修改各渲染组件。
 *
 * 尺寸设计原则：
 *   - 所有尺寸基于服务端下发的 occupy_radius / block_radius 进行等比缩放
 *   - SCALE_FACTOR 控制从世界坐标单位到场景坐标单位的视觉缩放比
 *   - MIN/MAX_SIZE 确保在极端数据（异常小/大半径）下实体仍在合理视觉范围内
 *   - 调整 SCALE_FACTOR 时建议在 1000px 宽度视口下进行可见性验证
 *
 * @author WildMap Team
 */

/**
 * 部队实体渲染尺寸配置
 * 部队以 3×3 方阵呈现，每个士兵的尺寸由 unitSize 控制。
 */
export const TROOP_ENTITY_SIZES = {
  /**
   * 渲染尺寸基础乘数（世界坐标 → 场景坐标）
   * 计算公式：unitSize = (occupy_radius ?? block_radius * 1.4) * SCALE_FACTOR
   * 值为 0.16 时：部队半径 2800 → unitSize = 2800 * 1.4 * 0.16 ≈ 627（可见性良好）
   */
  SCALE_FACTOR: 0.16,

  /**
   * 行走动画弹跳高度偏移乘数
   * 士兵弹跳高度 = unitSize * BOUNCE_OFFSET，此值控制动作幅度感。
   */
  BOUNCE_OFFSET: 1.2,

  /**
   * 最小渲染尺寸（场景坐标单位）
   * 防止服务端下发极小 block_radius 导致部队不可见。
   */
  MIN_SIZE: 500,

  /**
   * 最大渲染尺寸（场景坐标单位）
   * 防止服务端下发异常大 occupy_radius 导致部队遮挡大片地图。
   */
  MAX_SIZE: 20000,

  /**
   * 选中光环内径比（相对于 occupy_radius 的倍数）
   * 光环宽度 = outerRadius - innerRadius，视觉上表现为选中圆环。
   */
  HALO_INNER_RATIO: 0.9,

  /**
   * 选中光环外径比（相对于 occupy_radius 的倍数）
   */
  HALO_OUTER_RATIO: 1.15,

  /**
   * 部队默认 block_radius（服务端未提供时的后备值）
   * 与服务端 melem/player_troop.go 中 BlockRadius 默认值保持一致。
   */
  DEFAULT_BLOCK_RADIUS: 2800,
} as const;

/**
 * 采集点（自然资源）实体渲染尺寸配置
 */
export const GATHER_ENTITY_SIZES = {
  /**
   * 渲染尺寸基础乘数（世界坐标 → 场景坐标）
   * 计算公式：radius = (occupy_radius || DEFAULT_OCCUPY_RADIUS) * SCALE_FACTOR
   * 值为 0.7 时：默认 occupy_radius 5000 → radius = 3500（地图上醒目可见）
   */
  SCALE_FACTOR: 0.7,

  /**
   * 默认 occupy_radius（服务端未提供时的后备值）
   * 与服务端采集点默认占用半径保持一致。
   */
  DEFAULT_OCCUPY_RADIUS: 5000,

  /**
   * 弹跳动画振幅（相对于 radius 的比例）
   * 资源点每帧 Y 轴偏移量 = radius * BOUNCE_AMPLITUDE * sin(time)，制造悬浮感。
   */
  BOUNCE_AMPLITUDE: 0.12,

  /**
   * 最小渲染尺寸（场景坐标单位）
   */
  MIN_SIZE: 800,

  /**
   * 最大渲染尺寸（场景坐标单位）
   */
  MAX_SIZE: 25000,
} as const;

/**
 * 玩家城市实体渲染尺寸配置
 * 城市以中世纪城堡形态渲染，各部件尺寸均基于 baseRadius 进行等比缩放。
 */
export const CITY_ENTITY_SIZES = {
  /**
   * 城堡底部半径乘数（相对于 occupy_radius）
   * 计算公式：baseRadius = occupy_radius * BASE_RADIUS_RATIO
   * 值为 0.75 时：occupy_radius 7200 → baseRadius = 5400（约占一个地图格子宽度）
   */
  BASE_RADIUS_RATIO: 0.75,

  /**
   * 城堡高度乘数（相对于 baseRadius）
   * 计算公式：h = baseRadius * HEIGHT_RATIO
   * h 控制所有城堡部件的竖向比例，使城堡主楼高度约为半径的 1 倍。
   */
  HEIGHT_RATIO: 0.7,

  /**
   * 默认 block_radius（服务端未提供时的后备值）
   * 与服务端 melem/player_city.go 中默认值保持一致。
   */
  DEFAULT_BLOCK_RADIUS: 6000,

  /**
   * occupy_radius 与 block_radius 的默认换算比
   * 当服务端未提供 occupy_radius 时：occupy_radius = block_radius * OCCUPY_TO_BLOCK_RATIO
   */
  OCCUPY_TO_BLOCK_RATIO: 1.2,
} as const;

/**
 * 触摸/点击交互热区扩展系数
 * 值 > 1 表示点击检测区域比视觉渲染区域更大，提升移动端触摸体验（Fitts 定律）。
 * 值 1.3 表示点击区域比视觉大 30%，在不影响精确度的前提下显著降低误操作率。
 */
export const HIT_TEST_PADDING = 1.3;
