/**
 * @fileoverview 导航网格线框渲染组件
 * @description 将服务端 NavMesh 三角剖分数据以线框方式可视化，用于开发调试阶段验证寻路网格是否正确。
 *              每个三角形以三条线段渲染，挂载在地形表面上方固定偏移处防止 Z-fighting。
 *
 * 性能策略：
 *   - 使用 LineSegments（而非 Line）以单次 DrawCall 渲染所有线段
 *   - 仅在 navMeshData 或地形数据变化时重建 BufferGeometry（useMemo 缓存）
 *   - 导航网格通常包含数万三角形，几何体构建是 CPU 密集操作，应避免每帧重建
 *
 * @author WildMap Team
 */
import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { NavMeshConfig, MapCenter, TileMeshConfig } from '../types/game';
import { worldToScene, type TerrainCache } from '../utils/coordinates';

/**
 * 【性能优化】复用临时向量，避免每个三角形创建 3 个新 Vector3
 * 原始问题：worldToScene 无 output 参数时每次返回 new Vector3()，
 *   对于含数万三角形的 NavMesh 会产生 3×N 个临时对象（N=三角形数），
 *   导致 GC 峰值压力，在移动端可能引发帧率跳变（GC pause 10-30ms）。
 * 修复方案：预分配 3 个 Vector3 复用，在 useMemo 同步执行中安全使用。
 */
const _navP1 = new THREE.Vector3();
const _navP2 = new THREE.Vector3();
const _navP3 = new THREE.Vector3();

interface NavMeshLinesProps {
  navMeshData:  NavMeshConfig;
  mapCenter:    MapCenter;
  tilesData:    TileMeshConfig | null;
  terrainCache: TerrainCache;
  visible:      boolean;
}

export const NavMeshLines: React.FC<NavMeshLinesProps> = ({
  navMeshData,
  mapCenter,
  tilesData,
  terrainCache,
  visible,
}) => {
  const geometry = useMemo(() => {
    const positions: number[] = [];

    navMeshData.triangles.forEach(triangle => {
      const v1 = navMeshData.vertices[triangle[0]];
      const v2 = navMeshData.vertices[triangle[1]];
      const v3 = navMeshData.vertices[triangle[2]];

      /* 【性能优化】传入 output 参数复用临时向量，避免每次 new Vector3() */
      worldToScene(v1.x, v1.z, mapCenter, tilesData, terrainCache, true, _navP1);
      worldToScene(v2.x, v2.z, mapCenter, tilesData, terrainCache, true, _navP2);
      worldToScene(v3.x, v3.z, mapCenter, tilesData, terrainCache, true, _navP3);

      /**
       * Y 轴偏移 4 个单位防止与地面产生 Z-fighting 闪烁。
       * 使用 LineSegments 每条边单独推两个顶点（不共享顶点），避免顶点索引复杂度。
       */
      const Y_OFFSET = 4;
      positions.push(
        _navP1.x, _navP1.y + Y_OFFSET, _navP1.z,  _navP2.x, _navP2.y + Y_OFFSET, _navP2.z,
        _navP2.x, _navP2.y + Y_OFFSET, _navP2.z,  _navP3.x, _navP3.y + Y_OFFSET, _navP3.z,
        _navP3.x, _navP3.y + Y_OFFSET, _navP3.z,  _navP1.x, _navP1.y + Y_OFFSET, _navP1.z,
      );
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [navMeshData, mapCenter, tilesData, terrainCache]);

  const material = useMemo(() => new THREE.LineBasicMaterial({
    color:       0x57f287,
    transparent: true,
    opacity:     0.25,
  }), []);

  React.useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return (
    <lineSegments
      geometry={geometry}
      material={material}
      visible={visible}
      renderOrder={2}
    />
  );
};
