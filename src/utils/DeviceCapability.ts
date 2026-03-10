/**
 * @fileoverview 设备性能分级工具
 * @description 在游戏启动时检测设备 GPU/内存/CPU 能力，输出性能档位，
 *              供 Canvas 配置、阴影、抗锯齿等渲染参数动态调整。
 *
 * 检测维度：
 *   - GPU 渲染器字符串（通过 WEBGL_debug_renderer_info 扩展）
 *   - 设备内存（navigator.deviceMemory，Chrome/Android 支持）
 *   - CPU 核心数（navigator.hardwareConcurrency）
 *   - 是否移动设备（UA 检测）
 *
 * 档位划分：
 *   - 'low'：低端设备（≤2GB RAM 或 2 核以下或已知低端 GPU）
 *     移动端老旧机型、低端安卓、低内存 PC
 *   - 'medium'：中端设备（≤4GB RAM 或移动端）
 *     主流手机、中端平板
 *   - 'high'：高端设备（>4GB RAM，多核，桌面端）
 *     PC/Mac、高端手机
 *
 * @author WildMap Team
 */

export type DeviceTier = 'low' | 'medium' | 'high';

export interface DeviceProfile {
  /** 设备性能档位 */
  tier: DeviceTier;
  /** 是否开启抗锯齿（MSAA），低端设备关闭以节省 GPU 填充率 */
  antialias: boolean;
  /** DPR 上限，移动端限制为 1 以节省 75% 像素计算量 */
  maxDpr: number;
  /** 是否开启投影阴影，低/中端设备关闭 */
  enableShadows: boolean;
  /** WebGL 电源偏好设置 */
  powerPreference: 'default' | 'high-performance' | 'low-power';
  /** 每帧最大可见实体数（影响 LOD 阈值） */
  maxVisibleEntities: number;
}

/**
 * 已知低端 GPU 的关键词列表（正则匹配）
 * Mali-4xx/T-xxx（旧款 Arm Mali）、Adreno 2xx/3xx（旧款高通）、PowerVR 等
 */
const LOW_END_GPU_PATTERNS = /Mali-4|Mali-T[2-7]|Adreno [23]|PowerVR|Vivante/i;

/**
 * 检测当前设备的 GPU 渲染器字符串
 * 若 WEBGL_debug_renderer_info 扩展不可用，返回空字符串
 */
function getGPURenderer(): string {
  /**
   * 【BUG修复】WebGL 上下文泄漏
   * 原始问题：临时创建的 Canvas + WebGL 上下文从未释放，浏览器对同一页面的
   * WebGL 上下文数量有硬性限制（Chrome 限 16 个），泄漏会占用宝贵的 GPU 资源，
   * 严重时导致后续 Three.js 创建上下文失败。
   * 修复方案：检测完毕后立即通过 WEBGL_lose_context 释放 GPU 上下文，
   * 并将 canvas 尺寸归零以释放关联的显存后备缓冲区。
   * 预期效果：避免占用 1 个 WebGL 上下文槽位，消除 GPU 资源泄漏。
   */
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | null = null;
  try {
    canvas = document.createElement('canvas');
    gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return '';
    return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
  } catch {
    return '';
  } finally {
    // 释放 WebGL 上下文，归还 GPU 上下文槽位
    if (gl) {
      const loseCtx = gl.getExtension('WEBGL_lose_context');
      if (loseCtx) loseCtx.loseContext();
    }
    // 将 canvas 尺寸归零，释放后备缓冲区显存
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/**
 * 检测设备性能并返回渲染配置档位
 * 单例懒加载：首次调用时执行检测，后续调用直接返回缓存结果
 */
let _cachedProfile: DeviceProfile | null = null;

export function getDeviceProfile(): DeviceProfile {
  if (_cachedProfile) return _cachedProfile;

  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  // navigator.deviceMemory 仅 Chrome/Chromium 支持，单位 GB，向下取整
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cpuCores = navigator.hardwareConcurrency ?? 4;
  const gpuRenderer = getGPURenderer();
  const isLowEndGPU = gpuRenderer ? LOW_END_GPU_PATTERNS.test(gpuRenderer) : false;
  const dpr = window.devicePixelRatio ?? 1;

  let tier: DeviceTier;

  if (memoryGB <= 2 || cpuCores <= 2 || isLowEndGPU) {
    // 低端：内存不足 2GB，或双核以下，或已知低端 GPU
    tier = 'low';
  } else if (memoryGB <= 4 || isMobile) {
    // 中端：4GB 以内或移动设备
    tier = 'medium';
  } else {
    // 高端：>4GB + 多核 + 桌面端
    tier = 'high';
  }

  const profiles: Record<DeviceTier, DeviceProfile> = {
    low: {
      tier: 'low',
      antialias: false,
      maxDpr: 1,
      enableShadows: false,
      powerPreference: 'low-power',
      maxVisibleEntities: 50,
    },
    medium: {
      tier: 'medium',
      antialias: false,
      maxDpr: Math.min(dpr, 1.5),
      enableShadows: false,
      powerPreference: 'default',
      maxVisibleEntities: 200,
    },
    high: {
      tier: 'high',
      antialias: true,
      maxDpr: Math.min(dpr, 2),
      enableShadows: true,
      powerPreference: 'high-performance',
      maxVisibleEntities: 1000,
    },
  };

  _cachedProfile = profiles[tier];
  return _cachedProfile;
}
