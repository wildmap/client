/**
 * @fileoverview 全局消息弹窗状态管理 Store（Zustand）
 * @description 提供命令式消息通知 API，支持 success/warning/error/info 四种消息类型。
 *
 * 核心特性：
 *   - 消息队列：维护有序消息列表，支持最多同时显示 MAX_VISIBLE_MESSAGES 条
 *   - 自动去重：相同内容+类型的消息在 DEDUP_WINDOW_MS 内不重复弹出
 *   - 定时关闭：duration > 0 时自动关闭，定时器在组件外管理避免 Store 序列化问题
 *   - 手动关闭：支持用户点击关闭按钮，触发 onClose 回调
 *
 * 使用示例：
 *   @example
 *   import { showSuccess, showError } from '../store/messageStore';
 *   showSuccess('部队移动指令已发送');
 *   showError('WebSocket 连接失败', { duration: 0 });
 *
 * @author WildMap Team
 */
import { create } from 'zustand';

/**
 * 消息类型枚举
 */
export type MessageType = 'success' | 'warning' | 'error' | 'info';

/**
 * 单条消息数据结构
 */
export interface MessageItem {
  /** 系统自动生成的唯一 ID（格式："msg_{timestamp}_{counter}"） */
  id: string;
  type: MessageType;
  /** 弹窗标题（省略时使用各类型的默认标题） */
  title?: string;
  content: string;
  /** 显示时长（毫秒），0 表示不自动关闭 */
  duration: number;
  onClose?: () => void;
  /** 是否显示手动关闭按钮 */
  closable: boolean;
  /** 创建时间戳，用于去重时间窗口计算 */
  createdAt: number;
}

/**
 * showMessage 外部调用参数（id 和 createdAt 由系统内部填充）
 */
export type ShowMessageOptions = Omit<MessageItem, 'id' | 'createdAt' | 'closable' | 'duration'> & {
  duration?: number;
  closable?: boolean;
};

/** 最大同时可见消息数量，超出时 FIFO 移除最旧消息 */
const MAX_VISIBLE_MESSAGES = 5;

/**
 * 去重时间窗口（毫秒）
 * 同 content + type 的消息在此时间内已存在时，addMessage 返回已有消息 ID 而不新增。
 * 防止网络抖动等场景下重复上报相同错误。
 */
const DEDUP_WINDOW_MS = 1000;

/** 消息队列硬上限，保护内存不被无限增长 */
const MAX_QUEUE_SIZE = 20;

let _idCounter = 0;
function genId(): string {
  return `msg_${Date.now()}_${_idCounter++}`;
}

interface MessageStore {
  /** 当前活跃消息列表（按添加时间升序，最新消息在末尾） */
  messages: MessageItem[];

  /**
   * 添加消息（核心方法）
   * 内部执行去重检查、容量限制和自动关闭定时器设置。
   * @returns 消息 ID（去重时返回已有消息的 ID），添加失败时返回 null
   */
  addMessage: (options: ShowMessageOptions) => string | null;

  /** 关闭并移除指定 ID 的消息，同时清理其定时器 */
  removeMessage: (id: string) => void;

  /** 清空所有消息及定时器 */
  clearAll: () => void;
}

/**
 * 消息定时器 Map（存储在 Store 外部，避免 Zustand 序列化问题）
 * key: 消息 ID，value: setTimeout 返回的定时器句柄
 */
const _timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(id: string) {
  const t = _timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    _timers.delete(id);
  }
}

export const useMessageStore = create<MessageStore>((set, get) => ({
  messages: [],

  addMessage: (options: ShowMessageOptions): string | null => {
    const now      = Date.now();
    const duration = options.duration ?? 3000;
    const closable = options.closable ?? true;

    const existing = get().messages.find(
      m => m.content === options.content
        && m.type    === options.type
        && (now - m.createdAt) < DEDUP_WINDOW_MS
    );
    if (existing) return existing.id;

    const id: string = genId();
    const item: MessageItem = {
      id,
      type:      options.type,
      title:     options.title,
      content:   options.content,
      duration,
      onClose:   options.onClose,
      closable,
      createdAt: now,
    };

    set(state => {
      const updated = [...state.messages, item];
      if (updated.length > MAX_VISIBLE_MESSAGES) {
        const removed = updated.splice(0, updated.length - MAX_VISIBLE_MESSAGES);
        removed.forEach(m => clearTimer(m.id));
      }
      return { messages: updated.slice(-MAX_QUEUE_SIZE) };
    });

    if (duration > 0) {
      const timer = setTimeout(() => {
        get().removeMessage(id);
      }, duration);
      _timers.set(id, timer);
    }

    return id;
  },

  removeMessage: (id: string) => {
    clearTimer(id);
    set(state => {
      const msg = state.messages.find(m => m.id === id);
      if (msg?.onClose) {
        setTimeout(() => msg.onClose?.(), 0);
      }
      return { messages: state.messages.filter(m => m.id !== id) };
    });
  },

  clearAll: () => {
    /**
     * 【BUG修复】Map 迭代中的安全删除
     * 原始问题：for-of 迭代 _timers 时在循环体内调用 clearTimer(id)
     * 执行 _timers.delete(id)，在 Map 迭代过程中修改其大小，
     * 虽然 ES6 规范对 Map 定义了"存活键"语义允许迭代中删除，
     * 但此行为依赖具体引擎实现，且代码意图不清晰。
     * 修复方案：先收集所有定时器 ID，再逐一清理，分离迭代与修改操作。
     * 预期效果：确保所有定时器 100% 被清理，代码意图更明确。
     */
    const ids = [..._timers.keys()];
    for (const id of ids) {
      clearTimer(id);
    }
    set({ messages: [] });
  },
}));

/**
 * 显示通用消息弹窗
 * @param options - 消息配置，必须包含 type 和 content 字段
 * @returns 消息 ID 或 null
 *
 * @example
 * showMessage({ type: 'success', content: '操作成功！' });
 * showMessage({ type: 'error', content: '网络错误', title: '连接失败', duration: 5000 });
 */
export function showMessage(options: ShowMessageOptions): string | null {
  return useMessageStore.getState().addMessage(options);
}

/**
 * 显示成功消息（绿色，默认 3 秒自动关闭）
 * @example showSuccess('部队创建成功');
 */
export function showSuccess(content: string, options?: Partial<ShowMessageOptions>): string | null {
  return showMessage({ ...options, type: 'success', content });
}

/**
 * 显示警告消息（橙色，默认 3 秒自动关闭）
 * @example showWarning('部队血量低于 20%，请及时补充');
 */
export function showWarning(content: string, options?: Partial<ShowMessageOptions>): string | null {
  return showMessage({ ...options, type: 'warning', content });
}

/**
 * 显示错误消息（红色，默认 5 秒自动关闭）
 * 错误消息默认持续时间更长，确保用户有足够时间阅读错误详情。
 * @example showError('WebSocket 连接失败，请检查服务器地址');
 */
export function showError(content: string, options?: Partial<ShowMessageOptions>): string | null {
  return showMessage({ ...options, type: 'error', content, duration: options?.duration ?? 5000 });
}

/**
 * 显示信息提示（蓝色，默认 3 秒自动关闭）
 * @example showInfo('已成功加入地图');
 */
export function showInfo(content: string, options?: Partial<ShowMessageOptions>): string | null {
  return showMessage({ ...options, type: 'info', content });
}
