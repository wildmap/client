/**
 * @fileoverview WebSocket 通信 Hook
 * @description 封装 WebSocket 连接生命周期管理，与 Zustand Store 解耦，对外暴露
 *              connect / disconnect / sendMessage 三个核心方法。
 *
 * 核心职责：
 *   1. 连接管理：建立/关闭 WebSocket 连接，更新 Store 连接状态
 *   2. 自动重连：断线后指数退避重连（最多 MAX_RECONNECT_ATTEMPTS 次）
 *   3. 消息路由：解析服务端 JSON 消息，按 kind 字段分发到 Store 更新方法
 *   4. 地图视图轮询：连接成功后每 300ms 发送 mapView 请求，服务端据此推送可视范围内实体
 *
 * 实体解析规则（mapView 消息）：
 *   - MapUnitNpcGatherable → GatherData（采集点）
 *   - MapUnitPlayerCity    → PlayerData（玩家城市）
 *   - MapUnitPlayerTroop   → TroopData（部队），state 由 position.move 存在与否推断
 *
 * 连接状态流转：
 *   disconnected → connecting → connected → disconnected（断线触发重连）
 *   disconnected → reconnecting → connecting（自动重连中）
 *   任意状态 → error（超过最大重连次数）
 *
 * @author WildMap Team
 */
import { useRef, useCallback, useEffect } from 'react';
import { useGameStore } from '../store/gameStore';
import { showError } from '../store/messageStore';
import type {
  MapResourceData,
  MapViewData,
  PlayerJoinData,
  LuaResultData,
  GatherDetailNtfData,
  EntitiesNtfData,
  PositionNtfData,
  DelEntitiesNtfData,
  RawEntity,
  GatherData,
  PlayerData,
  TroopData,
  WSMessage,
} from '../types/game';

/** 最大自动重连尝试次数，超过后停止重连并清除本地存储 */
const MAX_RECONNECT_ATTEMPTS = 5;

/** 基础重连延迟（毫秒），实际延迟 = BASE × 1.5^(尝试次数-1)（指数退避） */
const BASE_RECONNECT_DELAY   = 3000;

/**
 * 规范化服务器地址
 * 去掉用户可能输入的 ws:// 或 wss:// 前缀以及末尾斜杠，统一由 connect 函数根据当前页面协议补全。
 * @param url - 用户输入的服务器地址
 */
function normalizeServerUrl(url: string): string {
  return url
    .replace(/^(ws|wss):\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * 从原始实体推断部队行为状态
 * 简化版推断：position.move 存在则视为行军中（state=2），否则为空闲（state=1）。
 * 服务端完整状态位掩码在 TroopData.state 文档中说明。
 */
function extractTroopState(entity: RawEntity): number {
  if (entity.position?.move) return 2;
  return 1;
}

/**
 * 从原始实体提取寻路路径节点列表
 * 兼容两种服务端格式：end_coord 嵌套对象或直接 x/z 字段。
 */
function extractTroopPath(entity: RawEntity): Array<{ x: number; z: number }> {
  const move = entity.position?.move;
  if (!move?.path?.length) return [];
  return move.path.map(p => ({
    x: p.end_coord?.x ?? p.x ?? 0,
    z: p.end_coord?.z ?? p.z ?? 0,
  }));
}

/**
 * useWebSocket Hook 返回值接口
 */
export interface UseWebSocketReturn {
  /** 建立 WebSocket 连接并发送 playerJoin 请求 */
  connect:     (serverUrl: string, playerId: number) => void;
  /** 主动断开连接并清除会话状态 */
  disconnect:  () => void;
  /** 向服务端发送 JSON 消息（仅在连接 OPEN 状态时有效） */
  sendMessage: (msg: WSMessage) => void;
  /** WebSocket 实例引用，外部偶尔需要检查 readyState */
  wsRef: React.RefObject<WebSocket | null>;
}

/**
 * WebSocket 通信 Hook
 * @returns connect / disconnect / sendMessage 方法及 wsRef
 *
 * @example
 * const { connect, disconnect, sendMessage } = useWebSocket();
 * connect('localhost:8080', 1001);
 * sendMessage({ kind: 'newMarch', data: { troop_id: 1, target_coord: { x: 100, z: 200 } } });
 */
export function useWebSocket(): UseWebSocketReturn {
  const wsRef               = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isManualDisconnectRef = useRef(false);
  const mapViewTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const savedServerUrlRef   = useRef<string>('');
  const savedPlayerIdRef    = useRef<number>(0);

  const store = useGameStore;

  /**
   * 启动 mapView 轮询定时器（每 300ms 发送一次视口查询）
   * 服务端根据 center_pos 和 x_span/z_span 参数返回可视范围内的实体列表。
   * viewCenter 由 CameraController 每 100ms 同步，保证中心坐标反映实际相机位置。
   */
  const startMapViewTimer = useCallback(() => {
    if (mapViewTimerRef.current) clearInterval(mapViewTimerRef.current);
    mapViewTimerRef.current = setInterval(() => {
      const state = store.getState();
      if (
        !state.isPlayerJoined ||
        !wsRef.current ||
        wsRef.current.readyState !== WebSocket.OPEN
      ) return;

      const { viewSpan } = state;
      const center = state.viewCenter;

      wsRef.current.send(JSON.stringify({
        kind: 'mapView',
        data: {
          center_pos: { x: Math.round(center.x), z: Math.round(center.z) },
          x_span: viewSpan.x_span,
          z_span: viewSpan.z_span,
          reconnect: true,
        },
      }));
    }, 300);
  }, [store]);

  const stopMapViewTimer = useCallback(() => {
    if (mapViewTimerRef.current) {
      clearInterval(mapViewTimerRef.current);
      mapViewTimerRef.current = null;
    }
  }, []);

  /**
   * 处理服务端推送消息
   * 按 kind 字段路由到对应的 Store 更新逻辑，解耦消息解析与 UI 渲染。
   */
  const handleMessage = useCallback((msg: WSMessage) => {
    const state = store.getState();

    switch (msg.kind) {
      case 'playerJoin': {
        const data = msg.data as PlayerJoinData;
        if (!state.isPlayerJoined && state.currentPlayerId !== null) {
          const pid = state.currentPlayerId;
          const cityX = data.position?.coord?.x ?? data.position?.x ?? 0;
          const cityZ = data.position?.coord?.z ?? data.position?.z ?? 0;
          const playerData: PlayerData = {
            id:           pid,
            name:         `${pid}`,
            city_pos:     { x: cityX, z: cityZ },
            block_radius: data.block_radius  ?? 3500,
            occupy_radius: data.occupy_radius ?? 6000,
          };
          store.getState().setCurrentPlayerData(playerData);
          store.getState().setIsPlayerJoined(true);
          localStorage.setItem('game_server_url', savedServerUrlRef.current);
          localStorage.setItem('game_player_id', String(savedPlayerIdRef.current));
          startMapViewTimer();
          if (!store.getState().hasCenteredOnCity) {
            store.getState().setViewMode('city');
          }
        }
        break;
      }

      case 'mapRes': {
        const data = msg.data as MapResourceData;
        store.getState().setMapResource({
          navMesh:   data.navMeshCfg       ?? undefined,
          obstacles: data.globalObstacleCfg ?? undefined,
          tiles:     data.tileMeshCfg       ?? undefined,
        });
        break;
      }

      case 'mapView': {
        const data = msg.data as MapViewData;
        if (!data?.entities) break;

        const gathers:  GatherData[]  = [];
        const players:  PlayerData[]  = [];
        const troops:   TroopData[]   = [];

        data.entities.forEach((entity: RawEntity) => {
          const pos = entity.position?.coord ?? entity.position ?? {};
          const normPos = { x: (pos as { x?: number }).x ?? 0, z: (pos as { z?: number }).z ?? 0 };

          switch (entity.kind) {
            case 'MapUnitNpcGatherable':
              gathers.push({
                id:            entity.id,
                /**
                 * 【BUG修复】传递 conf_id (D2GatherConf.ID)，用于客户端按资源类型分组渲染。
                 * 原始代码缺少此字段，导致 GatherEntity.tsx 用唯一实例ID匹配配置表键永远失败，
                 * 所有采集点都落入默认分组（灰色），无法区分粮/木/石/铁四种资源类型的颜色。
                 */
                conf_id:       entity.conf_id ?? 0,
                position:      normPos,
                block_radius:  entity.block_radius,
                occupy_radius: entity.occupy_radius,
                remains:       entity.remains,
              });
              break;
            case 'MapUnitPlayerCity':
              players.push({
                id:            entity.owner ?? entity.id,
                name:          `玩家${entity.owner ?? entity.id}`,
                city_pos:      normPos,
                block_radius:  entity.block_radius ?? 6000,
                occupy_radius: entity.occupy_radius ?? 3500,
              });
              break;
            case 'MapUnitPlayerTroop':
              troops.push({
                id:            entity.id,
                owner:         entity.owner ?? 1,
                position:      normPos,
                block_radius:  entity.block_radius ?? 1500,
                occupy_radius: entity.occupy_radius ?? 1500,
                state:         extractTroopState(entity),
                path:          extractTroopPath(entity),
              });
              break;
          }
        });

        if (state.isPlayerJoined && state.currentPlayerId !== null) {
          const myCity = players.find(p => p.id === state.currentPlayerId);
          if (myCity) {
            store.getState().setCurrentPlayerData(myCity);
          }
        }

        store.getState().updateGathers(gathers);
        store.getState().updatePlayers(players);
        store.getState().updateTroops(troops);

        // 处理服务端标记需要删除的实体（已离开视野或已销毁）
        if (data.need_delete_entities?.length) {
          store.getState().removeEntitiesById(data.need_delete_entities);
        }
        break;
      }

      case 'doLua': {
        const data = msg.data as LuaResultData;
        const ts   = new Date().toLocaleTimeString();
        store.getState().appendLuaOutput(`[${ts}] 执行成功: ${data.result}`);
        break;
      }

      case 'gatherDetailNtf': {
        /**
         * 采集点详情响应
         * 服务端返回 GatherDetailNtf 结构，包含所请求采集点的详细数据。
         * 将数据写入 Store 供 GatherActionMenu 组件读取展示。
         */
        const data = msg.data as GatherDetailNtfData;
        const infos = data?.infos ?? [];
        store.getState().setGatherDetails(infos);
        break;
      }

      case 'entitiesNtf': {
        /**
         * 实体增量推送
         * 服务端观察者系统检测到视野内有新实体出现或已有实体属性变更时推送。
         * 复用 mapView 的实体解析逻辑，将新增/更新的实体合并到对应 Map 中。
         */
        const data = msg.data as EntitiesNtfData;
        if (!data?.entities?.length) break;

        const gathers:  GatherData[]  = [];
        const players:  PlayerData[]  = [];
        const troops:   TroopData[]   = [];

        data.entities.forEach((entity: RawEntity) => {
          const pos = entity.position?.coord ?? entity.position ?? {};
          const normPos = { x: (pos as { x?: number }).x ?? 0, z: (pos as { z?: number }).z ?? 0 };

          switch (entity.kind) {
            case 'MapUnitNpcGatherable':
              gathers.push({
                id:            entity.id,
                conf_id:       entity.conf_id ?? 0,
                position:      normPos,
                block_radius:  entity.block_radius,
                occupy_radius: entity.occupy_radius,
                remains:       entity.remains,
              });
              break;
            case 'MapUnitPlayerCity':
              players.push({
                id:            entity.owner ?? entity.id,
                name:          `玩家${entity.owner ?? entity.id}`,
                city_pos:      normPos,
                block_radius:  entity.block_radius ?? 6000,
                occupy_radius: entity.occupy_radius ?? 3500,
              });
              break;
            case 'MapUnitPlayerTroop':
              troops.push({
                id:            entity.id,
                owner:         entity.owner ?? 1,
                position:      normPos,
                block_radius:  entity.block_radius ?? 1500,
                occupy_radius: entity.occupy_radius ?? 1500,
                state:         extractTroopState(entity),
                path:          extractTroopPath(entity),
              });
              break;
          }
        });

        if (gathers.length) store.getState().updateGathers(gathers);
        if (players.length) store.getState().updatePlayers(players);
        if (troops.length)  store.getState().updateTroops(troops);
        break;
      }

      case 'positionNtf': {
        /**
         * 实体位置变更推送
         * 服务端在实体移动时推送位置增量更新，仅包含单个实体的新位置信息。
         * 通过实体 ID 查找对应 Map 并更新其坐标和行军数据。
         */
        const data = msg.data as PositionNtfData;
        const posEntry = data?.position;
        if (!posEntry?.id || !posEntry?.info) break;

        const eid = posEntry.id;
        const coord = posEntry.info.coord ?? posEntry.info;
        const newPos = { x: (coord as { x?: number }).x ?? 0, z: (coord as { z?: number }).z ?? 0 };

        // 尝试在各实体 Map 中查找并更新
        const { gathers, players, troops } = store.getState();

        if (troops.has(eid)) {
          const old = troops.get(eid)!;
          const updated: TroopData = {
            ...old,
            position: newPos,
            state:    posEntry.info.move ? 2 : old.state,
            path:     posEntry.info.move?.path?.map(p => ({
              x: p.end_coord?.x ?? p.x ?? 0,
              z: p.end_coord?.z ?? p.z ?? 0,
            })) ?? old.path,
          };
          store.getState().updateTroops([updated]);
        } else if (gathers.has(eid)) {
          const old = gathers.get(eid)!;
          store.getState().updateGathers([{ ...old, position: newPos }]);
        } else if (players.has(eid)) {
          const old = players.get(eid)!;
          store.getState().updatePlayers([{ ...old, city_pos: newPos }]);
        }
        break;
      }

      case 'delEntitiesNtf': {
        /**
         * 实体删除推送
         * 服务端在实体被销毁（如采集完毕、部队回城）时推送需要移除的 ID 列表。
         * 调用 Store 的 removeEntitiesById 从 gathers/players/troops 三个 Map 中批量移除。
         */
        const data = msg.data as DelEntitiesNtfData;
        if (data?.ids?.length) {
          store.getState().removeEntitiesById(data.ids);
        }
        break;
      }

      case 'error': {
        /**
         * 使用非阻塞消息弹窗代替 alert()，避免冻结 WebSocket 消息队列。
         * alert() 会阻塞 JS 主线程，导致后续 WebSocket 消息积压。
         */
        showError(`服务端错误: ${String(msg.data)}`, { duration: 6000 });
        break;
      }
    }
  }, [store, startMapViewTimer]);

  /**
   * 建立 WebSocket 连接
   * 连接建立后立即发送 playerJoin 和 mapRes 两条初始化请求。
   */
  const connect = useCallback((serverUrl: string, playerId: number) => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    isManualDisconnectRef.current = false;
    savedServerUrlRef.current    = serverUrl;
    savedPlayerIdRef.current     = playerId;

    const normalized = normalizeServerUrl(serverUrl);
    const protocol   = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl      = `${protocol}//${normalized}`;

    store.getState().setConnectionStatus('connecting');
    store.getState().setCurrentPlayerId(playerId);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      store.getState().setConnectionStatus('connected');
      reconnectAttemptsRef.current = 0;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      ws.send(JSON.stringify({
        kind: 'playerJoin',
        data: { player_id: playerId },
      }));
      ws.send(JSON.stringify({ kind: 'mapRes' }));
    };

    ws.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data) as WSMessage);
      } catch {
      }
    };

    ws.onclose = () => {
      store.getState().setConnectionStatus('disconnected');
      stopMapViewTimer();
      store.getState().clearGameObjects();

      if (isManualDisconnectRef.current) {
        isManualDisconnectRef.current = false;
        store.getState().resetSession();
        return;
      }

      attemptReconnect();
    };

    ws.onerror = () => {
      store.getState().setConnectionStatus('error');
      store.getState().clearGameObjects();
    };
  }, [handleMessage, stopMapViewTimer, store]);

  /**
   * 指数退避自动重连
   * 延迟时间 = BASE_RECONNECT_DELAY × 1.5^(attempts-1)：
   *   第1次：3000ms，第2次：4500ms，第3次：6750ms，第4次：10125ms，第5次：15188ms
   */
  const attemptReconnect = useCallback(() => {
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      store.getState().setConnectionStatus('error');
      localStorage.removeItem('game_server_url');
      localStorage.removeItem('game_player_id');
      store.getState().resetSession();
      reconnectAttemptsRef.current = 0;
      return;
    }

    reconnectAttemptsRef.current++;
    const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttemptsRef.current - 1);
    store.getState().setConnectionStatus('reconnecting');

    reconnectTimerRef.current = setTimeout(() => {
      const url = savedServerUrlRef.current;
      const pid = savedPlayerIdRef.current;
      if (url && pid) {
        connect(url, pid);
      }
    }, delay);
  }, [connect, store]);

  /**
   * 主动断开连接
   * 发送 playerLeave 通知服务端，然后关闭 WebSocket，并清理本地会话。
   */
  const disconnect = useCallback(() => {
    isManualDisconnectRef.current = true;
    stopMapViewTimer();

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ kind: 'playerLeave' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    localStorage.removeItem('game_server_url');
    localStorage.removeItem('game_player_id');
    store.getState().setConnectionStatus('disconnected');
    store.getState().resetSession();
  }, [stopMapViewTimer, store]);

  /**
   * 发送 WebSocket 消息
   * 仅在连接处于 OPEN 状态时才发送，调用方无需检查连接状态。
   */
  const sendMessage = useCallback((msg: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    return () => {
      stopMapViewTimer();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [stopMapViewTimer]);

  return { connect, disconnect, sendMessage, wsRef };
}
