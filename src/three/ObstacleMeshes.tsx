/**
 * @fileoverview 障碍物（有机地形）网格渲染组件
 * @description 将服务端全局障碍物三角形渲染为差异化 3D 自然地形元素。
 *
 * 核心修复：所有几何体在 mergeGeometries 前统一调用 toNonIndexed()，
 * 解决 ExtrudeGeometry(indexed) 与 DodecahedronGeometry(non-indexed) 混合
 * 导致 mergeGeometries 返回 null 的根本问题。
 *
 * 视觉特性：
 *   - 顶点有机扰动（打破规则边缘）
 *   - 随机倾斜（嵌地感）
 *   - type=0 岩体：周围碎石散布
 *   - type=1 灌木：树冠+树干植被簇群
 *   - type=2 雪山：多级斜切轮廓
 *   - type=3 火山：熔岩脉冲动画
 *
 * @author WildMap Team
 */
import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ObstacleConfig, MapCenter, TileMeshConfig } from '../types/game';
import { worldToScene, getTerrainHeight, HEIGHT_SCALE_FACTOR, EMPTY_TERRAIN_CACHE, type TerrainCache } from '../utils/coordinates';

const HEIGHT_SCALE = HEIGHT_SCALE_FACTOR;

/**
 * 【性能优化】模块级预分配 Three.js 临时对象
 * 原始问题：useMemo 中每个障碍三角形循环内都 new THREE.Quaternion/Vector3，
 * 当障碍物数量达数千时导致初始化阶段 GC 尖峰。
 * 优化：提升至模块级复用，初始化期间零分配。
 */
const _obsTmpQuat = new THREE.Quaternion();
const _obsTmpAxis = new THREE.Vector3();
const _obsP1 = new THREE.Vector3();
const _obsP2 = new THREE.Vector3();
const _obsP3 = new THREE.Vector3();
const _rockTmpQuat = new THREE.Quaternion();
const _rockTmpAxis = new THREE.Vector3();

// ─────────────────────────────────────────────────────────────────────────────
// 确定性伪随机工具
// ─────────────────────────────────────────────────────────────────────────────

function pseudoRand(seed: number): number {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function hash2(a: number, b: number): number {
  return pseudoRand(a * 1.618 + b * 2.718);
}

// ─────────────────────────────────────────────────────────────────────────────
// 着色器
// ─────────────────────────────────────────────────────────────────────────────

const OBSTACLE_VERT = /* glsl */`
  attribute float aSmoothFactor;
  attribute float aRoughness;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vColor;
  varying float vSmooth;
  varying float vRoughness;

  void main() {
    vNormal    = normalize(normalMatrix * normal);
    vWorldPos  = (modelMatrix * vec4(position, 1.0)).xyz;
    vColor     = color;
    vSmooth    = aSmoothFactor;
    vRoughness = aRoughness;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const OBSTACLE_FRAG = /* glsl */`
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vColor;
  varying float vSmooth;
  varying float vRoughness;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
  }

  void main() {
    vec3 upBias     = normalize(mix(vNormal, vec3(0,1,0), vSmooth * 0.6));
    vec3 softNormal = normalize(mix(vNormal, upBias, vSmooth));
    vec3 color = vColor;

    vec3 lightDir = normalize(vec3(1.5, 3.0, 1.0));
    float diff    = max(dot(softNormal, lightDir), 0.0) * 0.65 + 0.35;
    color        *= diff;

    /* 岩石裂缝纹理 */
    vec2 rockUV = vWorldPos.xz * 0.000012;
    float crack = noise(rockUV*8.0)*0.5 + noise(rockUV*22.0)*0.25 + noise(rockUV*55.0)*0.1;
    float isRock = 1.0 - smoothstep(0.25, 0.45, vColor.g - vColor.r - vColor.b*0.3);
    color -= vec3(smoothstep(0.42, 0.48, crack) * 0.22 * isRock);

    /* Fresnel 边缘光 */
    vec3 viewDir = normalize(vec3(0,1,0.4));
    float fres   = pow(1.0 - abs(dot(softNormal, viewDir)), 2.0);
    color += vec3(0.35,0.42,0.48) * fres * 0.10 * isRock;

    /* 粗糙度高光 */
    vec3 halfV = normalize(lightDir + viewDir);
    float spec = pow(max(dot(softNormal, halfV), 0.0), 14.0) * (1.0 - vRoughness) * 0.05;
    color += vec3(spec);

    /* 火山熔岩脉冲 */
    float isLava  = smoothstep(0.35, 0.55, vColor.r) * (1.0 - smoothstep(0.15, 0.35, vColor.g));
    float lavaP   = sin(uTime * 2.5 + vWorldPos.y * 0.0005) * 0.35 + 0.65;
    color        += vec3(1.0, 0.28, 0.0) * isLava * lavaP * 0.45;

    /* 雪顶高光 */
    float isSnow = smoothstep(0.62, 0.78, min(vColor.r, min(vColor.g, vColor.b)));
    color       += vec3(isSnow * max(dot(softNormal, vec3(0,1,0)), 0.0) * 0.35);

    color = max(color, vec3(0.03));
    gl_FragColor = vec4(color, 1.0);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// 几何辅助函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 将几何体转换为非索引化（non-indexed）并删除 UV。
 * 【关键】mergeGeometries 要求所有输入几何体要么都有 index，要么都没有。
 * ExtrudeGeometry 是 indexed，DodecahedronGeometry 是 non-indexed，
 * 统一调用 toNonIndexed() 解决此不一致。
 * 返回新的 non-indexed 几何体，调用方负责 dispose 原始几何体。
 */
function toNonIndexedClean(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  let result: THREE.BufferGeometry;
  if (geo.index !== null) {
    result = geo.toNonIndexed();
  } else {
    result = geo.clone();
  }
  if (result.hasAttribute('uv'))  result.deleteAttribute('uv');
  if (result.hasAttribute('uv2')) result.deleteAttribute('uv2');
  return result;
}

/**
 * 填充主体顶点属性（color / aSmoothFactor / aRoughness）
 */
function fillMainAttribs(
  geo: THREE.BufferGeometry,
  type: number,
  terrainY: number,
  extrudeDepth: number,
  smoothFactor: number,
): void {
  const posAttr  = geo.getAttribute('position') as THREE.BufferAttribute;
  const normAttr = geo.getAttribute('normal')   as THREE.BufferAttribute;
  const n   = posAttr.count;
  const maxY = terrainY + extrudeDepth;

  const colors    = new Float32Array(n * 3);
  const smoothArr = new Float32Array(n);
  const roughArr  = new Float32Array(n);

  for (let v = 0; v < n; v++) {
    const posY  = posAttr.getY(v);
    const normY = normAttr.getY(v);
    const topF  = Math.max(0, normY);
    const sideF = 1 - topF;
    const relH  = (maxY > terrainY)
      ? Math.max(0, Math.min(1, (posY - terrainY) / (maxY - terrainY)))
      : 0;

    let r = 0, g = 0, b = 0;
    switch (type) {
      case 0: r=0.34+topF*0.06+relH*0.06; g=0.28+topF*0.06; b=0.24+topF*0.03; break;
      case 1: r=0.22+sideF*0.12; g=0.38+topF*0.14+relH*0.06; b=0.16+topF*0.04; break;
      case 2:
        if (relH>0.65) { const s=0.78+relH*0.18; r=s;g=s;b=Math.min(1,s+0.04); }
        else if (relH>0.35) { r=0.50;g=0.46;b=0.43; }
        else { r=0.34;g=0.29;b=0.27; }
        break;
      case 3:
        if (relH>0.72) { r=0.78;g=0.14;b=0.06; }
        else if (relH>0.42) { r=0.56;g=0.22;b=0.10; }
        else { r=0.38;g=0.20;b=0.14; }
        break;
      default: r=0.40;g=0.35;b=0.30;
    }

    colors[v*3]=r; colors[v*3+1]=g; colors[v*3+2]=b;
    smoothArr[v] = smoothFactor * (0.65 + relH * 0.35);
    roughArr[v]  = (type===1) ? 0.88 : (0.5 + (1-relH) * 0.4);
  }

  geo.setAttribute('color',         new THREE.BufferAttribute(colors,    3));
  geo.setAttribute('aSmoothFactor', new THREE.BufferAttribute(smoothArr, 1));
  geo.setAttribute('aRoughness',    new THREE.BufferAttribute(roughArr,  1));
}

/**
 * 填充装饰物顶点属性（颜色偏暗的风化色调）
 */
function fillDecorAttribs(
  geo: THREE.BufferGeometry,
  r: number, g: number, b: number,
  seed: number,
): void {
  const n = geo.getAttribute('position').count;
  const colors    = new Float32Array(n * 3);
  const smoothArr = new Float32Array(n);
  const roughArr  = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const nv = pseudoRand(seed + v * 0.7) * 0.06 - 0.03;
    colors[v*3]   = Math.max(0, r * 0.78 + nv);
    colors[v*3+1] = Math.max(0, g * 0.78 + nv * 0.7);
    colors[v*3+2] = Math.max(0, b * 0.78 + nv * 0.5);
    smoothArr[v]  = 0.20;
    roughArr[v]   = 0.82;
  }
  geo.setAttribute('color',         new THREE.BufferAttribute(colors,    3));
  geo.setAttribute('aSmoothFactor', new THREE.BufferAttribute(smoothArr, 1));
  geo.setAttribute('aRoughness',    new THREE.BufferAttribute(roughArr,  1));
}

/**
 * 顶点有机扰动：底部不扰动，顶部最大
 */
function perturbGeometry(
  geo: THREE.BufferGeometry,
  seed: number,
  extrudeDepth: number,
  type: number,
  terrainY: number,
): void {
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;
  const n = posAttr.count;
  const jitterRatio = [0.14, 0.20, 0.06, 0.11][type] ?? 0.14;
  const maxJitter = extrudeDepth * jitterRatio;

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = arr[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const yRange = maxY - minY || 1;

  for (let i = 0; i < n; i++) {
    const y = arr[i * 3 + 1];
    if (y - terrainY < extrudeDepth * 0.07) continue;
    const strength = Math.pow(Math.max(0, Math.min(1, (y - minY) / yRange)), 0.55);
    arr[i * 3]     += (pseudoRand(seed + i * 2.31) - 0.5) * 2 * maxJitter * strength;
    arr[i * 3 + 1] += (pseudoRand(seed + i * 4.17) - 0.5) * 2 * maxJitter * strength * 0.4;
    arr[i * 3 + 2] += (pseudoRand(seed + i * 6.53) - 0.5) * 2 * maxJitter * strength;
  }
  posAttr.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * 生成碎石散布装饰（type=0/3）
 * 返回已经 toNonIndexed + fillDecorAttribs 处理好的几何体列表
 */
function buildScatterRocks(
  cx: number, cy: number, cz: number,
  extrudeDepth: number,
  seed: number,
): THREE.BufferGeometry[] {
  const results: THREE.BufferGeometry[] = [];
  const count = 1 + Math.floor(pseudoRand(seed * 7.3) * 2);

  for (let r = 0; r < count; r++) {
    try {
      const angle = pseudoRand(seed + r * 11.7) * Math.PI * 2;
      const dist  = extrudeDepth * (0.35 + pseudoRand(seed + r * 3.1) * 0.5);
      const rSize = extrudeDepth * (0.07 + pseudoRand(seed + r * 5.9) * 0.12);
      const rx    = cx + Math.cos(angle) * dist;
      const rz    = cz + Math.sin(angle) * dist;

      const raw = new THREE.DodecahedronGeometry(rSize, 0);
      raw.scale(
        0.7 + pseudoRand(seed + r * 2.2) * 0.6,
        0.5 + pseudoRand(seed + r * 8.1) * 0.7,
        0.7 + pseudoRand(seed + r * 4.4) * 0.6,
      );
      const tx = pseudoRand(seed + r * 1.1) - 0.5;
      const tz = pseudoRand(seed + r * 3.3) - 0.5;
      const tLen = Math.sqrt(tx * tx + tz * tz);
      if (tLen > 0.01) {
        /* 【优化】复用模块级 Quaternion/Vector3，避免循环内 new 分配 */
        raw.applyQuaternion(_rockTmpQuat.setFromAxisAngle(
          _rockTmpAxis.set(tx / tLen, 0, tz / tLen),
          (pseudoRand(seed + r * 9.9) - 0.5) * 0.6,
        ));
      }
      raw.translate(rx, cy + rSize * 0.5, rz);
      raw.computeVertexNormals();

      const geo = toNonIndexedClean(raw);
      raw.dispose();
      fillDecorAttribs(geo, 0.34, 0.28, 0.24, seed + r * 100);
      results.push(geo);
    } catch(e) {
      console.warn('[ObstacleMeshes] scatter rock error:', e);
    }
  }
  return results;
}

/**
 * 生成植被簇群装饰（type=1）
 * 返回已经 toNonIndexed + 自定义属性处理好的几何体列表
 */
function buildFoliageClusters(
  cx: number, cy: number, cz: number,
  extrudeDepth: number,
  seed: number,
): THREE.BufferGeometry[] {
  const results: THREE.BufferGeometry[] = [];
  const count = 2 + Math.floor(pseudoRand(seed * 4.7) * 2);

  for (let i = 0; i < count; i++) {
    try {
      const angle  = pseudoRand(seed + i * 7.3) * Math.PI * 2;
      const dist   = extrudeDepth * pseudoRand(seed + i * 2.9) * 0.5;
      const fx     = cx + Math.cos(angle) * dist;
      const fz     = cz + Math.sin(angle) * dist;
      const coneR  = extrudeDepth * (0.16 + pseudoRand(seed + i * 3.1) * 0.14);
      const coneH  = extrudeDepth * (0.50 + pseudoRand(seed + i * 1.7) * 0.45);
      const trunkR = coneR * 0.18;
      const trunkH = extrudeDepth * 0.30;

      // 树冠
      const rawCone = new THREE.ConeGeometry(coneR, coneH, 6);
      rawCone.translate(fx, cy + extrudeDepth + coneH * 0.5, fz);
      rawCone.computeVertexNormals();
      const cone = toNonIndexedClean(rawCone);
      rawCone.dispose();
      const cn = cone.getAttribute('position').count;
      const cColors=new Float32Array(cn*3), cSmooth=new Float32Array(cn), cRough=new Float32Array(cn);
      for (let v=0;v<cn;v++) {
        const gv=pseudoRand(seed+i*0.7+v*0.3);
        cColors[v*3]=0.18+gv*0.08; cColors[v*3+1]=0.40+gv*0.14; cColors[v*3+2]=0.13;
        cSmooth[v]=0.50; cRough[v]=0.85;
      }
      cone.setAttribute('color',         new THREE.BufferAttribute(cColors,3));
      cone.setAttribute('aSmoothFactor', new THREE.BufferAttribute(cSmooth,1));
      cone.setAttribute('aRoughness',    new THREE.BufferAttribute(cRough, 1));
      results.push(cone);

      // 树干
      const rawTrunk = new THREE.CylinderGeometry(trunkR, trunkR*1.2, trunkH, 5);
      rawTrunk.translate(fx, cy + trunkH * 0.5, fz);
      rawTrunk.computeVertexNormals();
      const trunk = toNonIndexedClean(rawTrunk);
      rawTrunk.dispose();
      const tn=trunk.getAttribute('position').count;
      const tColors=new Float32Array(tn*3), tSmooth=new Float32Array(tn), tRough=new Float32Array(tn);
      for (let v=0;v<tn;v++) {
        tColors[v*3]=0.35; tColors[v*3+1]=0.22; tColors[v*3+2]=0.12;
        tSmooth[v]=0.18; tRough[v]=0.90;
      }
      trunk.setAttribute('color',         new THREE.BufferAttribute(tColors,3));
      trunk.setAttribute('aSmoothFactor', new THREE.BufferAttribute(tSmooth,1));
      trunk.setAttribute('aRoughness',    new THREE.BufferAttribute(tRough, 1));
      results.push(trunk);
    } catch(e) {
      console.warn('[ObstacleMeshes] foliage error:', e);
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型分类
// ─────────────────────────────────────────────────────────────────────────────

function classifyObstacle(cx: number, cz: number, height: number): number {
  const nx=(cx/7200000)*3.7, nz=(cz/7200000)*4.1;
  const h1=Math.abs(Math.sin(nx*12.9898+nz*78.233)*43758.5453);
  const h2=Math.abs(Math.sin(nx*93.989+nz*67.345)*23456.789);
  const hash=(h1%1+h2%1)/2;
  if (height>5000&&hash<0.25) return 2;
  if (hash<0.05)               return 3;
  if (height<2000&&hash>0.70)  return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────────────────────

interface ObstacleMeshesProps {
  obstaclesData: ObstacleConfig;
  mapCenter:     MapCenter;
  tilesData:     TileMeshConfig | null;
  terrainCache:  TerrainCache;
  visible:       boolean;
}

export const ObstacleMeshes: React.FC<ObstacleMeshesProps> = ({
  obstaclesData,
  mapCenter,
  tilesData,
  terrainCache,
  visible,
}) => {
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  const mergedGeometry = useMemo(() => {
    if (!obstaclesData?.triangles?.length) return null;

    const allGeos: THREE.BufferGeometry[] = [];
    const SMOOTH_MAP = [0.32, 0.22, 0.68, 0.10];

    obstaclesData.triangles.forEach((triangle) => {
      const w1 = obstaclesData.vertices[triangle[0]];
      const w2 = obstaclesData.vertices[triangle[1]];
      const w3 = obstaclesData.vertices[triangle[2]];
      if (!w1 || !w2 || !w3) return;

      const cx = (w1.x+w2.x+w3.x)/3;
      const cz = (w1.z+w2.z+w3.z)/3;
      const area     = Math.abs((w2.x-w1.x)*(w3.z-w1.z)-(w3.x-w1.x)*(w2.z-w1.z))/2;
      const finalH   = Math.max(1500, Math.min(10000, Math.sqrt(area)*1.8*0.8));
      const extDepth = finalH * HEIGHT_SCALE;
      const terrainY = tilesData ? getTerrainHeight(cx, cz, tilesData, terrainCache) : 0;
      const type     = classifyObstacle(cx, cz, finalH);
      const seed     = hash2(cx, cz) * 10000;

      /* 【优化】复用模块级 Vector3，避免每个三角形 new 3 个 Vector3 */
      worldToScene(w1.x, w1.z, mapCenter, null, EMPTY_TERRAIN_CACHE, false, _obsP1);
      worldToScene(w2.x, w2.z, mapCenter, null, EMPTY_TERRAIN_CACHE, false, _obsP2);
      worldToScene(w3.x, w3.z, mapCenter, null, EMPTY_TERRAIN_CACHE, false, _obsP3);
      const p1 = _obsP1, p2 = _obsP2, p3 = _obsP3;
      const scCx=(p1.x+p2.x+p3.x)/3;
      const scCz=(p1.z+p2.z+p3.z)/3;

      const shape = new THREE.Shape();
      shape.moveTo(p1.x, -p1.z);
      shape.lineTo(p2.x, -p2.z);
      shape.lineTo(p3.x, -p3.z);
      shape.closePath();

      const bevelScale = (type===2)?0.18:(type===1)?0.08:0.12;
      const extrudeSettings: THREE.ExtrudeGeometryOptions = {
        depth:          extDepth,
        bevelEnabled:   true,
        bevelThickness: extDepth*bevelScale,
        bevelSize:      extDepth*bevelScale*0.5,
        bevelSegments:  (type===2)?4:3,
      };

      try {
        const rawGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        rawGeo.rotateX(-Math.PI / 2);
        rawGeo.computeVertexNormals();
        rawGeo.translate(0, terrainY, 0);

        /**
         * 【核心修复】统一转为 non-indexed 并删除 UV
         * 解决 ExtrudeGeometry(indexed) 与装饰物几何体(non-indexed) 混合
         * 导致 mergeGeometries 返回 null 的根本原因。
         * toNonIndexed() 必须在自定义属性（color/aSmoothFactor/aRoughness）填充之前调用，
         * 因为它会展开顶点，顶点数量改变，之前设置的属性会失效。
         */
        const geo = toNonIndexedClean(rawGeo);
        rawGeo.dispose();

        // 顶点有机扰动
        perturbGeometry(geo, seed, extDepth, type, terrainY);

        // 随机倾斜（绕重心嵌地感，防零向量）
        const tx=pseudoRand(seed*1.13)-0.5, tz=pseudoRand(seed*2.17)-0.5;
        const tLen=Math.sqrt(tx*tx+tz*tz);
        if (tLen>0.01) {
          const tiltMag=(type===2)?0.04:0.09;
          const tiltAngle=(pseudoRand(seed*0.91)-0.5)*tiltMag*2;
          const pivotY=terrainY+extDepth*0.45;
          geo.translate(-scCx,-pivotY,-scCz);
          /* 【优化】复用模块级 Quaternion/Vector3，避免 useMemo 循环内 new 分配 */
          geo.applyQuaternion(_obsTmpQuat.setFromAxisAngle(
            _obsTmpAxis.set(tx/tLen,0,tz/tLen), tiltAngle,
          ));
          geo.translate(scCx, pivotY, scCz);
          geo.computeVertexNormals();
        }

        // 填充顶点颜色和属性
        fillMainAttribs(geo, type, terrainY, extDepth, SMOOTH_MAP[type]??0.32);
        allGeos.push(geo);

        // 次级装饰物（已在内部完成 toNonIndexedClean）
        const decors = (type===0||type===3)
          ? buildScatterRocks(scCx, terrainY, scCz, extDepth, seed)
          : (type===1)
            ? buildFoliageClusters(scCx, terrainY, scCz, extDepth, seed)
            : [];
        allGeos.push(...decors);

      } catch(e) {
        // 退化三角形静默跳过
      }
    });

    if (allGeos.length === 0) return null;

    const merged = mergeGeometries(allGeos, false);
    allGeos.forEach(g => g.dispose());
    return merged;

  }, [obstaclesData, mapCenter, tilesData, terrainCache]);

  const material = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader:   OBSTACLE_VERT,
      fragmentShader: OBSTACLE_FRAG,
      uniforms:       { uTime: { value: 0 } },
      vertexColors:   true,
      side:           THREE.DoubleSide,
    });
    materialRef.current = mat;
    return mat;
  }, []);

  /**
   * 使用 useFrame 驱动 uTime uniform 更新，与 R3F 游戏循环统一。
   * 替代原有的独立 requestAnimationFrame，消除双驱动冲突，
   * 确保火山熔岩动画与实际渲染帧精确同步。
   */
  useFrame(({ clock }) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = clock.elapsedTime;
    }
  });

  React.useEffect(() => {
    return () => {
      mergedGeometry?.dispose();
      material.dispose();
    };
  }, [mergedGeometry, material]);

  if (!mergedGeometry) return null;

  return (
    <mesh
      geometry={mergedGeometry}
      material={material}
      visible={visible}
      castShadow
      receiveShadow
    />
  );
};
