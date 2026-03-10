/**
 * @fileoverview 柏林噪声（Perlin Noise）生成器
 * @description 实现经典 Ken Perlin 改进版噪声算法，用于程序化地形高程生成。
 *              移植自 gamesvr/resource/js/perlin.js，保持与服务端原始版本的算法一致性。
 *              使用固定种子确保客户端地形与服务端地形数据在视觉上保持一致。
 *
 * 算法说明：
 *   - 基础噪声：2D 柏林噪声，输出范围 [-1, 1]
 *   - FBM：分形布朗运动，多倍频叠加产生自然山地形态
 *   - 置换表：使用 Fisher-Yates 洗牌算法基于种子初始化，长度 512（256×2 防止下标越界）
 *
 * @author WildMap Team
 */

/**
 * 柏林噪声生成器
 * 提供确定性（给定相同种子和输入，输出恒定）的 2D 噪声与 FBM 噪声。
 */
export class PerlinNoise {
  private seed: number;
  private p: number[];

  /**
   * @param seed - 随机种子（默认 0），固定种子保证地形在每次加载时完全一致
   */
  constructor(seed = 0) {
    this.seed = seed;
    this.p = [];

    for (let i = 0; i < 256; i++) {
      this.p[i] = i;
    }

    for (let i = 255; i > 0; i--) {
      const j = Math.floor(this.seededRandom(i + seed) * (i + 1));
      const tmp = this.p[i];
      this.p[i] = this.p[j];
      this.p[j] = tmp;
    }

    for (let i = 0; i < 256; i++) {
      this.p[256 + i] = this.p[i];
    }
  }

  /**
   * 基于种子的确定性伪随机数生成器
   * 使用 sin 函数的小数部分作为伪随机源，避免引入外部依赖。
   * @param n - 输入值
   * @returns [0, 1) 范围内的伪随机数
   */
  private seededRandom(n: number): number {
    const x = Math.sin(n) * 10000;
    return x - Math.floor(x);
  }

  /**
   * Smoothstep 渐变函数（Ken Perlin 改进版曲线）
   * 使用 6t^5 - 15t^4 + 10t^3 代替早期的 3t^2 - 2t^3，消除一阶和二阶导数的不连续性。
   * @param t - 输入值 [0, 1]
   */
  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /**
   * 线性插值
   * @param t - 插值因子 [0, 1]
   * @param a - 起始值
   * @param b - 结束值
   */
  private lerp(t: number, a: number, b: number): number {
    return a + t * (b - a);
  }

  /**
   * 梯度函数：将哈希值映射为 12 方向梯度向量之一，并与输入向量做点积
   * 通过位操作高效选择梯度方向，避免查表开销。
   * @param hash - 置换表查询结果
   * @param x    - 相对 X 坐标
   * @param y    - 相对 Y 坐标
   */
  private grad(hash: number, x: number, y: number): number {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : 0);
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  /**
   * 2D 柏林噪声采样
   * @param x - X 坐标（连续浮点数）
   * @param y - Y 坐标（连续浮点数）
   * @returns 噪声值，范围约 [-1, 1]
   */
  noise(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;

    x -= Math.floor(x);
    y -= Math.floor(y);

    const u = this.fade(x);
    const v = this.fade(y);

    const a  = this.p[X] + Y;
    const aa = this.p[a];
    const ab = this.p[a + 1];
    const b  = this.p[X + 1] + Y;
    const ba = this.p[b];
    const bb = this.p[b + 1];

    return this.lerp(v,
      this.lerp(u, this.grad(this.p[aa], x, y),     this.grad(this.p[ba], x - 1, y)),
      this.lerp(u, this.grad(this.p[ab], x, y - 1), this.grad(this.p[bb], x - 1, y - 1))
    );
  }

  /**
   * 分形布朗运动（FBM）噪声
   * 将多个不同频率和振幅的柏林噪声叠加，产生具有自相似性的自然地形形态。
   *
   * 性能注意：octaves 参数线性增加计算量，默认 4 倍频在复杂度与质量间取得平衡。
   * 地形生成时使用 5 倍频以获得更丰富的细节。
   *
   * @param x           - X 坐标
   * @param y           - Y 坐标
   * @param octaves     - 叠加层数（越多越精细，但 CPU 开销线性增加）
   * @param persistence - 振幅衰减系数（通常 0.4~0.6），控制高频细节的强度
   * @param lacunarity  - 频率倍增系数（通常 2.0），控制相邻倍频的频率比
   * @returns 归一化噪声值，范围约 [-1, 1]
   */
  fbm(
    x: number,
    y: number,
    octaves = 4,
    persistence = 0.5,
    lacunarity = 2.0
  ): number {
    let total = 0;
    let frequency = 1;
    let amplitude = 1;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
      total     += this.noise(x * frequency, y * frequency) * amplitude;
      maxValue  += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }

    return total / maxValue;
  }
}

/**
 * 全局共享柏林噪声实例
 * 使用固定种子 12345，确保每次加载地形视觉完全一致，无论何时连接服务器。
 * 所有地形高程计算均使用此实例，避免多实例重复初始化置换表的开销。
 */
export const globalPerlinNoise = new PerlinNoise(12345);
