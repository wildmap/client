/**
 * @fileoverview 渲染一致性验证工具
 * @description 对比 client（React/R3F）与 gamesvr/resource/index.html（Vanilla JS）的渲染关键参数，
 *              确保两套渲染实现在相机参数、渲染器配置、色调映射等方面保持一致。
 *
 * 使用方式：
 *   在浏览器开发者工具控制台中执行：
 *     window.__renderCheck.run()
 *
 *   或在 CI 流水线中通过 Puppeteer 自动执行像素级截图对比：
 *     const result = await page.evaluate(() => window.__renderCheck.run());
 *
 * @author WildMap Team
 */

import * as THREE from 'three';

/**
 * 期望的渲染参数基准值（与 gamesvr/resource/index.html 保持一致）
 * 修改 GameScene 或 CameraController 中的渲染参数时，需同步更新此处的期望值。
 */
export const EXPECTED_RENDER_PARAMS = {
  threeVersion: '0.181.1',

  renderer: {
    antialias: true,
    alpha: true,
    outputColorSpace: 'srgb',
    toneMapping: 4,
    toneMappingExposure: 2.2,
    shadowMapEnabled: true,
    shadowMapType: 2,
  },

  camera: {
    fov: 50,
    near: 10,
    far: 3000000,
  },

  controls: {
    enableRotate: false,
    enableZoom: true,
    enablePan: true,
    enableDamping: true,
    dampingFactor: 0.15,
    zoomSpeed: 1.2,
    minDistance: 30000,
    maxDistance: 600000,
  },

  obstacleColor: '#5a9a3c',
  obstacleMaterialType: 'MeshBasicMaterial',
  heightScaleFactor: 0.035,
} as const;

/**
 * 渲染一致性检查结果结构
 */
export interface RenderCheckResult {
  passed: boolean;
  checks: Array<{
    name: string;
    expected: unknown;
    actual: unknown;
    passed: boolean;
  }>;
}

/**
 * 从 R3F Canvas 元素中提取 WebGLRenderer 实例
 * R3F 将 renderer 实例挂载到 canvas.__r3f.gl，通过此方式绕过 React 上下文获取渲染器引用。
 *
 * @returns WebGLRenderer 实例，Canvas 不存在时返回 null
 */
function getR3FRenderer(): THREE.WebGLRenderer | null {
  const canvas = document.querySelector('.map-canvas') as HTMLCanvasElement & {
    __r3f?: { gl?: THREE.WebGLRenderer };
  } | null;
  if (!canvas) return null;
  return canvas.__r3f?.gl ?? null;
}

/**
 * 执行渲染一致性检查
 * 逐项对比运行时渲染参数与 EXPECTED_RENDER_PARAMS 中的基准值，输出详细差异报告。
 *
 * @returns 检查结果对象，包含每项对比的通过/失败状态和实际值
 *
 * @example
 * const result = runRenderConsistencyCheck();
 * if (!result.passed) {
 *   console.error('渲染一致性检查失败，存在参数差异');
 * }
 */
export function runRenderConsistencyCheck(): RenderCheckResult {
  const results: RenderCheckResult = { passed: true, checks: [] };

  function check(name: string, expected: unknown, actual: unknown) {
    const passed = JSON.stringify(expected) === JSON.stringify(actual);
    results.checks.push({ name, expected, actual, passed });
    if (!passed) results.passed = false;
  }

  check('Three.js 版本', EXPECTED_RENDER_PARAMS.threeVersion, THREE.REVISION);

  const renderer = getR3FRenderer();
  if (renderer) {
    check('渲染器 outputColorSpace',
      EXPECTED_RENDER_PARAMS.renderer.outputColorSpace,
      renderer.outputColorSpace
    );
    check('渲染器 toneMapping',
      EXPECTED_RENDER_PARAMS.renderer.toneMapping,
      renderer.toneMapping
    );
    check('渲染器 toneMappingExposure',
      EXPECTED_RENDER_PARAMS.renderer.toneMappingExposure,
      renderer.toneMappingExposure
    );
    check('阴影渲染启用',
      EXPECTED_RENDER_PARAMS.renderer.shadowMapEnabled,
      renderer.shadowMap.enabled
    );
    check('阴影渲染类型',
      EXPECTED_RENDER_PARAMS.renderer.shadowMapType,
      renderer.shadowMap.type
    );

    const dpr = renderer.getPixelRatio();
    const expectedDpr = window.devicePixelRatio || 1;
    check('设备像素比 (DPR)',
      Math.min(expectedDpr, 2),
      Math.round(dpr * 100) / 100
    );
  } else {
    results.checks.push({
      name: 'WebGLRenderer 实例',
      expected: '不为 null',
      actual: null,
      passed: false,
    });
    results.passed = false;
  }

  const canvas = document.querySelector('.map-canvas') as HTMLCanvasElement | null;
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    const isFullSize = rect.width > 100 && rect.height > 100;
    check('Canvas 尺寸有效（宽>100 且 高>100）', true, isFullSize);

    const gameArea = canvas.parentElement;
    if (gameArea) {
      const areaRect = gameArea.getBoundingClientRect();
      const widthMatch = Math.abs(rect.width - areaRect.width) <= 1;
      const heightMatch = Math.abs(rect.height - areaRect.height) <= 1;
      check('Canvas 填满父容器（宽度）', true, widthMatch);
      check('Canvas 填满父容器（高度）', true, heightMatch);
    }
  }

  console.group('🔍 渲染一致性检查');
  results.checks.forEach(c => {
    const icon = c.passed ? '✅' : '❌';
    console.log(`${icon} ${c.name}`, c.passed ? '' : `\n   期望: ${JSON.stringify(c.expected)}\n   实际: ${JSON.stringify(c.actual)}`);
  });
  const total = results.checks.length;
  const passed = results.checks.filter(c => c.passed).length;
  console.log(`\n📊 结果: ${passed}/${total} 通过 ${results.passed ? '✅ 所有检查通过' : '❌ 存在差异'}`);
  console.groupEnd();

  return results;
}

/**
 * 截取当前帧 Canvas 内容并转换为 base64 PNG
 * 用于与 gamesvr 参考截图进行像素级比较，验证渲染视觉一致性。
 *
 * 注意：WebGL 默认 preserveDrawingBuffer=false，截图可能返回空白帧。
 *       如需稳定截图，需在 Canvas 创建时设置 preserveDrawingBuffer=true。
 *
 * @returns base64 PNG 字符串，失败时返回 null
 */
export function captureCanvasFrame(): string | null {
  const canvas = document.querySelector('.map-canvas') as HTMLCanvasElement | null;
  if (!canvas) return null;
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * 计算两个 base64 图像的像素级差异率
 * 通过 Canvas 2D API 解码图像并逐像素比较 RGB 通道，统计差异像素比例。
 *
 * @param base64A - 参考图像的 base64 编码
 * @param base64B - 待对比图像的 base64 编码
 * @returns 包含差异比例、差异像素数和总像素数的对象
 *
 * @example
 * const ref = await captureReferenceFrame();
 * const cur = captureCanvasFrame();
 * const diff = await compareFrames(ref, cur);
 * if (diff.diffRatio > 0.01) console.warn('像素差异超过 1%');
 */
export async function compareFrames(
  base64A: string,
  base64B: string
): Promise<{ diffRatio: number; diffPixels: number; totalPixels: number }> {
  const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });

  const [imgA, imgB] = await Promise.all([loadImage(base64A), loadImage(base64B)]);
  const w = Math.min(imgA.width, imgB.width);
  const h = Math.min(imgA.height, imgB.height);

  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d')!;

  ctx.drawImage(imgA, 0, 0, w, h);
  const dataA = ctx.getImageData(0, 0, w, h);

  ctx.drawImage(imgB, 0, 0, w, h);
  const dataB = ctx.getImageData(0, 0, w, h);

  let diffPixels = 0;
  const threshold = 10;
  for (let i = 0; i < dataA.data.length; i += 4) {
    const dr = Math.abs(dataA.data[i]   - dataB.data[i]);
    const dg = Math.abs(dataA.data[i+1] - dataB.data[i+1]);
    const db = Math.abs(dataA.data[i+2] - dataB.data[i+2]);
    if (dr > threshold || dg > threshold || db > threshold) {
      diffPixels++;
    }
  }

  const totalPixels = w * h;
  const diffRatio = diffPixels / totalPixels;
  return { diffRatio, diffPixels, totalPixels };
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__renderCheck = {
    run: runRenderConsistencyCheck,
    capture: captureCanvasFrame,
    compare: compareFrames,
    expected: EXPECTED_RENDER_PARAMS,
  };
}
