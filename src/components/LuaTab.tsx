/**
 * @fileoverview Lua 脚本执行器标签页组件
 * @description 提供向服务端发送 Lua 代码并查看执行结果的开发者工具面板。
 *              支持 Ctrl+Enter 快捷键执行，输出区域自动滚动到最新内容。
 *
 * 使用场景：
 *   主要用于游戏开发调试，允许开发者在运行时向服务端注入 Lua 脚本
 *   执行任意游戏逻辑，用于测试、作弊码或快速验证功能。
 *
 * @author WildMap Team
 */
import React, { useRef, useEffect } from 'react';
import { useGameStore } from '../store/gameStore';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

interface LuaTabProps {
  ws: UseWebSocketReturn;
}

export const LuaTab: React.FC<LuaTabProps> = ({ ws }) => {
  const luaInput      = useGameStore(s => s.luaInput);
  const luaOutput     = useGameStore(s => s.luaOutput);
  const setLuaInput   = useGameStore(s => s.setLuaInput);
  const appendOutput  = useGameStore(s => s.appendLuaOutput);
  const clearOutput   = useGameStore(s => s.clearLuaOutput);
  const isPlayerJoined = useGameStore(s => s.isPlayerJoined);

  const outputRef = useRef<HTMLDivElement>(null);

  /** 新输出内容追加后自动将滚动条推到底部 */
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [luaOutput]);

  const handleExecute = () => {
    const content = luaInput.trim();
    if (!content) {
      alert('请输入Lua代码！');
      return;
    }
    appendOutput(`> ${content}`);
    ws.sendMessage({ kind: 'doLua', data: { content } });
  };

  const handleClear = () => {
    clearOutput();
  };

  /** Ctrl+Enter 快捷键执行，避免与普通换行操作冲突 */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      handleExecute();
    }
  };

  return (
    <div>
      <textarea
        className="lua-input"
        placeholder={"输入Lua代码...\n例如: print('Hello World!')"}
        value={luaInput}
        onChange={e => setLuaInput(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={!isPlayerJoined}
      />

      <div className="button-group">
        <button
          className="btn btn-action"
          onClick={handleExecute}
          disabled={!isPlayerJoined}
        >
          ▶️ 执行
        </button>
        <button
          className="btn btn-action"
          onClick={handleClear}
        >
          🗑️ 清空
        </button>
      </div>

      {luaOutput && (
        <div className="lua-output" ref={outputRef}>
          {luaOutput}
        </div>
      )}

      <div className="lua-examples">
        <strong>💡 示例：</strong><br />
        <code>print("Hello!")</code>
      </div>
    </div>
  );
};
