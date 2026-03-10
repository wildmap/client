/**
 * @fileoverview 通用消息弹窗组件
 * @description 渲染 messageStore 中的消息队列，支持进场/退场 CSS 动画、自动计时关闭和手动关闭。
 *
 * 组件层级：
 *   MessageContainer（容器，订阅 Store）
 *     └── MessageItemView（单条消息，管理退场动画状态）
 *
 * 支持两种使用方式：
 *   1. 命令式（推荐）：通过 showSuccess/showError 等工厂函数从任意位置触发
 *   2. 声明式：将 <MessageContainer /> 挂载到 App 根节点，无需其他配置
 *
 * 动画机制：
 *   进场：msg-item--entering 类触发 CSS slide-in-right 动画
 *   退场：duration 到期前 400ms 设置 msg-item--leaving 类触发 fade-out 动画，
 *         动画结束后（animationend 事件）再调用 removeMessage 从 DOM 移除，
 *         避免直接删除导致内容闪断。
 *
 * @author WildMap Team
 */
import React, { useEffect, useState, useCallback } from 'react';
import { useMessageStore, type MessageItem, type MessageType } from '../store/messageStore';

/** 各消息类型对应的图标字符 */
const TYPE_ICONS: Record<MessageType, string> = {
  success: '✓',
  warning: '⚠',
  error:   '✕',
  info:    'ℹ',
};

/** 各消息类型的默认标题（未指定 title 时使用） */
const TYPE_DEFAULT_TITLES: Record<MessageType, string> = {
  success: '操作成功',
  warning: '警告提示',
  error:   '发生错误',
  info:    '消息提示',
};

interface MessageItemProps {
  item:     MessageItem;
  onClose:  (id: string) => void;
}

/**
 * 单条消息视图组件
 * 管理独立的退场动画状态（leaving），与 Store 中的消息生命周期解耦。
 */
const MessageItemView: React.FC<MessageItemProps> = ({ item, onClose }) => {
  const [leaving, setLeaving] = useState(false);

  /** 点击关闭按钮时触发退场动画（不立即移除，等待动画结束） */
  const handleClose = useCallback(() => {
    setLeaving(true);
  }, []);

  /** 监听退场动画结束事件，动画完成后通知父组件移除消息 */
  const handleAnimationEnd = useCallback((e: React.AnimationEvent) => {
    if (e.animationName === 'msgSlideOut') {
      onClose(item.id);
    }
  }, [item.id, onClose]);

  /**
   * duration 到期前 400ms 触发退场动画
   * 400ms 与 CSS 退场动画时长匹配，确保动画结束后消息已被移除。
   * 不依赖 messageStore 的定时器，两个定时器各自独立负责不同逻辑。
   */
  useEffect(() => {
    if (item.duration <= 0) return;
    const timer = setTimeout(() => {
      setLeaving(true);
    }, item.duration - 400);
    return () => clearTimeout(timer);
  }, [item.duration]);

  const title   = item.title ?? TYPE_DEFAULT_TITLES[item.type];
  const icon    = TYPE_ICONS[item.type];
  const classes = [
    'msg-item',
    `msg-item--${item.type}`,
    leaving ? 'msg-item--leaving' : 'msg-item--entering',
  ].join(' ');

  return (
    <div
      className={classes}
      role="alert"
      aria-live={item.type === 'error' ? 'assertive' : 'polite'}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="msg-item__bar" aria-hidden="true" />

      <div className={`msg-item__icon msg-item__icon--${item.type}`} aria-hidden="true">
        {icon}
      </div>

      <div className="msg-item__body">
        <div className="msg-item__title">{title}</div>
        <div className="msg-item__content">{item.content}</div>
      </div>

      {item.closable && (
        <button
          className="msg-item__close"
          onClick={handleClose}
          aria-label="关闭消息"
          title="关闭"
        >
          ×
        </button>
      )}

      {item.duration > 0 && (
        <div
          className="msg-item__progress"
          style={{ animationDuration: `${item.duration}ms` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
};

/**
 * 消息弹窗容器组件
 * 固定在视口右上角（由 CSS .msg-container 控制），层级高于所有游戏内容。
 * 应在应用根组件（App.tsx）中渲染一次且仅一次。
 *
 * @example
 * import { MessageContainer } from './components/MessagePopup';
 * function App() {
 *   return (
 *     <div>
 *       <GameScene />
 *       <MessageContainer />
 *     </div>
 *   );
 * }
 */
export const MessageContainer: React.FC = () => {
  const messages    = useMessageStore(s => s.messages);
  const removeMsg   = useMessageStore(s => s.removeMessage);

  if (messages.length === 0) return null;

  return (
    <div
      className="msg-container"
      role="region"
      aria-label="系统消息"
      aria-live="polite"
    >
      {messages.map(item => (
        <MessageItemView
          key={item.id}
          item={item}
          onClose={removeMsg}
        />
      ))}
    </div>
  );
};

export { showMessage, showSuccess, showWarning, showError, showInfo } from '../store/messageStore';
export type { MessageType, MessageItem, ShowMessageOptions } from '../store/messageStore';
