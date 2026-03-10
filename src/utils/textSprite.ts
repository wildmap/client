/**
 * @fileoverview 文字精灵（Billboard Text Sprite）工具
 * @description 将文字渲染到离屏 Canvas 后作为 Three.js Sprite 使用。
 *              Sprite 始终朝向摄像机（Billboard 行为），适用于实体名称标签、血量等 2D UI 叠加。
 *
 * 实现方案选择原因：
 *   相比 troika-three-text，此方案无 WASM 依赖，适合小量标签；
 *   相比 CSS2DRenderer，Sprite 天然融入 3D 场景深度，支持遮挡剔除。
 *
 * 性能注意：
 *   每次调用 createTextSprite 都会创建新的 Canvas、Texture 和 SpriteMaterial。
 *   对于频繁变化的文字（如血量），建议使用对象池或直接复用并调用 updateTextSprite。
 *   使用完毕后务必调用 disposeSprite 释放 GPU 纹理内存。
 *
 * @author WildMap Team
 */
import * as THREE from 'three';

/**
 * 文字精灵创建选项
 */
export interface TextSpriteOptions {
  /** 字体大小（像素），默认 48 */
  fontSize?: number;
  /** 文字区域内边距（像素），默认 16 */
  padding?: number;
  /** 背景颜色（CSS 颜色字符串），默认 'rgba(0,0,0,0.6)' */
  background?: string;
  /** 精灵在 3D 世界中的宽度（场景坐标单位），默认 15000 */
  scale?: number;
}

/**
 * 在 Canvas 2D Context 上绘制圆角矩形
 * 封装为独立函数避免在 createTextSprite 主体中重复路径绘制逻辑。
 *
 * @param ctx       - Canvas 2D 渲染上下文
 * @param x         - 矩形左上角 X
 * @param y         - 矩形左上角 Y
 * @param width     - 矩形宽度
 * @param height    - 矩形高度
 * @param radius    - 圆角半径
 * @param fillStyle - 填充颜色样式
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  width: number, height: number,
  radius: number,
  fillStyle: string
): void {
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * 创建文字标签精灵
 * 流程：测量文字宽度 → 确定 Canvas 尺寸 → 绘制背景+文字 → 创建 CanvasTexture → 构造 Sprite。
 *
 * @param text    - 显示的文字内容
 * @param color   - 文字颜色（CSS 颜色字符串），默认 '#ffffff'
 * @param options - 可选配置项
 * @returns Three.js Sprite 对象，锚点位于底部中心（适合从实体底部向上显示标签）
 *
 * @example
 * const label = createTextSprite('玩家A', '#ffdd00', { scale: 12000 });
 * label.position.set(x, y + 5000, z);
 * scene.add(label);
 *
 * @remarks 调用方负责在实体销毁时调用 disposeSprite 释放 GPU 内存
 */
export function createTextSprite(
  text: string,
  color = '#ffffff',
  options: TextSpriteOptions = {}
): THREE.Sprite {
  const fontSize   = options.fontSize   ?? 48;
  const padding    = options.padding    ?? 16;
  const background = options.background ?? 'rgba(0,0,0,0.6)';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontStr = `bold ${fontSize}px "Microsoft YaHei", "Segoe UI", sans-serif`;
  ctx.font = fontStr;

  const metrics    = ctx.measureText(text);
  const textWidth  = Math.ceil(metrics.width);
  const textHeight = fontSize * 1.3;

  canvas.width  = textWidth + padding * 2;
  canvas.height = textHeight + padding * 2;

  ctx.font         = fontStr;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  drawRoundedRect(ctx, 0, 0, canvas.width, canvas.height, 18, background);

  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite   = new THREE.Sprite(material);

  const worldScale = options.scale ?? 15000;
  const aspect     = canvas.height / canvas.width;
  sprite.scale.set(worldScale, worldScale * aspect, 1);

  sprite.center.set(0.5, 0);

  sprite.userData.text = text;

  return sprite;
}

/**
 * 释放文字精灵占用的 GPU 内存
 * 依次 dispose Texture 和 SpriteMaterial，避免 WebGL 纹理单元泄漏。
 * 调用此函数后，该精灵不可再被渲染或重用。
 *
 * @param sprite - 待销毁的文字精灵
 *
 * @example
 * useEffect(() => {
 *   const label = createTextSprite(playerName);
 *   scene.add(label);
 *   return () => { disposeSprite(label); scene.remove(label); };
 * }, [playerName]);
 */
export function disposeSprite(sprite: THREE.Sprite): void {
  if (sprite.material.map) {
    sprite.material.map.dispose();
  }
  sprite.material.dispose();
}
