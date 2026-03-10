/**
 * @fileoverview 地面瓦片网格渲染组件
 * @description 渲染游戏地图的地面底板，包含程序化地形纹理和可选的网格线叠加层。
 *
 * 渲染方案：
 *   - 地面底板：单个 PlaneGeometry + ShaderMaterial，通过 GLSL 着色器在 GPU 上
 *     程序化生成草地/泥土/沙地/岩石的生物群系地形纹理，无需外部纹理资源
 *   - 网格线：LineSegments 渲染主线（每 5 格）和细线，增强区域感知和坐标定位
 *
 * 性能指标：
 *   - 地面底板：1 次 DrawCall（所有地形纹理在 GPU 着色器中实时计算）
 *   - 网格线：1 次 DrawCall
 *   - 总计：2 次 DrawCall 渲染整个地图底面，无论地图大小
 *
 * 着色器说明（GROUND_FRAG）：
 *   - biome：低频 FBM 噪声决定区域生物群系类型（草地/泥土/沙地/岩石）
 *   - detail：高频 FBM 噪声制造草地内部的细节变化
 *   - edge：UV 边缘淡出防止地图边界产生硬截断感
 *
 * @author WildMap Team
 */
import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { TileMeshConfig } from '../types/game';
import type { MapCenter } from '../types/game';

interface TileGridProps {
  tilesData: TileMeshConfig;
  mapCenter: MapCenter;
  visible:   boolean;
}

/**
 * 地面顶点着色器
 * 将世界坐标传递给片元着色器，用于基于位置而非 UV 坐标生成连续的地形纹理。
 */
const GROUND_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  void main() {
    vUv       = uv;
    vNormal   = normalize(normalMatrix * normal);
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 地面片元着色器
 * 基于世界 XZ 坐标的 FBM 噪声程序化生成地形纹理。
 * 使用双层噪声（慢变生物群系 + 快变细节）实现多样化地面效果。
 */
/**
 * 【性能优化】移除未使用的 uTime uniform
 * 原始问题：uTime 在着色器中声明但从未被 JS 侧更新（值始终为 0），
 *   且着色器代码中也未引用 uTime 变量。保留它会浪费一个 GPU uniform 槽位，
 *   并在每次 draw call 时触发无意义的 uniform 上传。
 * 修复方案：从 GLSL 和 JS uniforms 对象中同时移除 uTime。
 */
const GROUND_FRAG = /* glsl */`
  uniform vec2  uMapSize;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i + vec2(0,0));
    float b = hash(i + vec2(1,0));
    float c = hash(i + vec2(0,1));
    float d = hash(i + vec2(1,1));
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
  }

  float fbm(vec2 p) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 4; i++) {
      val  += noise(p * freq) * amp;
      freq *= 2.1;
      amp  *= 0.5;
    }
    return val;
  }

  void main() {
    vec2 worldXZ  = vWorldPos.xz * 0.000025;
    float biome   = fbm(worldXZ * 0.5);
    float detail  = fbm(worldXZ * 3.0 + 1.7);

    vec3 grassLight = vec3(0.30, 0.48, 0.18);
    vec3 grassDark  = vec3(0.18, 0.32, 0.10);
    vec3 dirtColor  = vec3(0.42, 0.30, 0.18);
    vec3 sandColor  = vec3(0.62, 0.52, 0.32);
    vec3 rockColor  = vec3(0.36, 0.33, 0.30);

    vec3 grassColor = mix(grassDark, grassLight, detail * 0.7 + 0.15);

    vec3 color;
    color = grassColor;
    color = mix(color,   dirtColor, smoothstep(0.35, 0.55, biome));
    color = mix(color,   sandColor, smoothstep(0.60, 0.75, biome));
    color = mix(color,   rockColor, smoothstep(0.82, 0.95, biome));

    vec3 lightDir   = normalize(vec3(1.5, 3.0, 1.0));
    float diffuse   = max(dot(vNormal, lightDir), 0.0) * 0.45 + 0.55;

    vec3 viewDir    = normalize(vec3(0,1,0));
    vec3 halfVec    = normalize(lightDir + viewDir);
    float spec      = pow(max(dot(vNormal, halfVec), 0.0), 20.0) * 0.04;

    color  = color * diffuse + vec3(spec);

    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float fade = smoothstep(0.0, 0.015, edge);
    vec3 edgeColor = vec3(0.12, 0.14, 0.10);
    color = mix(edgeColor, color, fade);

    gl_FragColor = vec4(color, 1.0);
  }
`;

export const TileGrid: React.FC<TileGridProps> = ({ tilesData, mapCenter, visible }) => {
  const { tilewidth, tileheight, xtilecount, ztilecount } = tilesData;
  const mapWidth  = tilewidth  * xtilecount;
  const mapHeight = tileheight * ztilecount;

  /**
   * 地面 PlaneGeometry
   * 32×32 细分提高法线精度，使阴影接收更准确（低细分在大 shadowMap 范围下会产生锯齿阴影）。
   */
  const groundGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(mapWidth, mapHeight, 32, 32);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [mapWidth, mapHeight]);

  const groundMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader:   GROUND_VERT,
    fragmentShader: GROUND_FRAG,
    uniforms: {
      uMapSize: { value: new THREE.Vector2(mapWidth, mapHeight) },
    },
    side: THREE.FrontSide,
  }), [mapWidth, mapHeight]);

  /**
   * 网格线几何体
   * 两级网格：主线（每 5 格）使用较高不透明度，细线（每格）使用极低不透明度。
   * Y 轴高度：主线 3，细线 2（细线在下避免遮挡主线）。
   */
  const gridGeo = useMemo(() => {
    const vertices: number[] = [];

    const majorStep = 5;
    for (let x = 0; x <= xtilecount; x += majorStep) {
      const sceneX     = x * tilewidth  - mapCenter.x;
      const sceneZStart = -mapCenter.z;
      const sceneZEnd   = mapHeight - mapCenter.z;
      vertices.push(sceneX, 3, sceneZStart, sceneX, 3, sceneZEnd);
    }
    for (let z = 0; z <= ztilecount; z += majorStep) {
      const sceneZ      = z * tileheight - mapCenter.z;
      const sceneXStart = -mapCenter.x;
      const sceneXEnd   = mapWidth - mapCenter.x;
      vertices.push(sceneXStart, 3, sceneZ, sceneXEnd, 3, sceneZ);
    }

    for (let x = 0; x <= xtilecount; x++) {
      if (x % majorStep === 0) continue;
      const sceneX     = x * tilewidth  - mapCenter.x;
      const sceneZStart = -mapCenter.z;
      const sceneZEnd   = mapHeight - mapCenter.z;
      vertices.push(sceneX, 2, sceneZStart, sceneX, 2, sceneZEnd);
    }
    for (let z = 0; z <= ztilecount; z++) {
      if (z % majorStep === 0) continue;
      const sceneZ      = z * tileheight - mapCenter.z;
      const sceneXStart = -mapCenter.x;
      const sceneXEnd   = mapWidth - mapCenter.x;
      vertices.push(sceneXStart, 2, sceneZ, sceneXEnd, 2, sceneZ);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    return geo;
  }, [tilesData, mapCenter, mapWidth, mapHeight]);

  const majorGridMat = useMemo(() => new THREE.LineBasicMaterial({
    color:       0x8899bb,
    transparent: true,
    opacity:     0.12,
  }), []);

  React.useEffect(() => {
    return () => {
      groundGeo.dispose();
      groundMat.dispose();
      gridGeo.dispose();
      majorGridMat.dispose();
    };
  }, [groundGeo, groundMat, gridGeo, majorGridMat]);

  return (
    <group visible={visible}>
      <mesh
        geometry={groundGeo}
        material={groundMat}
        receiveShadow
        renderOrder={0}
      />
      <lineSegments
        geometry={gridGeo}
        material={majorGridMat}
        renderOrder={1}
      />
    </group>
  );
};
