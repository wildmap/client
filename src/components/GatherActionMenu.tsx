/**
 * @fileoverview 资源点采集菜单组件
 * @description 点击地图上的资源点后弹出此菜单，提供：
 *   1. 资源点信息展示（资源类型、剩余量、坐标）
 *   2. 采集详情展示（已采集资源、采集速度、预计完成时间等）
 *   3. 派出部队按钮 → 展开当前玩家部队列表
 *   4. 点击部队 → 确认弹窗 → 发送 newGather 指令
 *
 * 交互流程：
 *   点击资源点 → 弹出采集菜单（step=info）→ 自动发送 gatherDetailNtf 查询详情
 *     → 点击「派出部队」→ 切换到部队列表（step=troops）
 *       → 点击部队 → 确认弹窗（confirm）→ 确认 → 发送 newGather
 *
 * @author WildMap Team
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useGameStore } from '../store/gameStore';
import { showError, showWarning } from '../store/messageStore';
import type { TroopData, GatherDetailData, KindIDVal } from '../types/game';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

/** 请求超时时间（毫秒） */
const GATHER_DETAIL_TIMEOUT_MS = 5000;

/** 资源 ID → 中文名称映射 */
const RESOURCE_NAME_MAP: Record<number, string> = {
  11151001: '⭐ 金矿',
  11151006: '🔷 铁矿',
  11151007: '🌲 木材',
  11151008: '🪨 石矿',
};

/** 资源 kind → 中文类别名称 */
const RESOURCE_KIND_MAP: Record<string, string> = {
  gold:  '金币',
  iron:  '铁矿',
  wood:  '木材',
  stone: '石材',
};

function getResourceName(id: number): string {
  return RESOURCE_NAME_MAP[id] ?? '🟡 资源点';
}

/** 根据 KindIDVal 的 kind 字段获取中文名称 */
function getKindName(kind?: string): string {
  if (!kind) return '未知';
  return RESOURCE_KIND_MAP[kind] ?? kind;
}

/** 格式化数值（千位分隔） */
function formatNumber(val?: number): string {
  if (val === undefined || val === null) return '-';
  return val.toLocaleString();
}

/** 格式化时间戳差值为可读文字（如 "2分30秒"） */
function formatDuration(ms: number): string {
  if (ms <= 0) return '已完成';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}分${sec}秒`;
  return `${sec}秒`;
}

type Step = 'info' | 'troops' | 'confirm';

interface GatherActionMenuProps {
  ws: UseWebSocketReturn;
}

/**
 * 将部队状态数字转换为显示文字（与 TroopTab 保持一致）
 */
function getTroopStatusText(state: number): string {
  switch (state) {
    case 2:  return '🚶 行军';
    case 4:  return '⛏️ 采集';
    case 8:  return '🛡️ 驻守';
    default: return '⏸️ 空闲';
  }
}

export const GatherActionMenu: React.FC<GatherActionMenuProps> = ({ ws }) => {
  const selectedGatherId  = useGameStore(s => s.selectedGatherId);
  const setSelectedGatherId = useGameStore(s => s.setSelectedGatherId);
  const gathers           = useGameStore(s => s.gathers);
  const troops            = useGameStore(s => s.troops);
  const currentPid        = useGameStore(s => s.currentPlayerId);
  const isPlayerJoined    = useGameStore(s => s.isPlayerJoined);
  const gatherDetails     = useGameStore(s => s.gatherDetails);
  const gatherDetailLoading = useGameStore(s => s.gatherDetailLoading);
  const setGatherDetailLoading = useGameStore(s => s.setGatherDetailLoading);
  const clearGatherDetails = useGameStore(s => s.clearGatherDetails);

  const [step, setStep]               = useState<Step>('info');
  const [pendingTroop, setPendingTroop] = useState<TroopData | null>(null);
  /** 超时计时器引用，用于在组件卸载或关闭时清理 */
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 发送 gatherDetailNtf 请求并设置超时处理
   * 当 selectedGatherId 变化且玩家已加入游戏时自动触发。
   *
   * 请求格式与项目通信协议一致：
   *   kind: 'gatherDetailNtf'
   *   data: { gather_id: number }
   *
   * 注意：字段名使用 camelCase "gather_id"，与服务端 cspb.GatherInfoReq
   * 的 JSON tag `json:"gather_id"` 严格匹配。
   *
   * 若服务端在 GATHER_DETAIL_TIMEOUT_MS 内未响应，自动清除 loading 状态并提示用户。
   */
  const sendGatherDetailRequest = useCallback(() => {
    if (selectedGatherId === null || !isPlayerJoined) return;

    // 清除上一次的超时计时器
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    // 设置 loading 状态
    setGatherDetailLoading(true);

    // 发送请求（遵循项目 WSMessage 格式，gather_id 与后端 JSON tag 匹配）
    ws.sendMessage({
      kind: 'gatherDetailNtf',
      data: {
        gather_id: selectedGatherId,
      },
    });

    // 超时处理：若服务端未在限定时间内响应，清除 loading 并提示
    timeoutRef.current = setTimeout(() => {
      const store = useGameStore.getState();
      if (store.gatherDetailLoading) {
        store.setGatherDetailLoading(false);
        showWarning('获取采集详情超时，请稍后重试');
      }
    }, GATHER_DETAIL_TIMEOUT_MS);
  }, [selectedGatherId, isPlayerJoined, ws, setGatherDetailLoading]);

  /**
   * selectedGatherId 变化时自动请求采集详情
   * - 打开菜单时：发送请求
   * - 关闭菜单时（id=null）：清理状态
   */
  useEffect(() => {
    if (selectedGatherId !== null && isPlayerJoined) {
      sendGatherDetailRequest();
    } else {
      clearGatherDetails();
    }

    return () => {
      // 组件卸载或 selectedGatherId 变化时清理超时计时器
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [selectedGatherId, isPlayerJoined, sendGatherDetailRequest, clearGatherDetails]);

  /**
   * 当 gatherDetails 数据到达时，清除超时计时器。
   * 数据可能在超时前到达，此时应取消超时提示。
   */
  useEffect(() => {
    if (!gatherDetailLoading && timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, [gatherDetailLoading]);

  // 没有选中资源点时不渲染
  if (selectedGatherId === null) return null;

  const gather = gathers.get(selectedGatherId);
  if (!gather) return null;

  // 当前玩家的部队列表（空闲部队优先排序：state=1）
  const myTroops: TroopData[] = Array.from(troops.values())
    .filter(t => t.owner === currentPid)
    .sort((a, b) => {
      // 空闲部队优先
      const aIdle = a.state === 1 ? 0 : 1;
      const bIdle = b.state === 1 ? 0 : 1;
      return aIdle - bIdle;
    });

  const resourceName = getResourceName(gather.id);
  const isExhausted  = (gather.remains !== undefined) && gather.remains <= 0;

  /** 当前时间戳（毫秒），用于计算剩余时间 */
  const nowMs = Date.now();

  const handleClose = () => {
    setSelectedGatherId(null);
    setStep('info');
    setPendingTroop(null);
    clearGatherDetails();
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const handleDispatchClick = () => {
    if (!isPlayerJoined) {
      showError('请先加入游戏！');
      return;
    }
    setStep('troops');
  };

  const handleTroopSelect = (troop: TroopData) => {
    setPendingTroop(troop);
    setStep('confirm');
  };

  const handleConfirm = () => {
    if (!pendingTroop || !gather) return;
    ws.sendMessage({
      kind: 'newMarch',
      data: {
        troop_id:   pendingTroop.id,
        target_id:  gather.id,
        target_coord: {
          x: Math.round(gather.position.x),
          z: Math.round(gather.position.z),
        },
      },
    });
    handleClose();
  };

  const handleCancelConfirm = () => {
    setPendingTroop(null);
    setStep('troops');
  };

  /** 刷新采集详情 */
  const handleRefreshDetail = () => {
    sendGatherDetailRequest();
  };

  /**
   * 渲染 KindIDVal 列表（资源条目）
   * 用于展示 remains / got / cur 等字段
   */
  const renderKindIDValList = (label: string, items?: KindIDVal[]) => {
    if (!items || items.length === 0) return null;
    return (
      <div className="gather-detail-section">
        <div className="gather-detail-section-label">{label}</div>
        {items.map((item, idx) => (
          <div key={idx} className="gather-detail-row">
            <span className="gather-detail-kind">{getKindName(item.kind)}</span>
            <span className="gather-detail-val">{formatNumber(item.val)}</span>
          </div>
        ))}
      </div>
    );
  };

  /**
   * 渲染单条采集详情
   */
  const renderGatherDetail = (detail: GatherDetailData, idx: number) => {
    const remainMs = detail.end_ts ? detail.end_ts - nowMs : 0;
    const fullMs   = detail.full_ts ? detail.full_ts - nowMs : 0;

    return (
      <div key={idx} className="gather-detail-card">
        {detail.troop_id != null && (
          <div className="gather-detail-troop-header">
            ⚔️ 部队 #{detail.troop_id}
          </div>
        )}
        {renderKindIDValList('📦 剩余储量', detail.remains)}
        {renderKindIDValList('✅ 已采集', detail.got)}
        {renderKindIDValList('📋 当前负载', detail.cur)}
        {detail.speed && detail.speed.length > 0 && (
          <div className="gather-detail-section">
            <div className="gather-detail-section-label">⚡ 采集速度</div>
            {detail.speed.map((s, i) => (
              <div key={i} className="gather-detail-row">
                <span className="gather-detail-kind">{getKindName(s.kind)}</span>
                <span className="gather-detail-val">{formatNumber(s.val)}/h</span>
              </div>
            ))}
          </div>
        )}
        {detail.end_ts != null && (
          <div className="gather-detail-time-row">
            <span className="gather-detail-time-label">⏱️ 满载剩余</span>
            <span className="gather-detail-time-val">{formatDuration(fullMs)}</span>
          </div>
        )}
        {detail.full_ts != null && (
          <div className="gather-detail-time-row">
            <span className="gather-detail-time-label">🏁 采空剩余</span>
            <span className="gather-detail-time-val">{formatDuration(remainMs)}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="gather-menu-overlay" onClick={handleClose}>
      <div
        className="gather-menu-panel"
        onClick={e => e.stopPropagation()}
      >
        {/* ── 标题栏 ── */}
        <div className="gather-menu-header">
          <div className="gather-menu-title">
            {resourceName}
            {isExhausted && <span className="gather-menu-exhausted">已耗尽</span>}
          </div>
          <button className="gather-menu-close" onClick={handleClose} title="关闭">✕</button>
        </div>

        {/* ── 步骤 1：资源点信息 ── */}
        {step === 'info' && (
          <>
            <div className="gather-menu-info">
              <div className="gather-menu-info-row">
                <span className="gather-menu-info-label">坐标</span>
                <span className="gather-menu-info-value">
                  ({Math.round(gather.position.x)}, {Math.round(gather.position.z)})
                </span>
              </div>
              {gather.remains !== undefined && (
                <div className="gather-menu-info-row">
                  <span className="gather-menu-info-label">剩余储量</span>
                  <span className={`gather-menu-info-value ${isExhausted ? 'exhausted' : 'has-resource'}`}>
                    {isExhausted ? '已耗尽' : gather.remains.toLocaleString()}
                  </span>
                </div>
              )}
              {gather.occupy_radius !== undefined && (
                <div className="gather-menu-info-row">
                  <span className="gather-menu-info-label">采集半径</span>
                  <span className="gather-menu-info-value">{gather.occupy_radius}</span>
                </div>
              )}
            </div>

            {/* ── 采集详情区域 ── */}
            <div className="gather-detail-area">
              <div className="gather-detail-header">
                <span className="gather-detail-title">📊 采集详情</span>
                <button
                  className="gather-detail-refresh"
                  onClick={handleRefreshDetail}
                  disabled={gatherDetailLoading}
                  title="刷新详情"
                >
                  🔄
                </button>
              </div>

              {gatherDetailLoading && (
                <div className="gather-detail-loading">
                  <span className="gather-detail-spinner">⏳</span> 加载中…
                </div>
              )}

              {!gatherDetailLoading && gatherDetails.length === 0 && (
                <div className="gather-detail-empty">
                  暂无采集详情（该资源点当前无部队采集）
                </div>
              )}

              {!gatherDetailLoading && gatherDetails.length > 0 && (
                <div className="gather-detail-list">
                  {gatherDetails.map(renderGatherDetail)}
                </div>
              )}
            </div>

            <div className="gather-menu-actions">
              <button
                className="btn btn-action gather-menu-dispatch-btn"
                onClick={handleDispatchClick}
                disabled={isExhausted || !isPlayerJoined}
                title={isExhausted ? '资源已耗尽' : !isPlayerJoined ? '请先加入游戏' : ''}
              >
                ⚔️ 派出部队
              </button>
            </div>
          </>
        )}

        {/* ── 步骤 2：部队列表 ── */}
        {step === 'troops' && (
          <>
            <div className="gather-menu-section-title">选择派出的部队</div>
            <div className="gather-menu-troop-list">
              {myTroops.length === 0 ? (
                <div className="gather-menu-empty">暂无可用部队</div>
              ) : (
                myTroops.map(troop => (
                  <div
                    key={troop.id}
                    className="gather-menu-troop-item"
                    onClick={() => handleTroopSelect(troop)}
                  >
                    <span className="gather-menu-troop-id">⚔️ 部队 #{troop.id}</span>
                    <span className="gather-menu-troop-status">{getTroopStatusText(troop.state)}</span>
                  </div>
                ))
              )}
            </div>
            <div className="gather-menu-actions">
              <button className="btn btn-toggle" onClick={() => setStep('info')}>← 返回</button>
            </div>
          </>
        )}

        {/* ── 步骤 3：确认弹窗 ── */}
        {step === 'confirm' && pendingTroop && (
          <>
            <div className="gather-menu-confirm-body">
              <div className="gather-menu-confirm-text">
                确认派出部队 <strong>#{pendingTroop.id}</strong> 前往采集<br />
                <span className="gather-menu-confirm-target">{resourceName}</span>？
              </div>
            </div>
            <div className="gather-menu-actions gather-menu-actions--split">
              <button className="btn btn-toggle" onClick={handleCancelConfirm}>取消</button>
              <button className="btn btn-action" onClick={handleConfirm}>✔ 确认派遣</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
